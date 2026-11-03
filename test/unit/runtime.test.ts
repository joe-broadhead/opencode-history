import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Caller } from "../../src/domain/api.js"
import { FAILURES, HistoryError, logUnexpected } from "../../src/domain/common.js"
import { loadConfig, type Config } from "../../src/domain/config.js"
import { INDEX_SCHEMA_VERSION } from "../../src/domain/contract.js"
import { openDb } from "../../src/domain/sqlite.js"
import type { HistoryRuntime, RuntimeOptions } from "../../src/host/runtime.js"
import { acquire, REGISTRY } from "../../src/index/shared.js"
import { SYNCED_AT } from "../../src/index/sync.js"
import { QueryError, type QueryFailure } from "../../src/query/parse.js"
import { createRuntime, QUERY_FAILURES, REFRESH_MS, toFailure } from "../../src/runtime.js"
import type { ContextSessionApi } from "../../src/source/context.js"
import { assistantData, createOpencodeDb, idleData, shellData, textPart, toolPart, userData, type OpencodeDbFixture } from "../fixtures/opencode-db.js"

const SECRET = "sk-live-0123456789abcdef"
const CALLER: Caller = { sessionID: null, projectID: "proj_app", directory: "/work/app" }
const registry = () => (globalThis as { [REGISTRY]?: Map<string, unknown> })[REGISTRY] ?? new Map()

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "history-runtime-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** OpenCode's database with a login fix that edited a file and left a todo, and a migration session. */
function opencode(): OpencodeDbFixture {
  const fixture = createOpencodeDb()
  cleanups.push(() => fixture.cleanup())
  fixture.insertSession({ id: "ses_login", title: "Fix login redirect loop" })
  fixture.insertMessage({ sessionID: "ses_login", type: "user", data: userData("The login page keeps redirecting after OAuth") })
  fixture.insertMessage({
    sessionID: "ses_login",
    type: "assistant",
    data: assistantData([
      textPart(`The state cookie used SameSite=Strict; set it to Lax. Token ${SECRET}`),
      toolPart("edit", { filePath: "/work/app/src/auth.ts", oldString: "Strict", newString: "Lax" }),
    ]),
  })
  fixture.insertMessage({ sessionID: "ses_login", type: "idle", data: idleData("succeeded") })
  fixture.insertTodo({ sessionID: "ses_login", content: `Rotate ${SECRET}` })
  fixture.insertSession({ id: "ses_db", title: "Database migration" })
  fixture.insertMessage({ sessionID: "ses_db", type: "user", data: userData("Write the schema migration for invoices") })
  return fixture
}

function info(id: string, title: string): SessionInfo {
  return {
    id,
    projectID: "proj_app",
    title,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 100, updated: 200 },
    location: { directory: "/work/app" },
  }
}

/** The plugin session API with fixed sessions and messages. */
function contextApi(sessions: SessionInfo[] = [], threads: Record<string, SessionMessageInfo[]> = {}): ContextSessionApi {
  return {
    list: async () => ({ data: sessions, cursor: { next: null } }),
    context: async ({ sessionID }) => threads[sessionID] ?? [],
  }
}

async function open(options: Config, more: { session?: ContextSessionApi; generate?: RuntimeOptions["generate"] } = {}): Promise<HistoryRuntime> {
  const runtime = await createRuntime({
    config: loadConfig(options),
    session: (more.session ?? contextApi()) as unknown as RuntimeOptions["session"],
    generate: more.generate ?? (async () => "the answer"),
  })
  cleanups.push(() => runtime.close())
  return runtime
}

/** A runtime over the fixture database whose first backfill has finished. */
async function indexed(options: Partial<Config> = {}, more: Parameters<typeof open>[1] = {}) {
  const fixture = opencode()
  const indexPath = join(temp(), "index.db")
  const runtime = await open({ database: fixture.path, indexPath, ...options }, more)
  await runtime.reindex("catch-up")
  return { fixture, indexPath, runtime }
}

const ids = (runtime: HistoryRuntime) => runtime.sessions(CALLER, {}).then(out => out.sessions.map(s => s.sessionID).sort())

/**
 * What opening the file with an earlier version of the plugin does to it: that version's layout, schema 1, whose docs
 * keep their own text and have no doc_texts table, with the rows written so far.
 */
function rebuildAsSchemaOne(indexPath: string): void {
  const raw = openDb(indexPath)
  try {
    raw.transaction(() => {
      raw.exec("create temp table kept as select d.*, t.text from docs d join doc_texts t on t.id = d.id")
      for (const trigger of ["doc_texts_ai", "doc_texts_ad", "docs_ad"]) raw.exec(`drop trigger ${trigger}`)
      for (const table of ["docs_words", "docs_sub", "doc_texts", "docs"]) raw.exec(`drop table ${table}`)
      raw.exec(`create table docs (id integer primary key, session_id text not null, root_id text not null, message_id text not null,
        seq integer not null, part integer not null, time integer not null, kind text not null, tool text, text text not null)`)
      raw.exec("insert into docs select * from kept")
      raw.exec("create virtual table docs_words using fts5(text, content='docs', content_rowid='id', tokenize='porter unicode61')")
      raw.exec("create virtual table docs_sub using fts5(text, content='docs', content_rowid='id', tokenize='trigram')")
      raw.exec("insert into docs_words(docs_words) values ('rebuild')")
      raw.exec("insert into docs_sub(docs_sub) values ('rebuild')")
      raw.run("update meta set value = '1' where key = 'schema_version'")
    })
  } finally {
    raw.close()
  }
}

/** Make the index say it was last in step with the source `ago` milliseconds ago. */
function lastSynced(indexPath: string, ago: number): void {
  const raw = openDb(indexPath)
  try {
    raw.run("update meta set value = ? where key = ?", String(Date.now() - ago), SYNCED_AT)
  } finally {
    raw.close()
  }
}

describe("createRuntime", () => {
  it("returns before indexing finishes, then answers every query from OpenCode's database", async () => {
    const fixture = opencode()
    const indexPath = join(temp(), "index.db")
    const runtime = await open({ database: fixture.path, indexPath })
    expect(await runtime.status()).toMatchObject({ ready: false, source: "opencode-db" })

    expect(await runtime.reindex("catch-up")).toMatchObject({ ready: true, sessionsIndexed: 2, sessionsTotal: 2, source: "opencode-db", complete: true })
    expect(await runtime.status()).toMatchObject({ ready: true, sessionsIndexed: 2 })
    const found = await runtime.search(CALLER, { query: ["login redirect", "SameSite cookie"] })
    expect(found).toMatchObject({ truncated: false, results: [{ sessionID: "ses_login", queriesMatched: 2 }] })
    expect(await ids(runtime)).toEqual(["ses_db", "ses_login"])
    expect((await runtime.files(CALLER, { path: "src/auth.ts" })).files).toMatchObject([{ path: "/work/app/src/auth.ts", sessions: [{ sessionID: "ses_login" }] }])
    expect((await runtime.read(CALLER, { sessionID: "ses_db" })).messages).toMatchObject([{ seq: 0, text: "Write the schema migration for invoices" }])
    expect((await runtime.brief(CALLER, { sessionID: "ses_login" })).filesEdited).toEqual([{ path: "/work/app/src/auth.ts", edits: 1 }])
    expect(await runtime.sql(CALLER, { sql: "select session_id from v_sessions order by session_id" })).toEqual({ columns: ["session_id"], rows: [["ses_db"], ["ses_login"]], truncated: false })
  })

  it("masks the configured patterns in the index and in what read, brief and recall take from the source", async () => {
    const { runtime } = await indexed({ mask: ["sk-live-[0-9a-f]+"] })
    const read = await runtime.read(CALLER, { sessionID: "ses_login" })
    const brief = await runtime.brief(CALLER, { sessionID: "ses_login" })
    const recall = await runtime.recall(CALLER, { question: "What did we change on the cookie?", queries: ["SameSite cookie"], synthesize: false })
    const search = await runtime.search(CALLER, { query: "Token", snippets: 5 })
    const docs = await runtime.sql(CALLER, { sql: "select text from v_docs" })
    for (const [name, out] of Object.entries({ read, brief, recall, search, docs })) expect(JSON.stringify(out), name).not.toContain(SECRET)
    expect(read.messages[1]!.text).toContain("Token [masked]")
    expect(brief.todos).toEqual([{ content: "Rotate [masked]", status: "pending" }])
    expect(recall.evidence[0]!.text).toContain("Token [masked]")
    expect(search.results[0]!.snippets[0]!.text).toContain("[masked]")
  })

  it("falls back to the plugin session API when OpenCode's database is missing or has an unknown layout, and says why", async () => {
    const unknown = createOpencodeDb({ tables: ["project"] })
    const other = createOpencodeDb({ tables: [] })
    cleanups.push(() => unknown.cleanup(), () => other.cleanup())
    const dir = temp()
    const session = contextApi([info("ses_ctx", "Upload tests")], { ses_ctx: [{ id: "msg_1", type: "user", text: "the flaky upload test again", time: { created: 150 } }] })
    const cases = [
      ["missing", join(dir, "missing.db"), "SOURCE_UNAVAILABLE"],
      ["not OpenCode's", other.path, "SOURCE_UNAVAILABLE"],
      ["unknown layout", unknown.path, "SOURCE_SCHEMA_UNKNOWN"],
    ] as const
    for (const [name, database, fallback] of cases) {
      const runtime = await open({ database, indexPath: join(dir, `${name}.db`) }, { session })
      expect(runtime.fallback, name).toBe(fallback)
      expect(await runtime.reindex("catch-up"), name).toMatchObject({ ready: true, sessionsIndexed: 1, source: "context", complete: false })
      expect((await runtime.search(CALLER, { query: "flaky upload" })).results.map(hit => hit.sessionID), name).toEqual(["ses_ctx"])
    }
    const { runtime } = await indexed()
    expect(runtime.fallback).toBeUndefined()
  })

  it("search, sessions and recall catch up first, so they find a session written since the last pass, with no lag", async () => {
    const { fixture, runtime } = await indexed()
    fixture.insertSession({ id: "ses_pelican", title: "Pelican release notes" })
    fixture.insertMessage({ sessionID: "ses_pelican", type: "user", data: userData("Draft the pelican release notes") })
    const found = await runtime.search(CALLER, { query: "pelican" })
    expect(found.results.map(hit => hit.sessionID)).toEqual(["ses_pelican"])
    expect(found.index).toMatchObject({ sessionsIndexed: 3, lagSeconds: 0 })

    fixture.insertSession({ id: "ses_heron", title: "Heron dashboard" })
    expect((await runtime.sessions(CALLER, { title: "Heron" })).sessions.map(s => s.sessionID)).toEqual(["ses_heron"])
    fixture.insertMessage({ sessionID: "ses_heron", type: "user", data: userData("Why is the heron dashboard slow?") })
    expect((await runtime.recall(CALLER, { question: "heron dashboard", synthesize: false })).evidence.map(e => e.text)).toEqual([expect.stringContaining("heron dashboard slow")])

    // Files does not catch up first: it answers from the index as it is.
    fixture.insertMessage({ sessionID: "ses_db", type: "assistant", data: assistantData([toolPart("write", { filePath: "/work/app/db/egret.sql", content: "-- x" })]) })
    expect((await runtime.files(CALLER, { path: "egret.sql" })).files).toEqual([])
  })

  it("answers after about 200 ms when the catch-up takes longer, which carries on in the background", async () => {
    // ses_slow fails to index, so every catch-up retries it first. Once `slow` is set, that retry hangs until released.
    let slow = false, release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const thread: SessionMessageInfo[] = [{ id: "msg_1", type: "user", text: "the flaky upload test again", time: { created: 150 } }]
    const session: ContextSessionApi = {
      list: async () => ({ data: [info("ses_ctx", "Upload tests"), info("ses_slow", "Slow")], cursor: { next: null } }),
      context: async ({ sessionID }) => {
        if (sessionID !== "ses_slow") return thread
        if (slow) await gate
        throw new Error("not yet")
      },
    }
    const indexPath = join(temp(), "index.db")
    const runtime = await open({ database: join(temp(), "missing.db"), indexPath }, { session })
    expect(await runtime.reindex("catch-up")).toMatchObject({ ready: true, complete: false })
    lastSynced(indexPath, 60_000)
    slow = true
    const started = performance.now()
    const found = await runtime.search(CALLER, { query: "flaky upload" })
    const waited = performance.now() - started
    expect(waited).toBeGreaterThanOrEqual(REFRESH_MS - 20)
    expect(waited).toBeLessThan(REFRESH_MS + 1500)
    expect(found.results.map(hit => hit.sessionID)).toEqual(["ses_ctx"])
    expect(found.index.lagSeconds).toBe(60)
    release()
    await vi.waitFor(async () => expect((await runtime.status()).lagSeconds).toBe(0))
  })

  it("lags behind until a sync finishes, and an event-driven sync brings the lag back to 0", async () => {
    const { fixture, indexPath, runtime } = await indexed()
    lastSynced(indexPath, 90_000)
    expect((await runtime.status()).lagSeconds).toBe(90)
    fixture.insertMessage({ sessionID: "ses_db", type: "user", data: userData("Add an index on invoices") })
    runtime.onEvent({ type: "session.idle", data: { sessionID: "ses_db" } })
    await vi.waitFor(async () => expect((await runtime.status()).lagSeconds).toBe(0), { timeout: 5000 })
    expect((await runtime.sql(CALLER, { sql: "select count(*) from v_docs where text like '%index on invoices%'" })).rows).toEqual([[1]])
  })

  it("indexes the user's shell commands and their output, for search, brief and read", async () => {
    const { fixture, runtime } = await indexed()
    fixture.insertMessage({ sessionID: "ses_db", type: "shell", data: shellData("npm run migrate -- --dry-run", "Applied 3 migrations to the invoices schema") })
    const found = await runtime.search(CALLER, { query: ["migrate dry-run", "Applied migrations"], tool: "shell" })
    // Both texts are found; a session gives one snippet per message.
    expect(found.results).toMatchObject([{ sessionID: "ses_db", matches: 2, queriesMatched: 2, snippets: [{ tool: "shell" }] }])
    expect((await runtime.sql(CALLER, { sql: "select kind, tool from v_docs where session_id = 'ses_db' and tool = 'shell' order by kind" })).rows).toEqual([["tool_call", "shell"], ["tool_result", "shell"]])
    expect((await runtime.brief(CALLER, { sessionID: "ses_db" })).commands).toEqual(["npm run migrate -- --dry-run"])
    const read = await runtime.read(CALLER, { sessionID: "ses_db", at: found.results[0]!.snippets[0]!.seq, before: 0, after: 0 })
    expect(read.messages).toMatchObject([{ type: "shell", text: "▸ shell: npm run migrate -- --dry-run\n  Applied 3 migrations to the invoices schema" }])
    expect((await runtime.sql(CALLER, { sql: "select tool_calls from v_sessions where session_id = 'ses_db'" })).rows).toEqual([[0]])
  })

  it("indexes a Code Mode call's code as it is, so substring search finds code with quotes and lines", async () => {
    const { fixture, runtime } = await indexed()
    const code = 'const issue = await tools.linear.get_issue({id:"ENG-7"})\nreturn issue.title'
    fixture.insertMessage({ sessionID: "ses_db", type: "assistant", data: assistantData([toolPart("execute", { code, timeout: 30 }, { output: "Invoice totals" })]) })
    // In JSON the quotes would be \" and the line break \n, which glues the n to the next word.
    const found = await runtime.search(CALLER, { query: 'get_issue({id:"ENG-7"})', match: "substring", tool: "execute" })
    expect(found.results).toMatchObject([{ sessionID: "ses_db", snippets: [{ kind: "tool_call", tool: "execute" }] }])
    expect(found.results[0]!.snippets[0]!.text).toContain('«get_issue({id:"ENG-7"})»')
    expect((await runtime.search(CALLER, { query: "return issue", tool: "execute" })).results).toMatchObject([{ sessionID: "ses_db", queriesMatched: 1 }])
    expect((await runtime.sql(CALLER, { sql: "select text from v_docs where tool = 'execute' and kind = 'tool_call'" })).rows).toEqual([[`execute: {"timeout":30}\ncode: ${code}`]])
  })

  it("shares one store, indexer and event router per index file, whatever the spelling, until the last instance closes", async () => {
    const fixture = opencode()
    const dir = temp()
    const link = join(temp(), "link")
    symlinkSync(dir, link)
    const first = await open({ database: fixture.path, indexPath: join(dir, "index.db") })
    const second = await open({ database: fixture.path, indexPath: join(dir, "sub", "..", "index.db") })
    const third = await open({ database: fixture.path, indexPath: join(link, "index.db") })
    expect(registry().size).toBe(1)
    await first.reindex("catch-up")
    expect(await second.status()).toMatchObject({ ready: true, sessionsIndexed: 2 })

    // An event given to one instance changes the index every instance reads.
    fixture.deleteSession("ses_db")
    first.onEvent({ type: "session.deleted", data: { sessionID: "ses_db" } })
    await vi.waitFor(async () => expect(await ids(third)).toEqual(["ses_login"]))

    await first.close()
    await second.close()
    expect(await ids(third)).toEqual(["ses_login"])
    const other = await open({ database: fixture.path, indexPath: join(dir, "other.db") })
    expect(registry().size).toBe(2)
    await third.close()
    await other.close()
    expect(registry().size).toBe(0)
  })

  it("does not join the index that an earlier plugin version loaded in this process opened for its own schema", async () => {
    const fixture = opencode()
    const dir = temp()
    // Earlier versions keyed the registry by the index path alone, and their index has their own layout.
    const earlier = acquire(join(realpathSync(dir), "index.db"), () => ({ close: vi.fn() }))
    cleanups.push(() => earlier.release())
    const runtime = await open({ database: fixture.path, indexPath: join(dir, "index.db") })
    expect(registry().size).toBe(2)
    await runtime.reindex("catch-up")
    expect((await runtime.search(CALLER, { query: "SameSite", match: "substring" })).results.map(hit => hit.sessionID)).toEqual(["ses_login"])
    expect((await runtime.search(CALLER, { query: "Same\\w+=", match: "regex" })).results.map(hit => hit.sessionID)).toEqual(["ses_login"])
  })

  it("fails with INDEX_MISMATCH, not OPERATION_FAILED, once another plugin version has rebuilt the index for its own schema", async () => {
    const { indexPath, runtime } = await indexed()
    expect((await runtime.search(CALLER, { query: "SameSite", match: "substring" })).total).toBe(1)
    const build = String(INDEX_SCHEMA_VERSION)
    expect(await runtime.schema()).toEqual({ file: build, build })
    rebuildAsSchemaOne(indexPath)
    expect(await runtime.schema()).toEqual({ file: "1", build })
    const calls: [string, () => Promise<unknown>][] = [
      ["substring", () => runtime.search(CALLER, { query: "SameSite", match: "substring" })],
      ["regex", () => runtime.search(CALLER, { query: "Same\\w+", match: "regex" })],
      ["words", () => runtime.search(CALLER, { query: "login redirect" })],
      ["sessions", () => runtime.sessions(CALLER, {})],
      ["files", () => runtime.files(CALLER, { path: "src/auth.ts" })],
      ["read", () => runtime.read(CALLER, { sessionID: "ses_login" })],
      ["brief", () => runtime.brief(CALLER, { sessionID: "ses_login" })],
      ["sql", () => runtime.sql(CALLER, { sql: "select count(*) from v_docs" })],
      ["recall", () => runtime.recall(CALLER, { question: "What changed on the cookie?", synthesize: false })],
    ]
    for (const [name, call] of calls) {
      await expect(call(), name).rejects.toMatchObject({ code: "INDEX_MISMATCH", message: FAILURES.INDEX_MISMATCH[0], hint: FAILURES.INDEX_MISMATCH[1] })
    }
    expect(await runtime.status()).toMatchObject({ ready: true })
    // A rebuild makes the file this version's again.
    await runtime.reindex("rebuild")
    expect(await runtime.schema()).toEqual({ file: build, build })
    expect((await runtime.search(CALLER, { query: "SameSite", match: "substring" })).total).toBe(1)
  })

  it("catches up with sessions that changed, and ignores events it cannot use", async () => {
    const { fixture, runtime } = await indexed()
    fixture.insertMessage({ sessionID: "ses_db", type: "user", data: userData("Now add invoice totals") })
    fixture.insertSession({ id: "ses_new", title: "Release notes" })
    expect(await runtime.reindex("catch-up")).toMatchObject({ sessionsIndexed: 3 })
    expect((await runtime.search(CALLER, { query: "invoice totals" })).results.map(hit => hit.sessionID)).toEqual(["ses_db"])
    for (const event of [{ type: "session.idle", data: null }, { type: "other", data: {} }, null]) expect(() => runtime.onEvent(event as never)).not.toThrow()
  })

  it("rebuilds from nothing; rebuilds and catch-ups asked for meanwhile share it, even during the first backfill", async () => {
    const fixture = opencode()
    const indexPath = join(temp(), "index.db")
    const runtime = await open({ database: fixture.path, indexPath })
    const states = await Promise.all([runtime.reindex("rebuild"), runtime.reindex("rebuild"), runtime.reindex("catch-up")])
    for (const state of states) expect(state).toMatchObject({ ready: true, sessionsIndexed: 2 })

    // Text that only the index has, as if written by an older version, is gone after a rebuild. Catching up, or
    // backfilling without the reset, would re-index ses_login only from its last batch at seq 2.
    const raw = openDb(indexPath)
    raw.run("insert into docs (session_id, root_id, message_id, seq, part, time, kind) values ('ses_login', 'ses_login', 'm', 0, 9, 0, 'user')")
    raw.run("insert into doc_texts (id, text) values (last_insert_rowid(), 'stale marker')")
    raw.close()
    expect((await runtime.search(CALLER, { query: "stale marker" })).results).toHaveLength(1)
    await runtime.reindex("catch-up")
    expect((await runtime.search(CALLER, { query: "stale marker" })).results).toHaveLength(1)
    expect(await runtime.reindex("rebuild")).toMatchObject({ ready: true, sessionsIndexed: 2 })
    expect((await runtime.search(CALLER, { query: "stale marker" })).results).toEqual([])
    expect((await runtime.search(CALLER, { query: "migration" })).results).toHaveLength(1)
  })

  it("waits for indexing in flight before a rebuild drops the index, so no session loses its start", async () => {
    const { fixture, indexPath, runtime } = await indexed()
    for (let i = 1; i <= 250; i++) fixture.insertMessage({ sessionID: "ses_db", type: "user", data: userData(i === 5 ? "an early zebra message" : `filler ${i}`) })
    const raw = openDb(indexPath, { readOnly: true })
    cleanups.push(() => raw.close())
    const indexedSeq = () => raw.get<{ seq: number }>("select indexed_seq as seq from sessions where id = 'ses_db'")?.seq
    const catchingUp = runtime.reindex("catch-up")
    // Indexing yields between batches of 200 messages: rebuild while the first batch is written and the rest is not.
    for (let turns = 0; indexedSeq() !== 199; turns++) {
      if (turns > 1000) throw new Error("the catch-up never stopped between batches")
      await new Promise(resolve => setImmediate(resolve))
    }
    const rebuilt = runtime.reindex("rebuild")
    expect(await catchingUp).toMatchObject({ ready: true })
    expect(await rebuilt).toMatchObject({ ready: true, sessionsIndexed: 2 })
    expect((await runtime.search(CALLER, { query: "zebra" })).results.map(hit => hit.sessionID)).toEqual(["ses_db"])
    expect(indexedSeq()).toBe(250)
  })

  it("closes during the first backfill without errors, and a later instance finishes the index", async () => {
    const fixture = opencode()
    const indexPath = join(temp(), "index.db")
    const runtime = await open({ database: fixture.path, indexPath })
    await runtime.close()
    await runtime.close()
    await expect(runtime.search(CALLER, { query: "login" })).rejects.toMatchObject({ code: "CLOSED" })
    await expect(runtime.reindex("catch-up")).rejects.toMatchObject({ code: "CLOSED" })
    expect(() => runtime.onEvent({ type: "session.idle", data: { sessionID: "ses_db" } })).not.toThrow()
    expect(registry().size).toBe(0)
    await new Promise(resolve => setTimeout(resolve, 20))

    const again = await open({ database: fixture.path, indexPath })
    expect(await again.reindex("catch-up")).toMatchObject({ ready: true, sessionsIndexed: 2 })
  })

  it("fails with INDEX_UNAVAILABLE when the index file cannot be created, and holds nothing open", async () => {
    const fixture = opencode()
    const dir = temp()
    writeFileSync(join(dir, "file"), "")
    await expect(open({ database: fixture.path, indexPath: join(dir, "file", "index.db") })).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" })
    expect(registry().size).toBe(0)
    mkdirSync(join(dir, "ok"))
    expect(await (await open({ database: fixture.path, indexPath: join(dir, "ok", "index.db") })).reindex("catch-up")).toMatchObject({ ready: true })
  })
})

describe("recall", () => {
  const asked = { question: "What did we change on the cookie?", queries: ["SameSite cookie"] }

  it("writes an answer with the host's model when asked; by default as recall.synthesize says", async () => {
    const prompts: string[] = []
    const generate = async (prompt: string) => {
      prompts.push(prompt)
      return "Use SameSite=Lax."
    }
    const on = await indexed({ recall: { synthesize: true } }, { generate })
    expect((await on.runtime.recall(CALLER, asked)).answer).toBe("Use SameSite=Lax.")
    expect((await on.runtime.recall(CALLER, { ...asked, synthesize: false })).answer).toBeNull()
    const off = await indexed({}, { generate })
    expect((await off.runtime.recall(CALLER, asked)).answer).toBeNull()
    expect((await off.runtime.recall(CALLER, { ...asked, synthesize: true })).answer).toBe("Use SameSite=Lax.")
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain("[ses_login#1]")
  })

  it("fails with RECALL_FAILED when the model call fails", async () => {
    const { runtime } = await indexed({}, { generate: async () => Promise.reject(new Error("provider said no to secret")) })
    const error = await runtime.recall(CALLER, { ...asked, synthesize: true }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "RECALL_FAILED", message: FAILURES.RECALL_FAILED[0] })
    expect(String((error as Error).message)).not.toContain("secret")
  })

  it("fails with RECALL_MODEL_UNAVAILABLE when generate says there is no model", async () => {
    const { runtime } = await indexed({}, { generate: async () => Promise.reject(new HistoryError("RECALL_MODEL_UNAVAILABLE")) })
    await expect(runtime.recall(CALLER, { ...asked, synthesize: true })).rejects.toMatchObject({ code: "RECALL_MODEL_UNAVAILABLE", message: FAILURES.RECALL_MODEL_UNAVAILABLE[0] })
    expect((await runtime.recall(CALLER, { ...asked, synthesize: false })).evidence).not.toEqual([])
  })
})

describe("failures", () => {
  it("maps every QueryError reason to its host failure code", () => {
    const reasons = Object.keys(QUERY_FAILURES) as QueryFailure[]
    expect(reasons.map(reason => toFailure(new QueryError("x", reason)).code)).toEqual([
      "QUERY_INVALID",
      "CURSOR_INVALID",
      "SESSION_NOT_FOUND",
      "MESSAGE_NOT_FOUND",
      "SQL_REJECTED",
      "SQL_FAILED",
      "SQL_TIMEOUT",
      "RECALL_FAILED",
    ])
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    cleanups.push(() => warn.mockRestore())
    expect(toFailure(new Error("disk full at /private/path"))).toMatchObject({ code: "OPERATION_FAILED", message: FAILURES.OPERATION_FAILED[0] })
    expect(toFailure(new Error("x"), "STATUS_UNAVAILABLE").code).toBe("STATUS_UNAVAILABLE")
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it("logs one line for an error it reports only by its code: the operation, the class, the SQLite code and the functions, never the text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    cleanups.push(() => warn.mockRestore())
    const { indexPath, runtime } = await indexed()
    const raw = openDb(indexPath)
    raw.exec("drop table files")
    raw.close()
    await expect(runtime.files(CALLER, { path: "secret-file.ts" })).rejects.toMatchObject({ code: "OPERATION_FAILED", message: FAILURES.OPERATION_FAILED[0] })
    expect(warn.mock.calls).toEqual([[expect.stringMatching(/^opencode-history: OPERATION_FAILED in files: Error, SQLite code 1, thrown in [\w$.]+ < [\w$.]+ < files\.$/)]])
    // Known failures are not logged.
    await expect(runtime.read(CALLER, { sessionID: "ses_secret" })).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" })
    expect(warn).toHaveBeenCalledTimes(1)

    const lines: string[] = []
    const log = (error: unknown) => logUnexpected(error, "OPERATION_FAILED", "search", line => lines.push(line))
    log(new TypeError("secret text\n    at leaked (secret.ts:1:1)"))
    log(Object.assign(new Error("no such table: secret"), { errcode: 11 }))
    log("secret thrown as text")
    expect(lines.join("\n")).not.toMatch(/secret|leaked|no such table/)
    expect(lines.map(line => line.replace(/, thrown in .*\.$/, "."))).toEqual([
      "opencode-history: OPERATION_FAILED in search: TypeError.",
      "opencode-history: OPERATION_FAILED in search: Error, SQLite code 11.",
      "opencode-history: OPERATION_FAILED in search: string.",
    ])
  })

  it("says what to change, and never repeats the input or SQLite's text", async () => {
    const { runtime } = await indexed()
    const failure = (work: Promise<unknown>) => work.then(
      () => undefined,
      (error: { code: string; message: string; hint?: string }) => ({ code: error.code, message: error.message }),
    )
    expect(await failure(runtime.search(CALLER, { query: "/(/", match: "regex" }))).toEqual({ code: "QUERY_INVALID", message: "The search query cannot be used: invalid regex: Unterminated group." })
    expect(await failure(runtime.search(CALLER, { query: "login", cursor: "secret-cursor" }))).toEqual({ code: "CURSOR_INVALID", message: FAILURES.CURSOR_INVALID[0] })
    expect(await failure(runtime.sessions(CALLER, { since: "secret" }))).toMatchObject({ code: "QUERY_INVALID", message: expect.stringMatching(/^The search query cannot be used: since must be an ISO date/) })
    expect(await failure(runtime.read(CALLER, { sessionID: "ses_secret" }))).toEqual({ code: "SESSION_NOT_FOUND", message: FAILURES.SESSION_NOT_FOUND[0] })
    expect(await failure(runtime.read(CALLER, { sessionID: "ses_login", at: 99 }))).toEqual({ code: "MESSAGE_NOT_FOUND", message: FAILURES.MESSAGE_NOT_FOUND[0] })
    expect(await failure(runtime.brief(CALLER, { sessionID: "ses_secret" }))).toMatchObject({ code: "SESSION_NOT_FOUND" })
    expect(await failure(runtime.sql(CALLER, { sql: "delete from sessions" }))).toEqual({
      code: "SQL_REJECTED",
      message: "Only one read-only SELECT or WITH statement over the history index is allowed: only a SELECT or WITH statement is allowed.",
    })
    const sqlFailures = await Promise.all(
      [
        ["select secret_column from v_sessions", "it names a column the views do not have"],
        ["select * from secret_table", "it names a table or view the index does not have"],
        ["select secret_fn(1)", "it calls a function SQLite does not have"],
        ["select secret from where", "it has a syntax error"],
        ["select session_id from v_sessions, v_docs", "a column name is ambiguous, so prefix it with its view"],
        ["select json('{secret')", undefined],
      ].map(async ([sql, mistake]) => [mistake, await failure(runtime.sql(CALLER, { sql: sql! }))] as const),
    )
    for (const [mistake, out] of sqlFailures) {
      expect(out).toEqual({ code: "SQL_FAILED", message: mistake ? `The SQL query failed: ${mistake}.` : FAILURES.SQL_FAILED[0] })
    }
    expect(await failure(runtime.sql(CALLER, { sql: "select ?", params: [1, 2] }))).toEqual({
      code: "SQL_FAILED",
      message: "The SQL query failed: params has more values than the statement has ? placeholders.",
    })
  })

  it("reports SOURCE_UNAVAILABLE, without SQLite's text, when OpenCode's database stops answering; the index still serves search", async () => {
    const { fixture, runtime } = await indexed()
    fixture.db.exec("drop table session_message")
    const read = await runtime.read(CALLER, { sessionID: "ses_login" }).catch((caught: { code: string; message: string; hint?: string }) => caught)
    expect(read).toMatchObject({ code: "SOURCE_UNAVAILABLE", message: FAILURES.SOURCE_UNAVAILABLE[0], hint: FAILURES.SOURCE_UNAVAILABLE[1] })
    expect((await runtime.search(CALLER, { query: "login redirect" })).results.map(hit => hit.sessionID)).toEqual(["ses_login"])
    fixture.db.exec("drop table session_v2")
    await expect(runtime.reindex("catch-up")).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE", message: FAILURES.SOURCE_UNAVAILABLE[0] })
  })

  it("maps SQLite's busy and locked results to INDEX_BUSY, also under a failed SQL query", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    cleanups.push(() => warn.mockRestore())
    const path = join(temp(), "locked.db")
    const holder = openDb(path)
    const other = openDb(path, { busyMs: 0 })
    cleanups.push(() => other.close(), () => holder.close())
    holder.exec("create table t (x)")
    holder.exec("begin exclusive")
    let locked: unknown
    try {
      other.run("insert into t values (1)")
    } catch (error) {
      locked = error
    }
    holder.exec("rollback")
    expect(locked).toBeInstanceOf(Error)
    expect(toFailure(locked, "INDEX_FAILED")).toMatchObject({ code: "INDEX_BUSY", message: FAILURES.INDEX_BUSY[0] })
    expect(toFailure(new QueryError("the SQL failed", "sql_failed", { cause: locked })).code).toBe("INDEX_BUSY")
    expect(toFailure(Object.assign(new Error("x"), { errcode: 517 })).code).toBe("INDEX_BUSY")
    expect(toFailure(Object.assign(new Error("x"), { errcode: 1 })).code).toBe("OPERATION_FAILED")
    expect(toFailure(new QueryError("x", "recall", { cause: new HistoryError("RECALL_MODEL_UNAVAILABLE") })).code).toBe("RECALL_MODEL_UNAVAILABLE")
  })
})
