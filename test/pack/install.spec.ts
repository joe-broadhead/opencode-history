// Packs the package as npm would publish it, installs the tarball into an empty project with scripts disabled,
// imports its entries, and loads it on stock OpenCode 2.2.3, 2.2.4, 2.2.5 and 2.2.6. Run `npm run build` first.
// It runs on every release in src/host/tested-hosts.json. OPENCODE_BIN_2_2_3, OPENCODE_BIN_2_2_4 and
// OPENCODE_BIN_2_2_5 name the stock `opencode` binaries when set. When unset, each release is installed into this
// test's temp project with --ignore-scripts.
// PACKED_DIR names a folder with the tarball already packed, as release.yml does: the test then checks that exact
// file, the one that will be published.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { arch, platform } from "node:os"
import { join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { PLUGIN_ID, TUI_ID } from "../../src/domain/contract.js"
import { HOST_RANGE, TESTED_HOSTS } from "../../src/domain/hosts.js"
import { tempDir } from "../temp.js"

setDefaultTimeout(300_000)
const repo = fileURLToPath(new URL("../../", import.meta.url))
const NAME = "@joe-broadhead/opencode-history"
const VERSIONS = TESTED_HOSTS
const source = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string }

const temp = tempDir("history-pack-")
const project = join(temp, "project"), installed = join(project, "node_modules", NAME)
interface Packed { filename: string; size: number; files: { path: string }[] }
const PACKED_DIR = process.env.PACKED_DIR
let main: Packed
const servers = new Set<ChildProcess>()

const run = (command: string, args: string[], cwd: string) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
// The package has no workspaces or platform packages, so the checked-in package.json is the published one.
const pack = () => (JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp], repo)) as Packed[])[0]!

/** The tarball packed earlier, described the way `npm pack --json` describes one. */
const existing = (): Packed => {
  const file = join(PACKED_DIR!, `${NAME.replace(/^@/, "").replace("/", "-")}-${source.version}.tgz`)
  if (!existsSync(file)) throw new Error(`PACKED_DIR has no ${file}`)
  const files = run("tar", ["-tzf", file], PACKED_DIR!).split("\n").filter(path => path && !path.endsWith("/")).map(path => ({ path: path.replace(/^package\//, "") }))
  return { filename: file, size: statSync(file).size, files }
}

beforeAll(() => {
  if (!PACKED_DIR && !existsSync(join(repo, "dist/index.js"))) throw new Error("dist/ is missing: run npm run build first")
  // No prepare or prepack script exists (check-forbidden), so packing never rebuilds dist/.
  main = PACKED_DIR ? existing() : pack()
  mkdirSync(project)
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "pack-probe", private: true }))
  // Offline: the package has no dependencies.
  run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", join(temp, "npm-cache"), resolve(temp, main.filename)], project)
})

afterAll(async () => {
  await Promise.all([...servers].map(stop))
  rmSync(temp, { recursive: true, force: true })
})

describe("the tarball", () => {
  test("holds the whitelisted files only, under 1 MB", () => {
    const files = main.files.map(file => file.path)
    expect(main.size).toBeLessThan(1_000_000)
    // No TypeScript, JSX or declaration files: nothing consumes plugin types.
    expect(files.filter(file => /\.(?:tsx|jsx|ts)$/.test(file))).toEqual([])
    expect(files.sort()).toMatchSnapshot()
  })

  test("has the published manifest: no dependencies or peers, and the tested host range", () => {
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as Record<string, unknown>
    // Only release.yml checks "private"; this test passes with or without it.
    expect(manifest).toMatchObject({ name: NAME, version: source.version, type: "module", opencode: { host: HOST_RANGE } })
    for (const field of ["workspaces", "dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bundleDependencies", "bundledDependencies", "overrides", "engines"]) expect(manifest[field]).toBeUndefined()
    // The server part at "." and "./tui" (the TUI imports the RPC contract from its own bundle), plus the three icons
    // the host and Jelly read. Nothing else, and no ./rpc.
    expect(manifest.exports).toEqual({
      ".": "./dist/index.js",
      "./tui": "./dist/tui.js",
      "./icon.svg": "./assets/icon.svg",
      "./icon-128.png": "./assets/icon-128.png",
      "./icon-256.png": "./assets/icon-256.png",
    })
    expect(manifest.opencode).toMatchObject({ icons: expect.any(Array) })
    expect(manifest.main).toBeUndefined()
    expect(manifest.types).toBeUndefined()
  })

  // Hot-reload regression: OpenCode reloads an updated plugin in place but keeps the module records it already holds
  // for unchanged paths. A new entry that imported a sibling file could get the stale old one. So dist/ holds only the
  // two entries, and neither imports, dynamically imports or requires any relative path.
  test("dist/ holds exactly index.js and tui.js, each self-contained", () => {
    expect(readdirSync(join(installed, "dist")).sort()).toEqual(["index.js", "tui.js"])
    const scanner = new Bun.Transpiler({ loader: "js" })
    for (const entry of ["index.js", "tui.js"]) {
      const imports = scanner.scanImports(readFileSync(join(installed, "dist", entry), "utf8"))
      expect(imports.filter(i => i.path.startsWith(".") || i.path.startsWith("/")).map(i => `${i.kind} ${i.path}`), entry).toEqual([])
      expect(imports.filter(i => i.kind === "dynamic-import" || i.kind === "require-call").map(i => i.path), entry).toEqual([])
      const host = /^(?:node:|@opencode\/plugin(?:\/|$)|@opentui\/|solid-js(?:\/|$))/
      expect(imports.map(i => i.path).filter(path => !host.test(path)), entry).toEqual([])
    }
    expect(scanner.scanImports(readFileSync(join(installed, "dist/tui.js"), "utf8")).map(i => i.path)).toContain("@opentui/solid")
  })

  test("dist/tui.js carries no zod and stays under 30 KB: the RPC contract is plain JSON Schema", () => {
    const tui = readFileSync(join(installed, "dist/tui.js"), "utf8")
    expect(Buffer.byteLength(tui)).toBeLessThan(30_000)
    expect(tui).not.toMatch(/node_modules\/zod\/|\bZodType\b|\$ZodError|from "zod"/)
    // NOTICE names exactly the bundles each package is in, and zod is in the server bundle only.
    expect(readFileSync(join(installed, "NOTICE"), "utf8")).toContain("## zod 4.6.7 (MIT), in dist/index.js\n")
  })
})

test("its entries import from the empty project with only host-provided modules served", () => {
  const probe = JSON.parse(run(process.execPath, [join(repo, "test/pack/probe.ts"), project], repo)) as { served: string[]; server: { id: string; setup: string; path: string }; tui: { id: string; setup: string } }
  expect(probe.served).toEqual(["@opencode/plugin", "@opencode/plugin/promise/tool", "@opencode/plugin/rpc", "@opentui/solid", "solid-js"])
  expect(probe.server).toEqual({ id: PLUGIN_ID, setup: "function", path: join(installed, "dist/index.js") })
  expect(probe.tui).toEqual({ id: TUI_ID, setup: "function" })
})

for (const version of VERSIONS) describe(`stock OpenCode ${version}`, () => {
  let host: Awaited<ReturnType<typeof serve>>
  let binary: string
  beforeAll(async () => { binary = stockBinary(version); host = await serve(version, binary) })
  afterAll(async () => { if (host) await stop(host.child) })

  test("loads the installed package as an active plugin with its server and TUI parts", () => {
    // No ./rpc export, so the host lists no rpc feature; the server still registers the status method, tested below.
    expect(host.plugin).toMatchObject({ id: PLUGIN_ID, source: { type: "local", path: installed }, features: { server: true, tui: true }, state: { status: "active" } })
    expect((host.plugin as { features?: { rpc?: boolean } }).features?.rpc).toBeUndefined()
  })

  test("answers the status RPC with its version and the host check, reading the host's own database by default", async () => {
    const response = await host.api("POST", `/api/rpc/${PLUGIN_ID}/status`, { input: {} })
    expect(response.status).toBe(200)
    const view = (response.data as { output: Record<string, any> }).output
    expect(view.version).toBe(source.version)
    // The binary's own version, not the slot's label, so a newer release can stand in for a slot.
    const found = host.version
    expect(view.host).toEqual({ version: found, range: HOST_RANGE, tested: TESTED_HOSTS.includes(found) })
    expect(view.state).toMatch(/^(ready|connecting)$/)
    expect(view.nextStep).toEqual(expect.any(String))
    // With no options, the database and the index are under the isolated XDG data home, and the database is the
    // file this OpenCode release writes.
    expect(view.database).toBe(join(host.home, ".local/share/opencode/opencode.db"))
    expect(view.indexPath).toBe(join(host.home, ".local/share/opencode-history/index.db"))
    expect(existsSync(view.database)).toBe(true)
    expect(view.index).toMatchObject({ source: "opencode-db", complete: true })
  })

  test("a script finds a session created on the stock server through the tools RPC, as a session and its agent", async () => {
    const title = `Rotate the pangolin keys on ${version}`
    const created = await host.api("POST", "/api/session", { title, location: { directory: host.directory } })
    expect(created.status).toBe(200)
    const id = (created.data as { data: { id: string } }).data.id
    expect(id).toStartWith("ses_")
    const script = await host.api("POST", "/api/session", { title: "Script", agent: "build", location: { directory: host.directory } })
    const sessionID = (script.data as { data: { id: string } }).data.id
    const deadline = Date.now() + 30_000
    let found: string[] = []
    while (!found.includes(id) && Date.now() < deadline) {
      const response = await host.api("POST", `/api/rpc/${PLUGIN_ID}.tools/search`, { input: { sessionID, input: { query: "pangolin keys", scope: "all" } } })
      expect(response.status).toBe(200)
      found = ((response.data as { output: { results: { sessionID: string }[] } }).output.results).map(result => result.sessionID)
      if (!found.includes(id)) await Bun.sleep(250)
    }
    expect(found).toEqual([id])
    const pin = await host.api("POST", `/api/rpc/${PLUGIN_ID}.tools/pin`, { input: { sessionID, input: { action: "list" } } })
    expect(pin.status).not.toBe(200)
  })

  test("describe gives each method's class and, with a session, its permission; a write needs a prior allow, and a location is required", async () => {
    const script = await host.api("POST", "/api/session", { title: "v2", agent: "build", location: { directory: host.directory } })
    const sessionID = (script.data as { data: { id: string } }).data.id
    const described = await host.api("POST", `/api/rpc/${PLUGIN_ID}.tools/describe`, { input: { sessionID } })
    expect(described.status).toBe(200)
    const methods = (described.data as { output: { methods: { name: string; class: string; permission?: string }[] } }).output.methods
    expect(Object.fromEntries(methods.map(method => [method.name, method.class]))).toEqual({
      search: "read", brief: "read", read: "read", sessions: "read", files: "read", recall: "read", sql: "read", pin: "write",
    })
    expect(Object.fromEntries(methods.map(method => [method.name, method.permission]))).toMatchObject({ search: "allow", pin: "ask" })
    // The write asks by default, so a script is refused before anything runs.
    const refused = await host.api("POST", `/api/rpc/${PLUGIN_ID}.tools/pin`, { input: { sessionID, input: { action: "list" } } })
    expect(refused.status).not.toBe(200)
    expect(JSON.stringify(refused.data)).toContain("would ask")
    // A session rule allows it, and the same call runs.
    const allowed = await host.api("POST", "/api/session", { title: "pin", agent: "build", permissions: [{ action: "history_pin", resource: "*", effect: "allow" }], location: { directory: host.directory } })
    const granted = (allowed.data as { data: { id: string } }).data.id
    const pinned = await host.api("POST", `/api/rpc/${PLUGIN_ID}.tools/pin`, { input: { sessionID: granted, input: { action: "list" } } })
    expect(pinned.status).toBe(200)
    expect((pinned.data as { output: { pins: unknown[] } }).output.pins).toEqual([])
    // A deny hides the tool, with no call.
    const denied = await host.api("POST", "/api/session", { title: "deny", agent: "build", permissions: [{ action: "history_*", resource: "*", effect: "deny" }], location: { directory: host.directory } })
    const locked = (denied.data as { data: { id: string } }).data.id
    const hidden = await host.api("POST", `/api/rpc/${PLUGIN_ID}.tools/search`, { input: { sessionID: locked, input: { query: "x" } } })
    expect(hidden.status).not.toBe(200)
    expect(JSON.stringify(hidden.data)).toContain("hidden from this session's agent")
    // Without a location, the call reaches the server's default location, where the installed plugin is not loaded.
    const missing = await host.api("POST", `/api/rpc/${PLUGIN_ID}.tools/describe`, { input: {} }, null)
    expect(missing.status).toBe(400)
    expect(JSON.stringify(missing.data)).toContain("rpc.unavailable")
  })

  test("an endless history_sql statement stops with SQL_TIMEOUT while the server keeps answering", async () => {
    const script = await host.api("POST", "/api/session", { title: "SQL script", agent: "build", location: { directory: host.directory } })
    const sessionID = (script.data as { data: { id: string } }).data.id
    const endless = "with recursive r(x) as (select 1 union all select x+1 from r) select count(*) from r"
    const started = Date.now()
    const pending = host.api("POST", `/api/rpc/${PLUGIN_ID}.tools/sql`, { input: { sessionID, input: { sql: endless } } })
    await Bun.sleep(2000)
    const probe = Date.now()
    expect((await host.api("GET", "/openapi.json")).status).toBe(200)
    expect(Date.now() - probe).toBeLessThan(3000)
    const answer = await pending
    expect(JSON.stringify(answer.data)).toContain("SQL_TIMEOUT")
    expect(Date.now() - started).toBeLessThan(20_000)
  })

  test("history_sql's runner stops an endless statement inside this OpenCode binary, which keeps its event loop", () => {
    const folder = mkdtempSync(join(temp, `sql-${version}-`))
    const env = { PATH: "/usr/bin:/bin", HOME: host.home, TMPDIR: folder, BUN_BE_BUN: "1" }
    const out = JSON.parse(execFileSync(binary, [join(repo, "test/pack/sql-probe.ts"), folder], { cwd: repo, env, encoding: "utf8" }).trim())
    expect(out).toMatchObject({ bun: true, endless: "SQL_TIMEOUT", quick: { columns: ["total"], rows: [[6]], truncated: false } })
    expect(out.took).toBeGreaterThanOrEqual(1400)
    expect(out.took).toBeLessThan(6000)
    expect(out.ticks).toBeGreaterThan(30)
  })

  test("history_sql's child stops within 2 s when this OpenCode binary is killed mid-statement", async () => {
    const folder = mkdtempSync(join(temp, `orphan-${version}-`))
    const env = { PATH: "/usr/bin:/bin", HOME: host.home, TMPDIR: folder, BUN_BE_BUN: "1" }
    const parent = spawn(binary, [join(repo, "test/pack/sql-probe.ts"), folder, "orphan"], { cwd: repo, env, stdio: ["ignore", "pipe", "ignore"] })
    let child: number | undefined
    try {
      const deadline = Date.now() + 30_000
      while (child === undefined && Date.now() < deadline && parent.exitCode === null) {
        child = processes().find(entry => entry.ppid === parent.pid)?.pid
        if (child === undefined) await Bun.sleep(100)
      }
      expect(child, "the probe started no SQL child").toBeNumber()
      await Bun.sleep(500)
      const killed = Date.now()
      parent.kill("SIGKILL")
      while (processes().some(entry => entry.pid === child) && Date.now() - killed < 5000) await Bun.sleep(50)
      expect(processes().some(entry => entry.pid === child), "the SQL child outlived the killed binary").toBe(false)
      expect(Date.now() - killed).toBeLessThan(2000)
    } finally {
      parent.kill("SIGKILL")
      if (child !== undefined) try { process.kill(child, "SIGKILL") } catch { /* gone */ }
    }
  })

  test("registers its skill, read from the installed skills/ folder", async () => {
    const response = await host.api("GET", "/api/skill")
    const list = Array.isArray(response.data) ? response.data : (response.data as { data?: unknown[] }).data ?? []
    const ids = (list as { id?: string; name?: string }[]).map(skill => skill.id ?? skill.name ?? "").filter(id => id.startsWith("history-")).sort()
    expect(ids).toEqual(["history-recall"])
  })
})

/** The stock CLI for `version`: the OPENCODE_BIN_* path when set, otherwise the npm release with scripts off, installed once. */
const binaries = new Map<string, string>()
function stockBinary(version: string) {
  let binary = binaries.get(version)
  if (!binary) binaries.set(version, binary = installBinary(version))
  return binary
}
function installBinary(version: string) {
  const given = process.env[`OPENCODE_BIN_${version.replaceAll(".", "_")}`]
  if (given) {
    if (!existsSync(given)) throw new Error(`OPENCODE_BIN_${version.replaceAll(".", "_")} does not exist: ${given}`)
    return given
  }
  // Its own package.json, and npm's cwd set to it: npm walks up from a folder that has none.
  const dir = join(temp, `opencode-${version}`)
  mkdirSync(dir)
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `history-pack-opencode-${version}`, private: true }))
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", `@opencode/cli@${version}`], dir)
  const binary = join(dir, "node_modules", "@opencode", `cli-${platform()}-${arch()}`, "bin", "opencode")
  if (!existsSync(binary)) throw new Error(`@opencode/cli@${version} has no binary for ${platform()}-${arch()}`)
  return binary
}

/** Starts `opencode serve` on its own port with an isolated home and a project that lists the installed package. */
async function serve(version: string, binary: string) {
  const root = join(temp, `host-${version}`)
  const home = join(root, "home"), directory = join(root, "project"), tmp = join(root, "tmp")
  for (const dir of [join(home, ".config"), join(home, ".local/share"), join(home, ".cache"), join(home, ".local/state"), directory, tmp]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(directory, "opencode.json"), JSON.stringify({ plugins: [installed] }))
  const password = randomBytes(18).toString("base64url"), port = await freePort()
  const env = {
    HOME: home, OPENCODE_TEST_HOME: home, TMPDIR: tmp,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local/state"),
    PATH: "/usr/bin:/bin", OPENCODE_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FREE_MODELS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_FILEWATCHER: "1",
    // A dead proxy: anything that leaves loopback fails instead of reaching a real service.
    HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  }
  // The slot's label names the release; the binary may be a newer one standing in for it. Tests read its own version.
  const found = /\d+\.\d+\.\d+\S*/.exec(execFileSync(binary, ["--version"], { env, cwd: directory, encoding: "utf8" }))?.[0]
  if (!found) throw new Error(`OpenCode ${version}: --version printed no version`)
  const listed = execFileSync(binary, ["debug", "paths"], { env, cwd: directory, encoding: "utf8" }).trim().split("\n").flatMap(line => {
    const value = line.trim().split(/\s+/).slice(1).join(" ")
    return value ? [value] : []
  })
  expect(listed.length).toBeGreaterThanOrEqual(8)
  expect(listed.filter(path => !path.startsWith(root + sep))).toEqual([])
  // The server's default location is its working directory, which is not the project: a call without a location then
  // proves rpc.unavailable, as it does for `opencode api` run from elsewhere.
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "warn"], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  servers.add(child)
  let log = ""
  const keep = (chunk: Buffer) => { log = (log + chunk.toString("utf8")).slice(-8000) }
  child.stdout!.on("data", keep)
  child.stderr!.on("data", keep)
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  // `at: null` sends no location at all, which is a call to the service's default location.
  const api = async (method: string, path: string, body?: unknown, at: string | null = directory) => {
    const url = new URL(path, `http://127.0.0.1:${port}`)
    if (at) url.searchParams.set("location[directory]", at)
    const response = await fetch(url, { method, headers: { authorization, "content-type": "application/json" }, ...body === undefined ? {} : { body: JSON.stringify(body) } })
    const text = await response.text()
    let data: unknown = text
    try { data = JSON.parse(text) } catch {}
    return { status: response.status, data }
  }
  // Plugins load on the location's first request; `plugin list` would not wait for that.
  const deadline = Date.now() + 240_000
  type Info = { id: string; state?: { status: string; error?: string } }
  let plugin: Info | undefined
  while (!plugin && Date.now() < deadline && child.exitCode === null) {
    const response = await api("GET", "/api/plugin").catch(() => undefined)
    const list = Array.isArray(response?.data) ? response.data : (response?.data as { data?: unknown[] } | undefined)?.data ?? []
    plugin = (list as Info[]).find(entry => entry.id === PLUGIN_ID)
    if (!plugin) await Bun.sleep(500)
  }
  if (!plugin) throw new Error(`OpenCode ${version} did not list ${PLUGIN_ID} (exit ${child.exitCode}). Server log:\n${log}`)
  if (plugin.state?.status !== "active") throw new Error(`${PLUGIN_ID} did not load on OpenCode ${version}: ${JSON.stringify(plugin.state)}. Server log:\n${log}`)
  return { child, plugin, api, home, directory, version: found }
}

async function stop(child: ChildProcess) {
  servers.delete(child)
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(resolve => child.once("exit", resolve))
  try { process.kill(-child.pid!, "SIGTERM") } catch {}
  if (await Promise.race([exited.then(() => true), Bun.sleep(10_000).then(() => false)])) return
  try { process.kill(-child.pid!, "SIGKILL") } catch {}
  await exited
}

/** Every process with its parent, from `ps`, which reads the same on macOS and Linux. */
function processes(): { pid: number; ppid: number }[] {
  return execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map(line => {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    return { pid: pid!, ppid: ppid! }
  })
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}
