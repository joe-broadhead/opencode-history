// The history_sql child stops by itself: at its own deadline, when its parent goes away, and at its own caps. It must
// never outlive OpenCode, even when OpenCode is killed with SIGKILL and has no chance to kill it (QA HIST-1).
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildSync } from "esbuild"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { BOUNDS } from "../../../src/domain/bounds.js"
import { RUNNER, SQL_CELL_CHARS, SQL_STDOUT_BYTES, runnerCommand } from "../../../src/query/sql.js"
import { tempDir } from "../../temp.js"
import { doc, session, sidecar, type Sidecar } from "./fixture.js"

const ENDLESS = "with recursive r(x) as (select 1 union all select x+1 from r) select count(*) from r"
const repo = fileURLToPath(new URL("../../../", import.meta.url))

let index: Sidecar | undefined
let folder: string
const started = new Set<ChildProcess>()
const strays = new Set<number>()

beforeAll(() => { folder = tempDir("history-sql-child-") })
afterAll(() => rmSync(folder, { recursive: true, force: true }))

afterEach(() => {
  for (const child of started) child.kill("SIGKILL")
  started.clear()
  for (const pid of strays) try { process.kill(pid, "SIGKILL") } catch { /* gone, as it should be */ }
  strays.clear()
  index?.close()
  index = undefined
})

/** Every process with its parent, from `ps`, which reads the same on macOS and Linux. */
function processes(): { pid: number; ppid: number }[] {
  return execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map(line => {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    return { pid: pid!, ppid: ppid! }
  })
}
const alive = (pid: number) => processes().some(entry => entry.pid === pid)
const childrenOf = (pid: number) => processes().filter(entry => entry.ppid === pid).map(entry => entry.pid)

async function until<T>(check: () => T | undefined, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = check()
    if (value !== undefined || Date.now() > deadline) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** Starts the runner as `sql` does, writes one job, and leaves stdin open, like a parent that is still waiting. */
function runner(job: Record<string, unknown>) {
  const { file, args, env } = runnerCommand()
  const child = spawn(file, args, { env, stdio: ["pipe", "pipe", "ignore"] })
  started.add(child)
  let out = ""
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { out += chunk })
  const exited = new Promise<{ ms: number; out: string }>(resolve => {
    const from = Date.now()
    child.on("close", () => resolve({ ms: Date.now() - from, out }))
  })
  child.stdin!.on("error", () => {})
  child.stdin!.write(`${JSON.stringify({ params: [], limit: 100, cellChars: SQL_CELL_CHARS, maxBytes: 1024, busyMs: 100, timeoutMs: 10_000, ...job })}\n`)
  return { child, exited }
}

describe("the history_sql child on its own", () => {
  it("stops at its own deadline and answers timeout, with no kill from its parent", async () => {
    const { path } = (index = sidecar())
    const { exited } = runner({ path, statement: ENDLESS, timeoutMs: 600 })
    const { ms, out } = await exited
    expect(JSON.parse(out)).toEqual({ ok: false, reason: "timeout" })
    expect(ms).toBeGreaterThanOrEqual(500)
    expect(ms).toBeLessThan(3000)
  })

  it("never takes a deadline longer than SQL_TIMEOUT_MS from its job", () => {
    expect(RUNNER).toContain('"timeoutMs":10000')
    expect(RUNNER).toMatch(/Math\.min\(Number\(job\.timeoutMs\) \|\| C\.timeoutMs, C\.timeoutMs\)/)
  })

  it("stops as soon as its stdin ends, which is what the system does when the parent dies", async () => {
    const ix = (index = sidecar())
    const { child, exited } = runner({ path: ix.path, statement: ENDLESS })
    await new Promise(resolve => setTimeout(resolve, 300))
    child.stdin!.end()
    const { ms } = await exited
    expect(ms).toBeLessThan(2000)
  })

  it("keeps to its own row, cell and byte caps whatever the job asks for", async () => {
    const ix = (index = sidecar())
    for (let i = 0; i < 300; i++) session(ix.db, { id: `ses_${String(i).padStart(3, "0")}` })
    doc(ix.db, { sessionID: "ses_000", text: "z".repeat(SQL_CELL_CHARS * 3) })
    const rows = JSON.parse((await runner({ path: ix.path, statement: "select session_id from v_sessions", limit: 100_000, maxBytes: 1e12 }).exited).out)
    expect(rows.rows).toHaveLength(BOUNDS.sql.limit.max)
    expect(rows.truncated).toBe(true)
    const cells = JSON.parse((await runner({ path: ix.path, statement: "select text from v_docs", cellChars: 1e9 }).exited).out)
    expect(cells.rows[0][0]).toHaveLength(SQL_CELL_CHARS)
  })

  it("answers output instead of writing more than SQL_STDOUT_BYTES", async () => {
    const ix = (index = sidecar())
    // One row of 1,100 cells of 2,000 two-byte characters: 4.4 MB of JSON.
    const wide = Array.from({ length: 1100 }, (_, at) => `w as c${at}`).join(", ")
    const statement = `with t(w) as (select replace(printf('%.${SQL_CELL_CHARS}c', 'x'), 'x', char(233))) select ${wide} from t`
    const { out } = await runner({ path: ix.path, statement, maxBytes: 1e12 }).exited
    expect(out.length).toBeLessThan(SQL_STDOUT_BYTES)
    expect(JSON.parse(out)).toEqual({ ok: false, reason: "output" })
  })

  it("masks text cells with the job's patterns before it cuts them", async () => {
    const ix = (index = sidecar())
    doc(ix.db, { sessionID: "ses_000", text: `PIN=4321 ${"y".repeat(SQL_CELL_CHARS)} PIN=9876` })
    const { out } = await runner({ path: ix.path, statement: "select text from v_docs", mask: [["(?<keep>PIN=)\\d+", "g"]] }).exited
    const [text] = JSON.parse(out).rows[0]
    expect(text.startsWith("PIN=[masked] ")).toBe(true)
    expect(text).not.toContain("4321")
  })
})

describe("the history_sql child when its parent is killed", () => {
  it("is gone within 2 s after the process that started it is killed mid-statement", async () => {
    const ix = (index = sidecar())
    // The parent runs the real sql(): bundled from src, as the plugin bundle is, and run on this Node.
    const entry = join(folder, "parent.ts"), bundle = join(folder, "parent.mjs")
    writeFileSync(entry, [
      `import { sql } from ${JSON.stringify(join(repo, "src/query/sql.ts"))}`,
      `setInterval(() => {}, 1000)`,
      `sql(process.argv[2], { sql: ${JSON.stringify(ENDLESS)} }).catch(() => {})`,
    ].join("\n"))
    buildSync({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent" })
    const parent = spawn(process.execPath, [bundle, ix.path], { stdio: "ignore" })
    started.add(parent)
    const child = await until(() => childrenOf(parent.pid!)[0], 10_000)
    expect(child, "the parent started no SQL child").toBeTypeOf("number")
    strays.add(child!)
    // Let the statement get going inside SQLite.
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(alive(child!)).toBe(true)
    const killed = Date.now()
    parent.kill("SIGKILL")
    const gone = await until(() => alive(child!) ? undefined : Date.now() - killed, 5000)
    expect(gone, "the SQL child outlived its killed parent").toBeTypeOf("number")
    expect(gone!).toBeLessThan(2000)
  })
})
