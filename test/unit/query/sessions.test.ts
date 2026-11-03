import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Caller, SessionsInput } from "../../../src/domain/api.js"
import type { Db } from "../../../src/domain/sqlite.js"
import { decodeCursor, encodeCursor } from "../../../src/query/parse.js"
import { sessions } from "../../../src/query/sessions.js"
import { CALLER, DAY, NOW, STATE, doc, file, project, session, sidecar, type Sidecar } from "./fixture.js"

let index: Sidecar
let db: Db

const list = (input: SessionsInput = {}, caller: Caller = CALLER) => sessions(db, caller, input, STATE, { now: NOW })
const ids = (input?: SessionsInput, caller?: Caller) => list(input, caller).sessions.map(item => item.sessionID)

beforeEach(() => {
  index = sidecar()
  db = index.db
  project(db, "prj_app", "/work/app")
  project(db, "prj_web", "/work/web")
  session(db, { id: "ses_a", title: "Fix the 100% CPU bug", created: NOW - 10 * DAY, updated: NOW - DAY, cost: 0.5, messages: 12, outcome: "succeeded" })
  session(db, { id: "ses_a_child", parentID: "ses_a", agent: "explore", title: "Explore", created: NOW - 9 * DAY, updated: NOW - 9 * DAY })
  session(db, { id: "ses_b", title: "Database migration", created: NOW - 40 * DAY, updated: NOW - 30 * DAY, cost: 2, messages: 4 })
  session(db, { id: "ses_c", title: "Refactor_utils", directory: "/work/app/pkg", created: NOW - 3 * DAY, updated: NOW - 2 * DAY, cost: 1, messages: 30 })
  session(db, { id: "ses_web", projectID: "prj_web", directory: "/work/web", title: "Web", updated: NOW })
  session(db, { id: "ses_old", title: "Archived", updated: NOW - 5 * DAY, archived: NOW - DAY })
  doc(db, { sessionID: "ses_a", kind: "tool_call", tool: "edit", text: "edit: src/cpu.ts" })
  doc(db, { sessionID: "ses_b", kind: "summary", text: "the migration was rolled back" })
  file(db, "ses_a_child", "/work/app/src/cpu.ts", "read")
})

afterEach(() => index.close())

describe("sessions", () => {
  it("lists top-level sessions of the caller's project, most recently updated first", () => {
    const out = list()
    expect(out.sessions.map(item => item.sessionID)).toEqual(["ses_a", "ses_c", "ses_b"])
    expect(out.sessions[0]).toMatchObject({ title: "Fix the 100% CPU bug", project: "/work/app", cost: 0.5, outcome: "succeeded", messages: 12, subagents: 1, parentID: null })
    expect(out.index).toBe(STATE)
    expect(out.next).toBeNull()
  })

  it("adds subagent sessions with includeSubagents", () => {
    expect(ids({ includeSubagents: true })).toEqual(["ses_a", "ses_c", "ses_a_child", "ses_b"])
  })

  it("sorts by created, cost or messages, largest first", () => {
    expect(ids({ sort: "created" })).toEqual(["ses_c", "ses_a", "ses_b"])
    expect(ids({ sort: "cost" })).toEqual(["ses_b", "ses_c", "ses_a"])
    expect(ids({ sort: "messages" })).toEqual(["ses_c", "ses_a", "ses_b"])
    expect(() => list({ sort: "size" as never })).toThrow(/sort must be/)
  })

  it("filters titles by contained text, treating % and _ literally", () => {
    expect(ids({ title: "cpu" })).toEqual(["ses_a"])
    expect(ids({ title: "100%" })).toEqual(["ses_a"])
    expect(ids({ title: "r_u" })).toEqual(["ses_c"])
    expect(ids({ title: "_" })).toEqual(["ses_c"])
  })

  it("keeps sessions active in the since/until window", () => {
    expect(ids({ since: "7d" })).toEqual(["ses_a", "ses_c"])
    expect(ids({ until: "20d" })).toEqual(["ses_b"])
    expect(ids({ since: "35d", until: "5d" })).toEqual(["ses_a", "ses_b"])
  })

  it("filters by tool, kinds, agent and touched path", () => {
    expect(ids({ tool: "edit" })).toEqual(["ses_a"])
    expect(ids({ kinds: ["summary"] })).toEqual(["ses_b"])
    expect(ids({ agent: "explore", includeSubagents: true })).toEqual(["ses_a_child"])
    expect(ids({ path: "src/cpu.ts" })).toEqual(["ses_a"])
    expect(ids({ path: "src/cpu.ts", includeSubagents: true })).toEqual(["ses_a", "ses_a_child"])
  })

  it("scopes by directory or all projects, and archived sessions on request", () => {
    expect(ids({ scope: "directory" }, { ...CALLER, directory: "/work/app/pkg" })).toEqual(["ses_c"])
    expect(ids({ scope: "all" })).toEqual(["ses_web", "ses_a", "ses_c", "ses_b"])
    expect(ids({ includeArchived: true })).toEqual(["ses_a", "ses_c", "ses_old", "ses_b"])
    expect(ids({ sessionID: "ses_web" })).toEqual(["ses_web"])
  })

  it("leaves out the caller's session tree unless includeCurrent", () => {
    expect(ids({}, { ...CALLER, sessionID: "ses_a_child" })).toEqual(["ses_c", "ses_b"])
    expect(ids({ includeCurrent: true }, { ...CALLER, sessionID: "ses_a_child" })).toEqual(["ses_a", "ses_c", "ses_b"])
  })

  it("counts what the default filters left out when nothing is listed", () => {
    const none = { scope: 0, archived: 0, subagents: 0, current: 0 }
    expect(list().hidden).toBeNull()
    expect(list({ title: "web" }).hidden).toEqual({ ...none, scope: 1 })
    expect(list({ title: "archived" }).hidden).toEqual({ ...none, archived: 1 })
    expect(list({ title: "explore" }).hidden).toEqual({ ...none, subagents: 1 })
    expect(list({ title: "cpu" }, { ...CALLER, sessionID: "ses_a" }).hidden).toEqual({ ...none, current: 1 })
    expect(list({ title: "nothing like it" }).hidden).toEqual(none)
    // A page past the end is not a search that found nothing.
    expect(list({ cursor: encodeCursor(10) })).toMatchObject({ sessions: [], hidden: null })
  })

  it("counts the caller's own subagent sessions under both current and subagents", () => {
    const none = { scope: 0, archived: 0, subagents: 0, current: 0 }
    expect(list({ title: "explore" }, { ...CALLER, sessionID: "ses_a" }).hidden).toEqual({ ...none, subagents: 1, current: 1 })
    expect(ids({ title: "explore", includeSubagents: true, includeCurrent: true }, { ...CALLER, sessionID: "ses_a" })).toEqual(["ses_a_child"])
  })

  it("pages with a cursor", () => {
    const first = list({ limit: 2 })
    expect(first.sessions.map(item => item.sessionID)).toEqual(["ses_a", "ses_c"])
    expect(decodeCursor(first.next!)).toBe(2)
    const second = list({ limit: 2, cursor: first.next! })
    expect(second.sessions.map(item => item.sessionID)).toEqual(["ses_b"])
    expect(second.next).toBeNull()
  })
})
