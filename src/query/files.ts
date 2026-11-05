// Which sessions touched a file or folder, grouped by path, with operation counts per session.
import type { Caller, FilesInput, FilesOutput, Hidden, IndexState } from "../domain/api.js"
import { BOUNDS } from "../domain/bounds.js"
import type { FileOp } from "../domain/contract.js"
import type { Db } from "../domain/sqlite.js"
import { bounded, iso, placeholders } from "./common.js"
import { filterSql, hiddenCounts, hidingColumns } from "./filters.js"
import { refused } from "../domain/common.js"
import { QUERY_HINTS } from "./parse.js"

/** Sessions listed per path, most recent first. */
const MAX_FILE_SESSIONS = 20

interface FilesOptions {
  /** Epoch milliseconds that durations count back from. */
  readonly now?: number
}

interface TouchRow {
  readonly path: string
  readonly sessionID: string
  readonly title: string
  readonly op: FileOp
  readonly count: number
  readonly last: number
  readonly firstSeq: number
}

interface SessionTouches {
  readonly sessionID: string
  readonly title: string
  readonly ops: Partial<Record<FileOp, number>>
  last: number
  firstSeq: number
}

/** Paths most recently touched first; each with the sessions that touched it, most recent first. */
export function files(db: Db, caller: Caller, input: FilesInput, state: IndexState, options: FilesOptions = {}): FilesOutput {
  if (!input.path?.trim()) throw refused("QUERY_INVALID", "path must name a file or folder", QUERY_HINTS.path)
  const ops = input.ops && input.ops.length > 0 ? input.ops : undefined
  const limit = bounded(input.limit, BOUNDS.files.limit)
  const where = filterSql(db, caller, input, options.now ?? Date.now(), "files")
  const from = "from files f join sessions s on s.id = f.session_id left join sessions r on r.id = s.root_id"
  const opsSql = ops ? ` and f.op in (${placeholders(ops.length)})` : ""
  const rows = db.all<TouchRow>(
    `select f.path as path, f.session_id as sessionID, s.title as title, f.op as op, count(*) as count, max(f.time) as last, min(f.seq) as firstSeq
      ${from} where ${where.sql}${opsSql}
      group by f.path, f.session_id, f.op`,
    ...where.params,
    ...(ops ?? []),
  )
  let hidden: Hidden | null = null
  if (rows.length === 0) {
    const columns = hidingColumns(where.hiding)
    const left = db.all<Record<string, unknown>>(`select distinct f.session_id as key${columns.sql} ${from} where ${where.base.sql}${opsSql}`, ...columns.params, ...where.base.params, ...(ops ?? []))
    hidden = hiddenCounts(left.map(row => ({ key: String(row.key), row })), where.hiding)
  }

  const paths = new Map<string, Map<string, SessionTouches>>()
  for (const row of rows) {
    let bySession = paths.get(row.path)
    if (!bySession) paths.set(row.path, (bySession = new Map()))
    let touches = bySession.get(row.sessionID)
    if (!touches) bySession.set(row.sessionID, (touches = { sessionID: row.sessionID, title: row.title, ops: {}, last: row.last, firstSeq: row.firstSeq }))
    touches.ops[row.op] = (touches.ops[row.op] ?? 0) + row.count
    touches.last = Math.max(touches.last, row.last)
    touches.firstSeq = Math.min(touches.firstSeq, row.firstSeq)
  }

  const byRecent = (a: { last: number }, b: { last: number }) => b.last - a.last
  const grouped = [...paths].map(([path, bySession]) => {
    const list = [...bySession.values()].sort((a, b) => byRecent(a, b) || (a.sessionID < b.sessionID ? -1 : 1))
    return { path, last: list[0]?.last ?? 0, sessions: list }
  })
  grouped.sort((a, b) => byRecent(a, b) || (a.path < b.path ? -1 : 1))
  return {
    files: grouped.slice(0, limit).map(file => ({
      path: file.path,
      sessions: file.sessions.slice(0, MAX_FILE_SESSIONS).map(s => ({ sessionID: s.sessionID, title: s.title, ops: s.ops, last: iso(s.last), firstSeq: s.firstSeq })),
    })),
    truncated: grouped.length > limit,
    hidden,
    index: state,
  }
}
