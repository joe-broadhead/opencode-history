// Inputs and outputs of the query layer. Tools, RPC and the TUI all use these shapes.
import type { DocKind, FileOp, MessageKind } from "./contract.js"

export type Scope = "session" | "directory" | "project" | "all"
export type MatchMode = "words" | "substring" | "regex"

/** Where the caller is. Scope filters and boosts are relative to it. */
export interface Caller {
  readonly sessionID: string
  readonly projectID: string
  readonly directory: string
}

export interface Filters {
  readonly scope?: Scope
  /** ISO date or duration such as "7d", "3w", "2m". */
  readonly since?: string
  readonly until?: string
  readonly kinds?: readonly DocKind[]
  readonly tool?: string
  readonly agent?: string
  readonly path?: string
  readonly sessionID?: string
  /**
   * Also count subagent sessions (work an agent delegated). Default false: only top-level sessions, or only
   * `sessionID` itself. When true, search folds subagent docs into their root session's result (snippets name the
   * subagent session), sessions lists subagent sessions, and files includes their touches.
   */
  readonly includeSubagents?: boolean
  readonly includeCurrent?: boolean
  readonly includeArchived?: boolean
}

export interface SearchInput extends Filters {
  /** One query, or several phrasings that are searched together. */
  readonly query: string | readonly string[]
  readonly match?: MatchMode
  readonly recency?: boolean
  readonly limit?: number
  readonly snippets?: number
  readonly cursor?: string
}

export interface Snippet {
  readonly messageID: string
  readonly seq: number
  readonly kind: DocKind
  readonly tool: string | null
  readonly time: string
  readonly text: string
  readonly sessionID: string
}

export interface SessionSummary {
  readonly sessionID: string
  readonly title: string
  readonly directory: string
  readonly project: string | null
  readonly created: string
  readonly updated: string
  readonly agent: string | null
  readonly messages: number
  readonly subagents: number
  readonly firstPrompt: string | null
  readonly parentID: string | null
}

export interface SearchHit extends SessionSummary {
  readonly score: number
  readonly matches: number
  /** Phrasings the session matches with every term. 0 for a near match, which has only some terms of a phrasing. */
  readonly queriesMatched: number
  /** Other matching sessions with the same title, ignoring case and punctuation, in the same directory, left out for this one. */
  readonly similar: number
  readonly snippets: readonly Snippet[]
}

/** Why a filter left sessions out by default: each reason is undone by one input. */
export type HiddenReason = "current" | "subagents" | "scope" | "archived"
export const HIDDEN_REASONS: readonly HiddenReason[] = ["scope", "archived", "subagents", "current"]

/**
 * Sessions a call would also have found with one more input: `scope: "all"`, `includeArchived`, `includeSubagents` or
 * `includeCurrent`. A session that two of them leave out is in neither count.
 */
export type Hidden = { readonly [R in HiddenReason]: number }

export interface IndexState {
  readonly ready: boolean
  readonly sessionsIndexed: number
  readonly sessionsTotal: number
  readonly lagSeconds: number
  readonly source: "opencode-db" | "context"
  readonly complete: boolean
}

export interface SearchOutput {
  readonly results: readonly SearchHit[]
  /** Matching sessions after near-duplicates are folded into `similar`. */
  readonly total: number
  /** Some results are near matches: they have only some of a phrasing's terms, and rank below full matches of it. */
  readonly relaxed: boolean
  /**
   * True when a cap left matches out, so `total` and the ranking may miss sessions: a phrasing had more matching docs
   * than are ranked, or regex mode stopped before reading every filtered doc (newest 20,000, or its time limit).
   */
  readonly truncated: boolean
  readonly next: string | null
  /** Counted only when nothing is found: what the default filters left out. Null otherwise. */
  readonly hidden: Hidden | null
  readonly index: IndexState
}

export interface SessionsInput extends Filters {
  readonly title?: string
  readonly sort?: "updated" | "created" | "cost" | "messages"
  readonly limit?: number
  readonly cursor?: string
}

export interface SessionsOutput {
  readonly sessions: readonly (SessionSummary & { readonly cost: number; readonly outcome: string | null })[]
  readonly next: string | null
  /** Counted only when nothing is found: what the default filters left out. Null otherwise. */
  readonly hidden: Hidden | null
  readonly index: IndexState
}

export interface ReadInput {
  readonly sessionID: string
  readonly at?: number | string
  readonly before?: number
  readonly after?: number
  readonly kinds?: readonly MessageKind[]
  readonly full?: boolean
  readonly maxChars?: number
}

export interface ReadMessage {
  readonly seq: number
  readonly messageID: string
  readonly type: string
  readonly time: string
  readonly text: string
}

export interface ReadOutput {
  readonly session: SessionSummary
  readonly messages: readonly ReadMessage[]
  readonly firstSeq: number
  readonly lastSeq: number
  readonly totalMessages: number
  readonly previous: number | null
  readonly next: number | null
  readonly truncated: boolean
  /**
   * With `kinds`, when no message from `from` to `to`, the window asked for, has them: the window widened to the nearest
   * messages that do, and `messages` is empty when the session has none. Null otherwise.
   */
  readonly widened: { readonly from: number; readonly to: number } | null
}

export interface BriefInput {
  readonly sessionID: string
  readonly children?: boolean
}

export interface BriefOutput {
  readonly session: SessionSummary & { readonly cost: number; readonly outcome: string | null; readonly models: readonly string[] }
  readonly firstPrompt: string | null
  readonly summaries: readonly string[]
  readonly lastReply: string | null
  readonly filesEdited: readonly { readonly path: string; readonly edits: number }[]
  readonly commands: readonly string[]
  readonly subagents: readonly { readonly sessionID: string; readonly description: string | null; readonly agent: string | null }[]
  readonly todos: readonly { readonly content: string; readonly status: string }[]
}

export interface FilesInput extends Omit<Filters, "kinds"> {
  readonly path: string
  readonly ops?: readonly FileOp[]
  readonly limit?: number
}

export interface FilesOutput {
  readonly files: readonly {
    readonly path: string
    readonly sessions: readonly { readonly sessionID: string; readonly title: string; readonly ops: Partial<Record<FileOp, number>>; readonly last: string; readonly firstSeq: number }[]
  }[]
  /** Counted only when nothing is found: what the default filters left out. Null otherwise. */
  readonly hidden: Hidden | null
  readonly index: IndexState
}

export interface SqlInput {
  readonly sql: string
  readonly params?: readonly (string | number | null)[]
  readonly limit?: number
}

export interface SqlOutput {
  readonly columns: readonly string[]
  readonly rows: readonly (readonly unknown[])[]
  readonly truncated: boolean
  readonly index: IndexState
}

export interface RecallInput extends Filters {
  readonly question: string
  readonly queries?: readonly string[]
  readonly sessions?: number
  readonly maxChars?: number
}

export interface Evidence {
  readonly sessionID: string
  readonly title: string
  readonly seq: number
  readonly time: string
  readonly text: string
}

export interface RecallOutput {
  readonly evidence: readonly Evidence[]
  readonly queries: readonly string[]
  readonly index: IndexState
}
