import type { Plugin } from "@opencode/plugin"
import type { Access } from "../domain/contract.js"

/**
 * The default permission block. `ctx.agent.transform` inserts it right after each agent's base `* * allow`, broad
 * first, so the last matching rule wins:
 *
 * - `history_*` takes the effect `access` asks for: at `all` it allows the namespace, so a tool a later version adds
 *   runs at once; `ask-changes` asks for it and `read-only` denies it;
 * - the known reads (`READ_TOOLS`) are allowed again by exact name, so they never prompt;
 * - `history_pin`, the one tool that changes something (the current session's instructions), takes the same effect.
 *
 * Every later rule (agent denies, the user's `permissions`, saved approvals) still wins. Each tool also asserts its
 * action on every call, so an `ask` rule prompts: the host itself only hides a plugin tool on a deny.
 */

export interface Rule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

/** The tools that only read the index, OpenCode's database or the plugin's state. */
export const READ_TOOLS = ["search", "read", "brief", "sessions", "files", "recall", "sql"] as const
export const KNOWN_READS: readonly string[] = READ_TOOLS.map(name => `history_${name}`)

/** The plugin's namespace: a tool a later version adds follows the same effect, so `all` means everything. */
export const NAMESPACE_ACTION = "history_*"

/** The actions that change something: `history_pin` writes to the current session's instructions. */
export const CHANGING_ACTIONS = ["history_pin"] as const

/** The block for this `access` value. */
export function defaultRules(access: Access = "all"): readonly Rule[] {
  const other: Rule["effect"] = access === "all" ? "allow" : access === "ask-changes" ? "ask" : "deny"
  return [
    { action: NAMESPACE_ACTION, resource: "*", effect: other },
    ...KNOWN_READS.map((action): Rule => ({ action, resource: "*", effect: "allow" })),
    ...CHANGING_ACTIONS.map((action): Rule => ({ action, resource: "*", effect: other })),
  ]
}

/** The block for the default access, `all`: every tool History registers. */
export const DEFAULT_RULES: readonly Rule[] = defaultRules("all")

/**
 * The fix for agents that miss the inserted block: the block first in each agent's own `permissions`, then the user's
 * top-level History rules again, because an agent's own rules come after the top-level ones. The top-level
 * `permissions` are no fix: they come after Explore's `* * deny` too, so they would loosen Explore.
 */
export const AGENT_FIX =
  "Put the default rules shown by /history-status first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for History tools."

const BASE_ALLOW: Rule = { action: "*", resource: "*", effect: "allow" }
const same = (a: Rule, b: Rule) => a.action === b.action && a.resource === b.resource && a.effect === b.effect

/**
 * True when the block appears, in one piece, anywhere after the agent's first base allow. Other plugins insert their
 * blocks at the same place, so it need not come first.
 */
export function hasDefaultRules(rules: readonly Rule[], access: Access = "all"): boolean {
  const base = rules.findIndex(rule => same(rule, BASE_ALLOW))
  if (base === -1) return false
  const block = defaultRules(access)
  return rules.some((_, start) => start > base && block.every((rule, offset) => {
    const candidate = rules[start + offset]
    return candidate !== undefined && same(candidate, rule)
  }))
}

/**
 * Inserts the block right after the agent's first base allow, once. An agent without a base allow gets nothing: there,
 * unlisted tools are not allowed anyway, and the block's `ask` or `allow` would loosen a default deny.
 */
export function insertDefaultRules(rules: Rule[], access: Access = "all"): void {
  const base = rules.findIndex(rule => same(rule, BASE_ALLOW))
  if (base === -1 || hasDefaultRules(rules, access)) return
  rules.splice(base + 1, 0, ...defaultRules(access).map(rule => ({ ...rule })))
}

/** Host wildcards: `*` matches any run of characters and `?` one character, over the whole string. */
const matches = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(value)

/** The effect of `rules` for `action` on resource `*`: the last matching rule wins, and no match asks. */
export function evaluate(rules: readonly Rule[], action: string): Rule["effect"] {
  for (let at = rules.length - 1; at >= 0; at--) {
    const rule = rules[at]!
    if (matches(rule.action, action) && matches(rule.resource, "*")) return rule.effect
  }
  return "ask"
}

/**
 * Agents that miss the block and would run any `history_*` tool, `history_pin` and future ones included, without
 * asking. An agent whose rules already decide unknown History tools another way is not listed. At `all` nothing is
 * held back, so no agent needs the fix.
 */
export function unguardedAgents(agents: readonly { readonly id: string; readonly permissions: readonly Rule[] }[], access: Access = "all"): string[] {
  if (access === "all") return []
  return agents.filter(agent => !hasDefaultRules(agent.permissions, access) && evaluate(agent.permissions, "history_unknown") === "allow").map(agent => agent.id)
}

export function registerDefaultRules(agent: Pick<Plugin.Context["agent"], "transform">, access: Access = "all") {
  return agent.transform(editor => {
    for (const { id } of editor.list()) editor.update(id, info => insertDefaultRules(info.permissions as Rule[], access))
  })
}

/** A model's tool call in a session. */
export interface ToolCall {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
}
export type Call = ToolCall

export interface PermissionRequest {
  readonly sessionID: string
  readonly agent: string
  readonly action: string
  readonly resources: string[]
  readonly save: string[]
  readonly metadata: Record<string, unknown>
  readonly source: { readonly type: "tool"; readonly messageID: string; readonly id: string }
}
export type Assert = (request: PermissionRequest) => Promise<void>

/** The assert for one call of `action`, on resource `*`, so "Always" allows the tool for the session. */
export function permissionRequest(call: Call, action: string, metadata: Record<string, unknown> = {}): PermissionRequest {
  return { sessionID: call.sessionID, agent: call.agent, action, resources: ["*"], save: ["*"], metadata, source: { type: "tool", messageID: call.messageID, id: call.id } }
}
