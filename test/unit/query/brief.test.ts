import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Db } from "../../../src/domain/sqlite.js"
import { brief, MAX_COMMANDS, type TodoSource } from "../../../src/query/brief.js"
import { DAY, NOW, NO_MASK, doc, fakeSource, file, link, project, session, sidecar, type FakeSource, type Sidecar } from "./fixture.js"

let index: Sidecar
let db: Db
let source: FakeSource

beforeEach(() => {
  index = sidecar()
  db = index.db
  source = fakeSource()
  project(db, "prj_app", "/work/app", "app")
  session(db, {
    id: "ses_main",
    title: "Fix uploads",
    model: "anthropic/claude-opus-5-5",
    cost: 1.25,
    created: NOW - 3 * DAY,
    updated: NOW - DAY,
    firstPrompt: "uploads fail over 10MB",
    lastReply: "Raised the limit and added a test.",
    outcome: "succeeded",
    messages: 20,
  })
  session(db, { id: "ses_child", parentID: "ses_main", agent: "explore", title: "Find the upload limit", model: "anthropic/claude-haiku-5-5", created: NOW - 2 * DAY })
  session(db, { id: "ses_unlinked", parentID: "ses_main", agent: "general", title: "Unlinked helper", created: NOW - 2 * DAY + 5 })
  link(db, "ses_main", "ses_child", "Find where the limit is set", "explore")

  doc(db, { sessionID: "ses_main", seq: 4, kind: "summary", text: "First compaction" })
  doc(db, { sessionID: "ses_main", seq: 12, kind: "summary", text: "Second compaction" })
  doc(db, { sessionID: "ses_main", seq: 2, kind: "tool_call", tool: "bash", text: "bash: npm test\nRun the tests" })
  doc(db, { sessionID: "ses_main", seq: 6, kind: "tool_call", tool: "bash", text: "bash: git diff" })
  doc(db, { sessionID: "ses_main", seq: 8, kind: "tool_call", tool: "bash", text: "bash: npm test\nAgain" })
  doc(db, { sessionID: "ses_main", seq: 9, kind: "tool_call", tool: "edit", text: "edit: /work/app/src/upload.ts" })
  doc(db, { sessionID: "ses_child", seq: 1, kind: "tool_call", tool: "bash", text: "bash: rg MAX_UPLOAD", time: NOW })
  file(db, "ses_main", "/work/app/src/upload.ts", "edit", { seq: 9 })
  file(db, "ses_main", "/work/app/src/upload.ts", "patch", { seq: 10 })
  file(db, "ses_main", "/work/app/test/upload.test.ts", "write", { seq: 11 })
  file(db, "ses_main", "/work/app/README.md", "read", { seq: 1 })
  file(db, "ses_child", "/work/app/src/config.ts", "edit", { seq: 2 })
  source.setTodos("ses_main", [
    { content: "Raise the limit", status: "completed" },
    { content: "Rotate token sk-123", status: "pending" },
  ])
})

afterEach(() => index.close())

describe("brief", () => {
  it("summarises the session from the index and its todos from the source", async () => {
    const out = await brief(db, source, { sessionID: "ses_main" }, text => text.replace(/sk-\d+/g, "[masked]"))
    expect(out).toEqual({
      session: {
        sessionID: "ses_main",
        title: "Fix uploads",
        directory: "/work/app",
        project: "/work/app",
        created: new Date(NOW - 3 * DAY).toISOString(),
        updated: new Date(NOW - DAY).toISOString(),
        agent: "build",
        messages: 20,
        subagents: 2,
        firstPrompt: "uploads fail over 10MB",
        parentID: null,
        cost: 1.25,
        outcome: "succeeded",
        models: ["anthropic/claude-opus-5-5"],
      },
      firstPrompt: "uploads fail over 10MB",
      summaries: ["First compaction", "Second compaction"],
      lastReply: "Raised the limit and added a test.",
      filesEdited: [
        { path: "/work/app/src/upload.ts", edits: 2 },
        { path: "/work/app/test/upload.test.ts", edits: 1 },
      ],
      commands: ["npm test", "git diff"],
      subagents: [
        { sessionID: "ses_child", description: "Find where the limit is set", agent: "explore" },
        { sessionID: "ses_unlinked", description: "Unlinked helper", agent: "general" },
      ],
      todos: [
        { content: "Raise the limit", status: "completed" },
        { content: "Rotate token [masked]", status: "pending" },
      ],
    })
  })

  it("covers the subagents' work with children", async () => {
    const out = await brief(db, source, { sessionID: "ses_main", children: true }, NO_MASK)
    expect(out.session.models).toEqual(["anthropic/claude-opus-5-5", "anthropic/claude-haiku-5-5"])
    expect(out.filesEdited.map(item => item.path)).toContain("/work/app/src/config.ts")
    expect(out.commands).toEqual(["npm test", "rg MAX_UPLOAD", "git diff"])
  })

  it("lists a long session's distinct commands, the most used first, then the most recent, capped", async () => {
    session(db, { id: "ses_long", title: "Long" })
    let seq = 0
    const run = (command: string, tool = "bash") => doc(db, { sessionID: "ses_long", seq: seq++, kind: "tool_call", tool, text: `${tool}: ${command}\nwhy` })
    for (let i = 0; i < 5; i++) run("npm test")
    for (let i = 0; i < 3; i++) run("git status", "shell")
    for (let i = 0; i < MAX_COMMANDS + 10; i++) run(`ls dir${i}`)
    run("git status")
    const out = await brief(db, source, { sessionID: "ses_long" }, NO_MASK)
    expect(out.commands).toHaveLength(MAX_COMMANDS)
    expect(out.commands.slice(0, 4)).toEqual(["npm test", "git status", `ls dir${MAX_COMMANDS + 9}`, `ls dir${MAX_COMMANDS + 8}`])
    expect(out.commands).not.toContain("ls dir0")
  })

  it("briefs a subagent session on its own", async () => {
    const out = await brief(db, source, { sessionID: "ses_child" }, NO_MASK)
    expect(out.session).toMatchObject({ parentID: "ses_main", agent: "explore", subagents: 0 })
    expect(out.commands).toEqual(["rg MAX_UPLOAD"])
    expect(out.todos).toEqual([])
  })

  it("reports a missing session and survives a source without todos", async () => {
    await expect(brief(db, source, { sessionID: "ses_nope" }, NO_MASK)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" })
    const broken: TodoSource = { todos: async () => Promise.reject(new Error("no todo table")) }
    expect((await brief(db, broken, { sessionID: "ses_main" }, NO_MASK)).todos).toEqual([])
  })
})
