import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { BOUNDS } from "../../../src/domain/bounds.js"
import type { Db } from "../../../src/domain/sqlite.js"
import { HistoryError } from "../../../src/domain/common.js"
import { SQL_CELL_CHARS, SQL_OUTPUT_BYTES, SQL_PARALLEL, SQL_TIMEOUT_MS, checkSql, sql } from "../../../src/query/sql.js"
import { FAILURES } from "../../../src/domain/common.js"
import { toFailure } from "../../../src/runtime.js"
import { NOW, doc, project, session, sidecar, type Sidecar } from "./fixture.js"

let index: Sidecar
let db: Db

const run = (text: string, params?: (string | number | null)[], limit?: number) =>
  sql(index.path, { sql: text, ...(params ? { params } : {}), ...(limit !== undefined ? { limit } : {}) })

beforeEach(() => {
  index = sidecar()
  db = index.db
  project(db, "prj_app", "/work/app")
  for (let i = 0; i < 250; i++) session(db, { id: `ses_${String(i).padStart(3, "0")}`, title: `Session ${i}`, updated: NOW - i, cost: i / 100 })
  doc(db, { sessionID: "ses_000", text: "x".repeat(5000) })
})

afterEach(() => index.close())

describe("sql", async () => {
  it("runs one SELECT over the views on its own read-only connection", async () => {
    const out = await run("select session_id, title, cost from v_sessions where cost >= ? order by cost desc", [2.48])
    expect(out).toEqual({ columns: ["session_id", "title", "cost"], rows: [["ses_249", "Session 249", 2.49], ["ses_248", "Session 248", 2.48]], truncated: false })
  })

  it("keeps the caller's ORDER BY and LIMIT and numbered params", async () => {
    expect((await run("select session_id from v_sessions order by session_id limit 3")).rows).toEqual([["ses_000"], ["ses_001"], ["ses_002"]])
    expect((await run("select ?2 as b, ?1 as a", ["one", "two"])).rows).toEqual([["two", "one"]])
  })

  it("accepts WITH, comments, a trailing semicolon and semicolons inside strings", async () => {
    const out = await run(`-- newest first
      with recent as (select session_id, title from v_sessions /* all of them */ order by updated desc)
      select title, 'a;b' as "semi;colon" from recent limit 1; `)
    expect(out).toEqual({ columns: ["title", "semi;colon"], rows: [["Session 0", "a;b"]], truncated: false })
  })

  it("caps rows at the limit, at most 200, and says when more exist", async () => {
    expect(await run("select session_id from v_sessions", undefined, 5)).toMatchObject({ truncated: true })
    expect((await run("select session_id from v_sessions", undefined, 5)).rows).toHaveLength(5)
    const all = await run("select session_id from v_sessions", undefined, 1000)
    expect(all.rows).toHaveLength(BOUNDS.sql.limit.max)
    expect(all.truncated).toBe(true)
    expect((await run("select session_id from v_sessions")).rows).toHaveLength(BOUNDS.sql.limit.default)
    expect(await run("select 1 as one")).toEqual({ columns: ["one"], rows: [[1]], truncated: false })
  })

  it("matches the full-text tables, whose rowid is v_docs.doc_id", async () => {
    doc(db, { sessionID: "ses_001", text: "the walrus migration stalled" })
    expect((await run("select d.session_id from v_docs d join docs_words w on w.rowid = d.doc_id where docs_words match ?", ["walrus"])).rows).toEqual([["ses_001"]])
    // docs_sub keeps trigrams without positions: LIKE finds a substring through it, and MATCH takes single trigrams.
    const like = "select d.session_id from v_docs d where d.doc_id in (select rowid from docs_sub where text like ?)"
    expect((await run(like, ["%ALRUS MIGR%"])).rows).toEqual([["ses_001"]])
    expect((await run(like, ["%alrus  migr%"])).rows).toEqual([])
    expect((await run("select count(*) from docs_sub where docs_sub match ?", ['"alr" AND "s m"'])).rows).toEqual([[1]])
    // The trigrams answer the LIKE, rather than a scan of every text.
    expect(db.all<{ detail: string }>("explain query plan select rowid from docs_sub where text like ?", "%alrus%").map(row => row.detail)).toEqual([expect.stringMatching(/VIRTUAL TABLE INDEX 0:L/)])
  })

  it("reads the tables behind the views as well, since one read-only statement over the index is the whole rule", async () => {
    expect((await run("select count(*) as n from sessions")).rows).toEqual([[250]])
    expect((await run("select count(*) as n from sqlite_master where name = 'v_docs'")).rows).toEqual([[1]])
  })

  it("caps cells, names duplicate columns apart and describes blobs", async () => {
    const [text] = (await run("select text from v_docs")).rows[0]!
    expect(text).toHaveLength(SQL_CELL_CHARS)
    expect(String(text).endsWith("…")).toBe(true)
    expect(await run("select 1 as id, 2 as id, x'0102' as b, null as n")).toEqual({ columns: ["id", "id:1", "b", "n"], rows: [[1, 2, "[blob, 2 bytes]", null]], truncated: false })
  })

  it("returns columns even when no row matches", async () => {
    expect(await run("select session_id, title from v_sessions where 0")).toEqual({ columns: ["session_id", "title"], rows: [], truncated: false })
  })

  it("rejects anything but one SELECT or WITH statement", async () => {
    for (const bad of [
      "",
      "  ;  ",
      "delete from docs",
      "update sessions set title = 'x'",
      "insert into meta values ('a', 'b')",
      "pragma table_info(docs)",
      "attach database 'x.db' as x",
      "select 1; delete from docs",
      "select 'unclosed",
      "-- only a comment",
    ]) {
      await expect(run(bad), bad).rejects.toThrow(expect.objectContaining({ code: "SQL_REJECTED" }))
    }
    expect(checkSql("select 1 -- trailing comment")).toBe("select 1")
  })

  it("cannot write, even through WITH", async () => {
    await expect(run("with x as (select 1) delete from docs")).rejects.toThrow(expect.objectContaining({ code: "SQL_FAILED" }))
    expect(db.get<{ n: number }>("select count(*) as n from docs")!.n).toBe(1)
  })

  it("reports SQL errors as failures", async () => {
    const error = await run("select nope from v_sessions").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HistoryError)
    expect(error).toMatchObject({ code: "SQL_FAILED", message: "The SQL query failed: it names a column the views do not have: nope." })
  })

  it("names the bad identifier SQLite reports, and never other text from the statement", async () => {
    const failed = async (text: string) => ((await run(text).catch((e: unknown) => e)) as Error).message
    const column = await failed("select secret_value from v_sessions where title = 'private words'")
    expect(column).toBe("The SQL query failed: it names a column the views do not have: secret_value.")
    expect(column).not.toContain("private words")
    expect(await failed("select * from v_session")).toBe("The SQL query failed: it names a table or view the index does not have: v_session.")
    expect(await failed("select nofunc(1)")).toBe("The SQL query failed: it calls a function SQLite does not have: nofunc.")
    expect(await failed("select session_id from v_sessions, v_docs")).toBe("The SQL query failed: a column name is ambiguous, so prefix it with its view: session_id.")
    // A name that is not a plain identifier is left out.
    expect(await failed(`select "my secret phrase" from v_sessions`)).toBe("The SQL query failed: it names a column the views do not have.")
  })

  it("compares times as the description says: stored as YYYY-MM-DD HH:MM:SS UTC, or datetime(?) on both sides", async () => {
    // ses_000 was updated at NOW; a window given with an offset converts to UTC under datetime().
    const at = new Date(NOW).toISOString().slice(0, 19)
    const count = async (where: string, value: string) => (await run(`select count(*) from v_sessions where session_id = 'ses_000' and ${where}`, [value])).rows[0]![0]
    expect(await count("datetime(updated) >= datetime(?)", `${at}+01:00`)).toBe(1)
    expect(await count("datetime(updated) <= datetime(?)", `${at}+01:00`)).toBe(0)
    expect(await count("updated >= ?", at.replace("T", " "))).toBe(1)
    // The T form sorts after the stored space form, which is the mistake the description warns about.
    expect(await count("updated >= ?", at)).toBe(0)
  })
})

/** The audit's statement: it never ends, and before the time limit it froze the whole OpenCode server. */
const ENDLESS = "with recursive r(x) as (select 1 union all select x+1 from r) select count(*) from r"

describe("sql limits", () => {
  it("stops an endless recursive statement at the time limit, while the event loop keeps running", async () => {
    let ticks = 0
    const timer = setInterval(() => ticks++, 20)
    const started = performance.now()
    const error = await sql(index.path, { sql: ENDLESS }, { timeoutMs: 1500 }).catch((e: unknown) => e)
    clearInterval(timer)
    const took = performance.now() - started
    expect(error).toMatchObject({ code: "SQL_TIMEOUT" })
    expect(took).toBeGreaterThanOrEqual(1400)
    expect(took).toBeLessThan(5000)
    // The statement ran in its own process: this one kept answering timers the whole time.
    expect(ticks).toBeGreaterThan(30)
  })

  it("stops an expensive cross join the same way", async () => {
    const error = await sql(index.path, { sql: "select count(*) from v_sessions a, v_sessions b, v_sessions c, v_sessions d" }, { timeoutMs: 1000 }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "SQL_TIMEOUT" })
  })

  it("reports a timeout as SQL_TIMEOUT, whose text names the default limit", async () => {
    const error = await sql(index.path, { sql: ENDLESS }, { timeoutMs: 300 }).catch((e: unknown) => e)
    expect(toFailure(error)).toMatchObject({ code: "SQL_TIMEOUT", message: FAILURES.SQL_TIMEOUT[0] })
    expect(FAILURES.SQL_TIMEOUT[0]).toContain(`${SQL_TIMEOUT_MS / 1000} seconds`)
  })

  it("kills the statement when the call is cancelled", async () => {
    const controller = new AbortController()
    const pending = sql(index.path, { sql: ENDLESS }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    const started = performance.now()
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" })
    expect(performance.now() - started).toBeLessThan(3000)
  })

  it("runs at most SQL_PARALLEL statements at once; the rest wait, then run", async () => {
    const endless = Array.from({ length: SQL_PARALLEL }, () => sql(index.path, { sql: ENDLESS }, { timeoutMs: 800 }).catch((e: unknown) => e))
    const quick = run("select 1 as one")
    expect(await quick).toEqual({ columns: ["one"], rows: [[1]], truncated: false })
    for (const error of await Promise.all(endless)) expect(error).toMatchObject({ code: "SQL_TIMEOUT" })
  })

  it("cuts rows at SQL_OUTPUT_BYTES of data and says truncated", async () => {
    for (let i = 0; i < 400; i++) doc(db, { sessionID: "ses_001", text: `${i} ${"y".repeat(SQL_CELL_CHARS * 2)}` })
    const out = await run("select text, text as again from v_docs", undefined, BOUNDS.sql.limit.max)
    expect(out.truncated).toBe(true)
    expect(out.rows.length).toBeLessThan(BOUNDS.sql.limit.max)
    expect(JSON.stringify(out.rows).length).toBeLessThanOrEqual(SQL_OUTPUT_BYTES + SQL_CELL_CHARS * 4)
  })
})

describe("sql child failures", () => {
  /** Runs `work` with the SQL child's command, this runtime's executable, replaced by `file`. */
  async function withRunner<T>(file: string, work: () => Promise<T>): Promise<T> {
    const real = process.execPath
    Object.defineProperty(process, "execPath", { value: file, configurable: true, writable: true })
    try { return await work() } finally { Object.defineProperty(process, "execPath", { value: real, configurable: true, writable: true }) }
  }

  it("is SQL_FAILED, with the table's text, when the child cannot start", async () => {
    const error = await withRunner("/nonexistent/history-sql-runner", () => run("select 1").catch((caught: unknown) => caught))
    expect(error).toMatchObject({ code: "SQL_FAILED", message: FAILURES.SQL_FAILED[0] })
  })

  it("is SQL_FAILED when the child exits without an answer", async () => {
    const error = await withRunner("/usr/bin/true", () => run("select 1").catch((caught: unknown) => caught))
    expect(error).toMatchObject({ code: "SQL_FAILED", message: FAILURES.SQL_FAILED[0] })
  })
})
