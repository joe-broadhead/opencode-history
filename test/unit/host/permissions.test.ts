import { describe, expect, test, vi } from "vitest"
import { HOST_RANGE } from "../../../src/domain/hosts.js"
import { formatStatus } from "../../../src/host/format.js"
import {
  AGENT_FIX, DEFAULT_RULES, evaluate, hasDefaultRules, insertDefaultRules, KNOWN_READS, permissionRequest, registerDefaultRules, unguardedAgents, type Rule,
} from "../../../src/host/permissions.js"
import { buildStatus } from "../../../src/host/status.js"
import { ACTIONS, READS, TOOL_NAMES } from "../../../src/host/tools.js"
import { fakeRuntime } from "../../host/runtime.js"

const BASE: Rule = { action: "*", resource: "*", effect: "allow" }
const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect })

describe("the default rules", () => {
  test("allow the known reads, ask for history_pin and any unknown history tool", () => {
    const rules = [BASE, ...DEFAULT_RULES]
    for (const name of ["search", "read", "brief", "sessions", "files", "recall", "sql"]) expect(evaluate(rules, `history_${name}`), name).toBe("allow")
    expect(evaluate(rules, "history_pin")).toBe("ask")
    expect(evaluate(rules, "history_export")).toBe("ask")
    expect(evaluate(rules, "other_tool")).toBe("allow")
  })

  test("cover every tool: the reads are allowed and every other tool is an action that asks", () => {
    expect(new Set([...READS, ...ACTIONS])).toEqual(new Set(TOOL_NAMES))
    for (const name of READS) expect(ACTIONS.has(name)).toBe(false)
    expect([...KNOWN_READS].sort()).toEqual([...READS].map(name => `history_${name}`).sort())
    expect([...ACTIONS]).toEqual(["pin"])
  })

  test("go right after the first base allow, once, and never into an agent without one", () => {
    const rules = [rule("read", "allow"), BASE, rule("history_sql", "deny")]
    insertDefaultRules(rules)
    expect(rules).toEqual([rule("read", "allow"), BASE, ...DEFAULT_RULES, rule("history_sql", "deny")])
    // A later deny still wins.
    expect(evaluate(rules, "history_sql")).toBe("deny")
    insertDefaultRules(rules)
    expect(rules).toHaveLength(DEFAULT_RULES.length + 3)
    const explore = [rule("*", "deny"), rule("read", "allow")]
    insertDefaultRules(explore)
    expect(explore).toEqual([rule("*", "deny"), rule("read", "allow")])
  })

  test("count as present anywhere after the base allow, as another plugin's block may come first", () => {
    const other = [rule("tavily_*", "ask"), rule("tavily_tavily_search", "allow")]
    expect(hasDefaultRules([BASE, ...other, ...DEFAULT_RULES])).toBe(true)
    expect(hasDefaultRules([...DEFAULT_RULES, BASE])).toBe(false)
    expect(hasDefaultRules([BASE, ...DEFAULT_RULES.slice(1)])).toBe(false)
    const rules = [BASE, ...other, ...DEFAULT_RULES]
    insertDefaultRules(rules)
    expect(rules).toHaveLength(1 + other.length + DEFAULT_RULES.length)
  })

  test("are inserted for every agent by the agent transform", async () => {
    const agents = new Map<string, { permissions: Rule[] }>([["build", { permissions: [BASE] }], ["explore", { permissions: [rule("*", "deny")] }]])
    let callback: ((editor: never) => void) | undefined
    await registerDefaultRules({ transform: (async (fn: (editor: never) => void) => { callback = fn; return { dispose: async () => {} } }) as never })
    callback!({ list: () => [...agents.keys()].map(id => ({ id })), update: (id: string, fn: (info: { permissions: Rule[] }) => void) => fn(agents.get(id)!) } as never)
    expect(agents.get("build")!.permissions).toEqual([BASE, ...DEFAULT_RULES])
    expect(agents.get("explore")!.permissions).toEqual([rule("*", "deny")])
  })
})

describe("unguarded agents", () => {
  test("are the agents without the block that would run an unknown history tool without asking", () => {
    expect(unguardedAgents([
      { id: "build", permissions: [BASE, ...DEFAULT_RULES] },
      { id: "custom", permissions: [BASE] },
      { id: "explore", permissions: [rule("*", "deny")] },
      { id: "careful", permissions: [BASE, rule("history_*", "ask")] },
    ])).toEqual(["custom"])
  })

  test("leave out an agent whose own rules end by asking or denying everything, as QA's probe agents do (LIVE-1)", () => {
    expect(unguardedAgents([
      { id: "probe", permissions: [BASE, rule("*", "ask")] },
      { id: "closed", permissions: [BASE, rule("*", "deny")] },
      { id: "smoke-bot", permissions: [BASE, rule("*", "allow")] },
    ])).toEqual(["smoke-bot"])
  })

  test("are named in status with the block and the fix", async () => {
    const view = await buildStatus({
      version: "0.0.0", host: { version: "2.2.3", range: HOST_RANGE, tested: true },
      config: { database: "/d", indexPath: "/i", defaultScope: "project" }, runtime: fakeRuntime(),
      agents: async () => [{ id: "build", permissions: [BASE, ...DEFAULT_RULES] }, { id: "reviewer", permissions: [BASE] }],
    })
    expect(view).toMatchObject({ unguardedAgents: ["reviewer"], permissionsBlock: DEFAULT_RULES, nextStep: AGENT_FIX })
    const text = formatStatus(view)
    expect(text).toContain("\nAgents without default rules: reviewer\n  [\n    {\"action\":\"history_*\",\"resource\":\"*\",\"effect\":\"ask\"},\n")
    expect(text.split("\n").at(-1)).toBe("Next step: Put the default rules shown by /history-status first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for History tools.")
  })
})

describe("permission requests", () => {
  test("a tool call carries its own source", () => {
    expect(permissionRequest({ sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" }, "history_pin", { pin: "put" })).toEqual({
      sessionID: "ses_1", agent: "build", action: "history_pin", resources: ["*"], save: ["*"], metadata: { pin: "put" }, source: { type: "tool", messageID: "msg_1", id: "call_1" },
    })
  })

  test("are asserted before every tool runs, so a refusal stops the call", async () => {
    const { toolTransform } = await import("../../../src/host/tools.js")
    const { fakeSession } = await import("../../host/session.js")
    const runtime = fakeRuntime(), session = fakeSession()
    const assert = vi.fn(async (request: { action: string }) => { if (request.action === "history_pin") throw Object.assign(new Error("Permission denied: history_pin"), { _tag: "Tool.Error" }) })
    const added: { name: string; input: { parse(v: unknown): unknown }; execute(input: unknown, context: object): Promise<unknown> }[] = []
    toolTransform({ runtime, session: session.session, location: { projectID: "prj", directory: "/w" }, defaults: { scope: "project" }, assert })(
      { namespace: () => {}, add: (tool: never) => { added.push(tool) } } as never)
    const context = { sessionID: "ses_now", agent: "build", messageID: "msg_1", id: "call_1", signal: new AbortController().signal, progress: async () => {} }
    const pin = added.find(tool => tool.name === "pin")!
    await expect(pin.execute(pin.input.parse({ sessionID: "ses_old" }), context)).rejects.toMatchObject({ _tag: "Tool.Error" })
    expect(session.store.get("ses_now")).toBeUndefined()
    expect(assert).toHaveBeenCalledWith(expect.objectContaining({ action: "history_pin", metadata: { pin: "put", pinned: "ses_old" } }))
    const sql = added.find(tool => tool.name === "sql")!
    await sql.execute(sql.input.parse({ sql: "select 1" }), context)
    expect(assert).toHaveBeenLastCalledWith(expect.objectContaining({ action: "history_sql", metadata: {} }))
    expect(runtime.calls.map(call => call.method)).toEqual(["sql"])
  })
})
