// events_list and probe: what changed in past sessions since a cursor, as the source contract's normalised events
// (@we-the-rebel-alliance/source-contract), and whose they are.
import { basename } from "node:path"
import { decodeBoundCursor, encodeBoundCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import {
  cut, decodeCursor, encodeCursor, eventsListResult, fitPage, makeEvent, parseEventsListInput, probeResult, screenEvents, startTime,
  type EventsListRequest, type EventsListResult, type ProbeResult, type RefusedEvent, type SourceEvent,
} from "@we-the-rebel-alliance/source-contract/events"
import type { IndexState } from "../domain/api.js"
import { fail } from "../domain/common.js"
import type { Db } from "../domain/sqlite.js"
import type { LocalIdentity } from "../host/identity.js"
import type { Mask } from "./common.js"

/** Contract 1's source, which a call without `source` lists, with the same answers as before the source contract. */
export const EVENTS_SOURCE = "history"
/** The declared source's name: `history.sessions`' `input.source`. */
export const SESSIONS_SOURCE = "sessions"
/** The package every sessions page names. */
export const PACKAGE = "@joe-broadhead/opencode-history"
/** The cursor binding's plugin: the source ids' first segment (`history` in `history.sessions`), as the contract's D16 has it. */
export const CURSOR_PLUGIN = "history"
/** The sessions source's page limit in bytes: package.json's `maxBytes` for `history.sessions`. */
export const PAGE_MAX_BYTES = 262_144
/** Contract 1's page limit, kept for its answers. */
const LEGACY_PAGE_BYTES = 900_000

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

/**
 * The input checked by the source contract's parser, after the tool's schema: INPUT_INVALID names the fields, never the
 * values. A source History does not have is SOURCE_UNKNOWN.
 */
export function eventsRequest(input: unknown): EventsListRequest {
  const source = typeof input === "object" && input !== null ? (input as Record<string, unknown>)["source"] : undefined
  if (source !== undefined && source !== EVENTS_SOURCE && source !== SESSIONS_SOURCE) return fail("SOURCE_UNKNOWN")
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

function toEvent(row: Row, source: string, account: string, mask: Mask): SourceEvent {
  const at = new Date(row.updated).toISOString()
  return makeEvent({
    source,
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

/** The top-level sessions that changed after `from` and settled, in (updated, id) order: one more than `limit`. */
function changed(db: Db, from: Position, limit: number, now: number): { readonly rows: readonly Row[] } {
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
    limit + 1,
  )
  return { rows }
}

/**
 * One event per top-level session each time it changes, oldest first: `external_id` is the session ID and the time it
 * changed, so a later change is a new event. Subagent sessions are part of their parent's work and are not listed. A
 * session is listed once it has stood still for SETTLE_MS. While the index is still being built, nothing is listed and
 * the cursor stays where it was, so no session is passed before it is indexed. `source: "sessions"` is the declared
 * source; anything else is contract 1's `history`, unchanged.
 */
export function eventsList(db: Db, request: EventsListRequest, identity: LocalIdentity, state: IndexState, mask: Mask, now: number): EventsListResult {
  if (request.source !== undefined && request.source !== EVENTS_SOURCE && request.source !== SESSIONS_SOURCE) return fail("SOURCE_UNKNOWN")
  if (request.source === SESSIONS_SOURCE) return sessionsList(db, request, identity, state, mask, now)
  const { account, owner } = identity
  const whose = { source: EVENTS_SOURCE, account, owner }
  if (request.account !== undefined && request.account !== account) return fail("ACCOUNT_UNKNOWN")
  const from = request.cursor === undefined ? { updated: startTime(request, now), id: "" } : position(request.cursor, account)
  if (!state.ready) return eventsListResult(whose, [], cursorAt(from, account), false)
  const { rows } = changed(db, from, request.limit, now)
  const events = rows.slice(0, request.limit).map(row => toEvent(row, EVENTS_SOURCE, account, mask))
  const kept = fitPage(events, request.limit, LEGACY_PAGE_BYTES)
  const last = rows[kept - 1]
  return eventsListResult(whose, events.slice(0, kept), cursorAt(last ? { updated: last.updated, id: last.id } : from, account), rows.length > kept)
}

// ── the declared source: "sessions" ──────────────────────────────────────

/** The cursor's binding: the plugin, the source and this machine's account; the source declares no scope. */
const binding = (account: string) => ({ plugin: CURSOR_PLUGIN, source: SESSIONS_SOURCE, account, scope: {} })

/** The account a cursor names, read before its binding is checked, so another account's is ACCOUNT_MISMATCH. */
function cursorAccount(cursor: string): string | undefined {
  try {
    const value = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>)["a"]
    return typeof value === "string" ? value : undefined
  } catch {
    return undefined
  }
}

const START_AGAIN = "Start again: call history_events_list with source sessions, this machine's account and since, without a cursor."

/** The position a sessions cursor holds, when this machine's sessions source issued it for its owner. */
function sessionsPosition(cursor: string, identity: LocalIdentity): Position {
  const decoded = decodeBoundCursor(binding(identity.account), cursor)
  if (!decoded.ok) return fail("CURSOR_INVALID", { hint: START_AGAIN })
  const { a, o, u, i } = decoded.state
  if (a !== identity.account || o !== identity.owner.id || typeof u !== "number" || !Number.isSafeInteger(u) || u < 0 || typeof i !== "string") {
    return fail("CURSOR_INVALID", { hint: START_AGAIN })
  }
  return { updated: u, id: i }
}

const sessionsCursor = (at: Position, identity: LocalIdentity) =>
  encodeBoundCursor(binding(identity.account), { a: identity.account, o: identity.owner.id, u: at.updated, i: at.id })

/**
 * The declared source, `history.sessions`: the same sessions as contract 1's, under the source contract's cursor and
 * page. A listing with a cursor names its account; another account, or a cursor for one, is ACCOUNT_MISMATCH, and a
 * cursor of another source or plugin, or contract 1's, is CURSOR_INVALID, before the index is read. A session whose
 * title or text still holds a secret after masking is refused for good, and the cursor moves past it.
 */
function sessionsList(db: Db, request: EventsListRequest, identity: LocalIdentity, state: IndexState, mask: Mask, now: number): EventsListResult {
  const { account, owner } = identity
  if (request.account !== undefined && request.account !== account) return fail("ACCOUNT_MISMATCH")
  let from: Position = { updated: startTime(request, now), id: "" }
  if (request.cursor !== undefined) {
    if (request.account === undefined) {
      return fail("INPUT_INVALID", { message: "The tool input is invalid. A cursor belongs to one account, and this listing names none.", hint: "Pass this machine's account, as the cursor's events name it, with the cursor." })
    }
    const other = cursorAccount(request.cursor)
    if (other !== undefined && other !== account) return fail("ACCOUNT_MISMATCH")
    from = sessionsPosition(request.cursor, identity)
  }
  const whose = { source: SESSIONS_SOURCE, account, owner }
  if (!state.ready) return eventsListResult(whose, [], sessionsCursor(from, identity), false, { plugin: PACKAGE })
  const { rows } = changed(db, from, request.limit, now)
  const listed: { row: Row; event?: SourceEvent; refused?: RefusedEvent }[] = rows.slice(0, request.limit).map(row => {
    const screened = screenEvents([toEvent(row, SESSIONS_SOURCE, account, mask)])
    return screened.refused.length > 0 ? { row, refused: screened.refused[0]! } : { row, event: screened.events[0]! }
  })
  const events = listed.flatMap(entry => entry.event ? [entry.event] : [])
  const fits = fitPage(events, request.limit, PAGE_MAX_BYTES)
  // The page ends after its last event that fits, with every refusal before it; refusals after the last event that fits
  // ride along only when every event fits.
  const cut = fits === events.length ? listed.length : listed.findIndex(entry => entry.event === events[fits])
  const taken = listed.slice(0, cut)
  const refused = taken.flatMap(entry => entry.refused ? [entry.refused] : [])
  const last = taken.at(-1)?.row
  return eventsListResult(
    whose,
    taken.flatMap(entry => entry.event ? [entry.event] : []),
    sessionsCursor(last ? { updated: last.updated, id: last.id } : from, identity),
    rows.length > taken.length,
    { plugin: PACKAGE, ...refused.length === 0 ? {} : { refused } },
  )
}

/**
 * `probe`'s answer: whose this machine's History is, as every sessions page names it, and nothing it reads. History is
 * local, so the account is this machine and the owner its OS user. A call naming another account, or another source,
 * is refused.
 */
export function probe(input: { readonly source?: string | undefined; readonly account?: string | undefined }, identity: LocalIdentity): ProbeResult {
  if (input.source !== undefined && input.source !== SESSIONS_SOURCE) return fail("SOURCE_UNKNOWN")
  if (input.account !== undefined && input.account !== identity.account) return fail("ACCOUNT_MISMATCH")
  return probeResult({ source: SESSIONS_SOURCE, account: identity.account, owner: identity.owner })
}
