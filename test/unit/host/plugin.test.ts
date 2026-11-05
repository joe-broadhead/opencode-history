import { afterEach, describe, expect, test, vi } from "vitest"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { FAILURES } from "../../../src/domain/common.js"
import { loadConfig } from "../../../src/domain/config.js"
import { SESSION_EVENTS } from "../../../src/host/events.js"
import { createPlugin } from "../../../src/host/plugin.js"
import type { RuntimeOptions } from "../../../src/host/runtime.js"
import { History } from "../../../src/rpc.js"
import { fakeRuntime, type FakeRuntime } from "../../host/runtime.js"
import { fakeSession } from "../../host/session.js"
import { tempDir } from "../../temp.js"

const packageRoot = fileURLToPath(new URL("../../../", import.meta.url))
const VERSION = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version
afterEach(() => { vi.restoreAllMocks() })

type Event = { type: string; data: unknown }
/** A fake plugin context that records what setup registers, in order, and lets a test push host events. */
function host({ options = {}, version = "2.2.3", fail, agents = [] }: { options?: unknown; version?: string; fail?: "tool" | "skill"; agents?: { id: string; permissions: { action: string; resource: string; effect: string }[] }[] } = {}) {
  const order: string[] = [], transforms: Record<string, (editor: never) => void> = {}, generated: unknown[] = [], subscriptions: { types: readonly string[]; signal: AbortSignal }[] = []
  const rpc: { definition?: unknown; handlers?: Record<string, (input: unknown, context: unknown) => Promise<unknown>> } = {}
  const queue: Event[] = []
  /** Set `fail` to make the host's text generation reject with it. */
  const generation: { fail?: unknown } = {}
  let wake = () => {}
  const registration = { dispose: async () => {} }
  const transform = (name: string) => async (callback: (editor: never) => void) => {
    order.push(name)
    if (fail === name) throw new Error("registration failed")
    transforms[name] = callback
    return registration
  }
  const session = fakeSession()
  const asserts: unknown[] = []
  const ctx = {
    options, app: { version }, location: { directory: "/work/app", project: { id: "prj_app", directory: "/work" } },
    agent: { transform: transform("agent"), list: async () => ({ data: agents }) },
    permission: { assert: async (request: unknown) => { asserts.push(request) }, hook: async () => { order.push("hook"); return registration } },
    tool: { transform: transform("tool"), list: async () => [] },
    rpc: {
      register: async (definition: { id: string }, handlers: typeof rpc.handlers) => {
        order.push(`rpc ${definition.id}`)
        if (!rpc.definition) Object.assign(rpc, { definition, handlers })
        return { ...registration, events: { emit: async () => {} } }
      },
    },
    command: { transform: transform("command") },
    skill: { transform: transform("skill") },
    session: { ...session.session, synthetic: async () => {}, list: async () => ({ data: [], cursor: {} }), context: async () => [] },
    event: {
      subscribe(options: { types: readonly string[]; signal: AbortSignal }) {
        order.push("event"); subscriptions.push(options)
        return (async function* () {
          while (!options.signal.aborted) {
            const next = queue.shift()
            if (next) { yield next; continue }
            await new Promise<void>(resolve => { wake = resolve; options.signal.addEventListener("abort", () => resolve(), { once: true }) })
          }
        })()
      },
    },
    experimental: { generate: { text: async (input: unknown) => { generated.push(input); if (generation.fail !== undefined) throw generation.fail; return { text: "the answer" } } } },
  }
  const push = (event: Event) => { queue.push(event); wake() }
  return { ctx: ctx as never, raw: ctx, order, transforms, rpc, generated, generation, subscriptions, push, asserts }
}
function runtimes() {
  const created: { options: RuntimeOptions; runtime: FakeRuntime }[] = []
  return { created, create: async (options: RuntimeOptions) => { const runtime = fakeRuntime(); created.push({ options, runtime }); return runtime } }
}
const setup = async (h: ReturnType<typeof host>, r = runtimes()) => {
  const cleanup = await createPlugin({ createRuntime: r.create, packageRoot }).setup(h.ctx) as () => Promise<void>
  return { cleanup, runtime: r.created[0]!.runtime, options: r.created[0]!.options, r }
}

describe("setup", () => {
  test("registers tools, RPC, commands and skills in order, then follows session events", async () => {
    const h = host(), { cleanup, options } = await setup(h)
    expect(h.order).toEqual(["agent", "tool", "rpc history.sessions", "rpc history.sessions.tools", "hook", "command", "skill", "event"])
    expect(options.config).toEqual(loadConfig({}))
    expect(options.session).toBe(h.raw.session)
    expect(h.rpc.definition).toBe(History)
    expect(Object.keys(h.rpc.handlers!)).toEqual(Object.keys(History.methods))
    expect(h.subscriptions).toEqual([{ types: SESSION_EVENTS, signal: expect.any(AbortSignal) }])
    await cleanup()
  })

  test("the tools run for the plugin's location and the calling session", async () => {
    const h = host({ options: { defaultScope: "all" } }), { cleanup, runtime } = await setup(h)
    const added: { name: string; input: { parse(v: unknown): unknown }; execute(input: unknown, context: object): Promise<{ content: string }> }[] = []
    h.transforms.tool!({ namespace: () => {}, add: (t: never) => { added.push(t) } } as never)
    expect(added).toHaveLength(8)
    const search = added.find(t => t.name === "search")!
    await search.execute(search.input.parse({ query: "x" }), { sessionID: "ses_now", agent: "build", messageID: "msg_1", id: "call_1", signal: new AbortController().signal, progress: async () => {} })
    expect(runtime.calls[0]).toMatchObject({ caller: { sessionID: "ses_now", projectID: "prj_app", directory: "/work/app" }, input: { scope: "all" } })
    expect(h.asserts).toEqual([{ sessionID: "ses_now", agent: "build", action: "history_search", resources: ["*"], save: ["*"], metadata: {}, source: { type: "tool", messageID: "msg_1", id: "call_1" } }])
    const skills: string[] = []
    h.transforms.skill!({ add: (s: { id: string }) => { skills.push(s.id) } } as never)
    expect(skills).toEqual(["history-recall"])
    const commands: string[] = []
    h.transforms.command!({ add: (c: { name: string }) => { commands.push(c.name) } } as never)
    expect(commands).toEqual(["history-status", "history-reindex"])
    await cleanup()
  })

  test("the status RPC carries the package version and the options", async () => {
    const h = host({ options: { recall: { synthesize: true, model: "anthropic/claude-sonnet" } } }), { cleanup } = await setup(h)
    expect(await h.rpc.handlers!.status!({}, { error: () => { throw new Error("unexpected") } })).toMatchObject({
      version: VERSION, host: { version: "2.2.3", range: ">=2.2.3 <2.3.0", tested: true }, state: expect.stringMatching(/^(ready|connecting)$/), recall: { synthesize: true, model: "anthropic/claude-sonnet" }, defaultScope: "project",
    })
    await cleanup()
  })

  test("recall answers go through the host's generate, with recall.model when set", async () => {
    const plain = host(), a = await setup(plain)
    expect(await a.options.generate("Q?")).toBe("the answer")
    const pinned = host({ options: { recall: { model: "openrouter/anthropic/claude" } } }), b = await setup(pinned)
    await b.options.generate("Q2?")
    expect([...plain.generated, ...pinned.generated]).toEqual([{ prompt: "Q?" }, { prompt: "Q2?", model: { providerID: "openrouter", id: "anthropic/claude" } }])
    await a.cleanup(); await b.cleanup()
  })

  test("a host answer that there is no model becomes RECALL_MODEL_UNAVAILABLE; other model failures pass through", async () => {
    const h = host(), { cleanup, options } = await setup(h)
    const failWith = (error: unknown) => { h.generation.fail = error }
    const noModel = [
      { _tag: "Generate.UnavailableError" }, { _tag: "Generate.ModelNotFoundError" }, { _tag: "Generate.UnsupportedModelError" },
      { _tag: "Generate.InvalidRequestError", field: "model" }, { _tag: "InvalidRequestError", field: "model.variant" },
      { _tag: "ServiceUnavailableError" }, { _tag: "ModelNotFoundError" }, { _tag: "ProviderNotFoundError" }, { _tag: "UnsupportedModelError" },
    ]
    for (const fields of noModel) {
      failWith(Object.assign(new Error("no model for the secret prompt"), fields))
      await expect(options.generate("Q?"), JSON.stringify(fields)).rejects.toMatchObject({ code: "RECALL_MODEL_UNAVAILABLE", message: FAILURES.RECALL_MODEL_UNAVAILABLE[0] })
    }
    for (const other of [{ _tag: "Generate.ProviderRequestError", reason: "rate_limit" }, { _tag: "Generate.InvalidRequestError", field: "prompt" }, { _tag: "Generate.InvalidRequestError" }]) {
      const error = Object.assign(new Error("rate limited"), other)
      failWith(error)
      await expect(options.generate("Q?"), JSON.stringify(other)).rejects.toBe(error)
    }
    await cleanup()
  })

  test("a runtime on the partial source warns once at setup, with the reason and its fix", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const r = runtimes()
    const create = async (options: RuntimeOptions) => Object.assign(await r.create(options), { fallback: "SOURCE_SCHEMA_UNKNOWN" as const })
    const cleanup = await createPlugin({ createRuntime: create, packageRoot }).setup(host().ctx) as () => Promise<void>
    expect(warn.mock.calls).toEqual([[
      "SOURCE_SCHEMA_UNKNOWN: OpenCode's database has a layout this plugin version does not know, so history comes from the plugin session API, which keeps only the messages after each compaction. Next step: Update the plugin, or use the OpenCode version it was tested with.",
    ]])
    await cleanup()
    warn.mockClear()
    await (await setup(host())).cleanup()
    expect(warn).not.toHaveBeenCalled()
  })

  test("session events reach the runtime until unload, which closes the runtime and the subscription", async () => {
    const h = host(), { cleanup, runtime } = await setup(h)
    h.push({ type: "session.created", data: { sessionID: "ses_1" } })
    h.push({ type: "session.idle", data: { sessionID: "ses_1" } })
    await vi.waitFor(() => expect(runtime.events).toEqual([{ type: "session.created", data: { sessionID: "ses_1" } }, { type: "session.idle", data: { sessionID: "ses_1" } }]))
    await cleanup()
    expect(runtime.closed).toBe(true)
    expect(h.subscriptions[0]!.signal.aborted).toBe(true)
    h.push({ type: "session.deleted", data: {} })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(runtime.events).toHaveLength(2)
  })

  test("a failing registration closes the runtime and starts no subscription", async () => {
    for (const fail of ["tool", "skill"] as const) {
      const h = host({ fail }), r = runtimes()
      await expect(createPlugin({ createRuntime: r.create, packageRoot }).setup(h.ctx)).rejects.toThrow("registration failed")
      expect(r.created[0]!.runtime.closed, fail).toBe(true)
      expect(h.order).not.toContain("event")
    }
  })

  test("invalid options and untested hosts stop setup before the runtime opens; allowUntestedHost warns and runs", async () => {
    const r = runtimes()
    await expect(createPlugin({ createRuntime: r.create, packageRoot }).setup(host({ options: { scope: "everywhere" } }).ctx)).rejects.toThrow(/^OPTIONS_INVALID: .*options\.scope is not a History option/)
    await expect(createPlugin({ createRuntime: r.create, packageRoot }).setup(host({ version: "2.3.0" }).ctx)).rejects.toThrow(/^HOST_UNTESTED: /)
    expect(r.created).toEqual([])
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { cleanup } = await setup(host({ version: "2.3.0", options: { allowUntestedHost: true } }), r)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^HOST_UNTESTED: OpenCode 2\.3\.0 is untested/))
    await cleanup()
  })

  test("an indexPath that names OpenCode's database or a file in the project fails setup before anything opens it", async () => {
    const r = runtimes()
    const cases = [
      { options: { database: "/data/opencode/opencode.db", indexPath: "/data/opencode/opencode.db" }, message: /^INDEX_PATH_REFUSED: The indexPath option names OpenCode's own database.* Next step: Set indexPath / },
      { options: { indexPath: "/work/app/.history/index.db" }, message: /^INDEX_PATH_REFUSED: The indexPath option is inside this project's folder/ },
      { options: { indexPath: "/work/other/index.db" }, message: /^INDEX_PATH_REFUSED: The indexPath option is inside this project's folder/ },
    ]
    for (const { options, message } of cases) {
      const setup = createPlugin({ createRuntime: r.create, packageRoot }).setup(host({ options }).ctx)
      await expect(setup).rejects.toMatchObject({ code: "INDEX_PATH_REFUSED", message: expect.stringMatching(message) })
    }
    expect(r.created).toEqual([])
  })

  test("an existing database that is not a History index fails setup and keeps its tables", async () => {
    const { createRuntime } = await import("../../../src/runtime.js")
    const { openDb } = await import("../../../src/domain/sqlite.js")
    const dir = tempDir("history-plugin-")
    try {
      const victim = join(dir, "victim.db")
      const db = openDb(victim)
      db.exec("create table precious (x)")
      db.exec("create table other (y)")
      db.close()
      const options = { database: join(dir, "missing.db"), indexPath: victim }
      await expect(createPlugin({ createRuntime, packageRoot }).setup(host({ options }).ctx)).rejects.toMatchObject({
        code: "INDEX_PATH_REFUSED", message: expect.stringMatching(/^INDEX_PATH_REFUSED: The indexPath option names an existing file that is not a History index, so it was left unchanged\. Next step: /),
      })
      const check = openDb(victim, { readOnly: true })
      expect(check.all("select name from sqlite_master order by name")).toEqual([{ name: "other" }, { name: "precious" }])
      check.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a runtime that cannot open fails setup with its code", async () => {
    const { createRuntime } = await import("../../../src/runtime.js")
    const dir = tempDir("history-plugin-")
    try {
      // The index folder would have to be inside a file.
      writeFileSync(join(dir, "file"), "")
      const options = { database: join(dir, "missing.db"), indexPath: join(dir, "file", "index.db") }
      await expect(createPlugin({ createRuntime, packageRoot }).setup(host({ options }).ctx)).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
