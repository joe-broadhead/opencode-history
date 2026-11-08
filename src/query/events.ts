// events_list: what changed in past sessions since a cursor, as the funnel's normalised events (src/host/events-list.ts).
import { basename } from "node:path"
import type { IndexState } from "../domain/api.js"
import { fail } from "../domain/common.js"
import type { Db } from "../domain/sqlite.js"
import {
  cut, decodeCursor, encodeCursor, eventsListResult, fitPage, makeEvent, parseEventsListInput, startTime, type EventsListRequest, type EventsListResult,
  type SourceEvent,
} from "../host/events-list.js"
import type { LocalIdentity } from "../host/identity.js"
import type { Mask } from "./common.js"

/** The `source` of History's events. */
export const EVENTS_SOURCE = "history"

/**
 * How long a session must have stood still before it is listed. Sessions are indexed one by one as they change, so one
 * changed a moment ago may not be indexed yet while a later one is; waiting this long keeps the cursor from passing it.
 * A session still in use is listed on a later call, once it settles, and again each time it changes after that.
 */
export const SETTLE_MS = 120_000

/** Characters of the first prompt in an event's text; the last reply has the rest of the 4096. */
const PROMPT_CHARS = 1_500

interface Row {
  readonly id: string
  readonly rootID: string
  readonly title: string
  readonly agent: string | null
  readonly firstPrompt: string | null
  readonly lastReply: string | null
  readonly updated: number
  readonly archived: number | null
  readonly worktree: string | null
}

/** The input checked by the shared contract's parser, after the tool's schema: INPUT_INVALID names the fields, never the values. */
export function eventsRequest(input: unknown): EventsListRequest {
  const parsed = parseEventsListInput(input)
  return parsed.ok ? parsed.value : fail("INPUT_INVALID", { message: `The tool input is invalid. ${parsed.problems.join("; ")}.` })
}

/** Where a listing stands: after the session `id` that changed at `updated`, in (updated, id) order. */
interface Position {
  readonly updated: number
  readonly id: string
}

/** The position a cursor holds, when it is this machine's; CURSOR_INVALID otherwise. */
function position(cursor: string, account: string): Position {
  const state = decodeCursor(EVENTS_SOURCE, cursor)
  const updated = state?.["u"]
  const id = state?.["i"]
  if (state?.["a"] !== account || typeof updated !== "number" || !Number.isSafeInteger(updated) || updated < 0 || typeof id !== "string") return fail("CURSOR_INVALID")
  return { updated, id }
}

const cursorAt = (at: Position, account: string) => encodeCursor(EVENTS_SOURCE, { a: account, u: at.updated, i: at.id })

/** `project:<name>` for a project's folder, by its last segment only, so no local path leaves the machine. */
function projectLabel(worktree: string | null): string[] {
  const name = worktree ? basename(worktree).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 55) : ""
  return name ? [`project:${name}`] : []
}

function sessionText(prompt: string | null, reply: string | null): string {
  return [prompt ? `Prompt: ${cut(prompt.trim(), PROMPT_CHARS)}` : "", reply ? `Reply: ${reply.trim()}` : ""].filter(Boolean).join("\n\n")
}

function toEvent(row: Row, account: string, mask: Mask): SourceEvent {
  const at = new Date(row.updated).toISOString()
  return makeEvent({
    source: EVENTS_SOURCE,
    account,
    external_id: `${row.id}@${at}`,
    kind: "session",
    occurred_at: row.updated,
    thread: `history-session:${row.rootID}`,
    actors: row.agent ? [{ role: "agent", id: `opencode-agent:${row.agent}`, name: row.agent }] : [],
    // Mask before cutting, so a cut never leaves part of a secret behind.
    title: mask(row.title),
    text: sessionText(row.firstPrompt === null ? null : mask(row.firstPrompt), row.lastReply === null ? null : mask(row.lastReply)),
    url: null,
    labels: [...projectLabel(row.worktree), ...(row.archived === null ? [] : ["archived"])],
  })
}

/**
 * One event per top-level session each time it changes, oldest first: `external_id` is the session ID and the time it
 * changed, so a later change is a new event. Subagent sessions are part of their parent's work and are not listed. A
 * session is listed once it has stood still for SETTLE_MS. While the index is still being built, nothing is listed and
 * the cursor stays where it was, so no session is passed before it is indexed.
 */
export function eventsList(db: Db, request: EventsListRequest, identity: LocalIdentity, state: IndexState, mask: Mask, now: number): EventsListResult {
  const { account, owner } = identity
  if (request.account !== undefined && request.account !== account) return fail("ACCOUNT_UNKNOWN")
  const from = request.cursor === undefined ? { updated: startTime(request, now), id: "" } : position(request.cursor, account)
  if (!state.ready) return eventsListResult(owner, [], cursorAt(from, account), false)
  const rows = db.all<Row>(
    `select s.id as id, s.root_id as rootID, s.title as title, s.agent as agent, s.first_prompt as firstPrompt, s.last_reply as lastReply,
        s.updated as updated, s.archived as archived, p.worktree as worktree
      from sessions s left join projects p on p.id = s.project_id
      where s.parent_id is null and s.updated <= ? and (s.updated > ? or (s.updated = ? and s.id > ?))
      order by s.updated, s.id limit ?`,
    now - SETTLE_MS,
    from.updated,
    from.updated,
    from.id,
    request.limit + 1,
  )
  const events = rows.slice(0, request.limit).map(row => toEvent(row, account, mask))
  const kept = fitPage(events, request.limit)
  const last = rows[kept - 1]
  return eventsListResult(owner, events.slice(0, kept), cursorAt(last ? { updated: last.updated, id: last.id } : from, account), rows.length > kept)
}
