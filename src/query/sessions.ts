// List indexed sessions with the shared filters, a title filter and a sort.
import type { Caller, Hidden, IndexState, SessionsInput, SessionsOutput } from "../domain/api.js"
import { BOUNDS } from "../domain/bounds.js"
import type { Db } from "../domain/sqlite.js"
import { bounded, clip, escapeLike, SUMMARY_COLUMNS, toSummary, type SummaryRow } from "./common.js"
import { filterSql, hiddenCounts, hidingColumns } from "./filters.js"
import { decodeCursor, encodeCursor } from "./parse.js"

/** Largest first; ties go to the most recently updated. */
/** Characters of each row's first prompt. */
const FIRST_PROMPT_CHARS = 200

const SORTS = { updated: "s.updated", created: "s.created", cost: "s.cost", messages: "s.messages" } as const

interface SessionsOptions {
  /** Epoch milliseconds that durations count back from. */
  readonly now?: number
}

export function sessions(db: Db, caller: Caller, input: SessionsInput, state: IndexState, options: SessionsOptions = {}): SessionsOutput {
  const sort = input.sort ?? "updated"
  const limit = bounded(input.limit, BOUNDS.sessions.limit)
  const offset = decodeCursor(input.cursor)
  const where = filterSql(db, caller, input, options.now ?? Date.now(), "sessions")
  const title = input.title?.trim()
  const titled = title ? { sql: " and s.title like ? escape '\\'", params: [`%${escapeLike(title)}%`] } : { sql: "", params: [] }
  const from = "from sessions s left join sessions r on r.id = s.root_id left join projects p on p.id = s.project_id"
  const rows = db.all<SummaryRow & { cost: number; outcome: string | null }>(
    `select ${SUMMARY_COLUMNS}, s.cost as cost, s.outcome as outcome ${from}
      where ${where.sql}${titled.sql}
      order by ${SORTS[sort]} desc, s.updated desc, s.id limit ? offset ?`,
    ...where.params,
    ...titled.params,
    limit + 1,
    offset,
  )
  let hidden: Hidden | null = null
  if (rows.length === 0 && offset === 0) {
    const columns = hidingColumns(where.hiding)
    const left = db.all<Record<string, unknown>>(`select s.id as key${columns.sql} ${from} where ${where.base.sql}${titled.sql}`, ...columns.params, ...where.base.params, ...titled.params)
    hidden = hiddenCounts(left.map(row => ({ key: String(row.key), row })), where.hiding)
  }
  return {
    // A page of 100 rows stays small: each first prompt is cut to FIRST_PROMPT_CHARS; history_brief has more of it.
    sessions: rows.slice(0, limit).map(row => {
      const summary = toSummary(row)
      return { ...summary, firstPrompt: summary.firstPrompt === null ? null : clip(summary.firstPrompt, FIRST_PROMPT_CHARS), cost: row.cost, outcome: row.outcome }
    }),
    next: rows.length > limit ? encodeCursor(offset + limit) : null,
    hidden,
    index: state,
  }
}
