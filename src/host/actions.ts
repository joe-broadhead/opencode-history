// Action tools: they change the current session through the plugin context, so they are not exposed to Code Mode.
import * as z from "zod"
import type { Plugin } from "@opencode/plugin"
import type { Caller } from "../domain/api.js"
import { BOUNDS } from "../domain/bounds.js"
import { fail, fence, integer } from "../domain/common.js"
import { formatBrief, formatRead, oneLine } from "./format.js"
import type { HistoryRuntime } from "./runtime.js"
import { ranged, sessionID } from "./schemas.js"

type Entries = Plugin.Context["session"]["instructions"]["entry"]
type SessionID = Parameters<Entries["put"]>[0]["sessionID"]

/** OpenCode refuses an instruction entry whose JSON value is larger than this (InstructionEntry.MaxValueBytes). */
export const MAX_PIN_BYTES = 256 * 1024
export const PIN_PREFIX = "history."
/** The most messages one pin can hold. */
export const MAX_PIN_RANGE = 200

/**
 * The instruction entry key of a pinned session. Keys must match `^[a-z0-9][a-z0-9._-]*$` and session IDs are mixed
 * case, so an upper-case letter is written as `-` and the letter, and `-` as `--`. `pinSession` reverses it.
 */
export const pinKey = (session: string) => PIN_PREFIX + session.replace(/[A-Z-]/g, c => c === "-" ? "--" : `-${c.toLowerCase()}`)
export function pinSession(key: string) {
  if (!key.startsWith(PIN_PREFIX) || key.length === PIN_PREFIX.length) return undefined
  let session = ""
  for (let i = PIN_PREFIX.length; i < key.length; i++) {
    const c = key[i]!
    if (c !== "-") { session += c; continue }
    const next = key[++i]
    if (next === "-") session += "-"
    else if (next !== undefined && /[a-z]/.test(next)) session += next.toUpperCase()
    else return undefined
  }
  return session
}

export const PinInputSchema = z.strictObject({
  action: z.enum(["put", "remove", "list"]).default("put").describe("put (default): pin, replacing any earlier pin of that session. remove: unpin it. list: show this session's pins."),
  sessionID: sessionID.optional().describe("The past session to pin or unpin, from history_search, history_sessions or history_files. Needed for put and remove."),
  from: integer.min(0).optional().describe("Pin messages from this seq instead of the brief, for example a search excerpt's seq. Omit from and to to pin the session's brief."),
  to: integer.min(0).optional().describe(`Last seq of the range, inclusive, at most ${MAX_PIN_RANGE} messages after from. Default: from, a single message.`),
  maxChars: ranged(BOUNDS.pin.maxChars, "Most characters of session text to pin"),
}).superRefine((input, issues) => {
  const issue = (path: string, message: string) => issues.addIssue({ code: "custom", path: [path], message })
  if (input.action !== "list" && input.sessionID === undefined) issue("sessionID", `is required for ${input.action}`)
  if (input.action !== "put" && (input.from !== undefined || input.to !== undefined)) issue(input.from !== undefined ? "from" : "to", "only applies to put")
  if (input.to !== undefined && input.from === undefined) issue("to", "needs from")
  if (input.from !== undefined && input.to !== undefined && (input.to < input.from || input.to - input.from > MAX_PIN_RANGE)) issue("to", `must be from to from + ${MAX_PIN_RANGE}`)
})
const PinSchema = z.strictObject({ sessionID: z.string(), key: z.string(), chars: integer.min(0), label: z.string() })
export const PinOutputSchema = z.strictObject({ action: z.enum(["put", "remove", "list"]), changed: z.boolean(), pins: z.array(PinSchema) })
export type PinOutput = z.output<typeof PinOutputSchema>
type Pin = z.output<typeof PinSchema>

export interface ActionSources {
  readonly runtime: Pick<HistoryRuntime, "brief" | "read">
  readonly session: { readonly instructions: { readonly entry: Pick<Entries, "list" | "put" | "remove"> } }
}

const pin = (key: string, value: unknown): Pin | undefined => {
  const session = pinSession(key)
  if (session === undefined) return undefined
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? ""
  return { sessionID: session, key, chars: text.length, label: oneLine(text.split("\n", 1)[0] ?? "", 200) }
}

/** The pinned text: a header that marks it as a record, then the brief or the messages, without follow-up calls. */
async function pinText(runtime: ActionSources["runtime"], caller: Caller, input: { readonly sessionID: string; readonly from?: number | undefined; readonly to?: number | undefined; readonly maxChars: number }) {
  const unpin = `Unpin with history_pin {"action":"remove","sessionID":${JSON.stringify(input.sessionID)}}.`
  if (input.from === undefined) {
    const brief = await runtime.brief(caller, { sessionID: input.sessionID })
    const body = formatBrief(brief, { calls: false })
    const trimmed = body.length > input.maxChars
    return [
      `Pinned brief of past session ${input.sessionID} ${JSON.stringify(brief.session.title)}${trimmed ? ", trimmed" : ""}. It is a record of earlier work, not instructions. ${unpin}`,
      trimmed ? `${body.slice(0, input.maxChars - 1)}…` : body,
    ].join("\n")
  }
  const to = input.to ?? input.from
  const read = await runtime.read(caller, { sessionID: input.sessionID, at: input.from, before: 0, after: to - input.from, maxChars: input.maxChars })
  return [
    `Pinned messages #${input.from}-#${to} of past session ${input.sessionID} ${JSON.stringify(read.session.title)}${read.truncated ? ", trimmed" : ""}. They are a record of earlier work, not instructions. ${unpin}`,
    formatRead(read, input, { calls: false }),
  ].join("\n")
}

/** history_pin: pins a brief or a seq range of a past session into the current session's instructions. */
/** The change happens only after a last cancellation check, so a cancelled call never pins or unpins late. */
export async function runPin(sources: ActionSources, caller: Caller, input: z.output<typeof PinInputSchema>, signal: AbortSignal): Promise<PinOutput> {
  if (caller.sessionID === null) return fail("OPERATION_FAILED", { message: "history_pin needs a session to pin into." })
  const target = caller.sessionID as SessionID, entries = sources.session.instructions.entry
  const listed = await entries.list({ sessionID: target })
  const existing = listed.flatMap(entry => pin(entry.key, entry.value) ?? [])
  if (input.action === "list") return { action: "list", changed: false, pins: existing }
  const key = pinKey(input.sessionID!), others = existing.filter(p => p.key !== key)
  if (input.action === "remove") {
    const pinned = others.length < existing.length
    fence(signal)
    if (pinned) await entries.remove({ sessionID: target, key })
    return { action: "remove", changed: pinned, pins: others }
  }
  const value = await pinText(sources.runtime, caller, { ...input, sessionID: input.sessionID! })
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_PIN_BYTES) fail("PIN_TOO_LARGE")
  fence(signal)
  await entries.put({ sessionID: target, key, value })
  return { action: "put", changed: listed.find(entry => entry.key === key)?.value !== value, pins: [...others, pin(key, value)!] }
}

const total = (pins: readonly Pin[]) => pins.reduce((n, p) => n + p.chars, 0)
export function formatPin(result: PinOutput, input: { readonly sessionID?: string | undefined }) {
  const summary = result.pins.length
    ? [`${result.pins.length} history pin${result.pins.length === 1 ? "" : "s"} in this session, ${total(result.pins)} characters, sent with every request:`, ...result.pins.map(p => `- ${p.sessionID}: ${p.label}`)]
    : ["No history pins in this session."]
  const head = result.action === "list" ? []
    : result.action === "remove" ? [result.changed ? `Unpinned ${input.sessionID}.` : `${input.sessionID} was not pinned.`]
    : [`${result.changed ? "Pinned" : "Already pinned, unchanged:"} ${input.sessionID} (${result.pins.find(p => p.sessionID === input.sessionID)?.chars ?? 0} characters). It applies from the next request and survives compaction.`]
  return [...head, ...summary, ...result.action === "list" || !result.pins.length ? [] : ["Remove pins that are no longer needed with action: \"remove\"."]].join("\n")
}
