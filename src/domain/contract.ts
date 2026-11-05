// Shared contract for every module. Change it only with the lead's agreement.

export const PLUGIN_ID = "history.sessions"
export const TUI_ID = "history.sessions.tui"
export const NAMESPACE = "history"
export const INDEX_SCHEMA_VERSION = 3

/** Kinds of searchable text taken from a session. */
export type DocKind = "title" | "user" | "assistant" | "summary" | "reasoning" | "synthetic" | "tool_call" | "tool_result"

/** The kinds of text a message shows: every kind but titles. */
export type MessageKind = Exclude<DocKind, "title">
export const DOC_KINDS: readonly DocKind[] = ["title", "user", "assistant", "summary", "reasoning", "synthetic", "tool_call", "tool_result"]

/** Ranking weight per kind. */
export const KIND_WEIGHT: Record<DocKind, number> = {
  title: 3,
  user: 3,
  summary: 3,
  assistant: 2,
  tool_call: 1.5,
  synthetic: 1,
  tool_result: 0.5,
  reasoning: 0.5,
}

export type FileOp = "read" | "edit" | "write" | "patch" | "search"

/** A session as the source reports it. Times are epoch milliseconds. */
export interface SourceSession {
  readonly id: string
  readonly parentID: string | null
  readonly projectID: string
  readonly directory: string
  readonly title: string
  readonly agent: string | null
  readonly model: string | null
  readonly cost: number
  readonly tokensInput: number
  readonly tokensOutput: number
  readonly created: number
  readonly updated: number
  readonly archived: number | null
}

/** A message as the source reports it; `data` is the message JSON object. */
export interface SourceMessage {
  readonly id: string
  readonly sessionID: string
  readonly seq: number
  readonly type: string
  readonly created: number
  readonly updated: number
  readonly data: Record<string, unknown>
}

export interface SourceProject {
  readonly id: string
  readonly worktree: string
  readonly name: string | null
}

/** Where the history comes from. `opencode-db` is complete; `context` is the partial fallback. */
export type SourceKind = "opencode-db" | "context"

export interface Source {
  readonly kind: SourceKind
  /** One session by ID; undefined when missing. */
  session(id: string): Promise<SourceSession | undefined>
  /** Sessions updated after `since` (exclusive), oldest first, at most `limit`. */
  changedSessions(since: number, limit: number): Promise<readonly SourceSession[]>
  /** Every session ID the source still has, for delete reconciliation. */
  sessionIDs(): Promise<ReadonlySet<string>>
  /** Messages of one session with seq >= fromSeq, in seq order, at most `limit`. */
  messages(sessionID: string, fromSeq: number, limit: number): Promise<readonly SourceMessage[]>
  /** One message by session and seq or ID; undefined when missing. */
  message(sessionID: string, at: { seq: number } | { id: string }): Promise<SourceMessage | undefined>
  projects(): Promise<readonly SourceProject[]>
  /** The latest todo list of a session, when the source has one. */
  todos(sessionID: string): Promise<readonly { content: string; status: string }[]>
  close(): void
}

/** One searchable text unit produced by extraction. */
export interface Doc {
  readonly sessionID: string
  readonly messageID: string
  readonly seq: number
  /** Position of the part inside the message, 0 for whole-message docs. */
  readonly part: number
  readonly time: number
  readonly kind: DocKind
  readonly tool: string | null
  readonly text: string
}

export interface FileTouch {
  readonly sessionID: string
  readonly messageID: string
  readonly seq: number
  readonly time: number
  readonly path: string
  readonly op: FileOp
  readonly tool: string
}

export interface SessionLink {
  readonly parentID: string
  readonly childID: string
  readonly messageID: string | null
  readonly description: string | null
  readonly agent: string | null
}

/** Facts about one session gathered while extracting its messages. */
export interface SessionFacts {
  readonly firstPrompt: string | null
  readonly lastReply: string | null
  readonly outcome: string | null
  readonly messages: number
  readonly userMessages: number
  readonly compactions: number
  readonly toolCalls: number
}

export interface Extracted {
  readonly docs: readonly Doc[]
  readonly files: readonly FileTouch[]
  readonly links: readonly SessionLink[]
  readonly facts: Partial<SessionFacts>
}

export interface ExtractOptions {
  readonly reasoning: boolean
  readonly toolResults: boolean
  readonly maxDocChars: number
  readonly resultHeadChars: number
  readonly resultTailChars: number
  /** User-supplied patterns whose matches are replaced before storage and output. */
  readonly redact: readonly RegExp[]
}

export const DEFAULT_EXTRACT: ExtractOptions = {
  reasoning: false,
  toolResults: true,
  maxDocChars: 8000,
  resultHeadChars: 2000,
  resultTailChars: 1000,
  redact: [],
}
