// The text content of each tool result: what the model reads. Search, sessions, files, brief, read and recall results
// end with the call to make next.
import {
  HIDDEN_REASONS, type BriefOutput, type EventsListOutput, type FilesInput, type FilesOutput, type Hidden, type HiddenReason, type IndexState,
  type ReadInput, type ReadOutput, type RecallInput, type RecallOutput, type SearchInput, type SearchOutput, type SessionSummary, type SessionsOutput,
  type SqlOutput,
} from "../domain/api.js"
import { NAMESPACE } from "../domain/contract.js"
import type { State, StatusView } from "./status.js"

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : /(?:s|x|ch|sh)$/.test(noun) ? "es" : "s"}`
/** `2026-10-12T09:30:00.000Z` as `2026-10-12 09:30`; anything else unchanged. */
export const when = (time: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(time) ? `${time.slice(0, 10)} ${time.slice(11, 16)}` : time
/** One line of at most `max` characters. */
export const oneLine = (text: string, max = 300) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
const call = (tool: string, input: object) => `${NAMESPACE}_${tool} ${JSON.stringify(input)}`
const quoted = (queries: string | readonly string[]) => (typeof queries === "string" ? [queries] : queries).map(q => JSON.stringify(q)).join(" | ")
const title = (session: Pick<SessionSummary, "sessionID" | "title">) => `${session.sessionID} ${JSON.stringify(session.title)}`

/** Warnings about an index that is still building or a partial source. */
export function indexNotes(index: IndexState) {
  const notes: string[] = []
  if (!index.ready) notes.push(`The index is still being built (${index.sessionsIndexed} of ${index.sessionsTotal} sessions), so results may be incomplete.`)
  if (index.source === "context") notes.push("History comes from a partial source that keeps only the messages after each compaction; the user can run /history-status for the fix.")
  else if (!index.complete) notes.push("The history source is incomplete; the user can run /history-status for the fix.")
  return notes
}
const lines = (...groups: readonly (string | readonly string[] | undefined | false)[]) =>
  groups.flatMap(group => group === undefined || group === false ? [] : typeof group === "string" ? [group] : group).join("\n")
const sessionFacts = (s: SessionSummary) => [
  plural(s.messages, "message"),
  ...s.subagents ? [plural(s.subagents, "subagent")] : [],
  ...s.agent ? [`agent ${s.agent}`] : [],
  ...s.parentID ? [`subagent of ${s.parentID}`] : [],
]

/** Each reason a default filter leaves sessions out: what they are, and the input that shows them. */
const HIDDEN: { readonly [R in HiddenReason]: readonly [what: string, input: string] } = {
  scope: ["in other projects or folders", 'scope: "all"'],
  archived: ["archived", "includeArchived: true"],
  subagents: ["in subagent sessions", "includeSubagents: true"],
  current: ["in the current session", "includeCurrent: true"],
}

/**
 * For an empty result: what the default filters left out, and the input that shows the most of it. A session counts
 * under every reason that leaves it out, so when the most are left out as subagents and the current session is left out
 * too, as many, the caller is a subagent itself and the input is both.
 */
function hiddenNotes(hidden: Hidden | null): { readonly note?: string; readonly input?: string } {
  if (!hidden) return {}
  const reasons = HIDDEN_REASONS.filter(reason => hidden[reason] > 0).sort((a, b) => hidden[b] - hidden[a])
  if (reasons.length === 0) return {}
  const top = reasons[0]!
  const pair = top === "subagents" ? "current" : top === "current" ? "subagents" : undefined
  const both = pair !== undefined && hidden[pair] >= hidden[top]
  return {
    note: `Left out by default: ${reasons.map(reason => `${plural(hidden[reason], "session")} ${HIDDEN[reason][0]} (${HIDDEN[reason][1]})`).join(", ")}.`,
    input: both ? `${HIDDEN.subagents[1]} and ${HIDDEN.current[1]}` : HIDDEN[top][1],
  }
}

export function formatSearch(result: SearchOutput, input: Pick<SearchInput, "query" | "scope">) {
  const phrasings = typeof input.query === "string" ? 1 : input.query.length
  const scope = input.scope ? ` in scope ${input.scope}` : ""
  if (result.results.length === 0) {
    const hidden = hiddenNotes(result.hidden)
    return lines(
      `No sessions matched ${quoted(input.query)}${scope}.`,
      hidden.note,
      indexNotes(result.index),
      hidden.input
        ? `Next: repeat the call with ${hidden.input} to include them, or search again with different phrasings.`
        : "Next: search again with different phrasings (synonyms, the exact error text, a file name), match: \"substring\" for identifiers, scope: \"all\", or fewer filters.",
    )
  }
  const first = result.results[0]!, at = first.snippets[0]
  const folded = result.results.find(hit => hit.similar > 0)
  return lines(
    `${plural(result.total, "session")} matched ${quoted(input.query)}${scope}; showing ${result.results.length}.`,
    result.relaxed ? "Sessions marked near match have only some words of a phrasing, so they rank below full matches: treat them as weaker." : undefined,
    result.truncated ? "Too many texts matched to rank them all, so the count and order are approximate: narrow with scope, since, kinds or path." : undefined,
    indexNotes(result.index),
    "",
    result.results.flatMap((hit, i) => [
      `${i + 1}. ${title(hit)} · updated ${when(hit.updated)} · ${hit.directory}`,
      `   ${[
        ...hit.queriesMatched === 0 ? ["near match"] : phrasings > 1 ? [`${hit.queriesMatched} of ${phrasings} phrasings`] : [],
        plural(hit.matches, "match"),
        ...sessionFacts(hit),
        ...hit.similar ? [`${hit.similar} similar`] : [],
      ].join(" · ")}`,
      ...hit.snippets.map(s => `   #${s.seq} ${s.kind}${s.tool ? ` (${s.tool})` : ""}${s.sessionID === hit.sessionID ? "" : ` in ${s.sessionID}`}: ${oneLine(s.text)}`),
    ]),
    "",
    folded ? `Similar sessions are in the same directory as the one shown, with a near-identical title or the same first prompt; list those with its title with ${call("sessions", { title: folded.title })}.` : undefined,
    result.next ? `More: repeat the call with cursor: ${JSON.stringify(result.next)}.` : undefined,
    `Next: ${call("brief", { sessionID: first.sessionID })} to see what that session did, then ${call("read", at ? { sessionID: at.sessionID, at: at.seq } : { sessionID: first.sessionID })} for the exact exchange. Cite what you use as (${at ? `${at.sessionID} #${at.seq}` : `${first.sessionID} #<seq>`}), with the session ID every time.`,
  )
}

export function formatSessions(result: SessionsOutput) {
  if (result.sessions.length === 0) {
    const hidden = hiddenNotes(result.hidden)
    return lines("No sessions matched.", hidden.note, indexNotes(result.index), hidden.input ? `Next: repeat the call with ${hidden.input} to include them.` : "Next: widen scope or since, or drop filters.")
  }
  const first = result.sessions[0]!
  return lines(
    `${plural(result.sessions.length, "session")}${result.next ? " (more with cursor)" : ""}.`,
    indexNotes(result.index),
    "",
    result.sessions.flatMap((s, i) => [
      `${i + 1}. ${title(s)} · updated ${when(s.updated)} · ${s.directory}`,
      `   ${[...sessionFacts(s), `$${s.cost.toFixed(2)}`].join(" · ")}`,
      ...s.firstPrompt ? [`   Asked: ${oneLine(s.firstPrompt, 200)}`] : [],
      ...s.outcome ? [`   Outcome: ${oneLine(s.outcome, 200)}`] : [],
    ]),
    "",
    result.next ? `More: repeat the call with cursor: ${JSON.stringify(result.next)}.` : undefined,
    `Next: ${call("brief", { sessionID: first.sessionID })} for a summary of a session. Cite sessions by ID.`,
  )
}

const OPS = ["edit", "write", "patch", "read", "search"] as const
/** A session's touch seqs; when cut, the first, then the latest. */
const touchSeqs = (s: FilesOutput["files"][number]["sessions"][number]) => `${s.seqsCut ? `#${s.firstSeq}, … ` : ""}${s.seqs.map(seq => `#${seq}`).join(", ")}`
export function formatFiles(result: FilesOutput, input: Pick<FilesInput, "path" | "scope" | "limit">) {
  if (result.files.length === 0) {
    const hidden = hiddenNotes(result.hidden)
    return lines(
      `No session touched ${JSON.stringify(input.path)}${input.scope ? ` in scope ${input.scope}` : ""}.`,
      hidden.note,
      indexNotes(result.index),
      hidden.input ? `Next: repeat the call with ${hidden.input} to include them.` : "Next: try scope: \"all\", a shorter path or a folder, or history_search with the file name.",
    )
  }
  const first = result.files[0]!.sessions[0]
  return lines(
    result.truncated ? `More than ${plural(result.files.length, "path")} matched; these are the most recently touched. Name the folder that makes the path unique, such as <repo>/${input.path.split("/").at(-1)}, or raise limit.` : undefined,
    indexNotes(result.index),
    result.files.flatMap(file => [
      file.path,
      ...file.sessions.map(s => `  ${title(s)} · last ${when(s.last)} · ${OPS.filter(op => s.ops[op]).map(op => `${op} ${s.ops[op]}`).join(", ") || "no counts"} · at ${touchSeqs(s)}`),
    ]),
    "",
    first ? `Next: ${call("read", { sessionID: first.sessionID, at: first.firstSeq })} to see why it changed. Cite as (${first.sessionID} #${first.firstSeq}), with the session ID every time.` : undefined,
  )
}

const kindsText = (kinds: ReadInput["kinds"]) => kinds?.length ? `${kinds.length === 1 ? "kind" : "kinds"} ${kinds.join(", ")}` : "the kinds asked for"

/** `calls: false` leaves out the paging calls, for text that is pinned rather than read now. */
export function formatRead(result: ReadOutput, input: Pick<ReadInput, "sessionID" | "kinds">, { calls = true }: { readonly calls?: boolean } = {}) {
  const { session, widened } = result
  const none = widened !== null && result.messages.length === 0
  const range = result.messages.length ? `messages #${result.firstSeq}-#${result.lastSeq} of ${result.totalMessages}`
    : none ? `no messages of those kinds (${result.totalMessages} in total)` : `no messages in that range (${result.totalMessages} in total)`
  return lines(
    `${title(session)} · ${session.directory} · ${range}`,
    widened && !none ? `No message in #${widened.from}-#${widened.to} has ${kindsText(input.kinds)}, so the window widened to the nearest messages that do.` : undefined,
    none ? `No message in this session has ${kindsText(input.kinds)}.` : undefined,
    "",
    result.messages.flatMap(m => [`#${m.seq} ${m.type} · ${when(m.time)}`, m.text, ""]),
    result.truncated && calls ? "Text was trimmed to maxChars. Read a shorter range, raise maxChars, or set full: true." : undefined,
    calls && result.messages.length ? `Cite a message as (${session.sessionID} #<seq>), with the session ID every time.` : undefined,
    calls && result.previous !== null ? `Earlier: ${call("read", { sessionID: input.sessionID, at: result.previous, before: 10, after: 0 })}` : undefined,
    calls && result.next !== null ? `Later: ${call("read", { sessionID: input.sessionID, at: result.next, before: 0 })}` : undefined,
    calls && none ? `Next: ${call("read", { sessionID: input.sessionID, at: widened.from })} to read without kinds, or repeat the call with other kinds.` : undefined,
  )
}

export function formatBrief(result: BriefOutput, { calls = true }: { readonly calls?: boolean } = {}) {
  const s = result.session
  return lines(
    title(s),
    `${s.directory}${s.project ? ` · project ${s.project}` : ""}${s.agent ? ` · agent ${s.agent}` : ""}${s.models.length ? ` · ${s.models.join(", ")}` : ""}`,
    `Created ${when(s.created)} · updated ${when(s.updated)} · ${[...sessionFacts(s).filter(f => !f.startsWith("agent ")), `$${s.cost.toFixed(2)}`].join(" · ")}`,
    s.outcome ? `Outcome: ${oneLine(s.outcome, 500)}` : undefined,
    result.firstPrompt ? `First prompt: ${oneLine(result.firstPrompt, 1000)}` : undefined,
    result.summaries.length ? ["Summaries:", ...result.summaries.map(text => `- ${oneLine(text, 1500)}`)] : undefined,
    result.lastReply ? `Last reply: ${oneLine(result.lastReply, 1500)}` : undefined,
    result.filesEdited.length ? `Files edited: ${result.filesEdited.map(f => `${f.path} (${f.edits})`).join(", ")}` : undefined,
    result.commands.length ? ["Commands:", ...result.commands.map(c => `- ${oneLine(c, 200)}`)] : undefined,
    result.subagents.length ? ["Subagents:", ...result.subagents.map(a => `- ${a.sessionID}${a.agent ? ` (${a.agent})` : ""}${a.description ? `: ${oneLine(a.description, 200)}` : ""}`)] : undefined,
    result.todos.length ? ["Todos:", ...result.todos.map(t => `- [${t.status}] ${oneLine(t.content, 200)}`)] : undefined,
    calls ? `Next: ${call("read", { sessionID: s.sessionID })} for the exact wording, or with at: <seq> from a search snippet.` : undefined,
  )
}

const cell = (value: unknown) => {
  if (value === null || value === undefined) return "null"
  if (typeof value === "string") return value.replace(/\r?\n/g, "\\n")
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
}
export function formatSql(result: SqlOutput) {
  return lines(
    `${plural(result.rows.length, "row")}${result.truncated ? "; more rows exist, so raise limit or narrow the query" : ""}.`,
    indexNotes(result.index),
    result.columns.join(" | "),
    result.rows.map(row => row.map(cell).join(" | ")),
  )
}

export function formatEvents(result: EventsListOutput) {
  return lines(
    `${plural(result.events.length, "event")} for ${result.owner.label}, oldest first${result.more ? "; more follow" : ""}.`,
    result.events.map(e => `${when(e.occurred_at)} ${e.external_id} ${JSON.stringify(e.title)}`),
    `Cursor: ${result.cursor}`,
    `Next: ${result.more ? call("events_list", { cursor: result.cursor }) : "call it again with this cursor later, for what changes next"}.`,
  )
}

export function formatRecall(result: RecallOutput, input: Pick<RecallInput, "scope">) {
  if (result.evidence.length === 0) return lines(
    `No evidence found${input.scope ? ` in scope ${input.scope}` : ""}. Searched for ${quoted(result.queries)}.`,
    indexNotes(result.index),
    "Next: retry with other phrasings in queries, scope: \"all\", or explore with history_search.",
  )
  const sessions = new Set(result.evidence.map(e => e.sessionID)).size, first = result.evidence[0]!
  return lines(
    indexNotes(result.index),
    `Evidence from ${plural(sessions, "session")}:`,
    result.evidence.flatMap(e => [`[${e.sessionID} #${e.seq} · ${when(e.time)} · ${JSON.stringify(e.title)}]`, e.text, ""]),
    `Searched for ${quoted(result.queries)}.`,
    `Next: answer from this evidence, citing each claim as (${first.sessionID} #${first.seq}), with the session ID every time, or ${call("read", { sessionID: first.sessionID, at: first.seq })} for more context.`,
  )
}

const SOURCE_TEXT = { "opencode-db": "OpenCode database", context: "plugin session API (partial)" } as const
export const NOTHING_TO_DO = "Nothing to do."
/** The row that shows only when the index file's schema is not this build's. */
export const MISMATCH_ROW = "Index schema:"
/** The permission block, one rule a line, as JSON to paste. */
function blockLines(rules: readonly { readonly action: string; readonly resource: string; readonly effect: string }[]) {
  return rules.length ? ["[", ...rules.map((rule, at) => `  ${JSON.stringify(rule)}${at < rules.length - 1 ? "," : ""}`), "]"] : []
}
/** The row of agents that miss the default rules: their names, then the block to paste. */
const AGENTS_ROW = "Agents without default rules:"
function agentsRow(view: StatusView) {
  const names = view.unguardedAgents
  if (names.length === 0) return [`${AGENTS_ROW} none`]
  return [`${AGENTS_ROW} ${names.join(", ")}`, ...blockLines(view.permissionsBlock ?? []).map(line => `  ${line}`)]
}
/** The Account row: History has no accounts. */
const ACCOUNT_TEXT = "none; History needs no sign-in"
/** The Access row: what the plugin can do. */
const ACCESS_TEXT = "reads OpenCode's database read-only and writes only its own index; history_pin asks before it changes a session"
const FALLBACK_TEXT = { SOURCE_UNAVAILABLE: "OpenCode's database could not be read", SOURCE_SCHEMA_UNKNOWN: "OpenCode's database has an unknown layout" } as const
/** The Connection row's words for each state: the S9 labels. */
const CONNECTION_WORDS: { readonly [S in State]: string } = { ready: "connected", connecting: "connecting", failed: "failed" }
/** The row that shows only when the mask options changed after text was indexed. */
const MASKS_ROW = "Masks:"
/** A byte count in the largest unit that keeps it at least 1: `512 B`, `3.4 KB`, `511 MB`. */
export function size(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
function hostText({ host, version }: StatusView) {
  const note = host.tested ? "tested" : `untested; supported range ${host.range}`
  return `${host.version ?? "unknown version"} (${note}). History ${version}`
}
function toolsText({ tools }: StatusView) {
  const unknown = tools.unknown.length ? `, ${tools.unknown.length} unknown (they ask first): ${tools.unknown.join(", ")}` : ""
  return `${tools.visible} available${unknown}`
}
export function formatStatus(view: StatusView) {
  const { index, mismatch } = view
  return lines(
    "History status",
    `Connection: ${CONNECTION_WORDS[view.state]}`,
    `Account: ${ACCOUNT_TEXT}`,
    `Access: ${ACCESS_TEXT}`,
    `Index: ${index.ready ? "ready" : "building"}, ${index.sessionsIndexed} of ${index.sessionsTotal} sessions${index.lagSeconds ? `, ${Math.round(index.lagSeconds)} s behind` : ""}`,
    `Source: ${SOURCE_TEXT[index.source]}${index.complete ? "" : ", incomplete"}${view.fallback ? ` (${FALLBACK_TEXT[view.fallback]})` : ""}`,
    `Database: ${view.database}`,
    `Index file: ${view.indexPath}${view.indexBytes === null ? "" : ` (${size(view.indexBytes)})`}`,
    view.masksChanged ? `${MASKS_ROW} changed since text was indexed, so the index file holds that text masked the old way until /history-reindex rebuild` : undefined,
    mismatch ? `${MISMATCH_ROW} ${mismatch.file === null ? "none" : `version ${mismatch.file}`} in the file, but this build uses version ${mismatch.build}, so every query fails (INDEX_MISMATCH)` : undefined,
    `Default scope: ${view.defaultScope}`,
    `Skill: ${view.shadowedSkills.length ? view.shadowedSkills.map(skill => `${skill.id} is hidden by ${skill.path}`).join("; ") : "history-recall"}`,
    `Tools: ${toolsText(view)}`,
    agentsRow(view),
    `OpenCode: ${hostText(view)}`,
    `Next step: ${view.nextStep}`,
  )
}
