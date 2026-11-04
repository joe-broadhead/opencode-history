// What the host drives. The index and query modules implement it; the host only codes against this interface.
import type { Plugin } from "@opencode/plugin"
import type {
  BriefInput, BriefOutput, Caller, FilesInput, FilesOutput, IndexState, ReadInput, ReadOutput, RecallInput, RecallOutput,
  SearchInput, SearchOutput, SessionsInput, SessionsOutput, SqlInput, SqlOutput,
} from "../domain/api.js"
import type { FailureCode } from "../domain/common.js"
import type { ResolvedConfig } from "../domain/config.js"

/** `catch-up` indexes what changed since the last run; `rebuild` drops the index and indexes everything again. */
export type ReindexMode = "catch-up" | "rebuild"

/** Why history comes from the plugin session API: OpenCode's database cannot be read, or has an unknown layout. */
export type SourceFallback = Extract<FailureCode, "SOURCE_UNAVAILABLE" | "SOURCE_SCHEMA_UNKNOWN">

/** A host event, as `ctx.event` delivers it. */
export interface HostEvent { readonly type: string; readonly data: unknown }

/**
 * The index file: its size with its write-ahead log, null when it cannot be read, and whether the mask options changed
 * since its text was stored, so the file holds text masked with other patterns until a rebuild.
 */
export interface IndexFile { readonly bytes: number | null; readonly masksChanged: boolean }

/** The schema version the index file is at now, null when it has none, and the one this build of the plugin uses. */
export interface IndexSchema { readonly file: string | null; readonly build: string }

/**
 * The history query layer. Every query method takes the caller, whose session, project and directory scope
 * filters and boosts are relative to. Failures are thrown as `HistoryError`s (domain/common.ts).
 */
export interface HistoryRuntime {
  /** Set when history comes from the plugin session API instead of OpenCode's database, to say why. */
  readonly fallback?: SourceFallback
  /** Index progress and the source the history comes from. */
  status(): Promise<IndexState>
  /**
   * The index file's schema version next to this build's. They differ once another process running another version of
   * the plugin has rebuilt the file, and then every query fails with INDEX_MISMATCH.
   */
  schema(): Promise<IndexSchema>
  /** The index file's size, and whether it was masked with other patterns than the current ones. */
  indexFile(): Promise<IndexFile>
  search(caller: Caller, input: SearchInput): Promise<SearchOutput>
  sessions(caller: Caller, input: SessionsInput): Promise<SessionsOutput>
  files(caller: Caller, input: FilesInput): Promise<FilesOutput>
  read(caller: Caller, input: ReadInput): Promise<ReadOutput>
  brief(caller: Caller, input: BriefInput): Promise<BriefOutput>
  /** Runs in a child process; `signal` kills it. */
  sql(caller: Caller, input: SqlInput, signal?: AbortSignal): Promise<SqlOutput>
  recall(caller: Caller, input: RecallInput): Promise<RecallOutput>
  /** Resolves with the index state once the pass has finished. */
  reindex(mode: ReindexMode): Promise<IndexState>
  /** Called for every host event, for example to catch the index up after a session changes. Returns at once and never throws. */
  onEvent(event: HostEvent): void
  close(): Promise<void>
}

/** The query methods the tools call, by name. */
export type QueryMethod = "search" | "sessions" | "files" | "read" | "brief" | "sql" | "recall"

export interface RuntimeOptions {
  readonly config: ResolvedConfig
  /** The plugin context's session API: the partial fallback source when OpenCode's database cannot be read. */
  readonly session: Pick<Plugin.Context["session"], "list" | "context">
  /** Writes a recall answer from a prompt, with recall.model or else the host's default model. */
  readonly generate: (prompt: string) => Promise<string>
}
/**
 * Opens the index and starts a catch-up in the background. It must not wait for indexing to finish. Search, sessions
 * and recall catch up first, for a bounded time.
 */
export type CreateRuntime = (options: RuntimeOptions) => Promise<HistoryRuntime>
