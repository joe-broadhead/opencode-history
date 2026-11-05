// Mounts the compiled dist/tui.js (run `npm run build` first) with the OpenTUI 0.8 test renderer, the way
// OpenCode's TUI does: the Solid plugin swaps solid-js's server build for the client build.
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { afterEach, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import type { Plugin } from "@opencode/plugin/tui"
import type { StatusView } from "../../src/host/status.js"

ensureSolidTransformPlugin()
const dist = new URL("../../dist/tui.js", import.meta.url)
if (!existsSync(dist)) throw new Error("dist/tui.js is missing: run npm run build first")
const { testRender } = await import("@opentui/solid")
const { default: tui } = (await import(dist.href)) as { default: Plugin.Definition }
const VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version

type Context = Parameters<Plugin.Definition["setup"]>[0]
type Command = { id?: string; title?: string; bind?: string; slash?: { name: string }; palette?: boolean; enabled?: () => boolean; run: () => unknown }
interface Deferred { resolve(view: unknown): void; reject(error: Error): void; signal: AbortSignal }

const BUILDING = "The index is still being built (40 of 42 sessions), and results cover only the indexed sessions. Wait for it to finish."
const view = (version: string, overrides: Partial<StatusView> = {}): StatusView => ({
  version,
  host: { version: "2.2.3", range: ">=2.2.3 <2.3.0", tested: true },
  state: "connecting",
  tools: { visible: 9, unknown: [] },
  index: { ready: false, sessionsIndexed: 40, sessionsTotal: 42, lagSeconds: 0, source: "opencode-db", complete: true },
  database: "/data/opencode/history-source.db",
  indexPath: "/data/opencode-history/index.db",
  indexBytes: 2_621_440,
  masksChanged: false,
  defaultScope: "project",
  shadowedSkills: [],
  unguardedAgents: [],
  nextStep: BUILDING,
  ...overrides,
})

/** A narrow fake of the TUI context: only what the view touches. */
function fakeContext() {
  const requests: Deferred[] = []
  const layers: (() => { mode?: string; commands?: readonly Command[] })[] = []
  const events = new Map<string, () => void>(), stopped: string[] = []
  const dialog = { render: undefined as (() => unknown) | undefined, onClose: undefined as (() => void) | undefined, cleared: 0, size: undefined as string | undefined }
  const context = {
    location: { directory: "/project" },
    data: {
      location: { default: () => ({ directory: "/default" }) },
      on: (type: string, handler: () => void) => { events.set(type, handler); return () => { stopped.push(type); events.delete(type) } },
    },
    theme: { text: { base: "#ffffff", muted: "#888888", feedback: { warning: { base: "#ffaa00" }, error: { base: "#ff0000" } } } },
    client: {
      rpc: () => ({
        status: (input: object, options: { signal: AbortSignal; location: unknown }) => {
          expect(input).toEqual({})
          expect(options.location).toEqual({ directory: "/project" })
          return new Promise<unknown>((resolve, reject) => requests.push({ resolve, reject, signal: options.signal }))
        },
      }),
    },
    keymap: { layer: (factory: () => { commands?: readonly Command[] }) => { layers.push(factory) } },
    ui: {
      dialog: {
        show: (render: () => unknown, onClose: () => void) => { dialog.render = render; dialog.onClose = onClose },
        set: (options: { size?: string }) => { dialog.size = options.size },
        clear: () => { dialog.cleared++; const close = dialog.onClose; dialog.render = dialog.onClose = undefined; close?.() },
      },
    },
  } satisfies Partial<Record<keyof Context, unknown>>
  const command = (id: string) => layers.flatMap(layer => layer().commands ?? []).find(c => c.id === id)
  return { context: context as unknown as Context, requests, layers, events, stopped, dialog, command }
}

const destroys: (() => void)[] = []
afterEach(() => { for (const destroy of destroys.splice(0)) destroy() })
async function mount(render: () => unknown) {
  const screen = await testRender(() => render() as never, { width: 110, height: 40 })
  destroys.push(() => screen.renderer.destroy())
  return async () => { await Bun.sleep(0); await screen.renderOnce(); return screen.captureCharFrame() }
}
async function start() {
  const fake = fakeContext()
  const cleanup = (await tui.setup(fake.context)) as () => void
  expect(tui.id).toBe("history.sessions.tui")
  return { ...fake, cleanup }
}
async function open() {
  const ui = await start()
  ui.command("history.status")!.run()
  return { ...ui, frame: await mount(ui.dialog.render!) }
}

test("the status command is a global palette and slash command registered from setup", async () => {
  const ui = await start()
  expect(ui.layers.map(layer => layer().mode)).toEqual(["global"])
  expect(ui.command("history.status")).toMatchObject({ title: "History: Status", palette: true, slash: { name: "history" } })
  expect(ui.command("history.refresh")).toMatchObject({ title: "Refresh History status", bind: "r" })
  expect(ui.layers.flatMap(layer => layer().commands ?? []).filter(c => c.palette).map(c => c.id)).toEqual(["history.status"])
  expect(ui.requests).toHaveLength(0) // nothing is read until the dialog opens
  expect(ui.command("history.refresh")!.enabled!()).toBe(false)
  ui.command("history.status")!.run()
  expect(ui.dialog.size).toBe("large")
  expect(ui.command("history.refresh")!.enabled!()).toBe(true)
  ui.context.ui.dialog.clear()
  expect(ui.command("history.refresh")!.enabled!()).toBe(false)
})

test("renders the /history-status text from the status RPC, with its one next step", async () => {
  const ui = await open()
  expect(await ui.frame()).toContain("Loading status")
  ui.requests[0]!.resolve(view(VERSION))
  const frame = await ui.frame()
  const lines = [
    "History status",
    "Index: building, 40 of 42 sessions",
    "Source: OpenCode database",
    "Database: /data/opencode/history-source.db",
    "Index file: /data/opencode-history/index.db (2.5 MB)",
    "Default scope: project",
    `OpenCode: 2.2.3 (tested). History ${VERSION}`,
    "Next step: The index is still being built (40 of 42 sessions)",
    "r refresh · esc close",
  ]
  for (const line of lines) expect(frame).toContain(line)
  const at = lines.map(line => frame.indexOf(line))
  expect(at).toEqual([...at].sort((a, b) => a - b))
  expect(frame.match(/Next step:/g)).toHaveLength(1)
  expect(frame).not.toContain("refreshing")
})

test("nothing to do says so", async () => {
  const ui = await open()
  const ready = view(VERSION, { state: "ready", nextStep: "Nothing to do.", index: { ready: true, sessionsIndexed: 42, sessionsTotal: 42, lagSeconds: 0, source: "opencode-db", complete: true } })
  ui.requests[0]!.resolve(ready)
  const frame = await ui.frame()
  expect(frame).toContain("Index: ready, 42 of 42 sessions")
  expect(frame).toContain("Next step: Nothing to do.")
})

test("an index file at another schema shows its row and the restart as the next step", async () => {
  const ui = await open()
  const restart = "The history index was rebuilt for another version of this plugin, likely by another OpenCode process. Restart every OpenCode process, so they all run one version of the plugin."
  ui.requests[0]!.resolve(view(VERSION, { mismatch: { file: "1", build: "3" }, nextStep: restart }))
  const frame = await ui.frame()
  const row = "Index schema: version 1 in the file, but this build uses version 3, so every query fails (INDEX_MISMATCH)"
  expect(frame).toContain(row)
  expect(frame.indexOf("Index file:")).toBeLessThan(frame.indexOf(row))
  expect(frame).toContain("Next step: The history index was rebuilt for another version of this plugin")
  expect(frame.match(/Next step:/g)).toHaveLength(1)
})

test("refresh re-reads the RPC and drops a stale answer", async () => {
  const ui = await open()
  ui.requests[0]!.resolve(view(VERSION))
  expect(await ui.frame()).toContain(`History ${VERSION}`)
  ui.command("history.refresh")!.run()
  ui.command("history.refresh")!.run()
  expect(ui.requests).toHaveLength(3)
  expect(ui.requests[1]!.signal.aborted).toBe(true)
  ui.requests[2]!.resolve(view("fresh"))
  ui.requests[1]!.resolve(view("stale"))
  const frame = await ui.frame()
  expect(frame).toContain("History fresh")
  expect(frame).not.toContain("stale")
})

test("a failed refresh keeps the last status and says why", async () => {
  const ui = await open()
  ui.requests[0]!.resolve(view(VERSION))
  await ui.frame()
  ui.command("history.refresh")!.run()
  ui.requests[1]!.reject(new Error("History status is unavailable"))
  const frame = await ui.frame()
  expect(frame).toContain(`History ${VERSION}`)
  expect(frame).toContain("Refresh failed: History status is unavailable")
})

test("an answer that is not a status shows the failure and its next step", async () => {
  const ui = await open()
  ui.requests[0]!.resolve({ version: VERSION })
  const frame = await ui.frame()
  expect(frame).toContain("STATUS_UNAVAILABLE: The History server answered with an unexpected status. Next step: Restart OpenCode.")
})

test("the dialog subscribes to server events only while it is open", async () => {
  const ui = await start()
  const events = ["server.connected", "agent.updated", "session.created", "session.deleted", "session.idle"]
  expect(ui.events.size).toBe(0)
  ui.command("history.status")!.run()
  expect([...ui.events.keys()].sort()).toEqual([...events].sort())
  expect(ui.requests).toHaveLength(1)
  for (const type of events) ui.events.get(type)!()
  expect(ui.requests).toHaveLength(1 + events.length)
  ui.context.ui.dialog.clear()
  expect(ui.events.size).toBe(0)
  expect(ui.stopped.sort()).toEqual([...events].sort())
})

test("dispose closes the dialog, aborts the request in flight, removes the listeners, and ignores late answers", async () => {
  const ui = await open()
  const pending = ui.requests[0]!
  ui.cleanup()
  expect(ui.dialog.cleared).toBe(1)
  expect(pending.signal.aborted).toBe(true)
  expect(ui.events.size).toBe(0)
  expect(ui.stopped).toHaveLength(5)
  pending.resolve(view("late"))
  ui.command("history.status")!.run()
  expect(ui.events.size).toBe(0)
  expect(ui.dialog.render).toBeUndefined()
  expect(ui.requests).toHaveLength(1)
})
