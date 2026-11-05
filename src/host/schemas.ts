import * as z from "zod"
import type {
  BriefInput, BriefOutput, FilesInput, FilesOutput, Hidden, IndexState, ReadInput, ReadOutput, RecallInput, RecallOutput,
  SearchInput, SearchOutput, SessionsInput, SessionsOutput, SqlInput, SqlOutput,
} from "../domain/api.js"
import { BOUNDS, MAX_PHRASINGS, type Bound } from "../domain/bounds.js"
import { integer, text } from "../domain/common.js"
import { SCOPES } from "../domain/config.js"
import { DOC_KINDS, type DocKind, type FileOp, type MessageKind } from "../domain/contract.js"
import type { StatusView } from "./status.js"

// Tool input and output schemas. Inputs carry the defaults the model sees, from BOUNDS, which the query layer clamps
// to as well; outputs are the api.ts shapes field for field, because the host validates every tool result against its
// output schema.

/** An integer input with its default and range from BOUNDS, which the description states. */
export const ranged = (bound: Bound, what: string) =>
  integer.min(bound.min).max(bound.max).default(bound.default).describe(`${what}, ${bound.min}-${bound.max}. Default ${bound.default}.`)

const FILE_OPS = ["read", "edit", "write", "patch", "search"] as const satisfies readonly FileOp[]
const kind = z.enum(DOC_KINDS as [DocKind, ...DocKind[]])
/** The kinds a message shows: every kind but titles, which are not messages. */
const READ_KINDS = DOC_KINDS.filter((k): k is MessageKind => k !== "title")
const messageKind = z.enum(READ_KINDS as [MessageKind, ...MessageKind[]])
const op = z.enum(FILE_OPS)
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "must be an ID such as ses_...")
export const sessionID = id
/** An ISO date or date-time, or an age such as 36h, 7d, 3w, 2m or 1y. */
const when = z.string().max(40).regex(/^(?:\d{1,4}[hdwmy]|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?)$/, "must be an ISO date, or an age such as 7d, 3w, 2m")
const phrase = text(512).trim().min(1)
const phrasings = z.array(phrase).min(1).max(MAX_PHRASINGS)

const KIND_TEXT = "title, user, assistant, summary (compaction summaries), reasoning, synthetic, tool_call, tool_result"
const filters = {
  scope: z.enum(["session", ...SCOPES]).optional()
    .describe("Where to look: project (this project), directory (sessions started in this directory), all (every project), or session (only the current session, for example to recover what was said before a compaction). Default: the defaultScope plugin option, normally project."),
  since: when.optional().describe("Only sessions active since then: an ISO date such as 2026-10-01, or an age such as 7d, 3w, 2m."),
  until: when.optional().describe("Only sessions active until then, in the same forms as since."),
  kinds: z.array(kind).min(1).max(DOC_KINDS.length).optional().describe(`Only match these kinds of text: ${KIND_TEXT}. Default: all indexed kinds.`),
  tool: text(128).min(1).optional().describe("Only tool calls and results of this tool, for example bash or edit."),
  agent: text(128).min(1).optional().describe("Only sessions run by this agent, for example build or plan."),
  path: text(4096).min(1).optional().describe("Only sessions that read or changed this file or folder. A relative path matches the end of a recorded path, so src/auth.ts finds that file in any checkout; an absolute path matches only that file or folder."),
  sessionID: id.optional().describe("Only this session."),
  includeSubagents: z.boolean().optional().describe("Also include subagent sessions (work the agent delegated). Default false."),
  includeCurrent: z.boolean().optional().describe("Also include the current session. Default false, because you can already see it, apart from what a compaction removed."),
  includeArchived: z.boolean().optional().describe("Also include archived sessions. Default false."),
}

export const SearchInputSchema = z.strictObject({
  query: z.union([phrase, phrasings])
    .describe("Two to four phrasings of the same topic, as an array: the user's words, the technical terms, an exact error message or a file name. A single string also works but finds less."),
  match: z.enum(["words", "substring", "regex"]).default("words")
    .describe("words (default): stemmed words in any order. substring: exact text, for identifiers, paths and error messages. regex: a JavaScript regular expression."),
  recency: z.boolean().default(true).describe("Rank newer sessions a little higher. Default true; set false when age should not matter, such as for a long-standing decision."),
  limit: ranged(BOUNDS.search.limit, "Sessions to return"),
  snippets: ranged(BOUNDS.search.snippets, "Matching excerpts per session"),
  cursor: text(1024).min(1).optional().describe("The next value of a previous result, to get the next page with the same input."),
  ...filters,
}) satisfies z.ZodType<SearchInput>

export const SessionsInputSchema = z.strictObject({
  title: text(256).min(1).optional().describe("Only sessions whose title contains this text."),
  sort: z.enum(["updated", "created", "cost", "messages"]).default("updated").describe("Order, newest or largest first: updated (default), created, cost or messages."),
  limit: ranged(BOUNDS.sessions.limit, "Sessions to return"),
  cursor: text(1024).min(1).optional().describe("The next value of a previous result, to get the next page."),
  ...filters,
}) satisfies z.ZodType<SessionsInput>

// Files filters touches, not texts, so it takes no kinds.
const { kinds: _kinds, ...fileFilters } = filters
export const FilesInputSchema = z.strictObject({
  ...fileFilters,
  path: text(4096).min(1).describe("A file or folder, for example src/auth or src/auth/login.ts. A relative path matches the end of a recorded path, in any checkout; an absolute path matches only that file or folder. Globs such as src/*.ts also work."),
  ops: z.array(op).min(1).max(FILE_OPS.length).optional().describe("Only these operations: read, edit, write, patch, search. Default: all."),
  limit: ranged(BOUNDS.files.limit, "Files to return"),
}) satisfies z.ZodType<FilesInput>

export const ReadInputSchema = z.strictObject({
  sessionID: id.describe("The session to read, from history_search, history_sessions or history_files."),
  at: z.union([integer.min(0), id]).optional().describe("Where to start reading: a snippet's seq number, or a message ID. Omit to start at the first message."),
  before: ranged(BOUNDS.read.before, "Messages to include before `at`"),
  after: ranged(BOUNDS.read.after, "Messages to include after `at`"),
  kinds: z.array(messageKind).min(1).max(READ_KINDS.length).optional()
    .describe("Only show these kinds of text: user, assistant, summary (compaction summaries), reasoning, synthetic, tool_call, tool_result. Default: all but reasoning, which full: true shows."),
  full: z.boolean().optional().describe("Show whole messages, including long tool output, instead of trimmed text. Default false."),
  maxChars: ranged(BOUNDS.read.maxChars, "Most characters of message text to return"),
}) satisfies z.ZodType<ReadInput>

export const BriefInputSchema = z.strictObject({
  sessionID: id.describe("The session to summarise, from history_search, history_sessions or history_files."),
  children: z.boolean().optional().describe("Also brief each subagent session. Default false."),
}) satisfies z.ZodType<BriefInput>

export const SqlInputSchema = z.strictObject({
  sql: text(16_384).min(1).describe("One read-only SELECT or WITH statement over the index: the v_sessions, v_docs, v_files and v_links views, and the docs_words (MATCH) and docs_sub (text LIKE '%substring%') full-text tables."),
  params: z.array(z.union([text(4096), z.number().finite(), z.null()])).max(64).optional().describe("Values for the ? placeholders, in order."),
  limit: ranged(BOUNDS.sql.limit, "Most rows to return"),
}) satisfies z.ZodType<SqlInput>

export const RecallInputSchema = z.strictObject({
  question: text(2048).trim().min(1).describe("The question to answer from past sessions, for example \"How did we fix the flaky upload test?\"."),
  queries: phrasings.optional().describe("Two to four search phrasings for the question. Default: phrasings taken from the question."),
  sessions: ranged(BOUNDS.recall.sessions, "Most sessions to draw evidence from"),
  maxChars: ranged(BOUNDS.recall.maxChars, "Most characters of evidence"),
  synthesize: z.boolean().optional().describe("Also write an answer from the evidence with a model. The default is the recall.synthesize plugin option."),
  ...filters,
}) satisfies z.ZodType<RecallInput>

// Outputs

const count = integer.min(0)
const time = z.string().max(64)
const nullable = z.string().nullable()
export const IndexStateSchema = z.strictObject({
  ready: z.boolean(), sessionsIndexed: count, sessionsTotal: count, lagSeconds: z.number().finite().min(0),
  source: z.enum(["opencode-db", "context"]), complete: z.boolean(),
}) satisfies z.ZodType<IndexState>
const summary = {
  sessionID: z.string(), title: z.string(), directory: z.string(), project: nullable, created: time, updated: time,
  agent: nullable, messages: count, subagents: count, firstPrompt: nullable, parentID: nullable,
}
const SessionSummarySchema = z.strictObject(summary)
const SnippetSchema = z.strictObject({ messageID: z.string(), seq: count, kind, tool: nullable, time, text: z.string(), sessionID: z.string() })
const HiddenSchema = z.strictObject({ scope: count, archived: count, subagents: count, current: count }) satisfies z.ZodType<Hidden>

export const SearchOutputSchema = z.strictObject({
  results: z.array(z.strictObject({ ...summary, score: z.number().finite(), matches: count, queriesMatched: count, similar: count, snippets: z.array(SnippetSchema) })),
  total: count, relaxed: z.boolean(), truncated: z.boolean(), next: nullable, hidden: HiddenSchema.nullable(), index: IndexStateSchema,
}) satisfies z.ZodType<SearchOutput>

export const SessionsOutputSchema = z.strictObject({
  sessions: z.array(z.strictObject({ ...summary, cost: z.number().finite(), outcome: nullable })),
  next: nullable, hidden: HiddenSchema.nullable(), index: IndexStateSchema,
}) satisfies z.ZodType<SessionsOutput>

export const FilesOutputSchema = z.strictObject({
  files: z.array(z.strictObject({
    path: z.string(),
    sessions: z.array(z.strictObject({
      sessionID: z.string(), title: z.string(),
      ops: z.strictObject(Object.fromEntries(FILE_OPS.map(o => [o, count.optional()])) as { [O in FileOp]: z.ZodOptional<typeof count> }),
      last: time, firstSeq: count,
    })),
  })),
  hidden: HiddenSchema.nullable(),
  index: IndexStateSchema,
}) satisfies z.ZodType<FilesOutput>

export const ReadOutputSchema = z.strictObject({
  session: SessionSummarySchema,
  messages: z.array(z.strictObject({ seq: count, messageID: z.string(), type: z.string(), time, text: z.string() })),
  firstSeq: integer, lastSeq: integer, totalMessages: count, previous: integer.nullable(), next: integer.nullable(), truncated: z.boolean(),
  widened: z.strictObject({ from: integer, to: integer }).nullable(),
}) satisfies z.ZodType<ReadOutput>

export const BriefOutputSchema = z.strictObject({
  session: z.strictObject({ ...summary, cost: z.number().finite(), outcome: nullable, models: z.array(z.string()) }),
  firstPrompt: nullable,
  summaries: z.array(z.string()),
  lastReply: nullable,
  filesEdited: z.array(z.strictObject({ path: z.string(), edits: count })),
  commands: z.array(z.string()),
  subagents: z.array(z.strictObject({ sessionID: z.string(), description: nullable, agent: nullable })),
  todos: z.array(z.strictObject({ content: z.string(), status: z.string() })),
}) satisfies z.ZodType<BriefOutput>

export const SqlOutputSchema = z.strictObject({
  columns: z.array(z.string()), rows: z.array(z.array(z.unknown())), truncated: z.boolean(), index: IndexStateSchema,
}) satisfies z.ZodType<SqlOutput>

export const RecallOutputSchema = z.strictObject({
  answer: nullable,
  evidence: z.array(z.strictObject({ sessionID: z.string(), title: z.string(), seq: count, time, text: z.string() })),
  queries: z.array(z.string()),
  index: IndexStateSchema,
}) satisfies z.ZodType<RecallOutput>

export const StatusSchema = z.strictObject({
  version: z.string().max(64),
  host: z.strictObject({ version: z.string().max(64).nullable(), range: z.string().max(64), tested: z.boolean() }),
  state: z.enum(["ready", "connecting", "failed"]),
  index: IndexStateSchema,
  fallback: z.enum(["SOURCE_UNAVAILABLE", "SOURCE_SCHEMA_UNKNOWN"]).optional(),
  tools: z.strictObject({ visible: z.number().int().min(0), unknown: z.array(z.string().max(128)).max(20) }),
  database: z.string().max(4096),
  indexPath: z.string().max(4096),
  indexBytes: z.number().int().min(0).nullable(),
  masksChanged: z.boolean(),
  defaultScope: z.enum(SCOPES),
  recall: z.strictObject({ synthesize: z.boolean(), model: z.string().max(256).nullable() }),
  unguardedAgents: z.array(z.string().max(256)).max(1000),
  permissionsBlock: z.array(z.strictObject({ action: z.string(), resource: z.string(), effect: z.enum(["allow", "deny", "ask"]) })).optional(),
  mismatch: z.strictObject({ file: z.string().max(64).nullable(), build: z.string().max(64) }).optional(),
  nextStep: z.string().max(4096),
}) satisfies z.ZodType<StatusView>
