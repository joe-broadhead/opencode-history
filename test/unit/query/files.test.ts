import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Caller, FilesInput } from "../../../src/domain/api.js"
import type { Db } from "../../../src/domain/sqlite.js"
import { MAX_TOUCH_SEQS, files } from "../../../src/query/files.js"
import { HistoryError } from "../../../src/domain/common.js"
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
          { sessionID: "ses_a", title: "Auth fix", ops: { read: 1, edit: 2 }, last: new Date(NOW - DAY).toISOString(), firstSeq: 3, seqs: [3, 5, 9], seqsCut: false },
          { sessionID: "ses_b", title: "Older auth work", ops: { patch: 1 }, last: new Date(NOW - 20 * DAY).toISOString(), firstSeq: 2, seqs: [2], seqsCut: false },
        ],
      },
    ])
  })

  it("lists each matching touch's seq once, in order, and keeps the latest when there are too many", () => {
    // A read and an edit in one message are one seq.
    file(db, "ses_a", "/work/app/src/auth.ts", "read", { seq: 9, time: NOW - DAY })
    expect(touched({ path: "src/auth.ts" }).files[0]!.sessions[0]).toMatchObject({ ops: { read: 2, edit: 2 }, firstSeq: 3, seqs: [3, 5, 9], seqsCut: false })
    session(db, { id: "ses_busy", title: "Busy", updated: NOW })
    for (let seq = 10; seq < 10 + MAX_TOUCH_SEQS + 5; seq++) file(db, "ses_busy", "/work/app/src/busy.ts", "edit", { seq, time: NOW - DAY + seq })
    const busy = touched({ path: "src/busy.ts" }).files[0]!.sessions[0]!
    expect(busy).toMatchObject({ ops: { edit: MAX_TOUCH_SEQS + 5 }, firstSeq: 10, seqsCut: true })
    expect(busy.seqs).toEqual(Array.from({ length: MAX_TOUCH_SEQS }, (_, i) => 15 + i))
  })

  it("matches folders, absolute paths and paths with ..", () => {
    expect(touched({ path: "/work/app/src" }).files.map(item => item.path)).toEqual(["/work/app/src/auth.ts", "/work/app/src/login.ts"])
    expect(touched({ path: "src/" }).files.map(item => item.path)).toEqual(["/work/app/src/auth.ts", "/work/app/src/login.ts"])
    expect(touched({ path: "../app/src/login.ts" }).files.map(item => item.path)).toEqual(["/work/app/src/login.ts"])
    expect(touched({ path: "src/*.ts" }).files.map(item => item.path)).toEqual(["/work/app/src/auth.ts", "/work/app/src/login.ts"])
    expect(touched({ path: "auth" }).files).toEqual([])
  })

  it("filters by ops, tool and time", () => {
    expect(touched({ path: "src", ops: ["edit"] }).files).toMatchObject([{ path: "/work/app/src/auth.ts", sessions: [{ sessionID: "ses_a", ops: { edit: 2 }, firstSeq: 5, seqs: [5, 9] }] }])
    expect(touched({ path: "src", tool: "apply_patch" }).files).toMatchObject([{ sessions: [{ sessionID: "ses_b" }] }])
    expect(touched({ path: "src", since: "7d" }).files.flatMap(item => item.sessions.map(s => s.sessionID))).toEqual(["ses_a", "ses_a"])
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
    expect(() => touched({ path: " " })).toThrow(HistoryError)
    expect(() => touched({ path: "/" })).toThrow(/path must name a file or folder/)
  })
})
