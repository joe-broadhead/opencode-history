// History's part of the tools RPC (src/host/tools-rpc.ts): its method table, its shapers, its error mapping and its
// probe, registered through the source contract's transport. The transport itself is the package's, whose own suites
// (the family's tools RPC and resolve suites, verbatim) run at the pinned tag.
import { describe, expect, test } from "vitest"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HistoryError } from "../../../src/domain/common.js"
import { PROBE_ACTION } from "../../../src/host/permissions.js"
import { NEXT_STEPS, PLUGIN_ID, pluginError, registerToolsRpc, scriptMethods, shapeInput, shapeResult, TOOLS_RPC_ID, type PluginMethod, type ToolCall } from "../../../src/host/tools-rpc.js"
import { ACTIONS, TOOL_NAMES } from "../../../src/host/tools.js"
import { fakeRuntime } from "../../host/runtime.js"
import { fakeSession } from "../../host/session.js"

type Handler = (input: unknown, context: { signal: AbortSignal; error: (type: string, message: string, data?: unknown) => unknown }) => Promise<any>
const LOCATION = join(tmpdir(), "history-tools-rpc")
const CLASSES = { search: "read", brief: "read", read: "read", sessions: "read", files: "read", recall: "read", sql: "read", events_list: "read", pin: "write", probe: "read" }

function methods(asserted: { action: string }[] = []) {
  const runtime = fakeRuntime(), session = fakeSession()
  const table = scriptMethods({ runtime, session: session.session, location: { projectID: "prj_app", directory: "/work/app" }, defaults: { scope: "project" }, assert: async (request) => void asserted.push(request) })
  return { runtime, table }
}

/** The package's registration over a narrow fake of the plugin context, with one session whose agent allows everything. */
async function registered(table: ReturnType<typeof methods>["table"]) {
  let handlers: Record<string, Handler> = {}
  const ctx = {
    location: { directory: LOCATION },
    rpc: { register: async (_contract: unknown, given: Record<string, Handler>) => ((handlers = given), { dispose: async () => {} }) },
    permission: { hook: async () => ({ dispose: async () => {} }) },
    session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, agent: "build", location: { directory: LOCATION } }) },
    agent: { get: async () => ({ data: { permissions: [{ action: "*", resource: "*", effect: "allow" }] } }) },
    tool: { list: async () => [] },
    mcp: { list: async () => ({ data: [] }) },
  }
  await registerToolsRpc(ctx as never, { methods: table })
  const context = { signal: new AbortController().signal, error: (type: string, message: string, data?: unknown) => ({ type, message, data }) }
  return (method: string, input: unknown) => handlers[method]!({ sessionID: "ses_1", input }, context)
}

describe("history's own block", () => {
  test("is history.sessions.tools: every tool is a method with its class, then probe, and only pin is direct-only", () => {
    expect([PLUGIN_ID, TOOLS_RPC_ID]).toEqual(["history.sessions", "history.sessions.tools"])
    const { table } = methods()
    expect(table.map((method) => method.name)).toEqual([...TOOL_NAMES, "probe"])
    expect(Object.fromEntries(table.map((method) => [method.name, method.class]))).toEqual(CLASSES)
    expect(table.filter((method) => method.directOnly).map((method) => method.name)).toEqual([...ACTIONS])
    for (const method of table) {
      expect(method).toMatchObject({ kind: "plugin", action: `history_${method.name}` })
      expect((method as PluginMethod).input).toMatchObject({ type: "object" })
      // `sessions` declares the list snapshot's answer beside the model tool's page, because the host validates a
      // method's answer against its declaration and the snapshot rides this method.
      if (method.name === "sessions") expect((method as PluginMethod).output).toMatchObject({ anyOf: [expect.objectContaining({ type: "object" }), expect.objectContaining({ type: "object" })] })
      else expect((method as PluginMethod).output).toMatchObject({ type: "object" })
    }
    expect(shapeInput("any", { q: 1 }, { sessionID: "s", agent: "a", action: "x" })).toEqual({ q: 1 })
    expect(shapeResult("any", { text: "t" }, { sessionID: "s", agent: "a", action: "x" })).toEqual({ text: "t" })
  })

  test("describe reports every method's class, pin and probe included", async () => {
    const call = await registered(methods().table)
    const description = await call("describe", undefined)
    expect(Object.fromEntries(description.methods.map((method: { name: string; class: string }) => [method.name, method.class]))).toEqual(CLASSES)
  })

  test("probe asserts history_probe, reads only the runtime's probe, and refuses a malformed input before it asserts", async () => {
    const asserted: { action: string }[] = []
    const { runtime, table } = methods(asserted)
    const probe = table.find((method) => method.name === "probe") as PluginMethod
    const call: ToolCall = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", signal: new AbortController().signal, progress: async () => {} }
    expect(await probe.run({ source: "sessions" }, call)).toEqual({ source: "sessions", account: "studio-mac", owner: { id: "os-user:sam@studio-mac", label: "sam on studio-mac" }, trust: "untrusted" })
    expect(asserted.map((request) => request.action)).toEqual([PROBE_ACTION])
    expect(runtime.calls.map((entry) => entry.method)).toEqual(["probe"])
    await expect(probe.run({ source: "sessions", extra: true }, call)).rejects.toMatchObject({ code: "INPUT_INVALID" })
    expect(asserted).toHaveLength(1)
  })

  test("gives a History failure its code and next step, and leaves any other error to the transport", () => {
    expect(pluginError(new HistoryError("CURSOR_INVALID"))).toEqual({ code: "CURSOR_INVALID", what: "The cursor is invalid or has expired.", next: "Repeat the call without cursor." })
    expect(pluginError(new Error("other"))).toBeUndefined()
    expect(Object.keys(NEXT_STEPS).sort()).toEqual(["CANCELLED", "PERMISSION_DENIED", "SESSION_AGENT_REQUIRED", "SESSION_UNKNOWN"])
  })
})
