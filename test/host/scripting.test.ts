// The tools RPC through the embedded host: a script calls History as a session, under that session's agent and its
// session rules, with no model. The agents are config-only, so they carry exactly the rules below.
import { HOST_VERSION, project, removeRoot, root, startHost, waitFor, withOptions } from "./harness.js"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { join } from "node:path"
import { Rpc } from "@opencode/plugin/rpc"
import type { Plugin } from "@opencode/plugin"
import plugin from "../../src/index.js"
import { TOOLS_RPC_ID } from "../../src/host/scripting.js"
import { TOOL_NAMES } from "../../src/host/tools.js"

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
  host = await startHost([withOptions(plugin, { database, indexPath }), observer], database, HOST_VERSION, {
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
  test("describes every tool but history_pin", async () => {
    const description = await tools().describe!({}, { location }) as { methods: { name: string; action: string }[] }
    expect(description.methods.map(method => method.name)).toEqual(["search", "brief", "read", "sessions", "files", "recall", "sql", "status"])
  })

  test("a known read runs as a session whose agent allows it, with no model turn, and returns the tool's output", async () => {
    const before = (await host.sdk.session.get({ sessionID: sessions.build! } as never) as { time?: unknown }).time
    const sql = await run("sql", sessions.build!, { sql: "select count(*) as n from v_sessions" })
    expect(sql.value, sql.message).toMatchObject({ columns: ["n"], rows: [[expect.any(Number)]], truncated: false })
    const status = await run("status", sessions.build!, {})
    expect(status.value).toMatchObject({ connection: expect.stringMatching(/^(connected|connecting)$/), unguardedAgents: expect.any(Number) })
    expect((await host.sdk.session.get({ sessionID: sessions.build! } as never) as { time?: unknown }).time).toEqual(before)
  })

  test("an agent deny, which hides the tools from the model, refuses every method", async () => {
    for (const method of ["search", "sql", "status"]) {
      expect(await run(method, sessions.locked!, method === "search" ? { query: "x" } : method === "sql" ? { sql: "select 1" } : {}), method).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
    }
  })

  test("an ask is refused at once, with no prompt left waiting", async () => {
    const started = Date.now()
    const result = await run("sql", sessions.careful!, { sql: "select 1" })
    expect(result).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
    expect(result.message).toMatch(/cannot answer an approval prompt/)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(await asked(sessions.careful!)).toEqual([])
    expect((await run("status", sessions.careful!, {})).value).toBeDefined()
  })

  test("applies the session's own rules after the agent's", async () => {
    expect((await run("search", sessions.narrow!, { query: "anything" })).value).toBeDefined()
    expect(await run("sql", sessions.narrow!, { sql: "select 1" })).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
  })

  test("an endless SQL statement is stopped with SQL_TIMEOUT, and the server keeps answering", async () => {
    const pending = run("sql", sessions.build!, { sql: "with recursive r(x) as (select 1 union all select x+1 from r) select count(*) from r" })
    await new Promise(resolve => setTimeout(resolve, 1000))
    const started = Date.now()
    expect((await run("status", sessions.build!, {})).value).toBeDefined()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(await pending).toMatchObject({ type: "failed", code: "SQL_TIMEOUT" })
  }, 30_000)

  test("names an unknown session with SESSION_UNKNOWN, and a session without an agent with SESSION_AGENT_REQUIRED", async () => {
    expect(await run("status", "ses_does_not_exist", {})).toMatchObject({ type: "failed", code: "SESSION_UNKNOWN" })
    expect(await run("status", sessions.agentless!, {})).toMatchObject({ type: "failed", code: "SESSION_AGENT_REQUIRED" })
  })

  test("has no pin method", async () => {
    const result = await run("pin", sessions.build!, { action: "list" })
    expect(result.value).toBeUndefined()
    expect(result.type).not.toBe("failed")
    expect(result.message).toMatch(/not.?found|unknown/i)
  })
})
