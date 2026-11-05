// Small helpers and the session summary every query function returns.
import type { SessionSummary } from "../domain/api.js"
import type { Bound } from "../domain/bounds.js"
import type { Db } from "../domain/sqlite.js"

/** Hides redacted text in what the source returns. The host passes the same masking the extractor used. */
export type Mask = (text: string) => string

export const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ")

export const iso = (ms: number) => new Date(ms).toISOString()

export const escapeLike = (text: string) => text.replace(/[\\%_]/g, char => `\\${char}`)

export const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path)

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/** `value` clamped to `bound`, or its default when missing. */
export const bounded = (value: number | undefined, bound: Bound) => clampInt(value, bound.default, bound.min, bound.max)

/** At most `max` characters, ending in `…` when cut, without splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  let end = Math.max(0, max - 1)
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end--
  return `${text.slice(0, end)}…`
}

/** The first `head` and last `tail` characters, saying how much was cut between them. */
export function headTail(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text
  let start = head
  if (start > 0 && isHighSurrogate(text.charCodeAt(start - 1))) start--
  let end = text.length - tail
  if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end++
  return `${text.slice(0, start)}\n…[${end - start} chars cut]…\n${text.slice(end)}`
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

/** Summary columns over `s` (sessions) and `p` (projects, left joined on s.project_id). */
export const SUMMARY_COLUMNS = `s.id as sessionID, s.title as title, s.directory as directory, p.worktree as project,
  s.created as created, s.updated as updated, s.agent as agent, s.messages as messages,
  (select count(*) from sessions c where c.parent_id = s.id) as subagents, s.first_prompt as firstPrompt, s.parent_id as parentID`

export interface SummaryRow {
  readonly sessionID: string
  readonly title: string
  readonly directory: string
  readonly project: string | null
  readonly created: number
  readonly updated: number
  readonly agent: string | null
  readonly messages: number
  readonly subagents: number
  readonly firstPrompt: string | null
  readonly parentID: string | null
}

export const toSummary = (row: SummaryRow): SessionSummary => ({
  sessionID: row.sessionID,
  title: row.title,
  directory: row.directory,
  project: row.project,
  created: iso(row.created),
  updated: iso(row.updated),
  agent: row.agent,
  messages: row.messages,
  subagents: row.subagents,
  firstPrompt: row.firstPrompt,
  parentID: row.parentID,
})

/** Session summaries by ID; IDs not in the index are left out. */
export function summaries(db: Db, ids: readonly string[]): Map<string, SessionSummary> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = db.all<SummaryRow>(
    `select ${SUMMARY_COLUMNS} from sessions s left join projects p on p.id = s.project_id where s.id in (${placeholders(unique.length)})`,
    ...unique,
  )
  return new Map(rows.map(row => [row.sessionID, toSummary(row)]))
}
