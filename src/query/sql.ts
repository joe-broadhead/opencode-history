// One read-only SELECT over the index, in a child process with a deadline, on its own read-only connection, with capped rows, cells and bytes.
import { spawn } from "node:child_process"
import { dirname } from "node:path"
import type { SqlInput, SqlOutput } from "../domain/api.js"
import { BOUNDS } from "../domain/bounds.js"
import { HistoryError, refused } from "../domain/common.js"
import { locked } from "../domain/sqlite.js"
import { bounded } from "./common.js"

export const SQL_CELL_CHARS = 2000
const SQL_BUSY_MS = 2000

/**
 * The statement with comments replaced by spaces and trailing semicolons dropped, ready to wrap in a subquery.
 * Rejects anything but one SELECT or WITH statement.
 */
export function checkSql(text: string): string {
  // `out` keeps strings and quoted names; `code` replaces them, so only real semicolons and keywords are seen.
  let out = ""
  let code = ""
  let at = 0
  while (at < text.length) {
    const char = text[at]!
    const pair = text.slice(at, at + 2)
    if (pair === "--") {
      const end = text.indexOf("\n", at)
      at = end < 0 ? text.length : end
      out += " "
      code += " "
    } else if (pair === "/*") {
      const end = text.indexOf("*/", at + 2)
      at = end < 0 ? text.length : end + 2
      out += " "
      code += " "
    } else if (char === "'" || char === '"' || char === "`" || char === "[") {
      // Strings and quoted names run to their closing quote; a doubled quote stays inside.
      const close = char === "[" ? "]" : char
      let end = at + 1
      for (;;) {
        end = text.indexOf(close, end)
        if (end < 0 || close === "]" || text[end + 1] !== close) break
        end += 2
      }
      if (end < 0) throw refused("SQL_REJECTED", "the SQL has an unclosed quote")
      out += text.slice(at, end + 1)
      code += "0"
      at = end + 1
    } else {
      out += char
      code += char
      at++
    }
  }
  const statement = code.trim().replace(/[;\s]+$/, "")
  if (!statement) throw refused("SQL_REJECTED", "the SQL is empty")
  if (statement.includes(";")) throw refused("SQL_REJECTED", "only one SQL statement is allowed")
  if (!/^(select|with)\b/i.test(statement)) throw refused("SQL_REJECTED", "only a SELECT or WITH statement is allowed")
  return out.trim().replace(/[;\s]+$/, "")
}

/** How long one statement may run. The child stops itself at this deadline, and the parent kills it soon after. */
export const SQL_TIMEOUT_MS = 10_000
/** How long after the deadline the parent kills a child that has not stopped itself. */
const SQL_KILL_GRACE_MS = 2000
/** Most bytes of row data one statement returns; rows past it are cut and the result says truncated. */
export const SQL_OUTPUT_BYTES = 512 * 1024
/** Most bytes the child may write at all; past it, the call fails with OUTPUT_LIMIT. */
export const SQL_STDOUT_BYTES = 4 * 1024 * 1024
/** Statements that run at once; more wait their turn. */
export const SQL_PARALLEL = 2
/** How often the child checks that the process that started it is still its parent. */
const SQL_PARENT_POLL_MS = 200

/**
 * The child's own ceilings, written into its script. It enforces them whatever the job asks for, so once it has
 * started it needs nothing from its parent: not the deadline, not the row or byte caps, and not a kill.
 */
const SQL_CEILINGS = {
  timeoutMs: SQL_TIMEOUT_MS,
  rows: BOUNDS.sql.limit.max,
  cellChars: SQL_CELL_CHARS,
  rowBytes: SQL_OUTPUT_BYTES,
  stdoutBytes: SQL_STDOUT_BYTES,
  busyMs: SQL_BUSY_MS,
  pollMs: SQL_PARENT_POLL_MS,
  // The job is the statement (at most 16,384 characters), its params and a few numbers, as one JSON line.
  jobChars: 1024 * 1024,
} as const

/**
 * The worker thread that runs the statement: one read-only connection, the statement, and the rows, posted back as
 * one message. SQLite holds the thread it runs on until the statement ends, so it runs here, and the child's main
 * thread stays free to enforce the deadline and watch for its parent. String cells are masked with the current mask
 * patterns, then cut.
 */
const WORKER = `"use strict"
const { parentPort, workerData: job } = require("node:worker_threads")
const { DatabaseSync } = require("node:sqlite")
const C = ${JSON.stringify(SQL_CEILINGS)}
const limit = Math.max(0, Math.min(job.limit, C.rows))
const cellChars = Math.max(1, Math.min(job.cellChars, C.cellChars))
const maxBytes = Math.max(0, Math.min(job.maxBytes, C.rowBytes))
const masks = (job.mask || []).map(([source, flags]) => new RegExp(source, flags.includes("g") ? flags : flags + "g"))
const mask = text => {
  for (const pattern of masks) text = text.replace(pattern, (match, ...rest) => {
    if (match === "") return match
    const groups = rest[rest.length - 1]
    const keep = typeof groups === "object" && groups !== null ? groups.keep : undefined
    return (keep || "") + "[masked]"
  })
  return text
}
const clip = text => {
  if (text.length <= cellChars) return text
  let end = Math.max(0, cellChars - 1)
  const code = text.charCodeAt(end - 1)
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end--
  return text.slice(0, end) + "\\u2026"
}
const cell = value => {
  if (typeof value === "string") return clip(mask(value))
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  if (value instanceof Uint8Array) return "[blob, " + value.byteLength + " bytes]"
  return value === undefined ? null : value
}
let out
try {
  const db = new DatabaseSync(job.path, { readOnly: true })
  try {
    db.exec("pragma busy_timeout = " + Math.max(0, Math.min(job.busyMs, C.busyMs)))
    db.exec("pragma query_only = 1")
    const statement = db.prepare(job.statement)
    let columns = typeof statement.columns === "function" ? statement.columns().map(column => column.name) : null
    const rows = []
    let bytes = 0, truncated = false
    for (const row of statement.iterate(...job.params)) {
      if (columns === null) columns = Object.keys(row)
      if (rows.length >= limit) { truncated = true; break }
      const cells = columns.map(name => cell(row[name]))
      bytes += JSON.stringify(cells).length
      if (bytes > maxBytes && rows.length > 0) { truncated = true; break }
      rows.push(cells)
    }
    out = { ok: true, columns: columns || [], rows, truncated }
  } finally {
    db.close()
  }
} catch (error) {
  out = { ok: false, message: error && error.message ? String(error.message) : String(error), errcode: error && typeof error.errcode === "number" ? error.errcode : undefined }
}
parentPort.postMessage(out)
`

/**
 * The script the child process runs. It reads its job, one JSON line, from stdin, so nothing of the statement is on a
 * command line, and runs the statement in a worker thread (WORKER). Its main thread writes the answer as JSON on
 * stdout. It also ends the process by itself, so the child never outlives its call, when:
 * - the deadline passes (the job's timeout, at most SQL_TIMEOUT_MS): it answers `timeout` and stops;
 * - stdin ends: the parent keeps stdin open while it waits, and the system closes it when the parent exits, crashes
 *   or is killed;
 * - its parent process ID changes: an orphan is adopted by PID 1 or a subreaper, on macOS and Linux alike.
 * It stops with SIGKILL, because `process.exit` waits for a worker thread that is stuck inside SQLite. CommonJS, for
 * `node -e` and `bun -e`.
 */
export const RUNNER = `"use strict"
const { Worker } = require("node:worker_threads")
const C = ${JSON.stringify(SQL_CEILINGS)}
const parent = process.ppid
const stop = () => { try { process.kill(process.pid, "SIGKILL") } finally { process.exit(1) } }
let answered = false
const answer = out => {
  if (answered) return
  answered = true
  let text = JSON.stringify(out)
  if (Buffer.byteLength(text) > C.stdoutBytes) text = JSON.stringify({ ok: false, reason: "output" })
  // A worker that has finished lets the process exit; one still inside SQLite (a timeout) needs the stop. A parent
  // that does not read the answer gets the stop too.
  setTimeout(stop, 1000)
  process.stdout.write(text, () => out.reason === "timeout" ? stop() : process.exit(0))
}
setInterval(() => { if (process.ppid !== parent) stop() }, C.pollMs)
process.stdin.on("end", stop)
process.stdin.on("close", stop)
process.stdin.on("error", stop)
let raw = "", started = false
process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => {
  if (started) return
  raw += chunk
  const end = raw.indexOf("\\n")
  if (end < 0) { if (raw.length > C.jobChars) stop(); return }
  started = true
  let job
  try { job = JSON.parse(raw.slice(0, end)) } catch { return answer({ ok: false, message: "the job is not JSON" }) }
  raw = ""
  const timeoutMs = Math.max(1, Math.min(Number(job.timeoutMs) || C.timeoutMs, C.timeoutMs))
  setTimeout(() => answer({ ok: false, reason: "timeout" }), timeoutMs)
  const worker = new Worker(${JSON.stringify(WORKER)}, { eval: true, workerData: job })
  worker.on("message", answer)
  worker.on("error", error => answer({ ok: false, message: error && error.message ? String(error.message) : String(error) }))
})
`

/** What the child answers. `reason` says it stopped by itself: at its deadline, or with too much output. */
type Answer =
  | { readonly ok: true; readonly columns: string[]; readonly rows: unknown[][]; readonly truncated: boolean }
  | { readonly ok: false; readonly reason: "timeout" | "output" }
  | { readonly ok: false; readonly reason?: undefined; readonly message: string; readonly errcode?: number }

/** The child's command: this runtime itself, as Bun or Node, with the runner script and an environment of its own. */
export function runnerCommand(): { readonly file: string; readonly args: string[]; readonly env: Record<string, string> } {
  const bun = typeof process.versions.bun === "string"
  const env: Record<string, string> = bun ? { BUN_BE_BUN: "1" } : {}
  // SQLite puts large sorts in temporary files.
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  return { file: process.execPath, args: bun ? ["-e", RUNNER] : ["--no-warnings", "-e", RUNNER], env }
}

let running = 0
const waiting: (() => void)[] = []
/** Waits for one of the SQL_PARALLEL slots, or rejects with CANCELLED. Returns the release. */
async function slot(signal?: AbortSignal): Promise<() => void> {
  while (running >= SQL_PARALLEL) {
    await new Promise<void>((resolve, reject) => {
      const wake = () => { signal?.removeEventListener("abort", cancel); resolve() }
      const cancel = () => {
        const at = waiting.indexOf(wake)
        if (at >= 0) waiting.splice(at, 1)
        reject(new HistoryError("CANCELLED"))
      }
      if (signal?.aborted) return cancel()
      waiting.push(wake)
      signal?.addEventListener("abort", cancel, { once: true })
    })
  }
  running++
  let released = false
  return () => {
    if (released) return
    released = true
    running--
    waiting.shift()?.()
  }
}

/**
 * Runs one job in a child process. The child stops itself at the job's deadline; this side kills it SQL_KILL_GRACE_MS
 * later if it has not, when it writes too much, or when `signal` aborts. Stdin stays open until the child exits: its
 * end tells the child that this process is gone.
 */
function runChild(job: Record<string, unknown> & { readonly timeoutMs: number }, cwd: string, signal?: AbortSignal): Promise<Answer> {
  const { file, args, env } = runnerCommand()
  const timeoutMs = job.timeoutMs
  return new Promise((resolve, reject) => {
    let stop: "timeout" | "output" | "cancelled" | undefined
    const chunks: Buffer[] = []
    let size = 0
    const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
    const kill = (why: typeof stop) => {
      stop ??= why
      child.kill("SIGKILL")
    }
    const timer = setTimeout(() => kill("timeout"), timeoutMs + SQL_KILL_GRACE_MS)
    const abort = () => kill("cancelled")
    signal?.addEventListener("abort", abort, { once: true })
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > SQL_STDOUT_BYTES) return kill("output")
      chunks.push(chunk)
    })
    child.stdin.on("error", () => {})
    child.on("error", () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      reject(new HistoryError("SQL_FAILED"))
    })
    child.on("close", () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      child.stdin.destroy()
      let answer: Answer | undefined
      try { answer = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Answer } catch { /* no answer: a kill, or a crash */ }
      const why = stop ?? (answer && !answer.ok ? answer.reason : undefined)
      if (why === "timeout") return reject(new HistoryError("SQL_TIMEOUT"))
      if (why === "output") return reject(new HistoryError("OUTPUT_LIMIT"))
      if (why === "cancelled") return reject(new HistoryError("CANCELLED"))
      if (answer) return resolve(answer)
      reject(new HistoryError("SQL_FAILED"))
    })
    // One line, and no end: the child reads the job up to the newline, and takes the end of stdin as this process exiting.
    child.stdin.write(`${JSON.stringify(job)}\n`)
  })
}

/** The kind of mistake SQLite found, in words that cannot repeat the statement as SQLite's own message does. */
function sqliteMistake(text: string): string | undefined {
  if (/no such column/i.test(text)) return "it names a column the views do not have"
  if (/no such table/i.test(text)) return "it names a table or view the index does not have"
  if (/no such function/i.test(text)) return "it calls a function SQLite does not have"
  if (/ambiguous column/i.test(text)) return "a column name is ambiguous, so prefix it with its view"
  if (/syntax error|unrecognized token|incomplete input/i.test(text)) return "it has a syntax error"
  if (/index out of range/i.test(text)) return "params has more values than the statement has ? placeholders"
  return undefined
}

interface SqlOptions {
  readonly signal?: AbortSignal
  /** The deadline, at most SQL_TIMEOUT_MS. */
  readonly timeoutMs?: number
  /** The current mask patterns, applied to every text cell before it is cut, so a pattern added after text was indexed still applies. */
  readonly mask?: readonly RegExp[]
}

/**
 * Runs `input.sql` with its params on a fresh read-only connection to the index at `path`, in a child process of its
 * own, so a slow or endless statement cannot block OpenCode: it stops after SQL_TIMEOUT_MS with SQL_TIMEOUT, and it
 * stops by itself when OpenCode goes away. Rows stop at the limit and at SQL_OUTPUT_BYTES of data.
 */
export async function sql(path: string, input: SqlInput, options: SqlOptions = {}): Promise<Omit<SqlOutput, "index">> {
  const body = checkSql(input.sql)
  const limit = bounded(input.limit, BOUNDS.sql.limit)
  if (options.signal?.aborted) throw new HistoryError("CANCELLED")
  const release = await slot(options.signal)
  let answer: Answer
  try {
    answer = await runChild({
      path,
      // The limit is our own integer, written into the SQL so it cannot shift the caller's ? numbering.
      // Wrapping renames duplicate columns (`id`, `id:1`), so names are unique and match the row keys.
      statement: `select * from (\n${body}\n) limit ${limit + 1}`,
      params: input.params ?? [],
      limit,
      cellChars: SQL_CELL_CHARS,
      maxBytes: SQL_OUTPUT_BYTES,
      busyMs: SQL_BUSY_MS,
      timeoutMs: Math.min(options.timeoutMs ?? SQL_TIMEOUT_MS, SQL_TIMEOUT_MS),
      mask: (options.mask ?? []).map(pattern => [pattern.source, pattern.flags]),
    }, dirname(path), options.signal)
  } finally {
    release()
  }
  if (!answer.ok) {
    const failed = answer as Extract<Answer, { message: string }>
    const cause = Object.assign(new Error(failed.message), failed.errcode === undefined ? {} : { errcode: failed.errcode })
    if (locked(cause)) throw new HistoryError("INDEX_BUSY")
    const mistake = sqliteMistake(failed.message)
    throw mistake ? refused("SQL_FAILED", mistake) : new HistoryError("SQL_FAILED")
  }
  return { columns: answer.columns, rows: answer.rows, truncated: answer.truncated }
}
