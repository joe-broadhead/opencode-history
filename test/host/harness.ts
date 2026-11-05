// Hosts History in-process on the public @opencode/sdk. Import this module before anything that loads
// @opencode/*: it points HOME, OPENCODE_TEST_HOME, the XDG variables and TMPDIR at a temporary root, and
// changes into that root, so the host never reads or writes the user's real OpenCode state.
import { mkdirSync, rmSync } from "node:fs"
import { join, sep } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { OpenCode } from "@opencode/sdk"
import { TESTED_HOSTS } from "../../src/domain/hosts.js"
import { tempDir } from "../temp.js"

/** The host version reported to plugins, the first tested release unless set. Read before the environment is replaced. */
export const HOST_VERSION = process.env.OPENCODE_HOST_VERSION ?? TESTED_HOSTS[0]!
export const root = tempDir("history-host-")
const home = join(root, "home")
const previousDir = process.cwd()
for (const dir of [home, join(home, ".config"), join(home, ".local/share"), join(home, ".cache"), join(home, ".local/state"), join(root, "tmp")]) mkdirSync(dir, { recursive: true })
// OpenCode's own variables, and credentials such as OPENCODE_API_KEY or GITHUB_TOKEN, would point the host at the
// user's config and accounts: with a key in the environment it connects that provider and calls it over the network.
for (const name of Object.keys(process.env)) if (/^OPENCODE/.test(name) || /(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/.test(name)) delete process.env[name]
Object.assign(process.env, {
  OPENCODE_DISABLE_FREE_MODELS: "1",
  HOME: home,
  OPENCODE_TEST_HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local/share"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_STATE_HOME: join(home, ".local/state"),
  TMPDIR: join(root, "tmp"),
})
// The embedded host also opens a location at the working directory.
process.chdir(home)

/** An empty project directory. */
export function project(name: string) {
  const directory = join(root, "projects", name)
  mkdirSync(directory, { recursive: true })
  return directory
}

/** `plugin` with these options, as opencode.json would pass them; plugins given to the SDK get none of their own. */
export function withOptions(plugin: Plugin.Plugin, options: Record<string, unknown>): Plugin.Plugin {
  return { id: plugin.id, setup: ctx => plugin.setup(Object.create(ctx, { options: { value: options, enumerable: true } }) as Plugin.Context) }
}

/**
 * Starts an embedded host on its own database file. `logs` collects its warnings and errors, such as a plugin's setup
 * failure. `config` is opencode.json content, for example config-only `agents`.
 */
export async function startHost(plugins: readonly Plugin.Plugin[], database: string, version = HOST_VERSION, config?: Record<string, unknown>) {
  const { OpenCode } = await import("@opencode/sdk")
  const { Global } = await import("@opencode/util/global")
  const paths = Global.Path as { data: string; cache: string; config: string; state: string; tmp: string; home: string; bin: string; log: string; repos: string }
  const outside = Object.entries({ data: paths.data, cache: paths.cache, config: paths.config, state: paths.state, tmp: paths.tmp, home: paths.home, bin: paths.bin, log: paths.log, repos: paths.repos, cwd: process.cwd(), database })
    .filter(([, path]) => !path.startsWith(root + sep))
  if (outside.length > 0) throw new Error(`refusing to start: OpenCode paths are outside the test root: ${outside.map(([name, path]) => `${name}=${path}`).join(", ")}`)
  const logs: { level: string; message: string; text: string }[] = []
  const sdk = await OpenCode.create({
    app: { version },
    plugins,
    database: { path: database },
    models: { fetch: false },
    fs: { filewatcher: false },
    config: config ? { content: JSON.stringify(config), directory: join(root, "config"), project: false, claude: false } : { claude: false },
    log: { level: "warn", emit: (entry: OpenCode.LogEntry) => logs.push({ level: entry.level, message: entry.message, text: `${entry.message} ${String(entry.cause ?? "")} ${JSON.stringify(entry.attributes ?? {})}` }) },
  })
  return { sdk, logs }
}

/** Polls `check` until it is true, or fails after `ms`. */
export async function waitFor(check: () => boolean | Promise<boolean>, ms = 20_000, what = "the condition") {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`)
}

export function removeRoot() {
  try { process.chdir(previousDir) } catch { /* the previous directory may already be gone */ }
  rmSync(root, { recursive: true, force: true })
}
