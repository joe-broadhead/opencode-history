import * as z from "zod"
import { HOST_RANGE, testedWords } from "./hosts.js"

export const text = (max = 256) => z.string().max(max).refine(s => !s.includes("\0"), "must not contain NUL")
export const integer = z.number().int().safe()

/** Every failure the plugin reports. Other modules throw these through `fail`. */
export type FailureCode =
  | "OPTIONS_INVALID" | "HOST_UNTESTED" | "CLOSED" | "STATUS_UNAVAILABLE" | "SKILLS_INVALID"
  | "INPUT_INVALID" | "OUTPUT_LIMIT" | "CANCELLED" | "CONTRACT_MISMATCH"
  | "SOURCE_UNAVAILABLE" | "SOURCE_SCHEMA_UNKNOWN"
  | "INDEX_UNAVAILABLE" | "INDEX_PATH_REFUSED" | "INDEX_BUSY" | "INDEX_FAILED" | "INDEX_MISMATCH"
  | "SESSION_NOT_FOUND" | "MESSAGE_NOT_FOUND" | "CURSOR_INVALID" | "QUERY_INVALID" | "ACCOUNT_UNKNOWN"
  | "SQL_REJECTED" | "SQL_FAILED" | "SQL_TIMEOUT"
  | "PIN_TOO_LARGE" | "EVENTS_UNAVAILABLE"
  | "PERMISSION_DENIED" | "SESSION_UNKNOWN" | "SESSION_AGENT_REQUIRED"
  | "OPERATION_FAILED"
/** What happened (message) and the next step (hint). Messages name zod paths and option keys, never input values. */
export interface HistoryFailure { readonly code: FailureCode; readonly message: string; readonly hint?: string }

/** What happened and the user's next step, per code. Messages never contain private input values or history text. */
export const FAILURES: { readonly [C in FailureCode]: readonly [message: string, hint?: string] } = {
  OPTIONS_INVALID: ["The plugin options are invalid.", "Fix the History plugin options in opencode.json (see Configure in the README), then restart OpenCode."],
  HOST_UNTESTED: ["This OpenCode version is outside the range History supports.", `Use OpenCode ${testedWords()}, or another release inside ${HOST_RANGE}, or set the plugin option allowUntestedHost: true to run anyway.`],
  CLOSED: ["The History plugin is shutting down.", "Retry after OpenCode has reloaded the plugin."],
  STATUS_UNAVAILABLE: ["History status could not be read.", "Run /history-status again, or check the OpenCode server log."],
  SKILLS_INVALID: ["A History skill file is missing or malformed, so that skill was skipped.", "Reinstall the plugin."],
  INPUT_INVALID: ["The tool input is invalid.", "Correct the named fields and call the tool again."],
  OUTPUT_LIMIT: ["The result is too large to return.", "Narrow the request: a lower limit, a smaller maxChars or a shorter range."],
  CANCELLED: ["The call was cancelled.", "Call the tool again if you still need the result."],
  CONTRACT_MISMATCH: ["The history index returned data this plugin version does not expect.", "Reinstall the plugin, and if it persists, report it with the /history-status output."],
  SOURCE_UNAVAILABLE: ["OpenCode's session history could not be read.", "Check that the database option points at OpenCode's opencode.db, then restart OpenCode."],
  SOURCE_SCHEMA_UNKNOWN: ["OpenCode's database has a layout this plugin version does not know.", "Update the plugin, or use the OpenCode version it was tested with."],
  INDEX_UNAVAILABLE: ["The history index could not be opened.", "Check that indexPath is a writable file path, then restart OpenCode."],
  INDEX_PATH_REFUSED: ["The indexPath option names a file the History index must not use.", "Set indexPath to a new file outside OpenCode's data folder and your projects, or remove it to use the default, then restart OpenCode."],
  INDEX_BUSY: ["The history index is locked by another writer, such as a second OpenCode process.", "Retry in a moment."],
  INDEX_FAILED: ["Updating the history index failed.", "Run /history-status, and if it persists, delete the index file at indexPath and restart OpenCode."],
  INDEX_MISMATCH: ["The history index was rebuilt for another version of this plugin, likely by another OpenCode process.", "Restart every OpenCode process, so they all run one version of the plugin."],
  SESSION_NOT_FOUND: ["No indexed session has that ID.", "Find the session ID with history_search or history_sessions."],
  MESSAGE_NOT_FOUND: ["That session has no message at that position.", "Call history_read without `at` to see the session's message range."],
  CURSOR_INVALID: ["The cursor is invalid or has expired.", "Repeat the call without cursor."],
  QUERY_INVALID: ["The search query cannot be used.", "Correct the named input and call the tool again."],
  ACCOUNT_UNKNOWN: ["History lists only this machine's sessions, and that account is another machine's.", "Call history_events_list without account, or with the account its events name."],
  SQL_REJECTED: ["The SQL was refused.", "Rewrite it as one read-only SELECT or WITH statement over the v_* views and the docs_words and docs_sub tables."],
  SQL_FAILED: ["The SQL query failed.", "Check the view and column names in the history_sql description, then retry."],
  SQL_TIMEOUT: [`The SQL query ran longer than 10 seconds and was stopped.`, "Narrow it: filter by time or session, and bound a recursive WITH with a LIMIT or a WHERE on its counter."],
  PIN_TOO_LARGE: ["The text to pin is larger than OpenCode allows for one instruction entry.", "Pin a shorter range, or set a lower maxChars."],
  EVENTS_UNAVAILABLE: ["OpenCode's session events stopped, so the index may lag behind new sessions.", "Wait, since the plugin subscribes again by itself, and restart OpenCode if it persists."],
  PERMISSION_DENIED: ["The session's agent may not use this tool.", "Add an allow rule for the tool's action to that agent, or call as a session whose agent allows it."],
  SESSION_UNKNOWN: ["OpenCode has no session with that ID.", "Create a session that names an agent, such as POST /api/session with {\"agent\":\"build\"}, and pass its id."],
  SESSION_AGENT_REQUIRED: ["That session names no agent, so there are no rules to run the tool under.", "Create a session that names an agent, such as POST /api/session with {\"agent\":\"build\"}, and pass its id."],
  OPERATION_FAILED: ["The tool failed unexpectedly.", "Retry, and if it persists, run /history-status."],
}

/** The one error text: `CODE: what happened. Next step: What to do.` */
export const formatFailure = (failure: HistoryFailure) => `${failure.code}: ${failure.message}${failure.hint ? ` Next step: ${failure.hint}` : ""}`

export class HistoryError extends Error implements HistoryFailure {
  readonly hint?: string
  constructor(readonly code: FailureCode, detail: { message?: string; hint?: string } = {}) {
    const [message, hint] = FAILURES[code]
    super(detail.message ?? message)
    this.name = "HistoryError"
    const next = detail.hint ?? hint
    if (next !== undefined) this.hint = next
  }
}
export function fail(code: FailureCode, detail?: { message?: string; hint?: string }): never { throw new HistoryError(code, detail) }

/**
 * `code` with what was wrong added to its own message, as in `The SQL was refused: only one SQL statement is allowed.`,
 * and a next step when one fits the cause better than the code's. `detail` never repeats input or history text.
 */
export function refused(code: FailureCode, detail: string, hint?: string): HistoryError {
  return new HistoryError(code, { message: `${FAILURES[code][0].replace(/\.$/, "")}: ${detail}.`, ...hint ? { hint } : {} })
}

/** The named functions an error was thrown from, innermost first, read from the stack after its message. */
function thrownIn(error: Error, count = 3): string[] {
  const stack = typeof error.stack === "string" ? error.stack : ""
  const after = error.message ? stack.indexOf(error.message) : -1
  const frames = after >= 0 ? stack.slice(after + error.message.length) : stack
  const names: string[] = []
  for (const line of frames.split("\n")) {
    const name = /^\s*at (?:async )?([\w$.]+) [([]/.exec(line)?.[1]?.replace(/^Object\./, "")
    if (name && !names.includes(name)) names.push(name)
    if (names.length >= count) break
  }
  return names
}

/**
 * Log one server-log line for an error that a call reports only as `code`, such as OPERATION_FAILED: the operation,
 * the error's class, its SQLite result code when it has one, and the functions it was thrown from. Never its message,
 * which can repeat input, history text or a SQL statement.
 */
export function logUnexpected(error: unknown, code: FailureCode, operation: string, warn: (line: string) => void = console.warn): void {
  const name = error instanceof Error ? error.constructor.name || "Error" : typeof error
  const errcode = typeof error === "object" && error !== null ? (error as { errcode?: unknown }).errcode : undefined
  const where = error instanceof Error ? thrownIn(error) : []
  const parts = [name, ...typeof errcode === "number" && Number.isInteger(errcode) ? [`SQLite code ${errcode}`] : [], ...where.length ? [`thrown in ${where.join(" < ")}`] : []]
  warn(`opencode-history: ${code} in ${operation}: ${parts.join(", ")}.`)
}

export function fence(signal: AbortSignal) { if (signal.aborted) fail("CANCELLED") }

/** Parses with the schema. INPUT_INVALID names the zod paths and rules, never the values. */
export function parse<T extends z.ZodType>(schema: T, input: unknown, code: FailureCode = "CONTRACT_MISMATCH"): z.output<T> {
  const parsed = schema.safeParse(input)
  if (parsed.success) return parsed.data
  if (code !== "INPUT_INVALID") fail(code)
  const issues = parsed.error.issues.slice(0, 8).map(issue => `${issue.path.length ? issue.path.join(".") : "input"}: ${issue.message}`)
  return fail(code, { message: `The tool input is invalid. ${issues.join("; ")}.` })
}
