import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Doc, FileTouch, SourceSession } from "../../../src/domain/contract.js"
import { openDb } from "../../../src/domain/sqlite.js"
import { SCHEMA_VERSION, VIEW_NAMES } from "../../../src/index/schema.js"
import { APPLICATION_ID, ForeignIndexError, IndexStore, SeqStraddleError, TITLE_SEQ, type Batch, type IndexedLink } from "../../../src/index/store.js"

let dir: string
let path: string
let store: IndexStore

const session = (over: Partial<SourceSession> = {}): SourceSession => ({
  id: "ses_a",
  parentID: null,
  projectID: "prj_1",
  directory: "/work/app",
  title: "Fix the login bug",
  agent: "build",
  model: "anthropic/claude",
  cost: 0.5,
  tokensInput: 100,
  tokensOutput: 50,
  created: 1_000,
  updated: 2_000,
  archived: null,
  ...over,
})

const doc = (seq: number, text: string, over: Partial<Doc> = {}): Doc => ({
  sessionID: "ses_a",
  messageID: `msg_${seq}`,
  seq,
  part: 0,
  time: 1_000 + seq,
  kind: "user",
  tool: null,
  text,
  ...over,
})

const file = (seq: number, path: string, over: Partial<FileTouch> = {}): FileTouch => ({
  sessionID: "ses_a",
  messageID: `msg_${seq}`,
  seq,
  time: 1_000 + seq,
  path,
  op: "edit",
  tool: "edit",
  ...over,
})

const batch = (over: Partial<Batch> = {}): Batch => ({ docs: [], files: [], links: [], facts: {}, ...over })

const row = (sql: string, ...params: (string | number)[]) => store.db.get<Record<string, unknown>>(sql, ...params)
const count = (sql: string, ...params: (string | number)[]) => Number(Object.values(row(sql, ...params) ?? {})[0])
const counts = () => row("select messages, user_messages, compactions, tool_calls, indexed_seq from sessions where id = 'ses_a'")
const words = (query: string) => count("select count(*) from docs_words where docs_words match ?", query)
const sub = (text: string) => count("select count(*) from docs_sub where text like ?", `%${text}%`)
/** Both full-text tables match their content, and every doc has exactly its one text. */
const ftsIntact = () => {
  store.db.exec("insert into docs_words(docs_words) values ('integrity-check')")
  store.db.exec("insert into docs_sub(docs_sub) values ('integrity-check')")
  expect(count("select count(*) from doc_texts t left join docs d on d.id = t.id where d.id is null")).toBe(0)
  expect(count("select count(*) from docs d left join doc_texts t on t.id = d.id where t.id is null")).toBe(0)
}
const snapshot = () => ({
  session: row("select * from sessions where id = 'ses_a'"),
  docs: store.db.all("select session_id, root_id, message_id, seq, part, kind, tool, text from v_docs order by seq, part"),
  files: store.db.all("select * from files order by seq, path"),
  links: store.db.all("select * from links order by child_id"),
  batches: store.db.all("select * from batches order by session_id, from_seq"),
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "history-store-"))
  path = join(dir, "state", "history", "index.db")
  store = IndexStore.open(path)
})

afterEach(() => {
  try {
    store.close()
  } catch {}
  rmSync(dir, { recursive: true, force: true })
})

describe("IndexStore.open", () => {
  it("creates a private directory and file", () => {
    expect(statSync(join(dir, "state", "history")).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(store.path).toBe(path)
  })

  it("uses WAL with synchronous NORMAL", () => {
    expect(row("pragma journal_mode")).toEqual({ journal_mode: "wal" })
    expect(row("pragma synchronous")).toEqual({ synchronous: 1 })
  })

  it("applies tables, triggers and views and records the schema version", () => {
    const names = store.db.all<{ name: string }>("select name from sqlite_master").map(r => r.name)
    for (const name of ["meta", "projects", "sessions", "docs", "doc_texts", "docs_words", "docs_sub", "files", "links", "batches", "doc_texts_ai", "doc_texts_ad", "docs_ad", ...VIEW_NAMES]) {
      expect(names).toContain(name)
    }
    expect(store.meta("schema_version")).toBe(String(SCHEMA_VERSION))
  })

  it("keeps data when reopened at the same version", () => {
    store.writeBatch(session(), "ses_a", { from: 0, to: 0 }, batch({ docs: [doc(0, "keep me")], facts: { messages: 1 } }))
    store.close()
    store = IndexStore.open(path)
    expect(words("keep")).toBe(1)
    expect(counts()?.messages).toBe(1)
  })

  it("drops everything and rebuilds when the schema version differs", () => {
    store.writeBatch(session(), "ses_a", { from: 0, to: 0 }, batch({ docs: [doc(0, "old text")], facts: { messages: 1 } }))
    store.db.exec("create table stray (x)")
    store.db.exec("create view v_stray as select 1")
    store.setMeta("schema_version", String(SCHEMA_VERSION + 1))
    store.setMeta("cursor", "123")
    store.close()

    store = IndexStore.open(path)
    expect(store.meta("schema_version")).toBe(String(SCHEMA_VERSION))
    expect(store.meta("cursor")).toBeUndefined()
    expect(row("select name from sqlite_master where name in ('stray', 'v_stray')")).toBeUndefined()
    expect(count("select count(*) from sessions")).toBe(0)
    expect(count("select count(*) from docs")).toBe(0)
    expect(words("old")).toBe(0)
    store.writeBatch(session(), "ses_a", { from: 0, to: 0 }, batch({ docs: [doc(0, "new text")] }))
    expect(words("new")).toBe(1)
    ftsIntact()
  })

  it("marks the file as a History index with its application id", () => {
    expect(row("pragma application_id")).toEqual({ application_id: APPLICATION_ID })
  })

  it("refuses an existing database that is not a History index, and leaves it exactly as it was", () => {
    store.close()
    const victim = join(dir, "victim.db")
    const foreign = openDb(victim)
    foreign.exec("create table precious (x)")
    foreign.exec("create table other (y)")
    foreign.run("insert into precious values (?)", "keep")
    foreign.close()
    chmodSync(victim, 0o644)
    const before = readFileSync(victim)

    expect(() => IndexStore.open(victim)).toThrow(ForeignIndexError)
    expect(readFileSync(victim).equals(before)).toBe(true)
    expect(statSync(victim).mode & 0o777).toBe(0o644)
    const check = openDb(victim, { readOnly: true })
    expect(check.all("select name from sqlite_master order by name")).toEqual([{ name: "other" }, { name: "precious" }])
    expect(check.get("pragma journal_mode")).toEqual({ journal_mode: "delete" })
    check.close()
    store = IndexStore.open(path)
  })

  it("refuses a database whose tables mimic the index's meta table but lack the application id", () => {
    store.close()
    const victim = join(dir, "lookalike.db")
    const foreign = openDb(victim)
    foreign.exec("create table meta (key text primary key, value text not null)")
    foreign.run("insert into meta values ('schema_version', ?)", String(SCHEMA_VERSION))
    foreign.close()
    expect(() => IndexStore.open(victim)).toThrow(ForeignIndexError)
    const check = openDb(victim, { readOnly: true })
    expect(check.all("select name from sqlite_master")).toEqual([{ name: "meta" }, { name: "sqlite_autoindex_meta_1" }])
    check.close()
    store = IndexStore.open(path)
  })

  it("refuses a file that is not a SQLite database, unchanged", () => {
    store.close()
    const notes = join(dir, "notes.txt")
    writeFileSync(notes, "my notes, not a database\n".repeat(20))
    const before = readFileSync(notes)
    expect(() => IndexStore.open(notes)).toThrow(ForeignIndexError)
    expect(readFileSync(notes).equals(before)).toBe(true)
    store = IndexStore.open(path)
  })

  it("uses an existing empty file, but leaves its mode alone because the plugin did not create it", () => {
    store.close()
    const empty = join(dir, "empty.db")
    writeFileSync(empty, "")
    chmodSync(empty, 0o640)
    store = IndexStore.open(empty)
    expect(store.meta("schema_version")).toBe(String(SCHEMA_VERSION))
    expect(statSync(empty).mode & 0o777).toBe(0o640)
  })

  it("reset empties the index", () => {
    store.writeBatch(session(), "ses_a", { from: 0, to: 0 }, batch({ docs: [doc(0, "gone soon")] }))
    store.reset()
    expect(count("select count(*) from sessions")).toBe(0)
    expect(words("gone")).toBe(0)
    expect(store.meta("schema_version")).toBe(String(SCHEMA_VERSION))
  })
})

describe("meta and projects", () => {
  it("gets and sets meta values", () => {
    expect(store.meta("cursor")).toBeUndefined()
    store.setMeta("cursor", "1")
    store.setMeta("cursor", "2")
    expect(store.meta("cursor")).toBe("2")
  })

  it("upserts projects", () => {
    store.upsertProjects([
      { id: "prj_1", worktree: "/work/app", name: null },
      { id: "prj_2", worktree: "/work/lib", name: "lib" },
    ])
    store.upsertProjects([{ id: "prj_1", worktree: "/work/app2", name: "app" }])
    expect(store.db.all("select * from projects order by id")).toEqual([
      { id: "prj_1", worktree: "/work/app2", name: "app" },
      { id: "prj_2", worktree: "/work/lib", name: "lib" },
    ])
    store.upsertSession(session(), "ses_a")
    expect(row("select project from v_sessions")).toEqual({ project: "/work/app2" })
  })
})

describe("upsertSession", () => {
  it("overwrites metadata", () => {
    store.upsertSession(session(), "ses_a")
    store.upsertSession(session({ title: "Renamed", archived: 3_000, updated: 4_000, cost: 1.25 }), "ses_a")
    expect(row("select title, archived, updated, cost from sessions")).toEqual({ title: "Renamed", archived: 3_000, updated: 4_000, cost: 1.25 })
    expect(store.sessionState("ses_a")).toMatchObject({ rootID: "ses_a", updated: 4_000, indexedSeq: -1 })
    expect(store.sessionState("ses_a")?.indexedAt).toBeGreaterThan(0)
    expect(store.sessionState("ses_missing")).toBeUndefined()
  })

  it("only overwrites the text facts it is given", () => {
    store.upsertSession(session(), "ses_a", { firstPrompt: "first", lastReply: "reply 1", outcome: "ok" })
    store.upsertSession(session(), "ses_a", { lastReply: "reply 2", outcome: null })
    expect(row("select first_prompt, last_reply, outcome from sessions")).toEqual({ first_prompt: "first", last_reply: "reply 2", outcome: "ok" })
  })

  it("keeps the earliest first prompt unless re-indexing from seq 0", () => {
    store.upsertSession(session(), "ses_a", {}, { from: 0, to: 0 })
    store.upsertSession(session(), "ses_a", { firstPrompt: "first" }, { from: 1, to: 1 })
    store.upsertSession(session(), "ses_a", { firstPrompt: "later" }, { from: 2, to: 2 })
    expect(row("select first_prompt from sessions")).toEqual({ first_prompt: "first" })
    store.upsertSession(session(), "ses_a", { firstPrompt: "rewritten" }, { from: 0, to: 2 })
    expect(row("select first_prompt from sessions")).toEqual({ first_prompt: "rewritten" })
  })

  it("resets missing text facts when re-indexing from seq 0", () => {
    store.upsertSession(session(), "ses_a", { firstPrompt: "first", lastReply: "reply", outcome: "ok" })
    store.upsertSession(session(), "ses_a", { firstPrompt: "again" }, { from: 0, to: 3 })
    expect(row("select first_prompt, last_reply, outcome from sessions")).toEqual({ first_prompt: "again", last_reply: null, outcome: null })
  })

  it("refuses counts without a seq range", () => {
    expect(() => store.upsertSession(session(), "ses_a", { messages: 2 })).toThrow(/seq range/)
    expect(store.sessionState("ses_a")).toBeUndefined()
  })

  it("records counts against a range", () => {
    store.upsertSession(session(), "ses_a", { messages: 3, userMessages: 1 }, { from: 0, to: 2 })
    store.upsertSession(session(), "ses_a", { messages: 2, toolCalls: 4 }, { from: 3, to: 4 })
    store.upsertSession(session(), "ses_a", { messages: 2, toolCalls: 4 }, { from: 3, to: 4 })
    expect(counts()).toEqual({ messages: 5, user_messages: 1, compactions: 0, tool_calls: 4, indexed_seq: 4 })
  })

  it("moves docs and files to a new root", () => {
    store.writeBatch(session(), "ses_a", { from: 0, to: 0 }, batch({ docs: [doc(0, "hello")], files: [file(0, "src/a.ts")] }))
    store.upsertSession(session({ parentID: "ses_root" }), "ses_root")
    expect(row("select root_id from docs")).toEqual({ root_id: "ses_root" })
    expect(row("select root_id from files")).toEqual({ root_id: "ses_root" })
    expect(row("select parent_id, root_id from sessions")).toEqual({ parent_id: "ses_root", root_id: "ses_root" })
  })

  it("moves sessions that guessed this session as their root", () => {
    // ses_c was indexed before ses_p, so its root could only be guessed as ses_p.
    store.writeBatch(session({ id: "ses_c", parentID: "ses_p" }), "ses_p", { from: 0, to: 0 }, batch({ docs: [doc(0, "child", { sessionID: "ses_c" })] }))
    store.writeTitle("ses_c", "ses_p", doc(TITLE_SEQ, "child title", { sessionID: "ses_c", kind: "title" }))
    store.upsertSession(session({ id: "ses_p", parentID: "ses_g" }), "ses_g")
    expect(store.db.all("select id, root_id from sessions order by id")).toEqual([
      { id: "ses_c", root_id: "ses_g" },
      { id: "ses_p", root_id: "ses_g" },
    ])
    expect(store.db.all("select distinct root_id from docs")).toEqual([{ root_id: "ses_g" }])
    store.upsertSession(session({ id: "ses_g" }), "ses_g")
    expect(store.db.all("select distinct root_id from sessions")).toEqual([{ root_id: "ses_g" }])
  })

  it("counts sessions", () => {
    expect(store.sessionCount()).toBe(0)
    store.upsertSession(session(), "ses_a")
    store.upsertSession(session({ id: "ses_b" }), "ses_b")
    expect(store.sessionCount()).toBe(2)
  })
})

describe("writeTitle", () => {
  const title = (text: string) => doc(7, text, { kind: "title", part: 3, messageID: "ses_a" })

  it("stores the title doc at the title seq and replaces it", () => {
    store.writeTitle("ses_a", "ses_a", title("login bug"))
    store.writeTitle("ses_a", "ses_a", title("token refresh"))
    expect(store.db.all("select seq, part, kind, text from v_docs")).toEqual([{ seq: TITLE_SEQ, part: 0, kind: "title", text: "token refresh" }])
    expect(words("login")).toBe(0)
    expect(words("refresh")).toBe(1)
    store.writeTitle("ses_a", "ses_a", null)
    expect(count("select count(*) from docs")).toBe(0)
    ftsIntact()
  })

  it("survives message batches from seq 0", () => {
    store.writeTitle("ses_a", "ses_a", title("login bug"))
    store.writeBatch(session(), "ses_a", { from: 0, to: 0 }, batch({ docs: [doc(0, "hello")] }))
    store.writeBatch(session(), "ses_a", { from: 0, to: -1 }, batch())
    expect(store.db.all("select seq, text from v_docs")).toEqual([{ seq: TITLE_SEQ, text: "login bug" }])
  })

  it("refuses a title doc of another session", () => {
    expect(() => store.writeTitle("ses_a", "ses_a", { ...title("x"), sessionID: "ses_b" })).toThrow(/title doc/)
  })
})

describe("writeBatch", () => {
  const first = batch({
    docs: [doc(0, "the login form rejects valid passwords"), doc(1, "checked the auth middleware", { kind: "assistant" })],
    files: [file(1, "src/auth.ts", { op: "read", tool: "read" })],
    facts: { firstPrompt: "the login form rejects valid passwords", lastReply: "checked the auth middleware", messages: 2, userMessages: 1 },
  })
  const second = batch({
    docs: [doc(2, "bash: npm test", { kind: "tool_call", tool: "bash" }), doc(3, "fixed the token refresh", { kind: "assistant" })],
    files: [file(3, "src/token.ts")],
    facts: { lastReply: "fixed the token refresh", outcome: "fixed", messages: 2, toolCalls: 1 },
  })

  it("indexes docs into both full-text tables", () => {
    store.writeBatch(session(), "ses_a", { from: 0, to: 1 }, first)
    expect(words("password")).toBe(1)
    expect(sub("iddlewa")).toBe(1)
    expect(sub("IDDLEWA")).toBe(1)
    expect(sub("iddlewax")).toBe(0)
    expect(row("select kind, text from v_docs where seq = 1")).toEqual({ kind: "assistant", text: "checked the auth middleware" })
    expect(row("select path, op from v_files")).toEqual({ path: "src/auth.ts", op: "read" })
    ftsIntact()
  })

  it("adds counts for new messages", () => {
    store.writeBatch(session(), "ses_a", { from: 0, to: 1 }, first)
    store.writeBatch(session(), "ses_a", { from: 2, to: 3 }, second)
    expect(counts()).toEqual({ messages: 4, user_messages: 1, compactions: 0, tool_calls: 1, indexed_seq: 3 })
    expect(row("select first_prompt, last_reply, outcome from sessions")).toEqual({
      first_prompt: "the login form rejects valid passwords",
      last_reply: "fixed the token refresh",
      outcome: "fixed",
    })
  })

  it("is idempotent when the same messages are written again", () => {
    store.writeBatch(session(), "ses_a", { from: 0, to: 1 }, first)
    store.writeBatch(session(), "ses_a", { from: 2, to: 3 }, second)
    const before = snapshot()
    store.writeBatch(session(), "ses_a", { from: 2, to: 3 }, second)
    store.writeBatch(session(), "ses_a", { from: 2, to: 3 }, second)
    const after = snapshot()
    expect({ ...after, session: { ...after.session, indexed_at: 0 } }).toEqual({ ...before, session: { ...before.session, indexed_at: 0 } })
    expect(words("token")).toBe(1)
    ftsIntact()
  })

  it("is idempotent when the whole session is written again from seq 0", () => {
    store.writeBatch(session(), "ses_a", { from: 0, to: 1 }, first)
    store.writeBatch(session(), "ses_a", { from: 2, to: 3 }, second)
    const before = snapshot()
    store.writeBatch(session(), "ses_a", { from: 0, to: 1 }, first)
    store.writeBatch(session(), "ses_a", { from: 2, to: 3 }, second)
    const after = snapshot()
    expect({ ...after, session: { ...after.session, indexed_at: 0 } }).toEqual({ ...before, session: { ...before.session, indexed_at: 0 } })
    ftsIntact()
  })

  it("replaces a changed tail and the counts it brought", () => {
    store.writeBatch(session(), "ses_a", { from: 0, to: 1 }, first)
    store.writeBatch(session(), "ses_a", { from: 2, to: 3 }, second)
    store.writeBatch(
      session(),
      "ses_a",
      { from: 2, to: 4 },
      batch({
        docs: [doc(2, "bash: npm run lint", { kind: "tool_call", tool: "bash" }), doc(4, "lint is clean", { kind: "assistant" })],
        facts: { lastReply: "lint is clean", messages: 3, toolCalls: 2, compactions: 1 },
      }),
    )
    expect(counts()).toEqual({ messages: 5, user_messages: 1, compactions: 1, tool_calls: 2, indexed_seq: 4 })
    expect(words("token")).toBe(0)
    expect(words("lint")).toBe(2)
    expect(count("select count(*) from files where seq >= 2")).toBe(0)
    expect(row("select last_reply, outcome from sessions")).toEqual({ last_reply: "lint is clean", outcome: "fixed" })
    ftsIntact()
  })

  it("drops everything from a seq when the range is empty", () => {
    store.writeBatch(session(), "ses_a", { from: 0, to: 1 }, first)
    store.writeBatch(session(), "ses_a", { from: 2, to: 3 }, second)
    store.writeBatch(session(), "ses_a", { from: 2, to: 1 }, batch())
    expect(counts()).toEqual({ messages: 2, user_messages: 1, compactions: 0, tool_calls: 0, indexed_seq: 1 })
    expect(count("select max(seq) from docs")).toBe(1)
    ftsIntact()
  })

  it("refuses to start inside a written range and changes nothing", () => {
    store.writeBatch(session(), "ses_a", { from: 0, to: 3 }, batch({ docs: [doc(0, "a"), doc(3, "b")], facts: { messages: 4 } }))
    const before = snapshot()
    expect(store.restartSeq("ses_a", 2)).toBe(0)
    expect(store.restartSeq("ses_a", 0)).toBe(0)
    expect(store.restartSeq("ses_a", 4)).toBe(4)
    expect(store.restartSeq("ses_other", 2)).toBe(2)
    let error: unknown
    try {
      store.writeBatch(session({ title: "changed" }), "ses_a", { from: 2, to: 5 }, batch({ facts: { messages: 4 } }))
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(SeqStraddleError)
    expect(error).toMatchObject({ sessionID: "ses_a", seq: 2, restart: 0 })
    expect(snapshot()).toEqual(before)
  })

  it("rolls back a batch with a doc outside its range", () => {
    store.writeBatch(session(), "ses_a", { from: 0, to: 1 }, first)
    const before = snapshot()
    expect(() => store.writeBatch(session(), "ses_a", { from: 2, to: 3 }, batch({ docs: [doc(2, "fine"), doc(9, "too far")], facts: { messages: 2 } }))).toThrow(
      /outside/,
    )
    expect(() => store.writeBatch(session(), "ses_a", { from: 2, to: 3 }, batch({ files: [file(2, "x.ts", { sessionID: "ses_b" })] }))).toThrow(/outside/)
    expect(() => store.writeBatch(session(), "ses_a", { from: 1.5, to: 3 }, batch())).toThrow(/bad seq range/)
    expect(snapshot()).toEqual(before)
    ftsIntact()
  })

  it("upserts links and replaces the ones found at or after the re-indexed seq", () => {
    const link = (childID: string, seq: number, description: string): IndexedLink => ({
      parentID: "ses_a",
      childID,
      messageID: `msg_${seq}`,
      seq,
      description,
      agent: "explore",
    })
    store.writeBatch(session(), "ses_a", { from: 0, to: 1 }, batch({ links: [link("ses_c1", 1, "look around")] }))
    store.writeBatch(session(), "ses_a", { from: 2, to: 3 }, batch({ links: [link("ses_c2", 2, "tests"), link("ses_c3", 3, "docs")] }))
    expect(store.db.all("select child_id, seq, description from links order by child_id")).toEqual([
      { child_id: "ses_c1", seq: 1, description: "look around" },
      { child_id: "ses_c2", seq: 2, description: "tests" },
      { child_id: "ses_c3", seq: 3, description: "docs" },
    ])
    store.writeBatch(session(), "ses_a", { from: 2, to: 2 }, batch({ links: [link("ses_c2", 2, "tests again")] }))
    expect(store.db.all("select child_id, description from links order by child_id")).toEqual([
      { child_id: "ses_c1", description: "look around" },
      { child_id: "ses_c2", description: "tests again" },
    ])
    expect(() => store.writeBatch(session(), "ses_a", { from: 3, to: 3 }, batch({ links: [{ ...link("ses_c4", 3, "x"), parentID: "ses_b" }] }))).toThrow(
      /outside/,
    )
    expect(() => store.writeBatch(session(), "ses_a", { from: 3, to: 3 }, batch({ links: [link("ses_c4", 4, "x")] }))).toThrow(/outside/)
  })
})

describe("transactions", () => {
  it("groups store calls and rolls them back together", () => {
    expect(() =>
      store.transaction(() => {
        store.upsertProjects([{ id: "prj_1", worktree: "/work/app", name: null }])
        store.writeBatch(session(), "ses_a", { from: 0, to: 0 }, batch({ docs: [doc(0, "inside")], facts: { messages: 1 } }))
        throw new Error("boom")
      }),
    ).toThrow("boom")
    expect(count("select count(*) from projects")).toBe(0)
    expect(count("select count(*) from sessions")).toBe(0)
    expect(words("inside")).toBe(0)

    store.transaction(() => {
      store.writeBatch(session(), "ses_a", { from: 0, to: 0 }, batch({ facts: { messages: 1 } }))
      store.writeBatch(session(), "ses_a", { from: 1, to: 1 }, batch({ facts: { messages: 1 } }))
    })
    expect(counts()?.messages).toBe(2)
  })
})

describe("deleting sessions", () => {
  const index = (id: string, parentID: string | null) => {
    const extracted = batch({
      docs: [doc(0, `words of ${id}`, { sessionID: id })],
      files: [file(0, `${id}.ts`, { sessionID: id })],
      links: parentID ? [] : [{ parentID: id, childID: `${id}_child`, messageID: "msg_0", seq: 0, description: null, agent: null }],
      facts: { messages: 1 },
    })
    store.writeBatch(session({ id, parentID }), parentID ?? id, { from: 0, to: 0 }, extracted)
  }

  it("removes every row of a session", () => {
    index("ses_a", null)
    index("ses_b", null)
    store.deleteSessions(["ses_a"])
    expect(store.db.all("select id from sessions")).toEqual([{ id: "ses_b" }])
    expect(store.db.all("select distinct session_id from docs")).toEqual([{ session_id: "ses_b" }])
    expect(store.db.all("select distinct session_id from files")).toEqual([{ session_id: "ses_b" }])
    expect(store.db.all("select distinct session_id from batches")).toEqual([{ session_id: "ses_b" }])
    expect(store.db.all("select parent_id from links")).toEqual([{ parent_id: "ses_b" }])
    expect(words("ses_a")).toBe(0)
    expect(sub("ses_a")).toBe(0)
    ftsIntact()
  })

  it("prunes sessions the source no longer has", () => {
    index("ses_a", null)
    index("ses_b", null)
    index("ses_c", "ses_a")
    expect(store.prune(new Set(["ses_b"])).sort()).toEqual(["ses_a", "ses_c"])
    expect(store.db.all("select id from sessions")).toEqual([{ id: "ses_b" }])
    expect(store.prune(new Set(["ses_b"]))).toEqual([])
    ftsIntact()
  })
})
