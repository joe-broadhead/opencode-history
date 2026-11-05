import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Caller, SearchInput } from "../../../src/domain/api.js"
import { BOUNDS, MAX_PHRASINGS } from "../../../src/domain/bounds.js"
import type { Db } from "../../../src/domain/sqlite.js"
import { QueryError, decodeCursor } from "../../../src/query/parse.js"
import { MARK, NEAR_CANDIDATES, NEAR_WEIGHT, SCAN_DOCS, SNIPPET_CHARS, search } from "../../../src/query/search.js"
import { CALLER, DAY, NOW, STATE, doc, file, noise, project, session, sidecar, titleDoc, type Sidecar } from "./fixture.js"

let index: Sidecar
let db: Db

const find = async (input: SearchInput, caller: Caller = CALLER) => search(db, caller, input, STATE, { now: NOW })
const ids = async (input: SearchInput, caller?: Caller) => (await find(input, caller)).results.map(hit => hit.sessionID)

/** A small history: two projects, a subagent, an archived session and the caller's own session. */
function seed(): void {
  project(db, "prj_app", "/work/app", "app")
  project(db, "prj_web", "/work/web", "web")
  session(db, { id: "ses_login", title: "Fix the login bug", updated: NOW - 2 * DAY, firstPrompt: "the login form throws", messages: 6 })
  titleDoc(db, "ses_login", "Fix the login bug")
  doc(db, { sessionID: "ses_login", seq: 1, messageID: "m_login_1", text: "the login form throws a null pointer when the password is empty" })
  doc(db, { sessionID: "ses_login", seq: 2, messageID: "m_login_2", kind: "assistant", text: "I fixed the login validation in src/auth.ts" })
  doc(db, { sessionID: "ses_login", seq: 3, messageID: "m_login_3", kind: "tool_call", tool: "edit", text: "edit src/auth.ts: guard against an empty password" })
  file(db, "ses_login", "/work/app/src/auth.ts")
  session(db, { id: "ses_explore", parentID: "ses_login", rootID: "ses_login", agent: "explore", title: "Explore validators", updated: NOW - 2 * DAY })
  doc(db, { sessionID: "ses_explore", seq: 0, messageID: "m_explore_0", kind: "assistant", text: "found the validation helper in validators.ts" })
  file(db, "ses_explore", "/work/app/src/validators.ts", "read")

  session(db, { id: "ses_db", title: "Database migration", directory: "/work/app/packages/db", updated: NOW - 100 * DAY })
  doc(db, { sessionID: "ses_db", seq: 0, messageID: "m_db_0", text: "the migration fails on postgres" })
  doc(db, { sessionID: "ses_db", seq: 1, messageID: "m_db_1", kind: "assistant", text: "migrating the schema again fixed it" })

  session(db, { id: "ses_web", projectID: "prj_web", directory: "/work/web", title: "Login page styling", updated: NOW - DAY })
  doc(db, { sessionID: "ses_web", seq: 0, messageID: "m_web_0", text: "style the login page" })

  session(db, { id: "ses_lookalike", directory: "/work/application", title: "Other checkout", updated: NOW - DAY })
  doc(db, { sessionID: "ses_lookalike", seq: 0, messageID: "m_look_0", text: "login in a sibling directory" })

  session(db, { id: "ses_archived", title: "Archived", updated: NOW - 3 * DAY, archived: NOW - DAY })
  doc(db, { sessionID: "ses_archived", seq: 0, messageID: "m_arch_0", text: "an archived login discussion" })

  session(db, { id: "ses_current", title: "Current", updated: NOW })
  doc(db, { sessionID: "ses_current", seq: 0, messageID: "m_cur_0", text: "search history for the login bug" })
}

/** Sessions with identical text that differ in one way, for ranking comparisons. */
function twins(text: string, a: Parameters<typeof session>[1], b: Parameters<typeof session>[1], kinds: ["user" | "title" | "tool_result", ("user" | "title" | "tool_result")?] = ["user"]) {
  session(db, a)
  session(db, b)
  doc(db, { sessionID: a.id, text, kind: kinds[0] })
  doc(db, { sessionID: b.id, text, kind: kinds[1] ?? kinds[0] })
}

beforeEach(() => {
  index = sidecar()
  db = index.db
})

afterEach(() => index.close())

describe("words mode", () => {
  beforeEach(seed)

  it("returns sessions of the caller's project and passes the index state through", async () => {
    const out = (await find({ query: "login" }))
    expect(out.truncated).toBe(false)
    expect(out.results.map(hit => hit.sessionID).sort()).toEqual(["ses_current", "ses_login", "ses_lookalike"])
    expect(out.index).toBe(STATE)
    expect(out.relaxed).toBe(false)
    const hit = out.results.find(result => result.sessionID === "ses_login")!
    expect(hit).toMatchObject({
      title: "Fix the login bug",
      directory: "/work/app",
      project: "/work/app",
      agent: "build",
      messages: 6,
      subagents: 1,
      firstPrompt: "the login form throws",
      parentID: null,
      updated: new Date(NOW - 2 * DAY).toISOString(),
    })
  })

  it("scores title docs but gives them no snippet", async () => {
    const hit = (await find({ query: "bug" })).results.find(result => result.sessionID === "ses_login")!
    expect(hit.matches).toBe(1)
    expect(hit.snippets).toEqual([])
    for (const result of (await find({ query: "login", scope: "all", includeArchived: true })).results) {
      expect(result.snippets.every(snippet => snippet.seq >= 0 && snippet.messageID !== "")).toBe(true)
    }
  })

  it("stems words with porter", async () => {
    expect((await ids({ query: "migrations" }))).toEqual(["ses_db"])
  })

  it("groups subagent docs under the root and names their session in snippets", async () => {
    const out = (await find({ query: "validation", includeSubagents: true }))
    expect(out.results).toHaveLength(1)
    const hit = out.results[0]!
    expect(hit.sessionID).toBe("ses_login")
    expect(hit.matches).toBe(2)
    expect(hit.snippets.map(snippet => snippet.sessionID).sort()).toEqual(["ses_explore", "ses_login"])
  })

  it("leaves subagent docs out unless includeSubagents", async () => {
    expect((await ids({ query: "helper" }))).toEqual([])
    expect((await ids({ query: "helper", includeSubagents: false }))).toEqual([])
    expect((await ids({ query: "helper", includeSubagents: true }))).toEqual(["ses_login"])
  })

  it("ranks full matches first, then near matches with some of a phrasing's words", async () => {
    const out = (await find({ query: "login password" }))
    expect(out.results[0]).toMatchObject({ sessionID: "ses_login", queriesMatched: 1 })
    expect(out.results.slice(1).map(hit => [hit.sessionID, hit.queriesMatched]).sort()).toEqual([["ses_current", 0], ["ses_lookalike", 0]])
    expect(out.relaxed).toBe(true)
    const loose = (await find({ query: "password postgres" }))
    expect(loose.relaxed).toBe(true)
    expect(loose.results.map(hit => [hit.sessionID, hit.queriesMatched]).sort()).toEqual([["ses_db", 0], ["ses_login", 0]])
    expect((await find({ query: "login" })).relaxed).toBe(false)
    expect((await find({ query: "login OR zebra" })).relaxed).toBe(false)
  })

  it("leaves out near matches that have an excluded term", async () => {
    expect((await ids({ query: "postgres password -empty" }))).toEqual(["ses_db"])
  })

  it("does not relax a single term or phrase", async () => {
    expect((await find({ query: '"pointer null"' }))).toMatchObject({ relaxed: false, results: [] })
    expect((await find({ query: '"null pointer"' })).results.map(hit => hit.sessionID)).toEqual(["ses_login"])
  })

  it("excludes docs with -terms", async () => {
    const hit = (await find({ query: "login -password" })).results.find(result => result.sessionID === "ses_login")!
    expect(hit.matches).toBe(2)
    expect(hit.snippets.map(snippet => snippet.messageID)).toEqual(["m_login_2"])
  })

  it("matches prefix* terms", async () => {
    expect((await find({ query: "valid*" })).results[0]).toMatchObject({ sessionID: "ses_login", matches: 1 })
    expect((await find({ query: "valid*", includeSubagents: true })).results[0]).toMatchObject({ sessionID: "ses_login", matches: 2 })
  })

  it("survives queries full of FTS5 syntax", async () => {
    for (const query of ['login" OR "x', "NEAR(login form)", "text:login", "login AND", "(login", "'; drop table docs; --"]) {
      await expect(find({ query, scope: "all" }), query).resolves.toBeDefined()
    }
    expect((await ids({ query: "text:login" }))).toEqual([])
    expect(db.get<{ n: number }>("select count(*) as n from docs")!.n).toBeGreaterThan(0)
  })

  it("rejects queries with nothing to include", async () => {
    await expect(find({ query: "-login" })).rejects.toThrow(/nothing to include/)
  })
})

describe("joined words in words mode", () => {
  beforeEach(() => {
    noise(db)
    session(db, { id: "ses_version", title: "Host upgrade" })
    doc(db, { sessionID: "ses_version", kind: "assistant", text: "pinned opencode 2.2.3 as the host, and v1.4.0 of the client" })
    session(db, { id: "ses_ip", title: "Listener" })
    doc(db, { sessionID: "ses_ip", kind: "tool_result", tool: "bash", text: "listening on 192.0.2.10 port 8080, module foo.bar.baz loaded, checksum sha-256" })
    // The same parts as the words above, more often and in a heavier kind of text, so bm25 alone ranks it first.
    session(db, { id: "ses_numbers", title: "Matrix" })
    doc(db, {
      sessionID: "ses_numbers",
      text: "opencode matrix 2 2 3, 2 2 3, 2 2 3; v1 4 0, v1 4 0; port 192 0 2 10; foo bar baz, foo bar baz; sha 256",
    })
    // The word inside a longer joined word.
    session(db, { id: "ses_nearby", title: "Neighbours" })
    doc(db, { sessionID: "ses_nearby", text: "addresses 10.2.2.3 and 2.2.3.4, versions v1.4.01 and pkg_foo.bar.baz" })
  })

  it("matches the word itself, not numbers or words with the same parts", async () => {
    expect((await ids({ query: "2.2.3" }))).toEqual(["ses_version"])
    expect((await ids({ query: "v1.4.0" }))).toEqual(["ses_version"])
    expect((await ids({ query: "192.0.2.10" }))).toEqual(["ses_ip"])
    expect((await ids({ query: "foo.bar.baz" }))).toEqual(["ses_ip"])
    expect((await ids({ query: "sha-256" }))).toEqual(["ses_ip"])
    expect((await ids({ query: '"opencode 2.2.3"' }))).toEqual(["ses_version"])
    expect((await ids({ query: "zebra OR 2.2.3" }))).toEqual(["ses_version"])
    expect((await ids({ query: "v1.4*" })).sort()).toEqual(["ses_nearby", "ses_version"])
  })

  it("ranks a version query's real match above noisy numeric text, which keeps only a near match", async () => {
    const out = (await find({ query: "opencode 2.2.3", recency: false }))
    expect(out.results.map(hit => [hit.sessionID, hit.queriesMatched])).toEqual([["ses_version", 1], ["ses_numbers", 0]])
    expect(out.relaxed).toBe(true)
    const several = (await find({ query: ["opencode 2.2.3", "2.2.3 host"], recency: false }))
    expect(several.results[0]).toMatchObject({ sessionID: "ses_version", queriesMatched: 2 })
    expect(several.results.slice(1).every(hit => hit.queriesMatched === 0)).toBe(true)
  })

  it("excludes only texts with the word itself", async () => {
    expect((await ids({ query: "port -192.0.2.10" }))).toEqual(["ses_numbers"])
    expect((await ids({ query: "opencode -2.2.3" }))).toEqual(["ses_numbers"])
  })

  it("marks the whole word in snippets", async () => {
    expect((await find({ query: "2.2.3" })).results[0]!.snippets[0]!.text).toContain(`opencode ${MARK.open}2.2.3${MARK.close} as`)
  })

  it("counts only sessions with the word as left out by the filters", async () => {
    session(db, { id: "ses_far", projectID: "prj_web", directory: "/work/web" })
    doc(db, { sessionID: "ses_far", text: "the resolver at 9.9.9.9 answered" })
    session(db, { id: "ses_far_noise", projectID: "prj_web", directory: "/work/web" })
    doc(db, { sessionID: "ses_far_noise", text: "scores 9 9 9 9 and 9 9 9 9" })
    expect((await find({ query: "9.9.9.9" })).hidden).toEqual({ scope: 1, archived: 0, subagents: 0, current: 0 })
    expect((await ids({ query: "9.9.9.9", scope: "all" }))).toEqual(["ses_far"])
  })
})

describe("substring mode", () => {
  beforeEach(seed)

  it("matches inside words", async () => {
    expect((await ids({ query: "uth.t", match: "substring" }))).toEqual(["ses_login"])
    expect((await ids({ query: "alidat", match: "substring" }))).toEqual(["ses_login"])
  })

  it("highlights the substring in snippets", async () => {
    const hit = (await find({ query: "uth.t", match: "substring" })).results[0]!
    expect(hit.snippets[0]!.text).toContain(`a${MARK.open}uth.t${MARK.close}s`)
  })

  it("needs terms of at least three characters", async () => {
    await expect(find({ query: "ab", match: "substring" })).rejects.toThrow(/at least 3 characters/)
    expect((await ids({ query: "ab postgres", match: "substring" }))).toEqual(["ses_db"])
  })

  it("checks candidates against the text, so scattered trigrams are not a match", async () => {
    session(db, { id: "ses_tri" })
    doc(db, { sessionID: "ses_tri", text: "the abc and xbcd parts" })
    expect((await ids({ query: "abcd", match: "substring" }))).toEqual([])
    expect((await ids({ query: "xbcd", match: "substring" }))).toEqual(["ses_tri"])
  })

  it("ignores case, also outside ASCII, and takes terms literally", async () => {
    session(db, { id: "ses_case" })
    doc(db, { sessionID: "ses_case", text: "İstanbul: Der ÄRGER mit a+b(c) in Config.YAML" })
    const snippet = async (query: string) => (await find({ query, match: "substring" })).results.find(hit => hit.sessionID === "ses_case")?.snippets[0]?.text
    expect((await snippet("ärger"))).toContain(`${MARK.open}ÄRGER${MARK.close}`)
    expect((await snippet("A+B(C)"))).toContain(`${MARK.open}a+b(c)${MARK.close}`)
    // İ lower-cases to two characters; positions after it still mark the right text.
    expect((await snippet("config.yaml"))).toContain(`${MARK.open}Config.YAML${MARK.close}`)
    expect((await ids({ query: "a.b", match: "substring" }))).not.toContain("ses_case")
  })

  it("centres the snippet on the first match of any term, however deep in the text", async () => {
    session(db, { id: "ses_deep" })
    const filler = Array.from({ length: 300 }, (_, i) => `word${i}`).join("  \n ")
    doc(db, { sessionID: "ses_deep", text: `${filler} then Needle-One here ${filler} and needle-two at the end` })
    const text = (await find({ query: "needle-two needle-one", match: "substring" })).results[0]!.snippets[0]!.text
    expect(text).toContain(`${MARK.open}Needle-One${MARK.close}`)
    expect(text.startsWith(MARK.cut) && text.endsWith(MARK.cut)).toBe(true)
    expect(text.length).toBeLessThanOrEqual(SNIPPET_CHARS + 8)
  })

  it("excludes -terms and ranks near matches below full ones", async () => {
    expect((await ids({ query: "login -password", match: "substring" })).sort()).toEqual(["ses_current", "ses_login", "ses_lookalike"])
    expect((await find({ query: "login -password", match: "substring" })).results.find(hit => hit.sessionID === "ses_login")!.matches).toBe(2)
    const out = (await find({ query: "uth.ts empty", match: "substring" }))
    expect(out.results.map(hit => [hit.sessionID, hit.queriesMatched])).toEqual([["ses_login", 1]])
    const near = (await find({ query: "uth.ts zzzz", match: "substring" }))
    expect(near).toMatchObject({ relaxed: true, results: [{ sessionID: "ses_login", queriesMatched: 0 }] })
  })
})

describe("near-duplicate sessions", () => {
  beforeEach(() => noise(db))

  const run = (id: string, title: string, directory = "/work/app", updated = NOW - DAY) => {
    session(db, { id, title, directory, updated })
    doc(db, { sessionID: id, text: "disk usage is fine, load average normal" })
  }

  it("fold into the best one, which counts them in similar", async () => {
    run("ses_r1", "sys-health.sh status report", "/work/app", NOW - 3 * DAY)
    run("ses_r2", "Sys-Health.sh  Status report!", "/work/app/", NOW - DAY)
    run("ses_r3", "sys health sh status report", "/work/app", NOW - 2 * DAY)
    run("ses_elsewhere", "sys-health.sh status report", "/work/app/ops")
    run("ses_other", "Disk report")
    const out = (await find({ query: "disk usage" }))
    expect(out.results.map(hit => [hit.sessionID, hit.similar]).sort()).toEqual([["ses_elsewhere", 0], ["ses_other", 0], ["ses_r2", 2]])
    expect(out.total).toBe(3)
  })

  it("fold near-identical titles in one directory, also through a title folded before, but not titles that differ in a number", async () => {
    run("ses_check", "sys-health.sh clean check", "/work/app", NOW - DAY)
    run("ses_clean", "sys-health.sh clean status", "/work/app", NOW - 2 * DAY)
    // Close to the second title only; it joins the group the second title joined.
    run("ses_report", "sys-health.sh status report", "/work/app", NOW - 3 * DAY)
    run("ses_ops", "sys-health.sh status report", "/work/app/ops")
    run("ses_issue1", "Fix issue 123 in the parser")
    run("ses_issue2", "Fix issue 456 in the parser")
    run("ses_login", "Fix the login bug")
    run("ses_logout", "Fix the logout bug")
    run("ses_new1", "New session - 2026-10-01T10:00:00.000Z")
    run("ses_new2", "New session - 2026-10-01T10:00:05.000Z")
    const out = (await find({ query: "disk usage", limit: 20 }))
    expect(out.results.map(hit => [hit.sessionID, hit.similar]).sort()).toEqual([
      ["ses_check", 2], ["ses_issue1", 0], ["ses_issue2", 0], ["ses_login", 0], ["ses_logout", 0], ["ses_new1", 0], ["ses_new2", 0], ["ses_ops", 0],
    ])
  })

  it("fold sessions in one directory whose first prompts are the same after normalising, unless the prompt is a word or two", async () => {
    const prompted = (id: string, title: string, firstPrompt: string, directory = "/work/app", updated = NOW - DAY) => {
      session(db, { id, title, firstPrompt, directory, updated })
      doc(db, { sessionID: id, text: "disk usage is fine, load average normal" })
    }
    prompted("ses_p1", "Morning disk check", "Run the nightly disk report, then summarise it.")
    prompted("ses_p2", "", "run the nightly disk report then  summarise it", "/work/app/", NOW - 2 * DAY)
    prompted("ses_p3", "Storage summary", "Run the nightly disk report, then summarise it.", "/work/app/ops")
    prompted("ses_go1", "Alpha", "Continue.")
    prompted("ses_go2", "Beta", "continue")
    const out = (await find({ query: "disk usage" }))
    expect(out.results.map(hit => [hit.sessionID, hit.similar]).sort()).toEqual([["ses_go1", 0], ["ses_go2", 0], ["ses_p1", 1], ["ses_p3", 0]])
  })

  it("never fold sessions with no title or prompt in common, and page over the folded list", async () => {
    run("ses_u1", "")
    run("ses_u2", " - ")
    for (let i = 0; i < 4; i++) run(`ses_same${i}`, "Nightly check", "/work/app", NOW - i * DAY)
    const first = (await find({ query: "disk usage", limit: 2 }))
    expect(first.total).toBe(3)
    const second = (await find({ query: "disk usage", limit: 2, cursor: first.next! }))
    expect([...first.results, ...second.results].map(hit => [hit.sessionID, hit.similar]).sort()).toEqual([["ses_same0", 3], ["ses_u1", 0], ["ses_u2", 0]])
    expect(second.next).toBeNull()
  })
})

describe("what the filters left out", () => {
  beforeEach(seed)

  const none = { scope: 0, archived: 0, subagents: 0, current: 0 }

  it("is counted per reason when a search finds nothing, in every mode", async () => {
    expect((await find({ query: "login" })).hidden).toBeNull()
    for (const match of ["words", "substring", "regex"] as const) {
      expect((await find({ query: "archived", match })).hidden, match).toEqual({ ...none, archived: 1 })
      expect((await find({ query: "style", match })).hidden, match).toEqual({ ...none, scope: 1 })
      expect((await find({ query: "helper", match })).hidden, match).toEqual({ ...none, subagents: 1 })
      expect((await find({ query: "search history", match: match === "regex" ? "words" : match }, { ...CALLER, sessionID: "ses_current" })).hidden, match).toEqual({ ...none, current: 1 })
      expect((await find({ query: "zzqx", match })).hidden, match).toEqual(none)
    }
  })

  it("counts a session under every input that leaves it out", async () => {
    session(db, { id: "ses_far", projectID: "prj_web", directory: "/work/web", archived: NOW - DAY })
    doc(db, { sessionID: "ses_far", text: "a quokka in another project, archived" })
    expect((await find({ query: "quokka" })).hidden).toEqual({ ...none, scope: 1, archived: 1 })
    expect((await find({ query: "quokka", scope: "all" })).hidden).toEqual({ ...none, archived: 1 })
    expect((await find({ query: "quokka", includeArchived: true })).hidden).toEqual({ ...none, scope: 1 })
  })

  it("counts matches in the caller's own subagents under both current and subagents, in every mode", async () => {
    session(db, { id: "ses_mine", parentID: "ses_current", agent: "explore", title: "Explore", updated: NOW })
    doc(db, { sessionID: "ses_mine", text: "the quokka lives in burrow.ts" })
    const caller = { ...CALLER, sessionID: "ses_current" }
    for (const match of ["words", "substring", "regex"] as const) {
      expect((await find({ query: "quokka", match }, caller)).hidden, match).toEqual({ ...none, subagents: 1, current: 1 })
    }
    expect((await find({ query: "quokka", includeSubagents: true }, caller)).hidden).toEqual({ ...none, current: 1 })
    expect((await ids({ query: "quokka", includeSubagents: true, includeCurrent: true }, caller))).toEqual(["ses_current"])
  })

  it("counts subagent matches of a named session", async () => {
    expect((await find({ query: "helper", sessionID: "ses_login" })).hidden).toEqual({ ...none, subagents: 1 })
    expect((await ids({ query: "helper", sessionID: "ses_login", includeSubagents: true }))).toEqual(["ses_login"])
  })
})

describe("ranking", () => {
  beforeEach(() => noise(db, 100))

  it("weights doc kinds", async () => {
    twins("deploy the release", { id: "ses_title" }, { id: "ses_result" }, ["title", "tool_result"])
    const out = (await find({ query: "deploy", recency: false }))
    expect(out.results.map(hit => hit.sessionID)).toEqual(["ses_title", "ses_result"])
    expect(out.results[0]!.score / out.results[1]!.score).toBeCloseTo(3 / 0.5, 4)
  })

  it("boosts the caller's project and directory", async () => {
    twins("deploy the release", { id: "ses_other", projectID: "prj_web", directory: "/work/web" }, { id: "ses_here", directory: "/work/app" })
    twins("deploy the release", { id: "ses_sub", directory: "/work/app/sub" }, { id: "ses_none", projectID: "prj_web", directory: "/work/app" })
    const out = (await find({ query: "deploy", scope: "all", recency: false }))
    const score = Object.fromEntries(out.results.map(hit => [hit.sessionID, hit.score]))
    expect(out.results.map(hit => hit.sessionID)).toEqual(["ses_here", "ses_sub", "ses_none", "ses_other"])
    expect(score.ses_sub! / score.ses_other!).toBeCloseTo(1.5, 2)
    expect(score.ses_none! / score.ses_other!).toBeCloseTo(1.2, 2)
    expect(score.ses_here! / score.ses_other!).toBeCloseTo(1.8, 2)
  })

  it("blends in recency with a 45-day half-life, unless turned off", async () => {
    twins("deploy the release", { id: "ses_old", updated: NOW - 45 * DAY }, { id: "ses_new", updated: NOW })
    const on = (await find({ query: "deploy" }))
    expect(on.results.map(hit => hit.sessionID)).toEqual(["ses_new", "ses_old"])
    expect(on.results[1]!.score / on.results[0]!.score).toBeCloseTo(0.85, 2)
    const off = (await find({ query: "deploy", recency: false }))
    expect(off.results[0]!.score).toBe(off.results[1]!.score)
  })

  it("adds 0.3 of the second match and caps the rest at half the best", async () => {
    session(db, { id: "ses_one" })
    session(db, { id: "ses_two" })
    session(db, { id: "ses_many" })
    doc(db, { sessionID: "ses_one", text: "deploy the release" })
    for (let i = 0; i < 2; i++) doc(db, { sessionID: "ses_two", text: "deploy the release" })
    for (let i = 0; i < 30; i++) doc(db, { sessionID: "ses_many", text: "deploy the release" })
    const out = (await find({ query: "deploy", recency: false }))
    const score = Object.fromEntries(out.results.map(hit => [hit.sessionID, hit.score]))
    expect(out.results.map(hit => hit.sessionID)).toEqual(["ses_many", "ses_two", "ses_one"])
    expect(score.ses_two! / score.ses_one!).toBeCloseTo(1.3, 2)
    expect(score.ses_many! / score.ses_one!).toBeCloseTo(1.8, 2)
    expect(out.results[0]!.matches).toBe(30)
  })

  it(`scores a near match at ${NEAR_WEIGHT} of the full match it would be`, async () => {
    session(db, { id: "ses_one" })
    doc(db, { sessionID: "ses_one", text: "deploy the release" })
    const full = (await find({ query: "deploy release", recency: false })).results[0]!
    const near = (await find({ query: "deploy release zebra", recency: false })).results[0]!
    expect([full.queriesMatched, near.queriesMatched]).toEqual([1, 0])
    expect(near.score / full.score).toBeCloseTo(NEAR_WEIGHT, 4)
  })

  it("finds a short session with most of the words among longer full matches", async () => {
    session(db, { id: "ses_short", title: "Flaky upload test", updated: NOW - DAY })
    titleDoc(db, "ses_short", "Flaky upload test")
    doc(db, { sessionID: "ses_short", text: "the upload test is flaky on CI" })
    for (let i = 0; i < 12; i++) {
      session(db, { id: `ses_log${i}`, updated: NOW - DAY })
      const log = Array.from({ length: 80 }, (_, line) => `step ${line} ok`).join("\n")
      doc(db, { sessionID: `ses_log${i}`, kind: "tool_result", tool: "bash", text: `fix flaky upload test\n${log}` })
    }
    const out = (await find({ query: "fix flaky upload test", limit: 20 }))
    expect(out.total).toBe(13)
    const short = out.results.find(hit => hit.sessionID === "ses_short")
    expect(short).toMatchObject({ queriesMatched: 0 })
    expect(out.results.filter(hit => hit.queriesMatched === 1).length).toBe(12)
  })

  it("looks for near matches only when the full matches of every phrasing leave the page short", async () => {
    for (let i = 0; i < 3; i++) {
      session(db, { id: `ses_full${i}` })
      doc(db, { sessionID: `ses_full${i}`, text: "rotate the signing key" })
    }
    session(db, { id: "ses_near" })
    doc(db, { sessionID: "ses_near", text: "the signing service" })
    const query = ["rotate signing", "signing key"]
    for (const match of ["words", "substring"] as const) {
      const filled = (await find({ query, match, limit: 2 }))
      expect([filled.total, filled.relaxed], match).toEqual([3, false])
      // The next page with the same limit pages over the same list.
      const next = (await find({ query, match, limit: 2, cursor: filled.next! }))
      expect([next.total, next.relaxed, next.results.length, next.next], match).toEqual([3, false, 1, null])
      const short = (await find({ query, match, limit: 4 }))
      expect([short.total, short.relaxed, short.results.at(-1)?.sessionID], match).toEqual([4, true, "ses_near"])
    }
  })

  it(`takes a phrasing's near matches from its ${NEAR_CANDIDATES} best texts by bm25, before the filters`, async () => {
    for (let i = 0; i < NEAR_CANDIDATES; i++) {
      session(db, { id: `ses_web${i}`, projectID: "prj_web", directory: "/work/web" })
      doc(db, { sessionID: `ses_web${i}`, kind: "title", text: "quokka" })
    }
    session(db, { id: "ses_here" })
    doc(db, { sessionID: "ses_here", text: `quokka ${"filler ".repeat(200)}` })
    expect((await find({ query: "quokka wombat" })).total).toBe(0)
    expect((await find({ query: "quokka wombat", scope: "all" })).total).toBe(NEAR_CANDIDATES)
    expect((await ids({ query: "quokka" }))).toEqual(["ses_here"])
  })

  it("searches several phrasings together and rewards matching more of them", async () => {
    twins("the token refresh expired", { id: "ses_both" }, { id: "ses_once" })
    doc(db, { sessionID: "ses_both", text: "oauth credentials rotated" })
    const out = (await find({ query: ["token refresh", "oauth credentials", "token refresh"], recency: false }))
    expect(out.results.map(hit => [hit.sessionID, hit.queriesMatched])).toEqual([
      ["ses_both", 2],
      ["ses_once", 1],
    ])
  })
})

describe("filters", () => {
  beforeEach(seed)

  it("scopes to the caller's directory and below, not siblings with the same prefix", async () => {
    expect((await ids({ query: "login OR migration", scope: "directory" })).sort()).toEqual(["ses_current", "ses_db", "ses_login"])
  })

  it("scopes to all projects", async () => {
    expect((await ids({ query: "login", scope: "all" })).sort()).toEqual(["ses_current", "ses_login", "ses_lookalike", "ses_web"])
  })

  it("scopes to one session tree, defaulting to the caller's", async () => {
    expect((await ids({ query: "validation", scope: "session", sessionID: "ses_login" }))).toEqual(["ses_login"])
    expect((await ids({ query: "login", scope: "session" }, { ...CALLER, sessionID: "ses_current" }))).toEqual(["ses_current"])
    expect((await ids({ query: "login", sessionID: "ses_web" }))).toEqual(["ses_web"])
  })

  it("leaves out the caller's whole session tree unless includeCurrent", async () => {
    expect((await ids({ query: "login" }, { ...CALLER, sessionID: "ses_current" }))).not.toContain("ses_current")
    expect((await ids({ query: "login", includeCurrent: true }, { ...CALLER, sessionID: "ses_current" }))).toContain("ses_current")
    expect((await ids({ query: "validation" }, { ...CALLER, sessionID: "ses_explore" }))).toEqual([])
    expect((await ids({ query: "validation" }, { ...CALLER, sessionID: "ses_login" }))).toEqual([])
  })

  it("leaves out archived sessions unless includeArchived", async () => {
    expect((await ids({ query: "archived" }))).toEqual([])
    expect((await ids({ query: "archived", includeArchived: true }))).toEqual(["ses_archived"])
  })

  it("filters by time with durations and dates", async () => {
    expect((await ids({ query: "fixed" })).sort()).toEqual(["ses_db", "ses_login"])
    expect((await ids({ query: "fixed", since: "7d" }))).toEqual(["ses_login"])
    expect((await ids({ query: "fixed", until: "2m" }))).toEqual(["ses_db"])
    expect((await ids({ query: "fixed", since: new Date(NOW - 2 * DAY).toISOString().slice(0, 10) }))).toEqual(["ses_login"])
    await expect(find({ query: "fixed", since: "last tuesday" })).rejects.toThrow(QueryError)
  })

  it("filters by kind, tool and agent", async () => {
    expect((await find({ query: "password", kinds: ["tool_call"] })).results[0]!.snippets.map(snippet => snippet.messageID)).toEqual(["m_login_3"])
    expect((await find({ query: "password", tool: "EDIT" })).results[0]!.snippets).toMatchObject([{ kind: "tool_call", tool: "edit" }])
    expect((await ids({ query: "password", tool: "bash" }))).toEqual([])
    expect((await find({ query: "validation", agent: "explore", includeSubagents: true })).results[0]!.snippets.map(snippet => snippet.sessionID)).toEqual(["ses_explore"])
  })

  it("filters by files the session tree touched", async () => {
    expect((await ids({ query: "login OR migration", path: "src/auth.ts" }))).toEqual(["ses_login"])
    expect((await ids({ query: "login OR migration", path: "/work/app/src/auth.ts" }))).toEqual(["ses_login"])
    expect((await ids({ query: "login OR migration", path: "/work/app/src/" }))).toEqual(["ses_login"])
    expect((await ids({ query: "login OR migration", path: "validators.ts" }))).toEqual(["ses_login"])
    expect((await ids({ query: "login OR migration", path: "src/*.ts" }))).toEqual(["ses_login"])
    expect((await ids({ query: "login OR migration", path: "auth" }))).toEqual([])
    expect((await ids({ query: "login OR migration", path: "uth.ts" }))).toEqual([])
  })
})

describe("snippets", () => {
  beforeEach(() => noise(db))

  it("takes up to `snippets` from distinct messages, best first", async () => {
    session(db, { id: "ses_a" })
    doc(db, { sessionID: "ses_a", messageID: "m1", part: 0, kind: "user", text: "deploy deploy deploy now" })
    doc(db, { sessionID: "ses_a", messageID: "m1", part: 1, kind: "user", text: "deploy again" })
    doc(db, { sessionID: "ses_a", messageID: "m2", kind: "assistant", text: "deploy finished" })
    doc(db, { sessionID: "ses_a", messageID: "m3", kind: "tool_result", text: "deploy log" })
    doc(db, { sessionID: "ses_a", messageID: "m4", kind: "reasoning", text: "deploy thoughts" })
    const hit = (await find({ query: "deploy" })).results[0]!
    expect(hit.matches).toBe(5)
    expect(hit.snippets.map(snippet => snippet.messageID)).toEqual(["m1", "m2", "m3"])
    expect(hit.snippets[0]).toMatchObject({ kind: "user", sessionID: "ses_a", time: new Date(NOW - DAY).toISOString() })
    expect(hit.snippets[0]!.text).toBe(`${MARK.open}deploy${MARK.close} ${MARK.open}deploy${MARK.close} ${MARK.open}deploy${MARK.close} now`)
    expect((await find({ query: "deploy", snippets: 1 })).results[0]!.snippets).toHaveLength(1)
    expect((await find({ query: "deploy", snippets: 0 })).results[0]!.snippets).toEqual([])
  })

  it("cuts long docs to about 240 characters around the match", async () => {
    session(db, { id: "ses_long" })
    const filler = (word: string) => Array.from({ length: 150 }, (_, i) => `${word}${i}`).join("\n  ")
    const text = `${filler("head")} the needle sits here ${filler("tail")}`
    doc(db, { sessionID: "ses_long", text })
    for (const match of ["words", "substring", "regex"] as const) {
      const snippet = (await find({ query: "needle", match })).results[0]!.snippets[0]!.text
      expect(snippet, match).toContain(`${MARK.open}needle${MARK.close}`)
      expect(snippet.startsWith(MARK.cut) && snippet.endsWith(MARK.cut), match).toBe(true)
      expect(snippet.length, match).toBeLessThanOrEqual(SNIPPET_CHARS + 8)
      expect(snippet.length, match).toBeGreaterThan(SNIPPET_CHARS - 40)
      expect(snippet, match).not.toMatch(/\s{2,}|\n/)
    }
  })
})

describe("pagination", () => {
  it("pages with an opaque cursor", async () => {
    for (let i = 0; i < 5; i++) {
      session(db, { id: `ses_${i}`, updated: NOW - i * DAY })
      doc(db, { sessionID: `ses_${i}`, text: "deploy the release" })
    }
    const first = (await find({ query: "deploy", limit: 2 }))
    expect(first.total).toBe(5)
    expect(first.results.map(hit => hit.sessionID)).toEqual(["ses_0", "ses_1"])
    expect(decodeCursor(first.next!)).toBe(2)
    const second = (await find({ query: "deploy", limit: 2, cursor: first.next! }))
    expect(second.results.map(hit => hit.sessionID)).toEqual(["ses_2", "ses_3"])
    const last = (await find({ query: "deploy", limit: 2, cursor: second.next! }))
    expect(last.results.map(hit => hit.sessionID)).toEqual(["ses_4"])
    expect(last.next).toBeNull()
    expect((await find({ query: "deploy" })).results).toHaveLength(5)
    await expect(find({ query: "deploy", cursor: "nope" })).rejects.toThrow(/cursor/)
  })

  it("defaults to the tool's default limit and snippet count, and clamps to their ranges", async () => {
    const { limit, snippets } = BOUNDS.search
    for (let i = 0; i < limit.max + 2; i++) {
      session(db, { id: `ses_${i}` })
      for (let seq = 0; seq < snippets.max + 2; seq++) doc(db, { sessionID: `ses_${i}`, seq, text: `deploy step ${seq}` })
    }
    const out = (await find({ query: "deploy" }))
    expect(out.results).toHaveLength(limit.default)
    expect(out.results[0]!.snippets).toHaveLength(snippets.default)
    expect(out.total).toBe(limit.max + 2)
    expect(out.next).not.toBeNull()
    const most = (await find({ query: "deploy", limit: 1000, snippets: 1000 }))
    expect(most.results).toHaveLength(limit.max)
    expect(most.results[0]!.snippets).toHaveLength(snippets.max)
    expect((await find({ query: "deploy", limit: 0, snippets: -1 })).results.map(hit => hit.snippets.length)).toEqual([snippets.min])
  })

  it("searches at most MAX_PHRASINGS phrasings, as the tool schema allows", async () => {
    session(db, { id: "ses_last" })
    doc(db, { sessionID: "ses_last", text: "zephyr" })
    const filler = Array.from({ length: MAX_PHRASINGS }, (_, i) => `absent${i}`)
    expect((await find({ query: [...filler.slice(1), "zephyr"] })).results.map(hit => hit.sessionID)).toEqual(["ses_last"])
    expect((await find({ query: [...filler, "zephyr"] })).results).toEqual([])
  })
})

describe("regex mode", () => {
  beforeEach(seed)

  it("matches a JavaScript RegExp, ignoring case unless /flags/ are given", async () => {
    expect((await ids({ query: "NULL\\s+pointer", match: "regex" }))).toEqual(["ses_login"])
    expect((await ids({ query: "/NULL\\s+pointer/", match: "regex" }))).toEqual([])
    expect((await ids({ query: "/null\\s+pointer/", match: "regex" }))).toEqual(["ses_login"])
    const hit = (await find({ query: "src/\\w+\\.ts", match: "regex" })).results[0]!
    expect(hit.snippets[0]!.text).toContain(`${MARK.open}src/auth.ts${MARK.close}`)
    expect((await find({ query: "login", match: "regex" })).relaxed).toBe(false)
  })

  it("applies the other filters", async () => {
    expect((await ids({ query: "login", match: "regex", scope: "all" })).sort()).toEqual(["ses_current", "ses_login", "ses_lookalike", "ses_web"])
    expect((await ids({ query: "login", match: "regex", kinds: ["assistant"] }))).toEqual(["ses_login"])
    expect((await ids({ query: "login", match: "regex" }, { ...CALLER, sessionID: "ses_current" })).sort()).toEqual(["ses_login", "ses_lookalike"])
  })

  it("lets the event loop run between batches of a long scan", async () => {
    session(db, { id: "ses_many", updated: NOW })
    for (let i = 0; i < 1200; i++) doc(db, { sessionID: "ses_many", seq: i, text: `line ${i} of the log` })
    let turns = 0, done = false
    const tick = () => { turns++; if (!done) setImmediate(tick) }
    setImmediate(tick)
    const out = await find({ query: "of the lo+g$", match: "regex" })
    done = true
    expect(out.results.map(hit => hit.sessionID)).toEqual(["ses_many"])
    expect(turns).toBeGreaterThan(1)
  })

  it("reports an invalid pattern clearly", async () => {
    await expect(find({ query: "fix(", match: "regex" })).rejects.toThrow(QueryError)
    await expect(find({ query: "fix(", match: "regex" })).rejects.toThrow("invalid regex: Unterminated group")
  })

  it("ignores patterns that only match empty strings", async () => {
    expect((await ids({ query: "^", match: "regex" }))).toEqual([])
  })

  it(`reads at most ${SCAN_DOCS} candidate docs, newest first, and asks the trigrams for candidates when the pattern has a literal`, async () => {
    session(db, { id: "ses_bulk", updated: NOW })
    db.transaction(() => {
      db.run(
        `with recursive n(i) as (select 0 union all select i + 1 from n where i < ?)
          insert into docs (session_id, root_id, message_id, seq, part, time, kind)
          select 'ses_bulk', 'ses_bulk', 'm_bulk_' || i, i, 0, ? - i, 'user' from n`,
        SCAN_DOCS,
        NOW,
      )
      db.run("insert into doc_texts (id, text) select id, 'filler ' || seq from docs where session_id = 'ses_bulk'")
    })
    session(db, { id: "ses_buried", updated: NOW - 400 * DAY })
    doc(db, { sessionID: "ses_buried", time: NOW - 400 * DAY, text: "zebra crossing" })
    expect((await ids({ query: "zebra" }))).toEqual(["ses_buried"])
    // "zebra" is a literal every match holds, so its trigrams find the old doc past the newest texts.
    expect((await find({ query: "zeb+ra\\s", match: "regex" }))).toMatchObject({ truncated: false, results: [{ sessionID: "ses_buried" }] })
    expect((await find({ query: "rossin", match: "substring" }))).toMatchObject({ truncated: false, results: [{ sessionID: "ses_buried" }] })
    // Without a literal of three characters, regex mode reads only the newest texts.
    expect((await find({ query: "\\bz\\w{3}a\\b", match: "regex" }))).toMatchObject({ truncated: true, results: [] })
    expect((await find({ query: "^filler \\d*0$", match: "regex" }))).toMatchObject({ truncated: true, results: [{ sessionID: "ses_bulk" }] })
    expect((await find({ query: "filler", match: "substring" }))).toMatchObject({ truncated: true, results: [{ sessionID: "ses_bulk" }] })
    expect((await find({ query: "filler" }))).toMatchObject({ truncated: true, results: [{ sessionID: "ses_bulk" }] })
    expect((await find({ query: "zebra" })).truncated).toBe(false)
  })
})
