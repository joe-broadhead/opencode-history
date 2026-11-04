// The plugin's own index file: open it, rebuild it on a schema change, and write sessions batch by batch.
import { closeSync, mkdirSync, openSync } from "node:fs"
import { dirname } from "node:path"
import type { Doc, Extracted, SessionFacts, SessionLink, SourceProject, SourceSession } from "../domain/contract.js"
import { openDb, type Db } from "../domain/sqlite.js"
import { SCHEMA_VERSION, TABLES, TRIGGERS, VIEWS } from "./schema.js"

/** Messages with seq from `from` to `to`, both inclusive; empty when `to < from`. */
export interface SeqRange {
  readonly from: number
  readonly to: number
}

/** A link with the seq of the message it was found in. */
export interface IndexedLink extends SessionLink {
  readonly seq: number
}

/** What one write puts in the index: extracted text, file touches and links for one seq range. */
export interface Batch extends Omit<Extracted, "links"> {
  readonly links: readonly IndexedLink[]
}

/** The seq title docs are stored at, outside every message range. */
export const TITLE_SEQ = -1

/** What sync needs to decide whether and where to re-index a session. */
export interface SessionState {
  readonly rootID: string
  readonly updated: number
  readonly indexedSeq: number
  readonly indexedAt: number
}

/** A write started inside a range written earlier; re-index from `restart` instead. */
export class SeqStraddleError extends Error {
  constructor(
    readonly sessionID: string,
    readonly seq: number,
    readonly restart: number,
  ) {
    super(`history index: seq ${seq} of session ${sessionID} is inside an indexed range; re-index from seq ${restart}`)
    this.name = "SeqStraddleError"
  }
}

const COUNTS = ["messages", "userMessages", "compactions", "toolCalls"] as const

/**
 * The SQLite application id ("HIST") the plugin writes into its own index file. Only a file that carries it, or one
 * that holds no tables at all, is ever changed: any other file is refused, so `indexPath` cannot damage a database
 * the plugin did not create.
 */
export const APPLICATION_ID = 0x48495354

/** `indexPath` names an existing SQLite file, or other file, that is not a History index. The file is left as it was. */
export class ForeignIndexError extends Error {
  constructor(readonly path: string) {
    super("history index: indexPath names an existing file that is not a History index")
    this.name = "ForeignIndexError"
  }
}

/** True when the open file is this plugin's index, or a database with nothing in it. Reads only. */
function ownFile(db: Db): boolean {
  let application: number | undefined
  let objects: number
  try {
    application = db.get<{ application_id: number }>("pragma application_id")?.application_id
    objects = Number(db.get<{ n: number }>("select count(*) as n from sqlite_master")?.n ?? 0)
  } catch {
    // Not a SQLite database at all, or one SQLite cannot read: never ours.
    return false
  }
  return application === APPLICATION_ID || (objects === 0 && (application ?? 0) === 0)
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

function schemaVersion(db: Db): string | undefined {
  if (!db.get("select 1 from sqlite_master where type = 'table' and name = 'meta'")) return undefined
  return db.get<{ value: string }>("select value from meta where key = 'schema_version'")?.value
}

/** Drop views, triggers and tables. Virtual tables go first so their shadow tables go with them. */
function dropAll(db: Db): void {
  for (const { type, name } of db.all<{ type: string; name: string }>("select type, name from sqlite_master where type in ('view', 'trigger')")) {
    db.exec(`drop ${type} if exists ${quote(name)}`)
  }
  for (const { name } of db.all<{ name: string }>("select name from sqlite_master where type = 'table' and sql like 'create virtual table%'")) {
    db.exec(`drop table if exists ${quote(name)}`)
  }
  for (const { name } of db.all<{ name: string }>("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")) {
    db.exec(`drop table if exists ${quote(name)}`)
  }
}

function create(db: Db): void {
  db.exec(`pragma application_id = ${APPLICATION_ID}`)
  for (const sql of [...TABLES, ...TRIGGERS, ...VIEWS]) db.exec(sql)
  db.run("insert into meta (key, value) values ('schema_version', ?) on conflict(key) do update set value = excluded.value", String(SCHEMA_VERSION))
}

function checkRange(range: SeqRange): void {
  if (!Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from < 0) {
    throw new Error(`history index: bad seq range ${range.from}..${range.to}`)
  }
}

export class IndexStore {
  private depth = 0

  private constructor(
    readonly db: Db,
    readonly path: string,
  ) {}

  /**
   * Opens the index at `path`, creating it when it is missing. An existing file is used only when it is a History
   * index (it carries APPLICATION_ID) or an empty database; anything else throws ForeignIndexError before a single
   * byte of it is written. Only a file this call creates gets the private mode.
   */
  static open(path: string): IndexStore {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    // Create the file private, and only if it is new, so SQLite gives its -wal and -shm files the same mode.
    try {
      closeSync(openSync(path, "wx", 0o600))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const db = openDb(path)
    try {
      // Reads only: a file that is not ours is closed unchanged.
      if (!ownFile(db)) throw new ForeignIndexError(path)
      db.exec("pragma journal_mode = wal")
      db.exec("pragma synchronous = normal")
      db.transaction(() => {
        if (schemaVersion(db) !== String(SCHEMA_VERSION)) dropAll(db)
        create(db)
      })
    } catch (error) {
      db.close()
      throw error
    }
    return new IndexStore(db, path)
  }

  /** Run `fn` in one transaction; store calls inside it join that transaction. Use this, not `db.transaction`, to group store calls. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn()
    this.depth++
    try {
      return this.db.transaction(fn)
    } finally {
      this.depth--
    }
  }

  /**
   * Drop everything and recreate an empty index. The dropped pages are overwritten with zeros and the write-ahead log is
   * emptied, so text stored before, such as a secret masked only by a newer pattern, does not stay in the file.
   */
  reset(): void {
    this.db.exec("pragma secure_delete = on")
    try {
      this.transaction(() => {
        dropAll(this.db)
        create(this.db)
      })
    } finally {
      this.db.exec("pragma secure_delete = off")
    }
    this.db.exec("pragma wal_checkpoint(truncate)")
  }

  /** The schema version the file is at now, which another process running another plugin version may have changed. */
  schemaVersion(): string | undefined {
    return schemaVersion(this.db)
  }

  meta(key: string): string | undefined {
    return this.db.get<{ value: string }>("select value from meta where key = ?", key)?.value
  }

  setMeta(key: string, value: string): void {
    this.db.run("insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value", key, value)
  }

  upsertProjects(projects: readonly SourceProject[]): void {
    this.transaction(() => {
      for (const project of projects) {
        this.db.run(
          "insert into projects (id, worktree, name) values (?, ?, ?) on conflict(id) do update set worktree = excluded.worktree, name = excluded.name",
          project.id,
          project.worktree,
          project.name,
        )
      }
    })
  }

  /**
   * Write a session's metadata and merge `facts`. Sessions whose root was guessed as this session's ID move to its root.
   *
   * `lastReply` and `outcome` overwrite when given as a string; null or missing keeps the stored value. `firstPrompt`
   * only fills an empty value, so the earliest one wins. When `range.from` is 0 the whole session is being re-indexed,
   * so all three are replaced and missing ones become null.
   *
   * Counts need `range`: they are the counts of the messages in that range. Everything recorded at seq >= `range.from`
   * (counts, docs, files, links) is replaced, and the session's counts are the sum over all recorded ranges. Writing the
   * same range twice leaves the same totals. `range.from` must not fall inside a range written earlier; see `restartSeq`.
   */
  upsertSession(session: SourceSession, rootID: string, facts: Partial<SessionFacts> = {}, range?: SeqRange): void {
    this.transaction(() => this.writeSession(session, rootID, facts, range))
  }

  /** Replace everything indexed for `session` at seq >= `range.from` with one batch, in one transaction. */
  writeBatch(session: SourceSession, rootID: string, range: SeqRange, batch: Batch): void {
    this.transaction(() => {
      this.writeSession(session, rootID, batch.facts, range)
      const inRange = (what: string, sessionID: string, seq: number) => {
        if (sessionID !== session.id || seq < range.from || seq > range.to) {
          throw new Error(`history index: ${what} at ${sessionID}#${seq} is outside ${session.id}#${range.from}..${range.to}`)
        }
      }
      for (const doc of batch.docs) {
        inRange("doc", doc.sessionID, doc.seq)
        this.insertDoc(doc, rootID, doc.seq, doc.part)
      }
      for (const file of batch.files) {
        inRange("file", file.sessionID, file.seq)
        this.db.run(
          "insert into files (session_id, root_id, message_id, seq, time, path, op, tool) values (?, ?, ?, ?, ?, ?, ?, ?)",
          file.sessionID,
          rootID,
          file.messageID,
          file.seq,
          file.time,
          file.path,
          file.op,
          file.tool,
        )
      }
      for (const link of batch.links) {
        inRange(`link to ${link.childID}`, link.parentID, link.seq)
        this.db.run(
          `insert into links (parent_id, child_id, message_id, seq, description, agent) values (?, ?, ?, ?, ?, ?)
            on conflict(child_id) do update set parent_id = excluded.parent_id, message_id = excluded.message_id,
              seq = excluded.seq, description = excluded.description, agent = excluded.agent`,
          link.parentID,
          link.childID,
          link.messageID,
          link.seq,
          link.description,
          link.agent,
        )
      }
    })
  }

  /** Replace the session's title doc, or remove it when `doc` is null. It is stored as part 0 at `TITLE_SEQ`. */
  writeTitle(sessionID: string, rootID: string, doc: Doc | null): void {
    if (doc && doc.sessionID !== sessionID) throw new Error(`history index: title doc of ${doc.sessionID} written for ${sessionID}`)
    this.transaction(() => {
      this.db.run("delete from docs where session_id = ? and seq = ?", sessionID, TITLE_SEQ)
      if (doc) this.insertDoc(doc, rootID, TITLE_SEQ, 0)
    })
  }

  sessionCount(): number {
    return this.db.get<{ n: number }>("select count(*) as n from sessions")?.n ?? 0
  }

  /** The seq to re-index from to cover `seq`: the start of the written range that holds it, otherwise `seq`. */
  restartSeq(sessionID: string, seq: number): number {
    const row = this.db.get<{ from_seq: number }>(
      "select from_seq from batches where session_id = ? and from_seq < ? and to_seq >= ?",
      sessionID,
      seq,
      seq,
    )
    return row?.from_seq ?? seq
  }

  sessionState(sessionID: string): SessionState | undefined {
    const row = this.db.get<{ root_id: string; updated: number; indexed_seq: number; indexed_at: number }>(
      "select root_id, updated, indexed_seq, indexed_at from sessions where id = ?",
      sessionID,
    )
    return row && { rootID: row.root_id, updated: row.updated, indexedSeq: row.indexed_seq, indexedAt: row.indexed_at }
  }

  deleteSessions(ids: Iterable<string>): void {
    this.transaction(() => {
      for (const id of ids) {
        this.db.run("delete from docs where session_id = ?", id)
        this.db.run("delete from files where session_id = ?", id)
        this.db.run("delete from batches where session_id = ?", id)
        this.db.run("delete from links where child_id = ? or parent_id = ?", id, id)
        this.db.run("delete from sessions where id = ?", id)
      }
    })
  }

  /** Delete every indexed session not in `keep`, and return their IDs. */
  prune(keep: ReadonlySet<string>): string[] {
    return this.transaction(() => {
      const gone = this.db
        .all<{ id: string }>("select id from sessions")
        .map(row => row.id)
        .filter(id => !keep.has(id))
      this.deleteSessions(gone)
      return gone
    })
  }

  close(): void {
    this.db.close()
  }

  private writeSession(session: SourceSession, rootID: string, facts: Partial<SessionFacts>, range: SeqRange | undefined): void {
    if (!range && COUNTS.some(key => facts[key] !== undefined)) {
      throw new Error("history index: session counts need the seq range they were counted over")
    }
    if (range) {
      checkRange(range)
      const restart = this.restartSeq(session.id, range.from)
      if (restart !== range.from) throw new SeqStraddleError(session.id, range.from, restart)
    }

    const previous = this.db.get<{ root_id: string }>("select root_id from sessions where id = ?", session.id)
    this.db.run(
      `insert into sessions (id, parent_id, root_id, project_id, directory, title, agent, model, cost, tokens_input, tokens_output,
          created, updated, archived, indexed_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set parent_id = excluded.parent_id, root_id = excluded.root_id, project_id = excluded.project_id,
          directory = excluded.directory, title = excluded.title, agent = excluded.agent, model = excluded.model, cost = excluded.cost,
          tokens_input = excluded.tokens_input, tokens_output = excluded.tokens_output, created = excluded.created,
          updated = excluded.updated, archived = excluded.archived, indexed_at = excluded.indexed_at`,
      session.id,
      session.parentID,
      rootID,
      session.projectID,
      session.directory,
      session.title,
      session.agent,
      session.model,
      session.cost,
      session.tokensInput,
      session.tokensOutput,
      session.created,
      session.updated,
      session.archived,
      Date.now(),
    )
    if (previous && previous.root_id !== rootID) this.moveRoot(session.id, rootID)
    // A session indexed before its parent could only guess the parent's ID as its root.
    if (rootID !== session.id) {
      for (const { id } of this.db.all<{ id: string }>("select id from sessions where root_id = ? and id != ?", session.id, session.id)) {
        this.db.run("update sessions set root_id = ? where id = ?", rootID, id)
        this.moveRoot(id, rootID)
      }
    }

    const text = (value: string | null | undefined) => (typeof value === "string" ? value : null)
    this.db.run(
      range?.from === 0
        ? "update sessions set first_prompt = ?, last_reply = ?, outcome = ? where id = ?"
        : "update sessions set first_prompt = coalesce(first_prompt, ?), last_reply = coalesce(?, last_reply), outcome = coalesce(?, outcome) where id = ?",
      text(facts.firstPrompt),
      text(facts.lastReply),
      text(facts.outcome),
      session.id,
    )

    if (!range) return
    this.db.run("delete from batches where session_id = ? and from_seq >= ?", session.id, range.from)
    this.db.run("delete from docs where session_id = ? and seq >= ?", session.id, range.from)
    this.db.run("delete from files where session_id = ? and seq >= ?", session.id, range.from)
    this.db.run("delete from links where parent_id = ? and seq >= ?", session.id, range.from)
    if (range.to >= range.from) {
      this.db.run(
        "insert into batches (session_id, from_seq, to_seq, messages, user_messages, compactions, tool_calls) values (?, ?, ?, ?, ?, ?, ?)",
        session.id,
        range.from,
        range.to,
        facts.messages ?? 0,
        facts.userMessages ?? 0,
        facts.compactions ?? 0,
        facts.toolCalls ?? 0,
      )
    }
    this.db.run(
      `update sessions set (messages, user_messages, compactions, tool_calls, indexed_seq) = (
          select coalesce(sum(messages), 0), coalesce(sum(user_messages), 0), coalesce(sum(compactions), 0),
            coalesce(sum(tool_calls), 0), coalesce(max(to_seq), -1)
          from batches where session_id = ?)
        where id = ?`,
      session.id,
      session.id,
    )
  }

  /** A doc's metadata, then its text under the same ID; the text's trigger indexes it. */
  private insertDoc(doc: Doc, rootID: string, seq: number, part: number): void {
    this.db.run(
      "insert into docs (session_id, root_id, message_id, seq, part, time, kind, tool) values (?, ?, ?, ?, ?, ?, ?, ?)",
      doc.sessionID,
      rootID,
      doc.messageID,
      seq,
      part,
      doc.time,
      doc.kind,
      doc.tool,
    )
    this.db.run("insert into doc_texts (id, text) values (last_insert_rowid(), ?)", doc.text)
  }

  /** Point the docs and files of one session at a new root. */
  private moveRoot(sessionID: string, rootID: string): void {
    this.db.run("update docs set root_id = ? where session_id = ?", rootID, sessionID)
    this.db.run("update files set root_id = ? where session_id = ?", rootID, sessionID)
  }
}
