// The tools RPC through the embedded host: a script calls History as a session, under that session's agent and its
// session rules, with no model. The agents are config-only, so they carry exactly the rules below.
import { HOST_VERSION, project, removeRoot, root, startHost, waitFor, withOptions } from "./harness.js"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { join } from "node:path"
import { Rpc } from "@opencode/plugin/rpc"
import type { Plugin } from "@opencode/plugin"
import plugin from "../../src/index.js"
import { History } from "../../src/rpc.js"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { TOOL_NAMES } from "../../src/host/tools.js"
import { defaultRules } from "../../src/host/permissions.js"

const database = join(root, "opencode.db")
const indexPath = join(root, "history", "index.db")
const directory = project("scripts")
const location = { directory }

// The client side only names the methods: the plugin checks each input against the tool's own schema.
const open = {}
const Tools = Rpc.define({
  id: TOOLS_RPC_ID,
  methods: Object.fromEntries(["describe", ...TOOL_NAMES].map(name => [name, { input: open, output: open, errors: { failed: open } }])),
  events: {},
})

let host: Awaited<ReturnType<typeof startHost>>
const loaded = new Set<string>()
const observer: Plugin.Plugin = { id: "test.observer", setup(ctx) { loaded.add(ctx.location.directory) } }
const sessions: Record<string, string> = {}

beforeAll(async () => {
  // The host runs at `ask-changes`, so a write is still refused here: that is where the refusal is tested.
  host = await startHost([withOptions(plugin, { database, indexPath, access: "ask-changes" }), observer], database, HOST_VERSION, {
    agents: {
      locked: { permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "history_*", resource: "*", effect: "deny" }] },
      careful: { permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "history_sql", resource: "*", effect: "ask" }] },
    },
  })
  await waitFor(() => host.sdk.agent.list({ location }).then(() => loaded.has(directory), () => false), 30_000, "the plugins to load")
  const create = async (input: Record<string, unknown>) => (await host.sdk.session.create({ location, title: "Script", ...input } as never)).id
  sessions.build = await create({ agent: "build" })
  sessions.locked = await create({ agent: "locked" })
  sessions.careful = await create({ agent: "careful" })
  sessions.agentless = await create({})
  // Session rules come after the agent's: this script may search but not run SQL.
  sessions.narrow = await create({ agent: "build", permissions: [{ action: "history_sql", resource: "*", effect: "deny" }] })
})
afterAll(async () => {
  await host?.sdk.close()
  removeRoot()
})

const tools = () => host.sdk.rpc(Tools) as unknown as Record<string, (input: unknown, options: unknown) => Promise<unknown>>
/** The method's result, or the declared error's `{ type, code, message }`. */
async function run(method: string, session: string, input: unknown): Promise<Record<string, any>> {
  try {
    return { value: await tools()[method]!({ sessionID: session, input }, { location }) }
  } catch (error) {
    const e = error as Record<string, any>
    return { type: e.type ?? e._tag, code: e.data?.code, message: String(e.message ?? e) }
  }
}
const asked = async (session: string) => host.sdk.permission.list({ sessionID: session })

describe(`tools RPC on @opencode/sdk, host version ${HOST_VERSION}`, () => {
  test("describes every tool, pin included, each with its class", async () => {
    const description = await tools().describe!({}, { location }) as { methods: { name: string; class: string }[] }
    expect(Object.fromEntries(description.methods.map(method => [method.name, method.class]))).toEqual({
      search: "read",
      brief: "read",
      read: "read",
      sessions: "read",
      files: "read",
      recall: "read",
      sql: "read",
      events_list: "read",
      pin: "write",
    })
  })

  test("describe with a session reports each method's permission", async () => {
    const description = await tools().describe!({ sessionID: sessions.build! }, { location }) as { methods: { name: string; permission?: string }[] }
    const permission = Object.fromEntries(description.methods.map(method => [method.name, method.permission]))
    expect(permission).toMatchObject({ search: "allow", sql: "allow", pin: "ask" })
    const careful = await tools().describe!({ sessionID: sessions.careful! }, { location }) as { methods: { name: string; permission?: string }[] }
    expect(Object.fromEntries(careful.methods.map(method => [method.name, method.permission]))).toMatchObject({ sql: "ask", search: "allow" })
  })

  test("a known read runs as a session whose agent allows it, with no model turn, and returns the tool's output", async () => {
    const before = (await host.sdk.session.get({ sessionID: sessions.build! } as never) as { time?: unknown }).time
    const sql = await run("sql", sessions.build!, { sql: "select count(*) as n from v_sessions" })
    expect(sql.value, sql.message).toMatchObject({ columns: ["n"], rows: [[expect.any(Number)]], truncated: false })
    const listed = await run("sessions", sessions.build!, {})
    expect(listed.value).toMatchObject({ sessions: expect.any(Array), index: { source: "opencode-db" } })
    expect((await host.sdk.session.get({ sessionID: sessions.build! } as never) as { time?: unknown }).time).toEqual(before)
  })

  test("an agent deny, which hides the tools from the model, refuses every method", async () => {
    for (const method of ["search", "sql", "sessions"]) {
      expect(await run(method, sessions.locked!, method === "search" ? { query: "x" } : method === "sql" ? { sql: "select 1" } : {}), method).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
    }
  })

  test("an ask is refused at once, with no prompt left waiting", async () => {
    const started = Date.now()
    const result = await run("sql", sessions.careful!, { sql: "select 1" })
    expect(result).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
    expect(result.message).toMatch(/cannot answer/)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(await asked(sessions.careful!)).toEqual([])
    expect((await run("sessions", sessions.careful!, {})).value).toBeDefined()
  })

  test("applies the session's own rules after the agent's", async () => {
    expect((await run("search", sessions.narrow!, { query: "anything" })).value).toBeDefined()
    expect(await run("sql", sessions.narrow!, { sql: "select 1" })).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
  })

  test("an endless SQL statement is stopped with SQL_TIMEOUT, and the server keeps answering", async () => {
    const pending = run("sql", sessions.build!, { sql: "with recursive r(x) as (select 1 union all select x+1 from r) select count(*) from r" })
    await new Promise(resolve => setTimeout(resolve, 1000))
    const started = Date.now()
    expect((await run("sessions", sessions.build!, {})).value).toBeDefined()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(await pending).toMatchObject({ type: "failed", code: "SQL_TIMEOUT" })
  }, 30_000)

  test("names an unknown session with SESSION_UNKNOWN, and a session without an agent with SESSION_AGENT_REQUIRED", async () => {
    expect(await run("sessions", "ses_does_not_exist", {})).toMatchObject({ type: "failed", code: "SESSION_UNKNOWN" })
    expect(await run("sessions", sessions.agentless!, {})).toMatchObject({ type: "failed", code: "SESSION_AGENT_REQUIRED" })
  })

  test("a bad envelope is rpc.invalid_input, worded as every plugin's tools RPC words it", async () => {
    const raw = async (method: string, body: unknown): Promise<{ value?: unknown; type?: string; message?: string }> => {
      try {
        return { value: await tools()[method]!(body, { location }) }
      } catch (error) {
        const e = error as { type?: string; message?: string }
        return { type: e.type, message: e.message }
      }
    }
    expect(await raw("search", { operation: "x" })).toEqual({
      type: "rpc.invalid_input",
      message: ['"operation" is not allowed', '"sessionID" must be a non-empty string', '"input" is missing'].join("\n"),
    })
    expect(await raw("search", { sessionID: sessions.build, input: {}, extra: true })).toEqual({ type: "rpc.invalid_input", message: '"extra" is not allowed' })
    expect(await raw("describe", { sessionID: sessions.build, extra: true })).toEqual({ type: "rpc.invalid_input", message: '"extra" is not allowed' })
    expect((await raw("describe", {})).value).toBeDefined()
    expect((await raw("describe", { sessionID: sessions.build })).value).toBeDefined()
  })

  test("pin is a method: a write that would ask is refused before it runs, and runs when the session allows it", async () => {
    const refused = await run("pin", sessions.build!, { action: "list" })
    expect(refused).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
    expect(refused.message).toMatch(/would ask/)
    const allowed = await host.sdk.session.create({ location, title: "Pin", agent: "build", permissions: [{ action: "history_pin", resource: "*", effect: "allow" }] } as never)
    const pinned = await run("pin", allowed.id, { action: "list" })
    expect(pinned.value, pinned.message).toMatchObject({ pins: [] })
  })
})

/**
 * One host per `access` value, on the tools RPC path. `ask-changes` is the suite above, where `pin` is refused; here
 * `all` runs it with no prompt and `read-only` denies it, with no prompt and nothing written either way.
 */
describe(`access on the tools RPC, host version ${HOST_VERSION}`, () => {
  for (const [access, effect] of [["all", "allow"], ["read-only", "deny"]] as const) {
    let target: Awaited<ReturnType<typeof startHost>>
    beforeAll(async () => {
      // Each value gets its own host database and index, so its status reads a complete source.
      const db = join(root, `access-${access}.db`)
      target = await startHost([withOptions(plugin, { database: db, indexPath: join(root, `access-${access}`, "index.db"), access })], db)
      await waitFor(() => target.sdk.agent.list({ location }).then(() => true, () => false), 30_000, "the plugin to load")
    })
    afterAll(async () => { await target?.sdk.close() })

    test(`${access}: inserts its block, and a read still runs`, async () => {
      const open = {}
      const Tools = Rpc.define({ id: TOOLS_RPC_ID, methods: { describe: { input: open, output: open, errors: { failed: open } }, sessions: { input: open, output: open, errors: { failed: open } } }, events: {} })
      const rpc = target.sdk.rpc(Tools) as unknown as Record<string, (input: unknown, options: unknown) => Promise<unknown>>
      const session = (await target.sdk.session.create({ location, title: "Access", agent: "build" } as never)).id
      const agents = (await target.sdk.agent.list({ location })).data as { id: string; permissions: { action: string; resource: string; effect: string }[] }[]
      const build = agents.find(agent => agent.id === "build")!
      expect(build.permissions.slice(1, 1 + defaultRules(access).length)).toEqual(defaultRules(access))
      expect(await rpc.sessions!({ sessionID: session, input: {} }, { location })).toMatchObject({ sessions: expect.any(Array) })
      expect(await target.sdk.permission.list({ sessionID: session })).toEqual([])
      const status = (await target.sdk.rpc(History).status({}, { location })) as { access: string }
      expect(status.access).toBe(access)
    })

    test(`${access}: ${effect === "deny" ? "denies" : "runs"} pin, with no prompt`, async () => {
      const open = {}
      const Tools = Rpc.define({ id: TOOLS_RPC_ID, methods: { pin: { input: open, output: open, errors: { failed: open } } }, events: {} })
      const rpc = target.sdk.rpc(Tools) as unknown as Record<string, (input: unknown, options: unknown) => Promise<unknown>>
      const session = (await target.sdk.session.create({ location, title: "Pin", agent: "build" } as never)).id
      const answer = await rpc.pin!({ sessionID: session, input: { action: "list" } }, { location }).then(
        value => ({ value }),
        (error: { data?: { code?: string } }) => ({ code: error.data?.code }),
      )
      if (effect === "deny") expect(answer).toMatchObject({ code: "PERMISSION_DENIED" })
      else expect(answer).toMatchObject({ value: { pins: [] } })
      expect(await target.sdk.permission.list({ sessionID: session })).toEqual([])
    })
  }
})
