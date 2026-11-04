import { describe, expect, test } from "vitest"
import { HOST_RANGE } from "../../../src/host/compat.js"
import { SCRIPT_MARK } from "../../../src/host/permissions.js"
import { EXCLUDED, registerScripting, sessionNotFound, TOOLS_RPC_ID, UNATTENDED } from "../../../src/host/scripting.js"
import { ACTIONS, TOOL_NAMES } from "../../../src/host/tools.js"
import { buildStatus } from "../../../src/host/status.js"
import { failure, fakeRuntime } from "../../host/runtime.js"
import { SAMPLES } from "../../host/samples.js"
import { fakeSession } from "../../host/session.js"

type Handler = (input: unknown, context: ReturnType<typeof rpcContext>) => Promise<unknown>
type Evaluation = { action: string; effect: "allow" | "deny" | "ask"; metadata?: Record<string, unknown>; message?: string }
type Request = Record<string, unknown> & { action: string; metadata: Record<string, unknown> }

interface SetupOptions {
  /** Sessions the host knows, with their agents. */
  sessions?: Record<string, { agent?: string }>
  /** The host's answer to each assert; resolves by default. */
  assert?: (request: Request) => Promise<void>
  /** Replaces the session lookup, for host failures other than "not found". */
  lookup?: (sessionID: string) => Promise<unknown>
}

async function setup(options: SetupOptions = {}) {
  const runtime = fakeRuntime(), session = fakeSession()
  const sessions = options.sessions ?? { ses_1: { agent: "build" } }
  const handlers: Record<string, Handler> = {}
  const asserts: Request[] = []
  const disposed: string[] = []
  let contract: { id: string; methods: Record<string, unknown> } | undefined
  let hook: ((evaluation: Evaluation) => void) | undefined
  const ctx = {
    rpc: {
      register: async (definition: typeof contract, registered: Record<string, Handler>) => {
        contract = definition
        Object.assign(handlers, registered)
        return { dispose: async () => { disposed.push("rpc") } }
      },
    },
    permission: {
      assert: async (request: Request) => {
        asserts.push(request)
        await options.assert?.(request)
      },
      hook: async (name: string, callback: (evaluation: Evaluation) => void) => {
        expect(name).toBe("evaluate")
        hook = callback
        return { dispose: async () => { disposed.push("hook") } }
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (options.lookup) return options.lookup(sessionID)
        const known = sessions[sessionID]
        // OpenCode rejects with its tagged Session.NotFoundError.
        if (!known) throw Object.assign(new Error(`Session not found: ${sessionID}`), { _tag: "Session.NotFoundError", sessionID })
        return { id: sessionID, ...known }
      },
    },
  }
  const status = () => buildStatus({ version: "0.0.0", host: { version: "2.2.3", range: HOST_RANGE, tested: true }, config: { database: "/d", indexPath: "/i", defaultScope: "project", recall: { synthesize: false } }, runtime, agents: async () => [] })
  const stop = await registerScripting(ctx as never, { runtime, session: session.session, status, location: { projectID: "prj_app", directory: "/work/app" }, defaults: { scope: "project", synthesize: false } })
  return { runtime, session, contract: contract!, handlers, asserts, hook: hook!, disposed, stop }
}

function rpcContext(signal = new AbortController().signal) {
  return { signal, error: (type: string, message: string, data?: unknown) => ({ type, message, data, handlerError: true }) }
}
const call = (h: Awaited<ReturnType<typeof setup>>, method: string, input: unknown, sessionID = "ses_1", context = rpcContext()) => h.handlers[method]!({ sessionID, input }, context)

describe("tools RPC contract", () => {
  test("has describe and every tool but the actions, under history.sessions.tools", async () => {
    const h = await setup()
    expect(h.contract.id).toBe(TOOLS_RPC_ID)
    expect(TOOLS_RPC_ID).toBe("history.sessions.tools")
    expect(Object.keys(h.contract.methods)).toEqual(["describe", "search", "brief", "read", "sessions", "files", "recall", "sql", "status"])
    expect(h.handlers.pin).toBeUndefined()
  })

  test("excludes the actions by name, so a tool that changes a session never becomes a method", async () => {
    const h = await setup()
    expect([...EXCLUDED]).toEqual([...ACTIONS])
    for (const name of TOOL_NAMES) expect(Object.hasOwn(h.contract.methods, name), name).toBe(!ACTIONS.has(name))
  })

  test("checks the envelope with the shared wording, one message per problem (INSTALL-12)", async () => {
    const h = await setup()
    type Validated = { value?: unknown; issues?: { message: string }[] }
    const validate = (method: string, value: unknown) =>
      ((h.contract.methods as Record<string, { input: Record<string, any> }>)[method]!.input["~standard"].validate(value)) as Validated
    const messages = (method: string, value: unknown) => validate(method, value).issues?.map(issue => issue.message) ?? []
    expect(messages("search", "nope")).toEqual([`the envelope must be an object, such as {"sessionID":"<session>","input":<the tool's input>}`])
    expect(messages("search", { operation: "x", params: {} })).toEqual([`"operation" is not allowed`, `"params" is not allowed`, `"sessionID" must be a non-empty string`, `"input" is missing`])
    expect(messages("search", { sessionID: "", input: {} })).toEqual([`"sessionID" must be a non-empty string`])
    expect(messages("search", { sessionID: "ses_1", input: {}, extra: 1 })).toEqual([`"extra" is not allowed`])
    expect(validate("search", { sessionID: "ses_1", input: { query: "x" } })).toEqual({ value: { sessionID: "ses_1", input: { query: "x" } } })
    expect(messages("describe", { sessionID: "ses_1" })).toEqual(["describe takes no input"])
    for (const empty of [undefined, null, {}]) expect(validate("describe", empty).issues, String(empty)).toBeUndefined()
    // The validator is hidden: the contract still reads as plain JSON Schema.
    const search = (h.contract.methods as Record<string, { input: object }>)["search"]!.input
    expect(Object.keys(search)).toEqual(["type", "properties", "required", "additionalProperties"])
    expect(JSON.stringify(search)).not.toContain("standard")
  })

  test("describes each method's action and its input and output as JSON Schema", async () => {
    const h = await setup()
    const description = await h.handlers.describe!({}, rpcContext()) as { id: string; call: string; methods: Record<string, any>[] }
    expect(description.id).toBe(TOOLS_RPC_ID)
    expect(description.call).toContain(`/api/rpc/${TOOLS_RPC_ID}/<method>`)
    expect(description.methods.map(method => [method.name, method.action])).toEqual(
      ["search", "brief", "read", "sessions", "files", "recall", "sql", "status"].map(name => [name, `history_${name}`]))
    const search = description.methods.find(method => method.name === "search")!
    expect(search.input).toMatchObject({ type: "object", required: ["query"] })
    expect(search.output).toMatchObject({ type: "object", properties: { results: { type: "array" } } })
  })
})

describe("tools RPC calls", () => {
  test("run the tool as the session and its agent, with the script mark and no source, and return its output", async () => {
    const h = await setup()
    expect(await call(h, "search", { query: "login" })).toEqual(SAMPLES.search)
    expect(h.asserts).toEqual([{ sessionID: "ses_1", agent: "build", action: "history_search", resources: ["*"], save: ["*"], metadata: { [SCRIPT_MARK]: true } }])
    expect(h.runtime.calls[0]).toMatchObject({ method: "search", caller: { sessionID: "ses_1", projectID: "prj_app", directory: "/work/app" }, input: { query: "login", scope: "project", limit: 10 } })
    expect(await call(h, "status", {})).toMatchObject({ version: "0.0.0", unguardedAgents: 0 })
  })

  test("a refused assert is PERMISSION_DENIED, and the tool does not run", async () => {
    const h = await setup({ assert: async () => { throw Object.assign(new Error("Permission denied: history_sql"), { _tag: "Tool.Error" }) } })
    expect(await call(h, "sql", { sql: "select 1" })).toEqual({
      type: "failed", handlerError: true,
      message: "PERMISSION_DENIED: history_sql was refused for this session's agent: Permission denied: history_sql. Next step: Add an allow rule for the tool's action to that agent, or call as a session whose agent allows it.",
      data: { code: "PERMISSION_DENIED", next: "Add an allow rule for the tool's action to that agent, or call as a session whose agent allows it." },
    })
    expect(h.runtime.calls).toEqual([])
  })

  test("an unknown session is SESSION_UNKNOWN, a session without an agent SESSION_AGENT_REQUIRED, and other lookup failures propagate", async () => {
    const h = await setup({ sessions: { ses_bare: {} } })
    expect(await call(h, "search", { query: "x" }, "ses_missing")).toMatchObject({ type: "failed", data: { code: "SESSION_UNKNOWN" } })
    expect(await call(h, "search", { query: "x" }, "ses_bare")).toMatchObject({ type: "failed", data: { code: "SESSION_AGENT_REQUIRED" } })
    const broken = await setup({ lookup: async () => { throw new Error("database is locked") } })
    await expect(call(broken, "search", { query: "x" })).rejects.toThrow("database is locked")
    expect(sessionNotFound({ status: 404 })).toBe(true)
    expect(sessionNotFound(new Error("other"))).toBe(false)
  })

  test("bad tool input is INPUT_INVALID, naming fields and never values", async () => {
    const h = await setup()
    const answer = await call(h, "search", { query: "secret-query", limit: 0 })
    expect(answer).toMatchObject({ type: "failed", data: { code: "INPUT_INVALID" } })
    expect(JSON.stringify(answer)).not.toContain("secret")
  })

  test("a query failure answers with its code and next step", async () => {
    const h = await setup()
    h.runtime.failures.set("brief", failure("SESSION_NOT_FOUND", "No indexed session has that ID.", "Find the session ID with history_search or history_sessions."))
    expect(await call(h, "brief", { sessionID: "ses_gone" })).toMatchObject({ type: "failed", data: { code: "SESSION_NOT_FOUND", next: "Find the session ID with history_search or history_sessions." } })
  })

  test("a cancelled call is CANCELLED and runs nothing", async () => {
    const h = await setup()
    const controller = new AbortController()
    controller.abort()
    expect(await call(h, "search", { query: "x" }, "ses_1", rpcContext(controller.signal))).toMatchObject({ type: "failed", data: { code: "CANCELLED" } })
    expect(h.runtime.calls).toEqual([])
  })
})

describe("the evaluate hook", () => {
  test("turns an ask on this plugin's script call into a deny, and touches nothing else", async () => {
    const h = await setup()
    const scripted: Evaluation = { action: "history_sql", effect: "ask", metadata: { [SCRIPT_MARK]: true } }
    h.hook(scripted)
    expect(scripted).toMatchObject({ effect: "deny", message: UNATTENDED })
    for (const evaluation of [
      { action: "history_pin", effect: "ask" as const, metadata: {} },
      { action: "gws.read", effect: "ask" as const, metadata: { [SCRIPT_MARK]: true } },
      { action: "history_sql", effect: "allow" as const, metadata: { [SCRIPT_MARK]: true } },
      { action: "history_sql", effect: "deny" as const, metadata: { [SCRIPT_MARK]: true } },
    ]) {
      const before = { ...evaluation }
      h.hook(evaluation)
      expect(evaluation).toEqual(before)
    }
  })

  test("is disposed with the registration", async () => {
    const h = await setup()
    await h.stop()
    expect(h.disposed).toEqual(["hook", "rpc"])
  })
})
