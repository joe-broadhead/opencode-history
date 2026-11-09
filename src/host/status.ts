import type * as z from "zod"
import type { StatusSchema } from "../domain/schemas.js"
import { FAILURES, type HistoryFailure } from "../domain/common.js"
import type { ResolvedConfig } from "../domain/config.js"
import type { HostCheck } from "./compat.js"
import { NOTHING_TO_DO } from "./format.js"
import { AGENT_FIX, defaultRules, unguardedAgents, type Rule } from "./permissions.js"
import { TOOL_NAMES } from "./tools.js"
import type { HistoryRuntime, SourceFallback } from "./runtime.js"

/**
 * The state, in the shared machine words (S13): `failed` when every query fails (an index at another schema) or the
 * history is partial (OpenCode's database could not be used), `connecting` while the first index builds, otherwise
 * `ready`: History has no service to connect to. The Connection row shows it in the S9 words. History has no
 * status-only mode, which is what `host_untested` means: outside the range it does not start at all, unless
 * `allowUntestedHost` is set, and then it works normally. An untested host shows in `host.tested` and the OpenCode row.
 */
export type State = StatusView["state"]

/** One status model for the command, the RPC and the TUI: the status RPC's output (`StatusSchema`). */
export type StatusView = z.output<typeof StatusSchema>

/** Why history comes from the plugin session API, and the fix: the setup warning, and the status's next step. */
export function fallbackFailure(code: SourceFallback): HistoryFailure {
  const cause = code === "SOURCE_SCHEMA_UNKNOWN" ? "OpenCode's database has a layout this plugin version does not know" : "OpenCode's database could not be read"
  return { code, message: `${cause}, so history comes from the plugin session API, which keeps only the messages after each compaction.`, hint: FAILURES[code][1]! }
}

/** The first item that needs the user, from blocking problems down to ones that pass by themselves; `Nothing to do.` otherwise. */
export function nextStep(host: HostCheck, view: Pick<StatusView, "index" | "mismatch" | "unguardedAgents" | "masksChanged"> & Partial<Pick<StatusView, "shadowedSkills">>, fallback?: SourceFallback): string {
  if (host.next) return host.next
  if (view.mismatch) return FAILURES.INDEX_MISMATCH[1]!
  if (view.index.source === "context") return FAILURES[fallback ?? "SOURCE_UNAVAILABLE"][1]!
  const shadow = view.shadowedSkills?.[0]
  if (shadow) return shadowed(shadow)
  if (view.masksChanged) return MASKS_CHANGED
  if (view.unguardedAgents.length > 0) return AGENT_FIX
  if (!view.index.ready) return BUILDING
  return NOTHING_TO_DO
}

export const MASKS_CHANGED =
  "Run /history-reindex rebuild, since the mask options changed after text was indexed: results are masked with the new patterns, but the index file still holds that text masked the old way."

/** The fix for a skill with the plugin's skill id that OpenCode loads instead of the plugin's own. */
export const shadowed = ({ id, path }: { readonly id: string; readonly path: string }) =>
  `Rename or move the skill at ${path}, since its id, ${id}, hides the plugin's own skill.`

export const BUILDING = "Wait for the index to finish building, since until then results cover only the sessions indexed so far."

function stateOf(view: Pick<StatusView, "index" | "mismatch">): State {
  if (view.mismatch || view.index.source === "context") return "failed"
  return view.index.ready ? "ready" : "connecting"
}

interface StatusSources {
  readonly version: string
  readonly host: HostCheck
  readonly config: Pick<ResolvedConfig, "database" | "indexPath" | "defaultScope" | "access">
  readonly runtime: Pick<HistoryRuntime, "status" | "schema" | "indexFile" | "fallback">
  /** The agents of the plugin's location, with their rules. */
  readonly agents: () => Promise<readonly { readonly id: string; readonly permissions: readonly Rule[] }[]>
  /** The tools OpenCode lists; omitted, the plugin's own are counted. */
  readonly tools?: () => Promise<readonly { readonly id: string }[]>
  /** The skills OpenCode lists, and the plugin's own that loaded, by id and path; omitted, none is shadowed. */
  readonly skills?: { readonly listed: () => Promise<readonly { readonly id: string; readonly path: string }[]>; readonly own: readonly { readonly id: string; readonly path: string }[] }
}

/** Tool names are listed only when they look like tool names. */
const SAFE_NAME = /^history_[a-z][a-z0-9_]{0,63}$/

export async function buildStatus({ version, host, config, runtime, agents, tools, skills }: StatusSources): Promise<StatusView> {
  const known = new Set(TOOL_NAMES.map(name => `history_${name}`))
  const [index, schema, file, listed, ids] = await Promise.all([
    runtime.status(), runtime.schema(), runtime.indexFile(), agents(), tools ? tools().then(list => list.map(tool => tool.id)) : Promise.resolve([...known]),
  ])
  // At `all` nothing is held back, so no agent needs the fix.
  const block = defaultRules(config.access)
  const unguarded = unguardedAgents(listed, config.access)
  // A listing that fails says nothing about shadowing, so it shows none rather than failing the status.
  const loaded = skills ? await skills.listed().catch(() => []) : []
  const shadowedSkills = (skills?.own ?? []).flatMap(own => loaded.filter(skill => skill.id === own.id && skill.path !== own.path).map(skill => ({ id: skill.id, path: skill.path }))).slice(0, 10)
  const ours = ids.filter(id => id.startsWith("history_"))
  const base = { index, ...schema.file !== schema.build ? { mismatch: schema } : {} }
  const view = {
    version, access: config.access, host: { version: host.version, range: host.range, tested: host.tested }, state: stateOf(base), index,
    ...index.source === "context" ? { fallback: runtime.fallback ?? "SOURCE_UNAVAILABLE" as const } : {},
    tools: { visible: ours.length, unknown: ours.filter(id => !known.has(id)).filter(id => SAFE_NAME.test(id)).slice(0, 20) },
    database: config.database,
    indexPath: config.indexPath,
    indexBytes: file.bytes,
    masksChanged: file.masksChanged,
    defaultScope: config.defaultScope,
    shadowedSkills,
    unguardedAgents: unguarded,
    ...unguarded.length ? { permissionsBlock: block.map(rule => ({ ...rule })) } : {},
    ...schema.file !== schema.build ? { mismatch: schema } : {},
  }
  return { ...view, nextStep: nextStep(host, view, runtime.fallback) }
}
