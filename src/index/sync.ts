// Keeps the index in step with the source, one session and one batch of messages at a time.
import type { IndexState } from "../domain/api.js"
import type { Doc, Extracted, FileTouch, Source, SourceMessage, SourceSession } from "../domain/contract.js"
import type { Batch, IndexedLink, IndexStore } from "./store.js"

/** Meta key: every session the source updated at or before this time (epoch ms) has been indexed. */
export const WATERMARK = "sync.watermark"
/**
 * Meta key: the latest time, by the indexer's clock, that the index is known to be in step with the source: when the
 * last finished catch-up, backfill or event-driven session sync started.
 */
export const SYNCED_AT = "sync.at"

export interface IndexerOptions {
  readonly store: IndexStore
  readonly source: Source
  /** Extract one message; facts are that message's alone. */
  readonly extract: (message: SourceMessage, session: SourceSession) => Extracted
  readonly titleDoc: (session: SourceSession) => Doc | null
  /** Messages per batch, and sessions per page of changes. */
  readonly batch?: number
  readonly now?: () => number
  /** Applied to the session title before anything is stored. */
  readonly maskTitle?: (text: string) => string
  /** Every error `health().lastError` records; `sessionID` is null when no single session failed. */
  readonly onError?: (error: unknown, sessionID: string | null) => void
}

export interface Progress {
  readonly done: number
  readonly total: number
  readonly failed: number
}

interface IndexError {
  readonly message: string
  readonly sessionID: string | null
  /** By the indexer's clock. */
  readonly at: number
}

interface Health extends IndexState {
  readonly lastError: IndexError | null
  /** Sessions waiting to be retried on the next catch-up. */
  readonly failedSessions: number
  readonly backfilling: boolean
}

type Job =
  | {
      readonly kind: "index"
      readonly session: SourceSession
      /** Sessions read alongside this one, for walking up to the root. */
      readonly known: ReadonlyMap<string, SourceSession>
      readonly signal?: AbortSignal
    }
  | { readonly kind: "delete"; readonly id: string }

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

/**
 * Runs one job per key at a time. Calls made during a run share a single rerun; `merge` picks its argument from the
 * one already queued and the newest.
 */
class Serial<A> {
  private readonly jobs = new Map<string, { arg: A; again: boolean; done: Promise<void> }>()

  constructor(
    private readonly fn: (arg: A) => Promise<void>,
    private readonly merge: (queued: A, next: A) => A = (_, next) => next,
  ) {}

  run(key: string, arg: A): Promise<void> {
    const running = this.jobs.get(key)
    if (running) {
      running.arg = running.again ? this.merge(running.arg, arg) : arg
      running.again = true
      return running.done
    }
    const job = { arg, again: true, done: Promise.resolve() }
    this.jobs.set(key, job)
    job.done = this.loop(key, job)
    return job.done
  }

  private async loop(key: string, job: { arg: A; again: boolean }): Promise<void> {
    try {
      let failure: { error: unknown } | null = null
      while (job.again) {
        job.again = false
        try {
          await this.fn(job.arg)
          failure = null
        } catch (error) {
          failure = { error }
        }
      }
      if (failure) throw failure.error
    } finally {
      this.jobs.delete(key)
    }
  }
}

export class Indexer {
  private readonly store: IndexStore
  private readonly source: Source
  private readonly extract: IndexerOptions["extract"]
  private readonly titleDoc: IndexerOptions["titleDoc"]
  private readonly batch: number
  private readonly now: () => number
  private readonly maskTitle: (text: string) => string
  private readonly onError: IndexerOptions["onError"]
  // A queued delete is never replaced by a sync.
  private readonly sessions = new Serial<Job>(
    job => (job.kind === "delete" ? this.remove(job.id) : this.index(job)),
    (queued, next) => (queued.kind === "delete" ? queued : next),
  )
  private readonly passes = new Serial<void>(() => this.pass())
  /** Sessions that failed in a pass, retried on the next catch-up. */
  private readonly failed = new Map<string, SourceSession>()
  /** Sessions deleted in this process. IDs are not reused, so they are never indexed again. */
  private readonly deleted = new Set<string>()
  /** One set per running reconcile, collecting sessions written while it waits for the source. */
  private readonly written = new Set<Set<string>>()
  private backfilling = 0
  private total: number | null = null
  private lastError: IndexError | null = null

  constructor(options: IndexerOptions) {
    this.store = options.store
    this.source = options.source
    this.extract = options.extract
    this.titleDoc = options.titleDoc
    this.batch = Math.max(1, Math.floor(options.batch ?? 200))
    this.now = options.now ?? Date.now
    this.maskTitle = options.maskTitle ?? (text => text)
    this.onError = options.onError
  }

  /**
   * Index one session from where it was left. False when the source does not have it or it was deleted. Session events
   * say what changed, so a finished sync also counts as being in step for the lag.
   */
  syncSession(id: string): Promise<boolean> {
    return this.recorded(id, async () => {
      if (this.deleted.has(id)) return false
      const started = this.now()
      const session = await this.source.session(id)
      if (!session) return false
      await this.sessions.run(id, { kind: "index", session, known: new Map() })
      this.failed.delete(id)
      if (this.deleted.has(id)) return false
      this.synced(started)
      return true
    })
  }

  /** Delete a session from the index once any sync of it in flight has stopped. */
  deleteSession(id: string): Promise<void> {
    this.deleted.add(id)
    this.failed.delete(id)
    return this.recorded(id, () => this.sessions.run(id, { kind: "delete", id }))
  }

  /** Index every session changed since the watermark, advancing it page by page. Does nothing while a backfill runs. */
  catchUp(): Promise<void> {
    if (this.backfilling > 0) return Promise.resolve()
    return this.recorded(null, () => this.passes.run("catch-up", undefined))
  }

  /** Index every session, newest first, then set the watermark. Rejects with the abort reason when `signal` aborts. */
  async backfill(signal?: AbortSignal, onProgress?: (progress: Progress) => void): Promise<void> {
    this.backfilling++
    try {
      await this.recorded(null, async () => {
        const started = this.now()
        const all: SourceSession[] = []
        for await (const { sessions } of this.changes(-1)) {
          signal?.throwIfAborted()
          all.push(...sessions)
        }
        all.sort((a, b) => b.updated - a.updated || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        this.total = all.length
        this.store.upsertProjects(await this.source.projects())
        const known = new Map(all.map(session => [session.id, session]))
        let done = 0
        let failed = 0
        onProgress?.({ done, total: all.length, failed })
        for (const session of all) {
          signal?.throwIfAborted()
          if (!(await this.attempt(session, known, signal))) failed++
          done++
          onProgress?.({ done, total: all.length, failed })
        }
        const watermark = all.reduce((max, session) => Math.max(max, session.updated), this.watermark() ?? -1)
        this.store.setMeta(WATERMARK, String(watermark))
        this.synced(started)
      }, signal)
    } finally {
      this.backfilling--
    }
  }

  /** Delete indexed sessions the source no longer has, and return their IDs. Skipped when the source has none but the index has some. */
  reconcile(): Promise<string[]> {
    return this.recorded(null, async () => {
      const written = new Set<string>()
      this.written.add(written)
      try {
        const ids = await this.source.sessionIDs()
        if (ids.size === 0 && this.store.sessionCount() > 0) return []
        this.total = ids.size
        // A session written while the source was listing may be newer than the list.
        const gone = this.store.prune(written.size > 0 ? new Set([...ids, ...written]) : ids)
        for (const id of gone) this.failed.delete(id)
        return gone
      } finally {
        this.written.delete(written)
      }
    })
  }

  state(): IndexState {
    const ready = this.watermark() !== undefined
    const syncedAt = Number(this.store.meta(SYNCED_AT))
    const indexed = this.store.sessionCount()
    return {
      ready,
      sessionsIndexed: indexed,
      sessionsTotal: Math.max(this.total ?? 0, indexed),
      lagSeconds: Number.isFinite(syncedAt) ? Math.max(0, Math.round((this.now() - syncedAt) / 1000)) : 0,
      source: this.source.kind,
      complete: ready && this.source.kind === "opencode-db" && this.failed.size === 0,
    }
  }

  /** `state()` plus what went wrong, for status reporting. `lastError` stays until a newer error replaces it. */
  health(): Health {
    return { ...this.state(), lastError: this.lastError, failedSessions: this.failed.size, backfilling: this.backfilling > 0 }
  }

  private record(error: unknown, sessionID: string | null): void {
    this.lastError = { message: error instanceof Error ? error.message : String(error), sessionID, at: this.now() }
    this.onError?.(error, sessionID)
  }

  /** Run `fn`, recording its error unless it was an abort through `signal`, and rethrow. */
  private async recorded<T>(sessionID: string | null, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (!signal?.aborted) this.record(error, sessionID)
      throw error
    }
  }

  private async pass(): Promise<void> {
    const started = this.now()
    for (const session of [...this.failed.values()]) await this.attempt(session, new Map())
    let projects = false
    for await (const { sessions, upTo } of this.changes(this.watermark() ?? -1)) {
      if (!projects) {
        this.store.upsertProjects(await this.source.projects())
        projects = true
      }
      const known = new Map(sessions.map(session => [session.id, session]))
      for (const session of sessions) await this.attempt(session, known)
      this.store.setMeta(WATERMARK, String(upTo))
    }
    this.synced(started)
  }

  /** Record that the index was in step with the source at `at`, unless a later sync has already said so. */
  private synced(at: number): void {
    const previous = Number(this.store.meta(SYNCED_AT))
    if (!(previous >= at)) this.store.setMeta(SYNCED_AT, String(at))
  }

  /** Index a session for a pass. A failure is recorded and kept for the next catch-up instead of stopping the pass. */
  private async attempt(session: SourceSession, known: ReadonlyMap<string, SourceSession>, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.sessions.run(session.id, { kind: "index", session, known, signal })
      this.failed.delete(session.id)
      return true
    } catch (error) {
      if (signal?.aborted) throw error
      this.failed.set(session.id, session)
      this.record(error, session.id)
      return false
    }
  }

  private async remove(id: string): Promise<void> {
    this.store.deleteSessions([id])
  }

  private async index({ session: source, known, signal }: Extract<Job, { kind: "index" }>): Promise<void> {
    if (this.deleted.has(source.id)) return
    const session = { ...source, title: this.maskTitle(source.title) }
    const rootID = await this.rootOf(session, known)
    const state = this.store.sessionState(session.id)
    // Context sessions renumber their messages after a compaction, so they are always indexed from the start.
    let from = state && this.source.kind !== "context" ? Math.max(0, this.store.restartSeq(session.id, state.indexedSeq)) : 0
    for (let first = true; ; first = false) {
      signal?.throwIfAborted()
      const messages = await this.source.messages(session.id, from, this.batch)
      signal?.throwIfAborted()
      if (this.deleted.has(session.id)) return
      const final = messages.length < this.batch
      // The newest message is the one most likely to change, so it gets a batch of its own that is cheap to re-read.
      const parts = final && messages.length > 1 ? [messages.slice(0, -1), messages.slice(-1)] : [messages]
      const writes = parts.map((part, i) => ({
        range: { from: i === 0 ? from : part[0]!.seq, to: part.length > 0 ? part[part.length - 1]!.seq : from - 1 },
        batch: this.combine(session, part),
      }))
      const title = first ? this.titleDoc(session) : undefined
      this.store.transaction(() => {
        if (title !== undefined) this.store.writeTitle(session.id, rootID, title)
        for (const { range, batch } of writes) this.store.writeBatch(session, rootID, range, batch)
      })
      for (const written of this.written) written.add(session.id)
      await tick()
      if (final) return
      from = messages[messages.length - 1]!.seq + 1
    }
  }

  /** Merge per-message extracts: counts add up, the first prompt is the earliest, the last reply and outcome the latest. */
  private combine(session: SourceSession, messages: readonly SourceMessage[]): Batch {
    const docs: Doc[] = []
    const files: FileTouch[] = []
    const links: IndexedLink[] = []
    const facts = { messages: 0, userMessages: 0, compactions: 0, toolCalls: 0, firstPrompt: null as string | null, lastReply: null as string | null, outcome: null as string | null }
    for (const message of messages) {
      const extracted = this.extract(message, session)
      docs.push(...extracted.docs)
      files.push(...extracted.files)
      for (const link of extracted.links) links.push({ ...link, seq: message.seq })
      facts.messages += extracted.facts.messages ?? 0
      facts.userMessages += extracted.facts.userMessages ?? 0
      facts.compactions += extracted.facts.compactions ?? 0
      facts.toolCalls += extracted.facts.toolCalls ?? 0
      facts.firstPrompt ??= extracted.facts.firstPrompt ?? null
      facts.lastReply = extracted.facts.lastReply ?? facts.lastReply
      facts.outcome = extracted.facts.outcome ?? facts.outcome
    }
    return { docs, files, links, facts }
  }

  /**
   * Walk parent IDs through the sessions read alongside this one, the store, then the source. A parent found nowhere is
   * taken as the root; the store moves this session to the real root if that parent is indexed later.
   */
  private async rootOf(session: SourceSession, known: ReadonlyMap<string, SourceSession>): Promise<string> {
    const seen = new Set<string>()
    let current = session
    while (current.parentID && !seen.has(current.id)) {
      seen.add(current.id)
      let parent = known.get(current.parentID)
      if (!parent) {
        const stored = this.store.sessionState(current.parentID)
        if (stored) return stored.rootID
        parent = await this.source.session(current.parentID)
        if (!parent) return current.parentID
      }
      current = parent
    }
    return current.id
  }

  /** Sessions updated after `since`, a page at a time. `upTo` is the watermark once the page is indexed. */
  private async *changes(since: number): AsyncGenerator<{ readonly sessions: readonly SourceSession[]; readonly upTo: number }> {
    let limit = this.batch
    for (;;) {
      const page = await this.source.changedSessions(since, limit)
      await tick()
      const times = page.map(session => session.updated)
      const last = times.reduce((max, time) => Math.max(max, time), since)
      if (page.length < limit) {
        if (page.length > 0) yield { sessions: page, upTo: last }
        return
      }
      // Pages are cut by update time alone, so a full page can end partway through sessions updated at the same time.
      // Hold the last time back for the next page, or widen the page when a single time fills it.
      if (times.every(time => time === last)) {
        limit *= 2
        continue
      }
      limit = this.batch
      yield { sessions: page.filter(session => session.updated < last), upTo: last - 1 }
      since = last - 1
    }
  }

  private watermark(): number | undefined {
    const value = Number(this.store.meta(WATERMARK))
    return Number.isFinite(value) ? value : undefined
  }
}
