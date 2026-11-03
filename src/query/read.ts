// A window of one session's messages, read in full from the source and rendered compactly.
import type { ReadInput, ReadMessage, ReadOutput, SessionSummary } from "../domain/api.js"
import { BOUNDS } from "../domain/bounds.js"
import type { Source, SourceMessage } from "../domain/contract.js"
import type { Db } from "../domain/sqlite.js"
import { bounded, clip, iso, summaries, type Mask } from "./common.js"
import { QueryError } from "./parse.js"
import { renderMessage, type RenderOptions } from "./render.js"

/** The part of a source that reading needs. */
export type MessageSource = Pick<Source, "messages" | "message">

export function indexedSession(db: Db, sessionID: string): SessionSummary {
  const summary = summaries(db, [sessionID]).get(sessionID)
  if (!summary) throw new QueryError("no indexed session has that ID", "session")
  return summary
}

/**
 * Messages from seq `from` to `to`, plus the seq just before and just after when they exist.
 * Title docs live at seq -1 in the index only; the source starts at 0, so they never appear here.
 */
export async function messageWindow(source: MessageSource, sessionID: string, from: number, to: number) {
  const start = Math.max(0, from - 1)
  const fetched = await source.messages(sessionID, start, to - start + 2)
  const inside = fetched.filter(message => message.seq >= from && message.seq <= to)
  const before = fetched.filter(message => message.seq < from).at(-1)?.seq ?? null
  let after = fetched.find(message => message.seq > to)?.seq ?? null
  // Seqs can have gaps; ask once more past the window before saying nothing follows.
  if (after === null) after = (await source.messages(sessionID, to + 1, 1))[0]?.seq ?? null
  return { inside, before, after }
}

/** Where the window centres: a seq, a message ID, or the session's first message. */
async function centre(source: MessageSource, sessionID: string, at: ReadInput["at"]): Promise<{ seq: number; given: boolean } | undefined> {
  if (typeof at === "number") return { seq: Math.max(0, Math.floor(at)), given: true }
  if (typeof at === "string" && at !== "") {
    if (/^\d+$/.test(at)) return { seq: Number(at), given: true }
    const message = await source.message(sessionID, { id: at })
    if (!message) throw new QueryError("that session has no message with that ID", "message")
    return { seq: message.seq, given: true }
  }
  const first = (await source.messages(sessionID, 0, 1))[0]
  return first ? { seq: first.seq, given: false } : undefined
}

/** Messages read per page while looking for the nearest ones with the requested kinds. */
export const SCAN_PAGE = 100

interface Rendered {
  readonly message: SourceMessage
  readonly text: string
}

/** The session's messages one by one from just before `seq` back to the first, or from just after it on to the last. */
async function* walk(source: MessageSource, sessionID: string, seq: number, direction: "back" | "on"): AsyncGenerator<SourceMessage> {
  if (direction === "on") {
    for (let from = seq + 1; ; ) {
      const page = await source.messages(sessionID, from, SCAN_PAGE)
      yield* page
      if (page.length < SCAN_PAGE) return
      from = page.at(-1)!.seq + 1
    }
  }
  for (let to = seq - 1; to >= 0; ) {
    const from = Math.max(0, to - SCAN_PAGE + 1)
    const page = (await source.messages(sessionID, from, to - from + 1)).filter(message => message.seq <= to)
    yield* [...page].reverse()
    to = from - 1
  }
}

/**
 * The `count` messages nearest to `seq` in `direction` that show text under `render`, nearest first, and the seq of the
 * message beyond the last of them, or null when the session ends first.
 */
async function nearest(source: MessageSource, sessionID: string, render: RenderOptions, seq: number, direction: "back" | "on", count: number) {
  const found: Rendered[] = []
  let beyond: number | null = null
  for await (const message of walk(source, sessionID, seq, direction)) {
    if (found.length >= count) {
      beyond = message.seq
      break
    }
    const text = renderMessage(message, render)
    if (text) found.push({ message, text })
  }
  return { found, beyond }
}

/**
 * With `kinds`, a window where no message has them widens to the nearest messages that do: up to `before` before it and
 * up to `after` after it, and when that finds none, the nearest one in a direction whose count is 0. Returns them in
 * order with the seqs beyond them, and no messages when the session has none of those kinds.
 */
async function widen(source: MessageSource, sessionID: string, render: RenderOptions, window: { readonly inside: readonly SourceMessage[]; readonly before: number | null; readonly after: number | null }, before: number, after: number) {
  const first = window.inside[0]!.seq
  const last = window.inside.at(-1)!.seq
  let back = before > 0 ? await nearest(source, sessionID, render, first, "back", before) : undefined
  let on = after > 0 ? await nearest(source, sessionID, render, last, "on", after) : undefined
  if ((back?.found.length ?? 0) + (on?.found.length ?? 0) === 0) {
    back ??= await nearest(source, sessionID, render, first, "back", 1)
    on ??= await nearest(source, sessionID, render, last, "on", 1)
  }
  return {
    rendered: [...(back?.found ?? []).reverse(), ...(on?.found ?? [])],
    before: back ? back.beyond : window.before,
    after: on ? on.beyond : window.after,
  }
}

export async function read(db: Db, source: MessageSource, input: ReadInput, mask: Mask): Promise<ReadOutput> {
  const session = indexedSession(db, input.sessionID)
  const maxChars = bounded(input.maxChars, BOUNDS.read.maxChars)
  const at = await centre(source, input.sessionID, input.at)
  const empty = { session, messages: [], totalMessages: session.messages, previous: null, next: null, truncated: false, widened: null }
  if (!at) return { ...empty, firstSeq: 0, lastSeq: -1 }

  // Without `at` the window starts at the first message, so `before` has nothing to show.
  const before = at.given ? bounded(input.before, BOUNDS.read.before) : 0
  const after = bounded(input.after, BOUNDS.read.after)
  const from = Math.max(0, at.seq - before)
  const window = await messageWindow(source, input.sessionID, from, at.seq + after)
  if (window.inside.length === 0) {
    if (at.given) throw new QueryError("that session has no message at that position", "message")
    return { ...empty, firstSeq: from, lastSeq: from - 1 }
  }

  const render: RenderOptions = { full: input.full ?? false, mask, ...(input.kinds && input.kinds.length > 0 ? { kinds: input.kinds } : {}) }
  let rendered: readonly Rendered[] = window.inside.map(message => ({ message, text: renderMessage(message, render) }))
  let neighbours = { before: window.before, after: window.after }
  let widened: ReadOutput["widened"] = null
  if (render.kinds && rendered.every(item => !item.text)) {
    widened = { from: window.inside[0]!.seq, to: window.inside.at(-1)!.seq }
    const wider = await widen(source, input.sessionID, render, window, before, after)
    if (wider.rendered.length === 0) return { ...empty, firstSeq: widened.from, lastSeq: widened.to, widened }
    rendered = wider.rendered
    neighbours = { before: wider.before, after: wider.after }
  }

  // The messages before `at` are trimmed first, earliest first, so `at` is shown whole whenever it fits on its own.
  // When every message is before `at`, the last of them stands for it.
  const found = rendered.findIndex(item => item.message.seq >= at.seq)
  const atIndex = found >= 0 ? found : rendered.length - 1
  let start = 0
  let lead = rendered.slice(0, atIndex + 1).reduce((sum, item) => sum + item.text.length, 0)
  while (start < atIndex && lead > maxChars) lead -= rendered[start++]!.text.length

  const messages: ReadMessage[] = []
  let used = 0
  let truncated = start > 0
  let next = neighbours.after
  let last: SourceMessage = rendered[start]!.message
  for (let index = start; index < rendered.length; index++) {
    const { message } = rendered[index]!
    let text = rendered[index]!.text
    if (used + text.length > maxChars) {
      truncated = true
      if (messages.length > 0) {
        // Stop before this message, so the next page starts with it whole.
        next = message.seq
        break
      }
      text = clip(text, maxChars)
      next = rendered[index + 1]?.message.seq ?? neighbours.after
      last = message
      if (text) messages.push({ seq: message.seq, messageID: message.id, type: message.type, time: iso(message.created), text })
      break
    }
    last = message
    // Messages with nothing shown, such as tool-only messages under a kinds filter, still count as read.
    if (!text) continue
    used += text.length
    messages.push({ seq: message.seq, messageID: message.id, type: message.type, time: iso(message.created), text })
  }

  return {
    session,
    messages,
    firstSeq: rendered[start]!.message.seq,
    lastSeq: last.seq,
    totalMessages: session.messages,
    previous: start > 0 ? rendered[start - 1]!.message.seq : neighbours.before,
    next,
    truncated,
    widened,
  }
}
