import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Source } from "../../../src/domain/contract.js"
import { defaultDatabasePath, modelName, openOpencodeSource } from "../../../src/source/opencode-db.js"
import { assistantData, createOpencodeDb, textPart, userData, type OpencodeDbFixture } from "../../fixtures/opencode-db.js"

const fixtures: OpencodeDbFixture[] = []
const sources: Source[] = []

function setup(options?: Parameters<typeof createOpencodeDb>[0]) {
  const fixture = createOpencodeDb(options)
  fixtures.push(fixture)
  const source = openOpencodeSource(fixture.path)
  sources.push(source)
  return { fixture, source }
}

afterEach(() => {
  for (const source of sources.splice(0)) source.close()
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
})

describe("defaultDatabasePath", () => {
  it("uses XDG_DATA_HOME when it is absolute", () => {
    expect(defaultDatabasePath({ XDG_DATA_HOME: "/data", HOME: "/home/me" })).toBe(join("/data", "opencode", "opencode.db"))
  })

  it("falls back to ~/.local/share", () => {
    expect(defaultDatabasePath({ HOME: "/home/me" })).toBe(join("/home/me", ".local", "share", "opencode", "opencode.db"))
  })

  it("ignores empty and relative XDG_DATA_HOME", () => {
    const fallback = join("/home/me", ".local", "share", "opencode", "opencode.db")
    expect(defaultDatabasePath({ XDG_DATA_HOME: "", HOME: "/home/me" })).toBe(fallback)
    expect(defaultDatabasePath({ XDG_DATA_HOME: "data", HOME: "/home/me" })).toBe(fallback)
  })
})

describe("openOpencodeSource probe", () => {
  it("reports a complete source for the 2.2 layout", async () => {
    const { source } = setup()
    expect(source.kind).toBe("opencode-db")
    expect(await source.probe()).toEqual({ ok: true })
  })

  it("reports a missing file without throwing", async () => {
    const source = openOpencodeSource(join("/nonexistent", "dir", "opencode.db"))
    sources.push(source)
    expect(await source.probe()).toEqual({ ok: false, problem: "unreadable" })
  })

  it("takes missing tables and columns for a layout it does not know", async () => {
    const { fixture, source } = setup({ tables: ["project", "session_message"] })
    fixture.db.exec("alter table session_message drop column data")
    expect(await source.probe()).toEqual({ ok: false, problem: "layout" })
  })

  it("takes a database with none of OpenCode's tables for an unreadable one, not a new layout", async () => {
    const { source } = setup({ tables: [] })
    expect(await source.probe()).toEqual({ ok: false, problem: "unreadable" })
  })

  it("stays usable without a todo table", async () => {
    const { fixture, source } = setup({ tables: ["project", "session_v2", "session_message"] })
    fixture.insertSession({ id: "ses_a" })
    expect(await source.probe()).toEqual({ ok: true })
    expect(await source.todos("ses_a")).toEqual([])
  })
})

describe("openOpencodeSource sessions", () => {
  it("returns sessions updated after since, oldest first, up to limit", async () => {
    const { fixture, source } = setup()
    fixture.insertSession({ id: "ses_c", created: 100, updated: 300 })
    fixture.insertSession({ id: "ses_a", created: 100, updated: 100 })
    fixture.insertSession({ id: "ses_b", created: 100, updated: 200 })
    fixture.insertSession({ id: "ses_d", created: 100, updated: 300 })

    expect((await source.changedSessions(0, 10)).map(s => s.id)).toEqual(["ses_a", "ses_b", "ses_c", "ses_d"])
    expect((await source.changedSessions(100, 10)).map(s => s.id)).toEqual(["ses_b", "ses_c", "ses_d"])
    expect((await source.changedSessions(100, 2)).map(s => s.id)).toEqual(["ses_b", "ses_c"])
    expect(await source.changedSessions(300, 10)).toEqual([])
    expect(await source.changedSessions(0, 0)).toEqual([])
  })

  it("maps and normalises session columns", async () => {
    const { fixture, source } = setup()
    fixture.insertSession({
      id: "ses_full",
      projectID: "proj_x",
      parentID: "ses_parent",
      directory: "/work/x",
      title: "Fix the parser",
      agent: "build",
      model: { id: "deepseek/deepseek-v4-flash", providerID: "openrouter", variant: "default" },
      cost: 0.25,
      tokensInput: 1200,
      tokensOutput: 340,
      created: 1000,
      updated: 2000,
      archived: 3000,
    })
    fixture.insertSession({ id: "ses_bare", title: null, agent: null, model: null, created: 4000 })
    fixture.insertSession({ id: "ses_text", title: '"Quoted title"', model: "anthropic/claude-sonnet-5-5", created: 5000 })

    const [full, bare, text] = await source.changedSessions(0, 10)
    expect(full).toEqual({
      id: "ses_full",
      parentID: "ses_parent",
      projectID: "proj_x",
      directory: "/work/x",
      title: "Fix the parser",
      agent: "build",
      model: "openrouter/deepseek/deepseek-v4-flash",
      cost: 0.25,
      tokensInput: 1200,
      tokensOutput: 340,
      created: 1000,
      updated: 2000,
      archived: 3000,
    })
    expect(bare).toMatchObject({ id: "ses_bare", parentID: null, title: "", agent: null, model: null, cost: 0, archived: null })
    expect(text).toMatchObject({ title: "Quoted title", model: "anthropic/claude-sonnet-5-5" })
  })

  it("finds one session by ID, mapped like the changed sessions", async () => {
    const { fixture, source } = setup()
    fixture.insertSession({ id: "ses_a", parentID: "ses_root", title: "Fix the parser", model: { id: "gpt-5", providerID: "openai" }, created: 100, updated: 200 })
    fixture.insertSession({ id: "ses_b", created: 300 })

    const found = await source.session("ses_a")
    expect(found).toEqual((await source.changedSessions(0, 10))[0])
    expect(found).toMatchObject({ id: "ses_a", parentID: "ses_root", title: "Fix the parser", model: "openai/gpt-5", updated: 200 })
    expect(await source.session("ses_missing")).toBeUndefined()
    fixture.deleteSession("ses_a")
    expect(await source.session("ses_a")).toBeUndefined()
  })

  it("lists every session ID and drops deleted ones", async () => {
    const { fixture, source } = setup()
    fixture.insertSession({ id: "ses_a" })
    fixture.insertSession({ id: "ses_b" })
    fixture.insertMessage({ sessionID: "ses_b", type: "user", data: userData("gone soon") })
    expect(await source.sessionIDs()).toEqual(new Set(["ses_a", "ses_b"]))
    fixture.deleteSession("ses_b")
    expect(await source.sessionIDs()).toEqual(new Set(["ses_a"]))
    expect(await source.messages("ses_b", 0, 10)).toEqual([])
  })
})

describe("openOpencodeSource messages", () => {
  it("pages messages by seq and tolerates gaps", async () => {
    const { fixture, source } = setup()
    fixture.insertSession({ id: "ses_a" })
    fixture.insertSession({ id: "ses_b" })
    fixture.insertMessage({ sessionID: "ses_a", type: "user", seq: 0, data: userData("first"), created: 10, updated: 11 })
    fixture.insertMessage({ sessionID: "ses_a", type: "assistant", seq: 1, data: assistantData([textPart("reply")]) })
    fixture.insertMessage({ sessionID: "ses_a", type: "user", seq: 5, data: userData("after gap") })
    fixture.insertMessage({ sessionID: "ses_b", type: "user", seq: 0, data: userData("other session") })

    const all = await source.messages("ses_a", 0, 100)
    expect(all.map(m => m.seq)).toEqual([0, 1, 5])
    expect(all[0]).toEqual({
      id: "msg_ses_a_0",
      sessionID: "ses_a",
      seq: 0,
      type: "user",
      created: 10,
      updated: 11,
      data: userData("first"),
    })
    expect((await source.messages("ses_a", 1, 1)).map(m => m.seq)).toEqual([1])
    expect((await source.messages("ses_a", 2, 10)).map(m => m.seq)).toEqual([5])
    expect(await source.messages("ses_missing", 0, 10)).toEqual([])
  })

  it("gives an empty data object for rows that are not JSON objects", async () => {
    const { fixture, source } = setup()
    fixture.insertSession({ id: "ses_a" })
    fixture.insertMessage({ sessionID: "ses_a", type: "user", data: "{not json" })
    fixture.insertMessage({ sessionID: "ses_a", type: "user", data: "[1,2]" })
    expect((await source.messages("ses_a", 0, 10)).map(m => m.data)).toEqual([{}, {}])
  })

  it("finds one message by seq or ID within its session", async () => {
    const { fixture, source } = setup()
    fixture.insertSession({ id: "ses_a" })
    fixture.insertSession({ id: "ses_b" })
    fixture.insertMessage({ sessionID: "ses_a", type: "user", data: userData("hello"), id: "msg_1" })
    fixture.insertMessage({ sessionID: "ses_b", type: "user", data: userData("other"), id: "msg_2" })

    expect((await source.message("ses_a", { seq: 0 }))?.id).toBe("msg_1")
    expect((await source.message("ses_a", { id: "msg_1" }))?.data).toEqual(userData("hello"))
    expect(await source.message("ses_a", { seq: 1 })).toBeUndefined()
    expect(await source.message("ses_a", { id: "msg_2" })).toBeUndefined()
  })
})

describe("openOpencodeSource projects and todos", () => {
  it("lists projects", async () => {
    const { fixture, source } = setup()
    fixture.insertProject({ id: "proj_b", worktree: "/work/b" })
    fixture.insertProject({ id: "proj_a", worktree: "/work/a", name: "App" })
    expect(await source.projects()).toEqual([
      { id: "proj_a", worktree: "/work/a", name: "App" },
      { id: "proj_b", worktree: "/work/b", name: null },
    ])
  })

  it("returns a session's todos in position order", async () => {
    const { fixture, source } = setup()
    fixture.insertSession({ id: "ses_a" })
    fixture.insertTodo({ sessionID: "ses_a", content: "second", status: "completed", position: 1 })
    fixture.insertTodo({ sessionID: "ses_a", content: "first", status: "in_progress", position: 0 })
    fixture.insertTodo({ sessionID: "ses_b", content: "elsewhere" })
    expect(await source.todos("ses_a")).toEqual([
      { content: "first", status: "in_progress" },
      { content: "second", status: "completed" },
    ])
  })
})

describe("openOpencodeSource access", () => {
  it("reads while OpenCode holds the database open and sees new rows", async () => {
    const { fixture, source } = setup()
    fixture.insertSession({ id: "ses_a", created: 100 })
    expect((await source.changedSessions(0, 10)).map(s => s.id)).toEqual(["ses_a"])
    fixture.insertMessage({ sessionID: "ses_a", type: "user", data: userData("later"), created: 500 })
    expect(await source.changedSessions(100, 10)).toMatchObject([{ id: "ses_a", updated: 500 }])
  })

  it("reads a WAL database after OpenCode has closed it", async () => {
    const { fixture, source } = setup()
    fixture.insertSession({ id: "ses_a" })
    fixture.close()
    expect((await source.probe()).ok).toBe(true)
    expect(await source.sessionIDs()).toEqual(new Set(["ses_a"]))
  })

  it("reopens after close", async () => {
    const { fixture, source } = setup()
    fixture.insertSession({ id: "ses_a" })
    expect((await source.sessionIDs()).size).toBe(1)
    source.close()
    expect((await source.sessionIDs()).size).toBe(1)
  })
})

describe("modelName", () => {
  it("handles JSON refs, plain text and null", () => {
    expect(modelName('{"id":"gpt-5","providerID":"openai"}')).toBe("openai/gpt-5")
    expect(modelName('{"modelID":"gpt-5","providerID":"openai"}')).toBe("openai/gpt-5")
    expect(modelName('{"id":"gpt-5"}')).toBe("gpt-5")
    expect(modelName("openai/gpt-5")).toBe("openai/gpt-5")
    expect(modelName('{"variant":"x"}')).toBeNull()
    expect(modelName(null)).toBeNull()
  })
})
