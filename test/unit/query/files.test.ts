import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Caller, FilesInput } from "../../../src/domain/api.js"
import type { Db } from "../../../src/domain/sqlite.js"
import { files } from "../../../src/query/files.js"
import { QueryError } from "../../../src/query/parse.js"
import { CALLER, DAY, NOW, STATE, file, project, session, sidecar, type Sidecar } from "./fixture.js"

let index: Sidecar
let db: Db

const touched = (input: FilesInput, caller: Caller = CALLER) => files(db, caller, input, STATE, { now: NOW })

beforeEach(() => {
  index = sidecar()
  db = index.db
  project(db, "prj_app", "/work/app")
  session(db, { id: "ses_a", title: "Auth fix", updated: NOW - DAY })
  session(db, { id: "ses_a_child", parentID: "ses_a", title: "Explore auth", updated: NOW - DAY })
  session(db, { id: "ses_b", title: "Older auth work", updated: NOW - 20 * DAY })
  session(db, { id: "ses_web", projectID: "prj_web", directory: "/work/web", title: "Web" })
  file(db, "ses_a", "/work/app/src/auth.ts", "read", { seq: 3, time: NOW - 2 * DAY })
  file(db, "ses_a", "/work/app/src/auth.ts", "edit", { seq: 5, time: NOW - 2 * DAY + 10 })
  file(db, "ses_a", "/work/app/src/auth.ts", "edit", { seq: 9, time: NOW - DAY })
  file(db, "ses_a", "/work/app/src/login.ts", "write", { seq: 4, time: NOW - 3 * DAY })
  file(db, "ses_a_child", "/work/app/src/session.ts", "read", { seq: 1, time: NOW - DAY })
  file(db, "ses_b", "/work/app/src/auth.ts", "patch", { seq: 2, time: NOW - 20 * DAY, tool: "apply_patch" })
  file(db, "ses_web", "/work/web/src/auth.ts", "edit", { seq: 1, time: NOW })
})

afterEach(() => index.close())

describe("files", () => {
  it("groups touches by path, with op counts per session, most recent first", () => {
    const out = touched({ path: "src/auth.ts" })
    expect(out.index).toBe(STATE)
    expect(out.files).toEqual([
      {
        path: "/work/app/src/auth.ts",
        sessions: [
          { sessionID: "ses_a", title: "Auth fix", ops: { read: 1, edit: 2 }, last: new Date(NOW - DAY).toISOString(), firstSeq: 3 },
          { sessionID: "ses_b", title: "Older auth work", ops: { patch: 1 }, last: new Date(NOW - 20 * DAY).toISOString(), firstSeq: 2 },
        ],
      },
    ])
  })

  it("matches folders, absolute paths and paths with ..", () => {
    expect(touched({ path: "/work/app/src" }).files.map(item => item.path)).toEqual(["/work/app/src/auth.ts", "/work/app/src/login.ts"])
    expect(touched({ path: "src/" }).files.map(item => item.path)).toEqual(["/work/app/src/auth.ts", "/work/app/src/login.ts"])
    expect(touched({ path: "../app/src/login.ts" }).files.map(item => item.path)).toEqual(["/work/app/src/login.ts"])
    expect(touched({ path: "src/*.ts" }).files.map(item => item.path)).toEqual(["/work/app/src/auth.ts", "/work/app/src/login.ts"])
    expect(touched({ path: "auth" }).files).toEqual([])
  })

  it("filters by ops, tool and time", () => {
    expect(touched({ path: "src", ops: ["edit"] }).files).toMatchObject([{ path: "/work/app/src/auth.ts", sessions: [{ sessionID: "ses_a", ops: { edit: 2 } }] }])
    expect(touched({ path: "src", tool: "apply_patch" }).files).toMatchObject([{ sessions: [{ sessionID: "ses_b" }] }])
    expect(touched({ path: "src", since: "7d" }).files.flatMap(item => item.sessions.map(s => s.sessionID))).toEqual(["ses_a", "ses_a"])
    expect(() => touched({ path: "src", ops: ["delete" as never] })).toThrow(/ops must be among/)
  })

  it("includes subagent touches and other projects only on request", () => {
    expect(touched({ path: "session.ts" }).files).toEqual([])
    expect(touched({ path: "session.ts", includeSubagents: true }).files).toMatchObject([{ sessions: [{ sessionID: "ses_a_child", firstSeq: 1 }] }])
    expect(touched({ path: "src/auth.ts", scope: "all" }).files.map(item => item.path)).toEqual(["/work/web/src/auth.ts", "/work/app/src/auth.ts"])
  })

  it("counts the sessions the default filters left out when no file matches", () => {
    const none = { scope: 0, archived: 0, subagents: 0, current: 0 }
    expect(touched({ path: "src/auth.ts" }).hidden).toBeNull()
    expect(touched({ path: "session.ts" }).hidden).toEqual({ ...none, subagents: 1 })
    expect(touched({ path: "/work/web/src" }).hidden).toEqual({ ...none, scope: 1 })
    expect(touched({ path: "login.ts" }, { ...CALLER, sessionID: "ses_a_child" }).hidden).toEqual({ ...none, current: 1 })
    expect(touched({ path: "auth.ts", ops: ["search"] }).hidden).toEqual(none)
  })

  it("counts touches by the caller's own subagents under both current and subagents", () => {
    const none = { scope: 0, archived: 0, subagents: 0, current: 0 }
    expect(touched({ path: "session.ts" }, { ...CALLER, sessionID: "ses_a" }).hidden).toEqual({ ...none, subagents: 1, current: 1 })
    expect(touched({ path: "session.ts", includeSubagents: true }, { ...CALLER, sessionID: "ses_a" }).hidden).toEqual({ ...none, current: 1 })
    expect(touched({ path: "session.ts", includeSubagents: true, includeCurrent: true }, { ...CALLER, sessionID: "ses_a" }).files).toMatchObject([{ sessions: [{ sessionID: "ses_a_child" }] }])
  })

  it("limits the number of paths", () => {
    expect(touched({ path: "src", limit: 1 }).files.map(item => item.path)).toEqual(["/work/app/src/auth.ts"])
  })

  it("needs a path", () => {
    expect(() => touched({ path: " " })).toThrow(QueryError)
    expect(() => touched({ path: "/" })).toThrow(/path must name a file or folder/)
  })
})
