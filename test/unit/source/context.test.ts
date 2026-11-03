import type { SessionInfo, SessionListInput, SessionMessageInfo } from "@opencode/client"
import type { SessionDomain } from "@opencode/plugin/promise/session"
import { describe, expect, expectTypeOf, it } from "vitest"
import { contextSource, type ContextSessionApi } from "../../../src/source/context.js"

function info(id: string, updated: number, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    projectID: "proj_app",
    cost: 0.5,
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: updated - 1, updated },
    location: { directory: "/work/app" },
    ...extra,
  }
}

const thread: SessionMessageInfo[] = [
  { id: "msg_a", type: "user", text: "hello", time: { created: 100 } },
  {
    id: "msg_b",
    type: "assistant",
    agent: "build",
    model: { id: "claude-sonnet-5-5", providerID: "anthropic" },
    content: [{ type: "text", text: "hi" }],
    time: { created: 110, completed: 120 },
  },
  { id: "msg_c", type: "idle", outcome: "succeeded", time: { created: 130 } },
]

function fakeApi(sessions: SessionInfo[], pageSize = 2) {
  const calls = { list: [] as (SessionListInput | undefined)[], context: [] as string[] }
  const api: ContextSessionApi = {
    async list(input) {
      calls.list.push(input)
      const start = input?.cursor ? Number(input.cursor) : 0
      const size = Math.min(input?.limit ?? pageSize, pageSize)
      const end = start + size
      return { data: sessions.slice(start, end), cursor: { next: end < sessions.length ? String(end) : null } }
    },
    async context({ sessionID }) {
      calls.context.push(sessionID)
      return sessionID === "ses_a" ? thread : []
    },
  }
  return { api, calls }
}

describe("contextSource", () => {
  it("accepts the plugin context's session domain", () => {
    expectTypeOf<Pick<SessionDomain, "list" | "context">>().toExtend<ContextSessionApi>()
  })

  it("probes as a partial source", async () => {
    const { api } = fakeApi([])
    const source = contextSource(api)
    expect(source.kind).toBe("context")
    expect(await source.probe()).toMatchObject({ kind: "context", ok: true, complete: false })
  })

  it("reports a failing session API", async () => {
    const source = contextSource({
      list: async () => {
        throw new Error("not ready")
      },
      context: async () => [],
    })
    expect(await source.probe()).toEqual({ kind: "context", ok: false, complete: false, detail: "plugin session API unavailable: not ready", problem: "unreadable" })
  })

  it("lists every page and returns changed sessions oldest first", async () => {
    const { api, calls } = fakeApi([info("ses_c", 300), info("ses_a", 100), info("ses_b", 200), info("ses_d", 300)])
    const source = contextSource(api, { cacheMs: 0 })
    expect((await source.changedSessions(0, 10)).map(s => s.id)).toEqual(["ses_a", "ses_b", "ses_c", "ses_d"])
    expect((await source.changedSessions(100, 2)).map(s => s.id)).toEqual(["ses_b", "ses_c"])
    expect(calls.list[1]).toEqual({ limit: 100, order: "desc", cursor: "2" })
    expect(await source.sessionIDs()).toEqual(new Set(["ses_a", "ses_b", "ses_c", "ses_d"]))
  })

  it("maps SessionInfo fields", async () => {
    const { api } = fakeApi([
      info("ses_child", 500, {
        parentID: "ses_parent",
        agent: "explore",
        model: { id: "gpt-5", providerID: "openai", variant: "high" },
        title: "Look around",
        time: { created: 400, updated: 500, archived: 600 },
        location: { directory: "/work/other" },
      }),
      info("ses_plain", 700),
    ])
    const [child, plain] = await contextSource(api).changedSessions(0, 10)
    expect(child).toEqual({
      id: "ses_child",
      parentID: "ses_parent",
      projectID: "proj_app",
      directory: "/work/other",
      title: "Look around",
      agent: "explore",
      model: "openai/gpt-5",
      cost: 0.5,
      tokensInput: 10,
      tokensOutput: 20,
      created: 400,
      updated: 500,
      archived: 600,
    })
    expect(plain).toMatchObject({ parentID: null, title: "", agent: null, model: null, archived: null })
  })

  it("reuses one listing within the cache window", async () => {
    let clock = 0
    const { api, calls } = fakeApi([info("ses_a", 100)], 10)
    const source = contextSource(api, { cacheMs: 1000, now: () => clock })
    await source.changedSessions(0, 10)
    await source.sessionIDs()
    expect(calls.list).toHaveLength(1)
    clock = 1000
    await source.sessionIDs()
    expect(calls.list).toHaveLength(2)
  })

  it("finds one session by ID from the listing", async () => {
    const { api, calls } = fakeApi([info("ses_a", 100), info("ses_b", 200, { title: "Second" }), info("ses_c", 300)], 10)
    const source = contextSource(api, { cacheMs: 1000, now: () => 0 })
    expect(await source.session("ses_b")).toEqual((await source.changedSessions(100, 1))[0])
    expect(await source.session("ses_b")).toMatchObject({ id: "ses_b", title: "Second", updated: 200 })
    expect(calls.list).toHaveLength(1)
  })

  it("lists again once when a session is not in the cached listing", async () => {
    const sessions = [info("ses_a", 100)]
    const { api, calls } = fakeApi(sessions, 10)
    const source = contextSource(api, { cacheMs: 1000, now: () => 0 })
    await source.sessionIDs()
    sessions.push(info("ses_new", 200))
    expect(await source.session("ses_new")).toMatchObject({ id: "ses_new" })
    expect(calls.list).toHaveLength(2)
    // The fresh listing is cached again, and a miss in a listing that was just taken is not listed again.
    expect(await source.session("ses_new")).toMatchObject({ id: "ses_new" })
    expect(calls.list).toHaveLength(2)
    source.close()
    expect(await source.session("ses_gone")).toBeUndefined()
    expect(calls.list).toHaveLength(3)
  })

  it("numbers messages by position and keeps the database data shape", async () => {
    const { api } = fakeApi([])
    const source = contextSource(api)
    const messages = await source.messages("ses_a", 0, 10)
    expect(messages.map(m => [m.seq, m.id, m.type])).toEqual([
      [0, "msg_a", "user"],
      [1, "msg_b", "assistant"],
      [2, "msg_c", "idle"],
    ])
    expect(messages[0]).toEqual({ id: "msg_a", sessionID: "ses_a", seq: 0, type: "user", created: 100, updated: 100, data: { text: "hello", time: { created: 100 } } })
    expect(messages[1]).toMatchObject({ created: 110, updated: 120 })
    expect(messages[1]?.data).not.toHaveProperty("id")
    expect((await source.messages("ses_a", 1, 1)).map(m => m.id)).toEqual(["msg_b"])
    expect(await source.messages("ses_none", 0, 10)).toEqual([])
  })

  it("finds one message by seq or ID and caches the thread", async () => {
    const { api, calls } = fakeApi([])
    const source = contextSource(api)
    expect((await source.message("ses_a", { seq: 2 }))?.id).toBe("msg_c")
    expect((await source.message("ses_a", { id: "msg_b" }))?.seq).toBe(1)
    expect(await source.message("ses_a", { seq: 9 })).toBeUndefined()
    expect(await source.message("ses_a", { id: "msg_x" })).toBeUndefined()
    expect(calls.context).toEqual(["ses_a"])
    source.close()
    await source.message("ses_a", { seq: 0 })
    expect(calls.context).toEqual(["ses_a", "ses_a"])
  })

  it("has no projects or todos", async () => {
    const source = contextSource(fakeApi([]).api)
    expect(await source.projects()).toEqual([])
    expect(await source.todos("ses_a")).toEqual([])
  })
})
