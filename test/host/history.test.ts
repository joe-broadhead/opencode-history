// History on the public @opencode/sdk host (no private host imports), with the real runtime: the plugin reads the
// embedded host's own database file and keeps its index in a temp file, both named by the plugin options. Sessions
// are created through the SDK, and the tests check that search finds them.
import { HOST_VERSION, project, removeRoot, root, startHost, waitFor, withOptions } from "./harness.js"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import plugin from "../../src/index.js"
import type { ReadOutput, SearchOutput } from "../../src/domain/api.js"
import { PLUGIN_ID } from "../../src/domain/contract.js"
import { HOST_RANGE } from "../../src/domain/hosts.js"
import { History } from "../../src/rpc.js"
import { Rpc } from "@opencode/plugin/rpc"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { defaultRules, hasDefaultRules } from "../../src/host/permissions.js"

const version = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version
const database = join(root, "opencode.db")
const indexPath = join(root, "history", "index.db")
const directory = project("app")
const location = { directory }

const contexts = new Map<string, Pick<Plugin.Context, "tool">>()
const observer: Plugin.Plugin = { id: "test.observer", setup(ctx) { contexts.set(ctx.location.directory, ctx) } }
let host: Awaited<ReturnType<typeof startHost>>

const rpc = () => host.sdk.rpc(History)
// The client side only names the methods: the plugin checks each input against the tool's own schema.
const open = {}
const Tools = Rpc.define({
  id: TOOLS_RPC_ID,
  methods: Object.fromEntries(["describe", "search", "read", "brief"].map(name => [name, { input: open, output: open, errors: { failed: open } }])),
  events: {},
})
/** The session scripts call as; it names the build agent. */
let script = ""
const tool = <T>(method: string, input: unknown): Promise<T> =>
  (host.sdk.rpc(Tools) as unknown as Record<string, (input: unknown, options: unknown) => Promise<T>>)[method]!({ sessionID: script, input }, { location })
const search = async (query: string | string[]): Promise<SearchOutput> => tool("search", { query, scope: "all" })
const found = async (query: string | string[]) => (await search(query)).results.map(result => result.sessionID)

let imported = 0
/**
 * A session with one user message and one assistant reply, imported through the SDK. Messages that a prompt or a
 * synthetic message would add need a model run, and these tests call no model.
 */
async function conversation(title: string, user: string, assistant: string) {
  const base = await host.sdk.session.create({ title, location })
  const n = String(++imported).padStart(16, "0"), id = `ses_imported${n}`, now = Date.now()
  await host.sdk.experimental.session.import({
    info: { ...base, id, title },
    messages: [
      { id: `msg_imported${n}1`, type: "user", time: { created: now }, text: user },
      { id: `msg_imported${n}2`, type: "assistant", time: { created: now + 1, completed: now + 2 }, agent: "build", model: { id: "model", providerID: "provider" }, content: [{ type: "text", text: assistant }], finish: "stop" },
    ],
    location,
  })
  await host.sdk.session.remove({ sessionID: base.id })
  return id
}

beforeAll(async () => {
  // The host runs at `ask-changes`, so a change still asks here: that is where the prompt and the refusal are tested.
  // `experimental.schedules` turns on Code Mode, where R2 proves the same rules on the `execute` path.
  host = await startHost([withOptions(plugin, { database, indexPath, access: "ask-changes" }), observer], database, HOST_VERSION, { experimental: { schedules: true } })
  // Plugins set up on the location's first listing, which fails while they are still activating.
  await waitFor(() => host.sdk.agent.list({ location }).then(() => contexts.has(directory), () => false), 30_000, "the plugins to load")
  script = (await host.sdk.session.create({ title: "Script", location, agent: "build" } as never)).id
})
afterAll(async () => {
  await host?.sdk.close()
  removeRoot()
})

/**
 * Runs a Code Mode program once on the host's `execute` path (a schedule's `if` code) as the session's agent. It must
 * throw: the message is what the program saw.
 */
async function codemode(sessionID: string, code: string): Promise<string> {
  try {
    await host.sdk.experimental.schedule.create({ sessionID, when: { in: "6 hours" }, if: { code }, prompt: "unused" } as never)
  } catch (error) {
    const detail = (error as { detail?: unknown }).detail
    return `${error instanceof Error ? error.message : String(error)} ${detail === undefined ? "" : String(detail)}`
  }
  throw new Error("the Code Mode program did not throw, so a schedule was created")
}

describe(`History on @opencode/sdk, host version ${HOST_VERSION}`, () => {
  test("loads with the database and indexPath options, and reports them in its status", async () => {
    const status = await rpc().status({}, { location })
    expect(status).toMatchObject({ version, database, indexPath, host: { version: HOST_VERSION, range: HOST_RANGE, tested: true }, state: expect.stringMatching(/^(ready|connecting)$/), nextStep: expect.any(String) })
    expect(status.index.source).toBe("opencode-db")
    expect(status.index.complete).toBe(true)
    expect(existsSync(indexPath)).toBe(true)
    expect(host.logs.filter(entry => entry.level === "error")).toEqual([])
  })

  test("registers its tools, commands and skill", async () => {
    const tools = (await contexts.get(directory)!.tool.list()).filter(tool => tool.id.startsWith("history_")).map(tool => tool.id).sort()
    expect(tools).toEqual(["history_brief", "history_events_list", "history_files", "history_pin", "history_read", "history_recall", "history_search", "history_sessions", "history_sql"])
    const commands = await host.sdk.command.list({ location })
    expect(commands.data.map((c: { name: string }) => c.name).filter((name: string) => name.startsWith("history-")).sort()).toEqual(["history-reindex", "history-status"])
    const skills = await host.sdk.skill.list({ location })
    expect(skills.data.map((s: { id: string }) => s.id).filter((id: string) => id.startsWith("history-"))).toEqual(["history-recall"])
  })

  test("finds a session created through the SDK by its title", async () => {
    const session = await host.sdk.session.create({ title: "Fix the flaky upload retry", location })
    const other = await host.sdk.session.create({ title: "Tune the database pool size", location })
    // Each session is synced on its own, after a short pause that follows its events.
    await waitFor(async () => (await found("upload retry")).includes(session.id) && (await found("database pool")).includes(other.id), 20_000, "both sessions to be indexed")
    expect(await found("upload retry")).toEqual([session.id])
    expect(await found("database pool")).toEqual([other.id])
  })

  test("finds the text of a session's messages, and reads and briefs it", async () => {
    const id = await conversation("Notes", "Why does the quokka migration fail on staging?", "It needs a backfill before the cutover.")
    await waitFor(async () => (await found("quokka migration")).includes(id), 20_000, "the messages to be indexed")
    const [hit] = (await search(["quokka migration", "backfill cutover"])).results
    expect(hit).toMatchObject({ sessionID: id, title: "Notes", queriesMatched: 2, firstPrompt: "Why does the quokka migration fail on staging?" })
    expect(hit!.snippets.map(s => s.kind).sort()).toEqual(["assistant", "user"])
    const read: ReadOutput = await tool("read", { sessionID: id, at: hit!.snippets[0]!.seq })
    expect(read.messages.map(m => m.text)).toEqual(["Why does the quokka migration fail on staging?", "It needs a backfill before the cutover."])
    const brief = await tool("brief", { sessionID: id })
    expect(brief).toMatchObject({ firstPrompt: "Why does the quokka migration fail on staging?", lastReply: "It needs a backfill before the cutover." })
  })

  test("a renamed session is found by its new title, and a removed one is no longer found", async () => {
    const session = await host.sdk.session.create({ title: "Draft", location })
    await host.sdk.session.update({ sessionID: session.id, title: "Rotate the wombat signing keys" })
    await waitFor(async () => (await found("wombat signing")).includes(session.id), 20_000, "the new title to be indexed")
    await host.sdk.session.remove({ sessionID: session.id })
    await waitFor(async () => !(await found("wombat signing")).includes(session.id), 20_000, "the session to leave the index")
  })

  test("the history_search tool finds sessions for the calling session", async () => {
    const session = await host.sdk.session.create({ title: "Investigate the narwhal cache stampede", location })
    const caller = await host.sdk.session.create({ title: "Caller", location })
    await waitFor(async () => (await found("narwhal stampede")).includes(session.id), 20_000, "the session to be indexed")
    const tool = (await contexts.get(directory)!.tool.list()).find(t => t.id === "history_search")!
    const result = await tool.execute({ query: ["narwhal cache stampede"] }, { sessionID: caller.id, agent: "build", messageID: "msg_test1", id: "call_test1", signal: new AbortController().signal, progress: async () => {} } as never) as { output: { results: { sessionID: string }[] }; content: unknown }
    expect(result.output.results.map(r => r.sessionID)).toEqual([session.id])
    expect(JSON.stringify(result.content)).toContain(session.id)
  })

  test("history_recall gives its evidence and no answer, and scope session finds the calling session's own text", async () => {
    const id = await conversation("Certificates", "How do we rotate the ocelot certificates?", "Run the ocelot rotation script, then restart the proxy.")
    await waitFor(async () => (await found("ocelot certificates")).includes(id), 20_000, "the messages to be indexed")
    const tools = await contexts.get(directory)!.tool.list()
    const context = { sessionID: id, agent: "build", messageID: "msg_test2", id: "call_test2", signal: new AbortController().signal, progress: async () => {} } as never
    const recall = tools.find(t => t.id === "history_recall")!
    const input = { question: "How do we rotate the ocelot certificates?", queries: ["ocelot certificates"], scope: "all", includeCurrent: true }
    const evidence = await recall.execute(input, context) as { output: { evidence: { sessionID: string }[] } }
    expect(evidence.output).not.toHaveProperty("answer")
    expect(evidence.output.evidence.map(e => e.sessionID)).toContain(id)
    // The calling session is left out by default, and scope "session" searches only it.
    const searchTool = tools.find(t => t.id === "history_search")!
    const own = await searchTool.execute({ query: ["ocelot rotation script"], scope: "session" }, context) as { output: { results: { sessionID: string }[] } }
    expect(own.output.results.map(r => r.sessionID)).toEqual([id])
    const others = await searchTool.execute({ query: ["ocelot rotation script"] }, context) as { output: { results: { sessionID: string }[] } }
    expect(others.output.results.map(r => r.sessionID)).not.toContain(id)
  })

  test("puts the default rules after each agent's base allow, so status names no agent", async () => {
    const agents = (await host.sdk.agent.list({ location })).data as { id: string; permissions: { action: string; resource: string; effect: string }[] }[]
    const based = agents.filter(agent => agent.permissions.some(rule => rule.action === "*" && rule.resource === "*" && rule.effect === "allow"))
    expect(based.map(agent => agent.id)).toContain("build")
    for (const agent of based) expect(hasDefaultRules(agent.permissions as never, "ask-changes"), agent.id).toBe(true)
    const build = agents.find(agent => agent.id === "build")!
    const at = build.permissions.findIndex(rule => rule.action === "history_*")
    expect(build.permissions.slice(at, at + defaultRules("ask-changes").length)).toEqual(defaultRules("ask-changes"))
    const status = await rpc().status({}, { location })
    expect(status).toMatchObject({ access: "ask-changes", unguardedAgents: [] })
  })

  test("history_pin asks before it changes the session, and a rejection pins nothing", async () => {
    const caller = await host.sdk.session.create({ title: "Pin caller", location })
    const past = await conversation("Pinned decision", "Which queue do we use for the lynx jobs?", "The lynx jobs go on the slow queue.")
    const tool = (await contexts.get(directory)!.tool.list()).find(t => t.id === "history_pin")!
    const context = { sessionID: caller.id, agent: "build", messageID: "msg_pin1", id: "call_pin1", signal: new AbortController().signal, progress: async () => {} } as never
    const pending = tool.execute({ action: "put", sessionID: past, maxChars: 4000 }, context).then(() => "pinned", (error: unknown) => error)
    let asked: { id: string; action: string }[] = []
    await waitFor(async () => {
      asked = await host.sdk.permission.list({ sessionID: caller.id }) as unknown as typeof asked
      return asked.length > 0
    }, 20_000, "the pin to ask")
    expect(asked.map(request => request.action)).toEqual(["history_pin"])
    await host.sdk.permission.reply({ sessionID: caller.id, requestID: asked[0]!.id, decision: "reject" })
    expect(await pending).not.toBe("pinned")
    expect(await host.sdk.experimental.session.instructions.entry.list({ sessionID: caller.id })).toEqual([])
  })

  test("a read tool runs without asking", async () => {
    const caller = await host.sdk.session.create({ title: "SQL caller", location })
    const tool = (await contexts.get(directory)!.tool.list()).find(t => t.id === "history_sql")!
    const context = { sessionID: caller.id, agent: "build", messageID: "msg_st1", id: "call_st1", signal: new AbortController().signal, progress: async () => {} } as never
    const result = await tool.execute({ sql: "select 1 as n" }, context) as { output: { rows: unknown[][]; index: { sessionsTotal: number } } }
    expect(result.output.rows).toEqual([[1]])
    expect(result.output.index.sessionsTotal).toEqual(expect.any(Number))
    expect(await host.sdk.permission.list({ sessionID: caller.id })).toEqual([])
  })

  // R2, the Code Mode path: inside `execute` the session's agent and rules decide, with no model and no one to answer
  // a prompt, so an ask is refused before the read runs.
  test("runs a read inside a Code Mode program as the session's agent", async () => {
    const sessionID = (await host.sdk.session.create({ title: "Code reader", location, agent: "build" } as never)).id
    const seen = await codemode(sessionID, 'const result = await tools.history.search({ query: ["app"] }); throw new Error("SEEN " + JSON.stringify({ results: result.results.length }))')
    expect(seen).toContain("SEEN ")
    expect(JSON.parse(/SEEN (\{.*\})/.exec(seen)?.[1] ?? "null")).toEqual({ results: expect.any(Number) })
  })

  test("refuses an ask, a deny and an unknown name inside a Code Mode program", async () => {
    const ask = (await host.sdk.session.create({ title: "Code ask", location, agent: "build", permissions: [{ action: "history_search", resource: "*", effect: "ask" }] } as never)).id
    expect(await codemode(ask, 'await tools.history.search({ query: ["app"] }); throw new Error("ran")')).toMatch(/needs approval|ask/i)
    const deny = (await host.sdk.session.create({ title: "Code deny", location, agent: "build", permissions: [{ action: "history_*", resource: "*", effect: "deny" }] } as never)).id
    expect(await codemode(deny, 'await tools.history.search({ query: ["app"] }); throw new Error("ran")')).toMatch(/denied|refus/i)
    // An unknown name is not a tool: the program fails before it reaches the plugin.
    expect(await codemode(deny, 'await tools.history.shiny_new_tool({}); throw new Error("ran")')).toMatch(/Unknown Code Mode tool|denied|refus/i)
  })
})

test("the plugin ID is stable", () => {
  expect(plugin.id).toBe(PLUGIN_ID)
})
