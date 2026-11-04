// The history runtime: a source of sessions, the shared index kept in step with it, and the query functions over it.
import { realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fail, FAILURES, HistoryError, logUnexpected, type FailureCode } from "./domain/common.js"
import { DEFAULT_EXTRACT, INDEX_SCHEMA_VERSION, type ExtractOptions, type Source } from "./domain/contract.js"
import { extractMessage, maskText, titleDoc } from "./extract/index.js"
import { INDEX_PATH_MESSAGES } from "./domain/paths.js"
import type { CreateRuntime, RuntimeOptions, SourceFallback } from "./host/runtime.js"
import { eventRouter, type EventRouter } from "./index/events.js"
import { acquire, type Lease } from "./index/shared.js"
import { ForeignIndexError, IndexStore } from "./index/store.js"
import { Indexer } from "./index/sync.js"
import { brief } from "./query/brief.js"
import { files } from "./query/files.js"
import { QueryError, type QueryFailure } from "./query/parse.js"
import { read } from "./query/read.js"
import { recall } from "./query/recall.js"
import { search } from "./query/search.js"
import { sessions } from "./query/sessions.js"
import { sql } from "./query/sql.js"
import { contextSource } from "./source/context.js"
import { openOpencodeSource } from "./source/opencode-db.js"

/** How long search, sessions and recall wait for the catch-up they start before they answer from the index as it is. */
export const REFRESH_MS = 200

/** The failure code for each reason the query layer gives. */
export const QUERY_FAILURES: Record<QueryFailure, FailureCode> = {
  query: "QUERY_INVALID",
  cursor: "CURSOR_INVALID",
  session: "SESSION_NOT_FOUND",
  message: "MESSAGE_NOT_FOUND",
  sql_rejected: "SQL_REJECTED",
  sql_failed: "SQL_FAILED",
  sql_timeout: "SQL_TIMEOUT",
  recall: "RECALL_FAILED",
}

/** The kind of mistake SQLite found, in words that cannot repeat the statement as SQLite's own message does. */
function sqliteMistake(cause: unknown): string | undefined {
  const text = cause instanceof Error ? cause.message : ""
  if (/no such column/i.test(text)) return "it names a column the views do not have"
  if (/no such table/i.test(text)) return "it names a table or view the index does not have"
  if (/no such function/i.test(text)) return "it calls a function SQLite does not have"
  if (/ambiguous column/i.test(text)) return "a column name is ambiguous, so prefix it with its view"
  if (/syntax error|unrecognized token|incomplete input/i.test(text)) return "it has a syntax error"
  if (/index out of range/i.test(text)) return "params has more values than the statement has ? placeholders"
  return undefined
}

/** SQLite's busy or locked result, by its primary code, or by its text where a driver gives no code. */
function locked(cause: unknown): boolean {
  const code = typeof cause === "object" && cause !== null ? (cause as { errcode?: unknown }).errcode : undefined
  if (typeof code === "number") return (code & 0xff) === 5 || (code & 0xff) === 6
  return cause instanceof Error && /\bdatabase (?:table )?is locked\b/i.test(cause.message)
}

/**
 * A HistoryError for whatever a query threw. A HistoryError, also as a QueryError's cause, keeps its code; a locked
 * index is INDEX_BUSY. Query and SQL rejections keep the query layer's reason, which never repeats the input.
 * Anything else becomes `fallback`, without its message, and leaves one line in the server log for `operation`.
 */
export function toFailure(error: unknown, fallback: FailureCode = "OPERATION_FAILED", operation = "runtime"): HistoryError {
  if (error instanceof HistoryError) return error
  const cause = error instanceof QueryError ? error.cause : error
  if (cause instanceof HistoryError) return cause
  if (locked(cause)) return new HistoryError("INDEX_BUSY")
  if (!(error instanceof QueryError)) {
    logUnexpected(error, fallback, operation)
    return new HistoryError(fallback)
  }
  const code = QUERY_FAILURES[error.reason]
  const detail =
    error.reason === "query" || error.reason === "sql_rejected" ? error.message : error.reason === "sql_failed" ? sqliteMistake(error.cause) : undefined
  return new HistoryError(code, detail ? { message: `${FAILURES[code][0].replace(/\.$/, "")}: ${detail}.` } : {})
}

/** One index file and the work that keeps it fresh, shared by every plugin instance that opens that file. */
class SharedIndex {
  readonly router: EventRouter
  /** Indexing work in flight, so a rebuild can wait for it before it drops the index. */
  private readonly running = new Set<Promise<unknown>>()
  private backfilling: { readonly controller: AbortController; readonly done: Promise<void> } | null = null
  private rebuilding: Promise<void> | null = null
  private closed = false

  constructor(
    readonly store: IndexStore,
    readonly source: Source,
    readonly indexer: Indexer,
    readonly fallback: SourceFallback | undefined,
  ) {
    this.router = eventRouter({ syncSession: id => this.track(indexer.syncSession(id)), deleteSession: id => this.track(indexer.deleteSession(id)) })
  }

  /** Index in the background: everything when no backfill has finished yet, otherwise what changed. Errors go to the indexer's health. */
  start(): void {
    ;(this.indexer.state().ready ? this.catchUp() : this.backfill()).catch(() => {})
  }

  /**
   * Catch up before a query, waiting at most `ms`; a longer catch-up carries on in the background. Skipped while a
   * rebuild or backfill runs, as that pass is the catch-up. Errors go to the indexer's health.
   */
  async refresh(ms: number): Promise<void> {
    if (this.closed || this.rebuilding || this.backfilling) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(resolve, ms)
    })
    try {
      await Promise.race([this.track(this.indexer.catchUp()).catch(() => {}), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Index what changed and drop deleted sessions, once a running rebuild or backfill has ended. */
  async catchUp(): Promise<void> {
    await this.rebuilding?.catch(() => {})
    await this.backfilling?.done.catch(() => {})
    await this.track(this.indexer.catchUp())
    await this.track(this.indexer.reconcile())
  }

  /** Drop the index and index everything again. Calls during a rebuild share it. */
  rebuild(): Promise<void> {
    this.rebuilding ??= this.reset().finally(() => {
      this.rebuilding = null
    })
    return this.rebuilding
  }

  close(): void {
    this.closed = true
    this.backfilling?.controller.abort()
    this.router.close()
    // Work still in flight stops at its next use of the closed store, before it reads the source again.
    this.store.close()
    this.source.close()
  }

  private async reset(): Promise<void> {
    this.backfilling?.controller.abort()
    // A session sync that started before the reset would write from partway through the session after it.
    while (this.running.size > 0) await Promise.allSettled([...this.running])
    if (this.closed) fail("CLOSED")
    this.store.reset()
    await this.backfill()
  }

  private backfill(): Promise<void> {
    const controller = new AbortController()
    const done = this.track(
      this.indexer
        .backfill(controller.signal)
        .then(() => this.indexer.reconcile())
        .then(() => undefined),
    )
    const entry = { controller, done }
    const clear = () => {
      if (this.backfilling === entry) this.backfilling = null
    }
    this.backfilling = entry
    done.then(clear, clear)
    return done
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.running.add(work)
    const settle = () => {
      this.running.delete(work)
    }
    work.then(settle, settle)
    return work
  }
}

function openIndex(path: string, { source, fallback }: Opened, options: ExtractOptions): SharedIndex {
  const store = IndexStore.open(path)
  try {
    const indexer = new Indexer({
      store,
      source,
      extract: (message, session) => extractMessage(message, session, options),
      titleDoc: session => titleDoc(session, options),
      maskTitle: text => maskText(text, options.redact),
    })
    const shared = new SharedIndex(store, source, indexer, fallback)
    shared.start()
    return shared
  } catch (error) {
    store.close()
    throw error
  }
}

/**
 * `source` with every failed read reported as SOURCE_UNAVAILABLE, so neither the driver's message, which can repeat a
 * statement, nor a host error reaches a caller.
 */
function guarded(source: Source): Source {
  const read = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work()
    } catch {
      return fail("SOURCE_UNAVAILABLE")
    }
  }
  return {
    kind: source.kind,
    probe: () => source.probe(),
    session: id => read(() => source.session(id)),
    changedSessions: (since, limit) => read(() => source.changedSessions(since, limit)),
    sessionIDs: () => read(() => source.sessionIDs()),
    messages: (sessionID, fromSeq, limit) => read(() => source.messages(sessionID, fromSeq, limit)),
    message: (sessionID, at) => read(() => source.message(sessionID, at)),
    projects: () => read(() => source.projects()),
    todos: sessionID => read(() => source.todos(sessionID)),
    close: () => source.close(),
  }
}

/** A source, and why it is the plugin session API when it is. */
interface Opened {
  readonly source: Source
  readonly fallback: SourceFallback | undefined
}

/** OpenCode's database when it can be read; otherwise the plugin session API, which only has part of the history. */
async function openSource(database: string, session: RuntimeOptions["session"]): Promise<Opened> {
  const db = openOpencodeSource(database)
  const probe = await db.probe()
  if (probe.ok) return { source: guarded(db), fallback: undefined }
  db.close()
  return { source: guarded(contextSource(session)), fallback: probe.problem === "layout" ? "SOURCE_SCHEMA_UNKNOWN" : "SOURCE_UNAVAILABLE" }
}

/**
 * The registry key for an index: its path with the folder's symlinks resolved, so different spellings of one file share
 * one index, and the schema version, so a plugin build loaded into a process that already runs another build never
 * joins the index that build opened for its own schema.
 */
function indexKey(path: string): string {
  const full = resolve(path)
  let file: string
  try {
    file = join(realpathSync(dirname(full)), basename(full))
  } catch {
    file = full
  }
  return `${file}\u0000schema ${INDEX_SCHEMA_VERSION}`
}

/**
 * Opens the index for `config.indexPath`, or joins the plugin instance that already has it open, and returns at once;
 * indexing runs in the background. The first instance's source and extraction options serve every instance. Search,
 * sessions and recall first catch up for at most REFRESH_MS, so they see sessions changed since the last pass.
 */
export const createRuntime: CreateRuntime = async ({ config, session, generate }) => {
  const opened = await openSource(config.database, session)
  const extract: ExtractOptions = { ...DEFAULT_EXTRACT, ...config.index, redact: config.mask }
  let lease: Lease<SharedIndex>
  try {
    lease = acquire(indexKey(config.indexPath), () => openIndex(config.indexPath, opened, extract))
  } catch (error) {
    opened.source.close()
    if (error instanceof ForeignIndexError) return fail("INDEX_PATH_REFUSED", { message: INDEX_PATH_MESSAGES.foreign })
    return fail("INDEX_UNAVAILABLE")
  }
  const shared = lease.value
  if (shared.source !== opened.source) opened.source.close()

  const mask = (text: string) => maskText(text, config.mask)
  const state = () => shared.indexer.state()
  let closed = false
  const closing = new AbortController()
  const run = async <T>(operation: string, work: () => T | Promise<T>, fallback?: FailureCode): Promise<T> => {
    if (closed) fail("CLOSED")
    try {
      return await work()
    } catch (error) {
      throw closed ? new HistoryError("CLOSED") : toFailure(error, fallback, operation)
    }
  }

  /**
   * `work` over the index, while the file still has this build's schema. Another OpenCode process that runs another
   * version of the plugin rebuilds the file for its own schema when it opens it, and this build's queries would fail.
   */
  const query = <T>(operation: string, work: () => T | Promise<T>) =>
    run(operation, () => {
      if (shared.store.schemaVersion() !== String(INDEX_SCHEMA_VERSION)) fail("INDEX_MISMATCH")
      return work()
    })

  /** `query` once the index has caught up, or REFRESH_MS has passed. */
  const fresh = async <T>(query: () => T | Promise<T>) => {
    await shared.refresh(REFRESH_MS)
    return query()
  }

  return {
    ...(shared.fallback ? { fallback: shared.fallback } : {}),
    status: () => run("status", state, "STATUS_UNAVAILABLE"),
    schema: () => run("status", () => ({ file: shared.store.schemaVersion() ?? null, build: String(INDEX_SCHEMA_VERSION) }), "STATUS_UNAVAILABLE"),
    search: (caller, input) => query("search", () => fresh(() => search(shared.store.db, caller, input, state()))),
    sessions: (caller, input) => query("sessions", () => fresh(() => sessions(shared.store.db, caller, input, state()))),
    files: (caller, input) => query("files", () => files(shared.store.db, caller, input, state())),
    read: (_caller, input) => query("read", () => read(shared.store.db, shared.source, input, mask)),
    brief: (_caller, input) => query("brief", () => brief(shared.store.db, shared.source, input, mask)),
    // A closing instance stops its statements, so a reload never leaves one running.
    sql: (_caller, input, signal) =>
      query("sql", () => sql(shared.store.path, input, { signal: signal ? AbortSignal.any([signal, closing.signal]) : closing.signal, mask: config.mask })),
    recall: (caller, input) =>
      query("recall", () =>
        fresh(() => recall(shared.store.db, shared.source, caller, input, state(), (input.synthesize ?? config.recall.synthesize) ? generate : undefined, mask)),
      ),
    reindex: mode =>
      run("reindex", async () => {
        await (mode === "rebuild" ? shared.rebuild() : shared.catchUp())
        return state()
      }, "INDEX_FAILED"),
    onEvent(event) {
      if (closed) return
      try {
        shared.router.handle(event)
      } catch {
        // onEvent must never throw; the router records indexing errors in the indexer's health.
      }
    },
    async close() {
      if (closed) return
      closed = true
      closing.abort()
      lease.release()
    },
  }
}
