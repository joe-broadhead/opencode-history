import type { IndexState } from "../domain/api.js"
import { FAILURES, type HistoryFailure } from "../domain/common.js"
import type { DefaultScope, ResolvedConfig } from "../domain/config.js"
import type { HostCheck } from "./compat.js"
import { AGENT_FIX, DEFAULT_RULES, unguardedAgents, type Rule } from "./permissions.js"
import { TOOL_NAMES } from "./tools.js"
import type { HistoryRuntime, IndexSchema, SourceFallback } from "./runtime.js"

/**
 * The Connection row, in the shared state words: `failed` when every query fails (an index at another schema) or the
 * history is partial (OpenCode's database could not be used), `host untested`, `connecting` while the first index
 * builds, otherwise `connected`.
 */
export type Connection = "connected" | "connecting" | "failed" | "host untested"

/** One status model for the history_status tool, the command, the RPC and the TUI. */
export interface StatusView {
  readonly version: string
  readonly host: HostCheck
  readonly connection: Connection
  readonly index: IndexState
  /** Why the history comes from the plugin session API; present only then. */
  readonly fallback?: SourceFallback
  /** The `history_*` tools OpenCode lists, and the names of any this version does not know. */
  readonly tools: { readonly visible: number; readonly unknown: readonly string[] }
  readonly database: string
  readonly indexPath: string
  readonly defaultScope: DefaultScope
  /** `model` is `provider/model`, or null for the host's default model. */
  readonly recall: { readonly synthesize: boolean; readonly model: string | null }
  /** Agents that miss the default permission block and would run every History tool without asking. */
  readonly unguardedAgents: readonly string[]
  /** The block to put first in each of those agents' own permissions; present when any is listed. */
  readonly permissionsBlock?: readonly Rule[]
  /** The index file's schema and this build's, present only when they differ, so every query fails with INDEX_MISMATCH. */
  readonly mismatch?: IndexSchema
  /** The single next step, present only when something needs the user. */
  readonly next?: string
}

/** Why history comes from the plugin session API, and the fix: the setup warning, and the status's next step. */
export function fallbackFailure(code: SourceFallback): HistoryFailure {
  const cause = code === "SOURCE_SCHEMA_UNKNOWN" ? "OpenCode's database has a layout this plugin version does not know" : "OpenCode's database could not be read"
  return { code, message: `${cause}, so history comes from the plugin session API, which keeps only the messages after each compaction.`, hint: FAILURES[code][1]! }
}

/** The first item that needs the user, from blocking problems down to ones that pass by themselves. */
export function nextStep(view: Pick<StatusView, "host" | "index" | "mismatch" | "unguardedAgents">, fallback?: SourceFallback) {
  if (view.host.next) return view.host.next
  if (view.mismatch) return FAILURES.INDEX_MISMATCH[1]
  if (view.index.source === "context") return FAILURES[fallback ?? "SOURCE_UNAVAILABLE"][1]
  if (view.unguardedAgents.length > 0) return AGENT_FIX
  if (!view.index.ready) return BUILDING
  return undefined
}

export const BUILDING = "Wait for the index to finish building, since until then results cover only the sessions indexed so far."

export function connection(view: Pick<StatusView, "host" | "index" | "mismatch">): Connection {
  if (view.mismatch || view.index.source === "context") return "failed"
  if (view.host.availability !== "AVAILABLE") return "host untested"
  return view.index.ready ? "connected" : "connecting"
}

export interface StatusSources {
  readonly version: string
  readonly host: HostCheck
  readonly config: Pick<ResolvedConfig, "database" | "indexPath" | "defaultScope" | "recall">
  readonly runtime: Pick<HistoryRuntime, "status" | "schema" | "fallback">
  /** The agents of the plugin's location, with their rules. */
  readonly agents: () => Promise<readonly { readonly id: string; readonly permissions: readonly Rule[] }[]>
  /** The tools OpenCode lists; omitted, the plugin's own are counted. */
  readonly tools?: () => Promise<readonly { readonly id: string }[]>
}

/** Tool names are listed only when they look like tool names. */
const SAFE_NAME = /^history_[a-z][a-z0-9_]{0,63}$/

export async function buildStatus({ version, host, config, runtime, agents, tools }: StatusSources): Promise<StatusView> {
  const known = new Set(TOOL_NAMES.map(name => `history_${name}`))
  const [index, schema, listed, ids] = await Promise.all([
    runtime.status(), runtime.schema(), agents(), tools ? tools().then(list => list.map(tool => tool.id)) : Promise.resolve([...known]),
  ])
  const unguarded = unguardedAgents(listed)
  const ours = ids.filter(id => id.startsWith("history_"))
  const { model } = config.recall
  const base = { host, index, ...schema.file !== schema.build ? { mismatch: schema } : {} }
  const view = {
    version, host, connection: connection(base), index,
    ...index.source === "context" ? { fallback: runtime.fallback ?? "SOURCE_UNAVAILABLE" as const } : {},
    tools: { visible: ours.length, unknown: ours.filter(id => !known.has(id)).filter(id => SAFE_NAME.test(id)).slice(0, 20) },
    database: config.database,
    indexPath: config.indexPath,
    defaultScope: config.defaultScope,
    recall: { synthesize: config.recall.synthesize, model: model ? `${model.providerID}/${model.id}` : null },
    unguardedAgents: unguarded,
    ...unguarded.length ? { permissionsBlock: DEFAULT_RULES.map(rule => ({ ...rule })) } : {},
    ...schema.file !== schema.build ? { mismatch: schema } : {},
  }
  const next = nextStep(view, runtime.fallback)
  return { ...view, ...next ? { next } : {} }
}
