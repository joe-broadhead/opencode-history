// Filters as SQL, shared by search, sessions and files so every tool reads them the same way.
import { posix } from "node:path"
import type { Caller, Filters, Hidden, HiddenReason } from "../domain/api.js"
import type { Db, Value } from "../domain/sqlite.js"
import { escapeLike, placeholders, trimSlash } from "./common.js"
import { refused } from "../domain/common.js"
import { parseTime, QUERY_HINTS } from "./parse.js"

/** A SQL condition and its parameters. */
export interface Where {
  readonly sql: string
  readonly params: readonly Value[]
}

/** A clause that leaves rows out by default, and the reason, which names the input that would let them in. */
export interface Hiding extends Where {
  readonly reason: HiddenReason
}

/**
 * The filters as one condition, `sql`, and the same condition taken apart: `base`, without the clauses that leave rows
 * out by default, and those clauses in `hiding`. `sql` is `base` and every hiding clause.
 */
export interface Filtered extends Where {
  readonly base: Where
  readonly hiding: readonly Hiding[]
}

const and = (parts: readonly Where[]): Where => ({
  sql: parts.length > 0 ? parts.map(part => part.sql).join(" and ") : "1",
  params: parts.flatMap(part => part.params),
})

/** `, coalesce((clause), 0) as h0, ...` for each hiding clause, to select alongside the rows of `base`. */
export function hidingColumns(hiding: readonly Hiding[]): Where {
  return { sql: hiding.map((clause, index) => `, coalesce((${clause.sql}), 0) as h${index}`).join(""), params: hiding.flatMap(clause => clause.params) }
}

/**
 * How many distinct keys each hiding clause leaves out, from rows selected with `hidingColumns`: a key counts for every
 * clause one of its rows fails, so turning on the inputs of all the clauses a row fails would show it. A caller that
 * is itself a subagent session, for one, counts under both `subagents` and `current`.
 */
export function hiddenCounts(rows: Iterable<{ readonly key: string; readonly row: Record<string, unknown> }>, hiding: readonly Hiding[]): Hidden {
  const keys = new Map<HiddenReason, Set<string>>()
  for (const { key, row } of rows) {
    hiding.forEach((clause, index) => {
      if (Number(row[`h${index}`]) === 1) return
      let set = keys.get(clause.reason)
      if (!set) keys.set(clause.reason, (set = new Set()))
      set.add(key)
    })
  }
  const count = (reason: HiddenReason) => keys.get(reason)?.size ?? 0
  return { scope: count("scope"), archived: count("archived"), subagents: count("subagents"), current: count("current") }
}

/**
 * What the filtered rows are. Every target has `s`, the row's session, and `r`, its root session (left joined).
 * `docs` adds `d` and `files` adds `f`.
 */
type FilterTarget = "docs" | "sessions" | "files"

/**
 * A condition on `f.path`. Absolute paths match the file or anything under the folder. Relative paths match as a
 * path tail on segment boundaries, so `src/auth.ts` also finds the file in other checkouts and worktrees. A path
 * with `..` is first resolved against `directory`. Globs (`*`, `?`, `[`) match whole stored paths.
 */
function pathMatch(path: string, directory: string): Where {
  let clean = path.trim().replace(/^\.\//, "")
  if (!clean || clean === "/" || clean === ".") throw refused("QUERY_INVALID", "path must name a file or folder", QUERY_HINTS.path)
  if (/[*?[]/.test(clean)) {
    return clean.startsWith("/") || clean.startsWith("*")
      ? { sql: "f.path glob ?", params: [clean] }
      : { sql: "(f.path glob ? or f.path glob ?)", params: [clean, `*/${clean}`] }
  }
  if (clean.split("/").includes("..")) clean = posix.resolve(directory || "/", clean)
  if (clean.startsWith("/")) return { sql: "(f.path || '/') like ? escape '\\'", params: [`${escapeLike(trimSlash(clean))}/%`] }
  return { sql: "('/' || f.path || '/') like ? escape '\\'", params: [`%/${escapeLike(clean.replace(/\/+$/, ""))}/%`] }
}

/**
 * Filters as one SQL condition for `target`.
 *
 * - scope: project by default. A `sessionID`, or scope `session` (the caller's session), replaces the scope and the
 *   leave-out-the-caller rule.
 * - includeSubagents: false by default, so only top-level sessions count. True adds subagent sessions; search folds
 *   their docs into the root session's result.
 * - includeCurrent: false by default, which leaves out the caller's own session only. Its parent, its subagents and
 *   any other running session are history like the rest.
 * - since/until: doc or file time; for sessions, `updated >= since` and `created <= until` (active in the window).
 * - kinds/tool: for sessions, sessions with such a doc; for files, `tool` is the touching tool and kinds are ignored.
 * - path: docs and sessions keep trees that touched a matching file; files keeps matching touches.
 *
 * The scope, subagent, current-session and archived clauses are also returned apart, as `hiding`, so a query that
 * finds nothing can count what each one left out.
 */
export function filterSql(db: Db, caller: Caller, filters: Filters, now: number, target: FilterTarget): Filtered {
  const clauses: Where[] = []
  const hiding: Hiding[] = []
  const add = (sql: string, ...params: readonly Value[]) => {
    clauses.push({ sql, params })
  }
  const hide = (reason: HiddenReason, sql: string, ...params: readonly Value[]) => {
    hiding.push({ reason, sql, params })
  }

  const scope = filters.scope ?? "project"
  const named = filters.sessionID ?? (scope === "session" ? caller.sessionID : null)
  if (named) {
    add("(s.id = ? or s.root_id = ?)", named, named)
    if (!filters.includeSubagents) hide("subagents", "s.id = ?", named)
  } else {
    if (scope === "project") hide("scope", "s.project_id = ?", caller.projectID)
    if (scope === "directory") {
      const directory = trimSlash(caller.directory)
      hide("scope", "(s.directory = ? or s.directory like ? escape '\\')", directory, `${escapeLike(directory === "/" ? "" : directory)}/%`)
    }
    if (!filters.includeSubagents) hide("subagents", "s.parent_id is null")
    if (!filters.includeCurrent) hide("current", "s.id <> ?", caller.sessionID)
  }

  if (!filters.includeArchived) hide("archived", "s.archived is null and r.archived is null")

  const since = filters.since ? parseTime(filters.since, now, "since") : undefined
  const until = filters.until ? parseTime(filters.until, now, "until") : undefined
  const time = target === "docs" ? "d.time" : "f.time"
  if (since !== undefined) add(target === "sessions" ? "s.updated >= ?" : `${time} >= ?`, since)
  if (until !== undefined) add(target === "sessions" ? "s.created <= ?" : `${time} <= ?`, until)

  const kinds = filters.kinds && filters.kinds.length > 0 && target !== "files" ? filters.kinds : undefined
  if (target === "sessions") {
    if (kinds || filters.tool) {
      const inner = [...(kinds ? [`x.kind in (${placeholders(kinds.length)})`] : []), ...(filters.tool ? ["lower(x.tool) = lower(?)"] : [])]
      add(`exists (select 1 from docs x where x.session_id = s.id and ${inner.join(" and ")})`, ...(kinds ?? []), ...(filters.tool ? [filters.tool] : []))
    }
  } else {
    const alias = target === "docs" ? "d" : "f"
    if (kinds) add(`d.kind in (${placeholders(kinds.length)})`, ...kinds)
    if (filters.tool) add(`lower(${alias}.tool) = lower(?)`, filters.tool)
  }

  if (filters.agent) add("lower(s.agent) = lower(?)", filters.agent)
  if (filters.path) {
    const path = pathMatch(filters.path, caller.directory)
    if (target === "files") add(path.sql, ...path.params)
    else if (target === "docs") add(`s.root_id in (select f.root_id from files f where ${path.sql})`, ...path.params)
    else add(`(s.id in (select f.session_id from files f where ${path.sql}) or s.id in (select f.root_id from files f where ${path.sql}))`, ...path.params, ...path.params)
  }
  const base = and(clauses)
  return { ...and([...hiding, ...clauses]), base, hiding }
}
