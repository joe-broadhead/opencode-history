import { describe, expect, test, vi } from "vitest"
import { HOST_RANGE } from "../../../src/domain/hosts.js"
import { formatStatus } from "../../../src/host/format.js"
import {
  AGENT_FIX, CHANGING_ACTIONS, DEFAULT_RULES, defaultRules, evaluate, hasDefaultRules, insertDefaultRules, KNOWN_READS, NAMESPACE_ACTION, permissionRequest, registerDefaultRules, unguardedAgents, type Rule,
} from "../../../src/host/permissions.js"
import { ACCESS_VALUES } from "../../../src/domain/contract.js"
import { buildStatus } from "../../../src/host/status.js"
import { ACTIONS, READS, TOOL_NAMES } from "../../../src/host/tools.js"
import { fakeRuntime } from "../../host/runtime.js"

const BASE: Rule = { action: "*", resource: "*", effect: "allow" }
const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect })

describe("the default rules", () => {
  test("allow every tool and the namespace at the default access, so a tool a later version adds runs too", () => {
    const rules = [BASE, ...DEFAULT_RULES]
    for (const name of ["search", "read", "brief", "sessions", "files", "recall", "sql"]) expect(evaluate(rules, `history_${name}`), name).toBe("allow")
    expect(evaluate(rules, "history_pin")).toBe("allow")
    expect(evaluate(rules, "history_export")).toBe("allow")
    expect(evaluate(rules, "other_tool")).toBe("allow")
    // Broad first, narrow last, and every rule of the default value allows.
    expect(NAMESPACE_ACTION).toBe("history_*")
    expect(DEFAULT_RULES[0]).toEqual({ action: NAMESPACE_ACTION, resource: "*", effect: "allow" })
    expect(new Set(DEFAULT_RULES.map(rule => rule.effect))).toEqual(new Set(["allow"]))
    expect(defaultRules()).toEqual(DEFAULT_RULES)
  })

  test("follow the value at ask-changes and read-only, from the tool classes", () => {
    expect(ACCESS_VALUES).toEqual(["all", "ask-changes", "read-only"])
    expect([...CHANGING_ACTIONS]).toEqual(["history_pin"])
    for (const [access, effect] of [["ask-changes", "ask"], ["read-only", "deny"]] as const) {
      const block = defaultRules(access)
      expect(block[0], access).toEqual({ action: NAMESPACE_ACTION, resource: "*", effect })
      expect(block.at(-1), access).toEqual({ action: "history_pin", resource: "*", effect })
      const rules = [BASE, ...block]
      for (const name of ["search", "read", "brief", "sessions", "files", "recall", "sql"]) expect(evaluate(rules, `history_${name}`), `${access} ${name}`).toBe("allow")
      expect(evaluate(rules, "history_export"), access).toBe(effect)
      // A tool a later version adds is not in the block's exact names, so the namespace rule alone decides it.
      expect(evaluate(rules, "history_new_tool"), access).toBe(effect)
      // Every rule is either a read allowed or a change at the value.
      expect(block.filter(rule => rule.effect !== "allow").map(rule => rule.action), access).toEqual([NAMESPACE_ACTION, "history_pin"])
    }
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
    await registerDefaultRules({ transform: (async (fn: (editor: never) => void) => { callback = fn; return { dispose: async () => {} } }) as never }, "read-only")
    callback!({ list: () => [...agents.keys()].map(id => ({ id })), update: (id: string, fn: (info: { permissions: Rule[] }) => void) => fn(agents.get(id)!) } as never)
    expect(agents.get("build")!.permissions).toEqual([BASE, ...defaultRules("read-only")])
    expect(agents.get("explore")!.permissions).toEqual([rule("*", "deny")])
  })
})

describe("unguarded agents", () => {
  test("are the agents without the block that would run an unknown history tool without asking, at a restricting value", () => {
    const block = defaultRules("ask-changes")
    expect(unguardedAgents([
      { id: "build", permissions: [BASE, ...block] },
      { id: "custom", permissions: [BASE] },
      { id: "explore", permissions: [rule("*", "deny")] },
      { id: "careful", permissions: [BASE, rule("history_*", "ask")] },
    ], "ask-changes")).toEqual(["custom"])
    // At `all` nothing is held back, so no agent needs the fix.
    expect(unguardedAgents([{ id: "custom", permissions: [BASE] }])).toEqual([])
  })

  test("leave out an agent whose own rules end by asking or denying everything, as QA's probe agents do (LIVE-1)", () => {
    expect(unguardedAgents([
      { id: "probe", permissions: [BASE, rule("*", "ask")] },
      { id: "closed", permissions: [BASE, rule("*", "deny")] },
      { id: "smoke-bot", permissions: [BASE, rule("*", "allow")] },
    ], "read-only")).toEqual(["smoke-bot"])
  })

  test("are named in status with the block and the fix, at a restricting value", async () => {
    const block = defaultRules("ask-changes")
    const view = await buildStatus({
      version: "0.0.0", host: { version: "2.2.3", range: HOST_RANGE, tested: true },
      config: { database: "/d", indexPath: "/i", defaultScope: "project", access: "ask-changes" }, runtime: fakeRuntime(),
      agents: async () => [{ id: "build", permissions: [BASE, ...block] }, { id: "reviewer", permissions: [BASE] }],
    })
    expect(view).toMatchObject({ access: "ask-changes", unguardedAgents: ["reviewer"], permissionsBlock: block, nextStep: AGENT_FIX })
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
