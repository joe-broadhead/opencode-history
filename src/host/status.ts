import type { IndexState } from "../domain/api.js"
import { FAILURES, type HistoryFailure } from "../domain/common.js"
import type { DefaultScope, ResolvedConfig } from "../domain/config.js"
import type { HostCheck } from "./compat.js"
import { NOTHING_TO_DO } from "./format.js"
import { AGENT_FIX, DEFAULT_RULES, unguardedAgents, type Rule } from "./permissions.js"
import { TOOL_NAMES } from "./tools.js"
import type { HistoryRuntime, IndexSchema, SourceFallback } from "./runtime.js"

/**
 * The state, in the shared machine words (S13): `failed` when every query fails (an index at another schema) or the
 * history is partial (OpenCode's database could not be used), `connecting` while the first index builds, otherwise
 * `ready`: History has no service to connect to. The Connection row shows it in the S9 words. History has no
 * status-only mode, which is what `host_untested` means: outside the range it does not start at all, unless
 * `allowUntestedHost` is set, and then it works normally. An untested host shows in `host.tested` and the OpenCode row.
 */
export type State = "ready" | "connecting" | "failed"

/** One status model for the history_status tool, the command, the RPC and the TUI. */
export interface StatusView {
  /** The plugin's version. */
  readonly version: string
  /** The OpenCode version, the supported range, and whether the version is a tested one. */
  readonly host: { readonly version: string | null; readonly range: string; readonly tested: boolean }
  readonly state: State
  readonly index: IndexState
  /** Why the history comes from the plugin session API; present only then. */
  readonly fallback?: SourceFallback
  /** The `history_*` tools OpenCode lists, and the names of any this version does not know. */
  readonly tools: { readonly visible: number; readonly unknown: readonly string[] }
  readonly database: string
  readonly indexPath: string
  /** The index file's size with its write-ahead log, in bytes; null when it cannot be read. */
  readonly indexBytes: number | null
  /** True when the mask options changed after text was stored, so the index file holds it masked the old way until a rebuild. */
  readonly masksChanged: boolean
  readonly defaultScope: DefaultScope
  /** `model` is `provider/model`, or null for the host's default model. */
  readonly recall: { readonly synthesize: boolean; readonly model: string | null }
  /** Agents that miss the default permission block and would run every History tool without asking. */
  readonly unguardedAgents: readonly string[]
  /** The block to put first in each of those agents' own permissions; present when any is listed. */
  readonly permissionsBlock?: readonly Rule[]
  /** The index file's schema and this build's, present only when they differ, so every query fails with INDEX_MISMATCH. */
  readonly mismatch?: IndexSchema
  /** The single next step, exactly the Next step row: `Nothing to do.` when nothing is needed. */
  readonly nextStep: string
}

/** Why history comes from the plugin session API, and the fix: the setup warning, and the status's next step. */
export function fallbackFailure(code: SourceFallback): HistoryFailure {
  const cause = code === "SOURCE_SCHEMA_UNKNOWN" ? "OpenCode's database has a layout this plugin version does not know" : "OpenCode's database could not be read"
  return { code, message: `${cause}, so history comes from the plugin session API, which keeps only the messages after each compaction.`, hint: FAILURES[code][1]! }
}

/** The first item that needs the user, from blocking problems down to ones that pass by themselves; `Nothing to do.` otherwise. */
export function nextStep(host: HostCheck, view: Pick<StatusView, "index" | "mismatch" | "unguardedAgents" | "masksChanged">, fallback?: SourceFallback): string {
  if (host.next) return host.next
  if (view.mismatch) return FAILURES.INDEX_MISMATCH[1]!
  if (view.index.source === "context") return FAILURES[fallback ?? "SOURCE_UNAVAILABLE"][1]!
  if (view.masksChanged) return MASKS_CHANGED
  if (view.unguardedAgents.length > 0) return AGENT_FIX
  if (!view.index.ready) return BUILDING
  return NOTHING_TO_DO
}

export const MASKS_CHANGED =
  "Run /history-reindex rebuild, since the mask options changed after text was indexed: results are masked with the new patterns, but the index file still holds that text masked the old way."

export const BUILDING = "Wait for the index to finish building, since until then results cover only the sessions indexed so far."

export function stateOf(view: Pick<StatusView, "index" | "mismatch">): State {
  if (view.mismatch || view.index.source === "context") return "failed"
  return view.index.ready ? "ready" : "connecting"
}

export interface StatusSources {
  readonly version: string
  readonly host: HostCheck
  readonly config: Pick<ResolvedConfig, "database" | "indexPath" | "defaultScope" | "recall">
  readonly runtime: Pick<HistoryRuntime, "status" | "schema" | "indexFile" | "fallback">
  /** The agents of the plugin's location, with their rules. */
  readonly agents: () => Promise<readonly { readonly id: string; readonly permissions: readonly Rule[] }[]>
  /** The tools OpenCode lists; omitted, the plugin's own are counted. */
  readonly tools?: () => Promise<readonly { readonly id: string }[]>
}

/** Tool names are listed only when they look like tool names. */
const SAFE_NAME = /^history_[a-z][a-z0-9_]{0,63}$/

export async function buildStatus({ version, host, config, runtime, agents, tools }: StatusSources): Promise<StatusView> {
  const known = new Set(TOOL_NAMES.map(name => `history_${name}`))
  const [index, schema, file, listed, ids] = await Promise.all([
    runtime.status(), runtime.schema(), runtime.indexFile(), agents(), tools ? tools().then(list => list.map(tool => tool.id)) : Promise.resolve([...known]),
  ])
  const unguarded = unguardedAgents(listed)
  const ours = ids.filter(id => id.startsWith("history_"))
  const { model } = config.recall
  const base = { index, ...schema.file !== schema.build ? { mismatch: schema } : {} }
  const view = {
    version, host: { version: host.version, range: host.range, tested: host.tested }, state: stateOf(base), index,
    ...index.source === "context" ? { fallback: runtime.fallback ?? "SOURCE_UNAVAILABLE" as const } : {},
    tools: { visible: ours.length, unknown: ours.filter(id => !known.has(id)).filter(id => SAFE_NAME.test(id)).slice(0, 20) },
    database: config.database,
    indexPath: config.indexPath,
    indexBytes: file.bytes,
    masksChanged: file.masksChanged,
    defaultScope: config.defaultScope,
    recall: { synthesize: config.recall.synthesize, model: model ? `${model.providerID}/${model.id}` : null },
    unguardedAgents: unguarded,
    ...unguarded.length ? { permissionsBlock: DEFAULT_RULES.map(rule => ({ ...rule })) } : {},
    ...schema.file !== schema.build ? { mismatch: schema } : {},
  }
  return { ...view, nextStep: nextStep(host, view, runtime.fallback) }
}
