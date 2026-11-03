import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { eventRouter } from "../../../src/index/events.js"
import { IndexStore } from "../../../src/index/store.js"
import { Indexer } from "../../../src/index/sync.js"
import { chat, extract, FakeSource, tick, titleDoc } from "./fakes.js"

let calls: string[]
let fail: boolean

const fake = {
  syncSession: async (id: string) => {
    calls.push(`sync ${id}`)
    if (fail) throw new Error("sync failed")
    return true
  },
  deleteSession: async (id: string) => {
    calls.push(`delete ${id}`)
    if (fail) throw new Error("delete failed")
  },
}

const event = (type: string, sessionID?: string) => ({ type, data: sessionID === undefined ? {} : { sessionID } })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  calls = []
  fail = false
})

afterEach(() => {
  vi.useRealTimers()
})

describe("eventRouter", () => {
  it("syncs a session once after its events go quiet", () => {
    const router = eventRouter(fake)
    router.handle(event("session.step.ended", "ses_a"))
    vi.advanceTimersByTime(500)
    router.handle(event("session.step.ended", "ses_a"))
    vi.advanceTimersByTime(500)
    router.handle(event("session.idle", "ses_a"))
    vi.advanceTimersByTime(1499)
    expect(calls).toEqual([])
    vi.advanceTimersByTime(1)
    expect(calls).toEqual(["sync ses_a"])
    vi.advanceTimersByTime(10_000)
    expect(calls).toEqual(["sync ses_a"])
  })

  it("debounces each session on its own", () => {
    const router = eventRouter(fake, { debounceMs: 100 })
    router.handle(event("session.idle", "ses_a"))
    vi.advanceTimersByTime(50)
    router.handle(event("session.idle", "ses_b"))
    vi.advanceTimersByTime(50)
    expect(calls).toEqual(["sync ses_a"])
    vi.advanceTimersByTime(50)
    expect(calls).toEqual(["sync ses_a", "sync ses_b"])
  })

  it("syncs a busy session at least every maxWaitMs", () => {
    const router = eventRouter(fake, { debounceMs: 1500, maxWaitMs: 4000 })
    for (let i = 0; i < 10; i++) {
      router.handle(event("session.step.ended", "ses_a"))
      vi.advanceTimersByTime(1000)
    }
    expect(calls).toEqual(["sync ses_a", "sync ses_a"])
  })

  it("syncs on every session event that names a session", () => {
    const router = eventRouter(fake, { debounceMs: 10 })
    const types = [
      "session.idle",
      "session.compaction.ended",
      "session.renamed",
      "session.moved",
      "session.archived",
      "session.unarchived",
      "session.created",
      "session.forked",
      "session.step.ended",
      "session.execution.ended",
    ]
    types.forEach((type, i) => router.handle(event(type, `ses_${i}`)))
    vi.advanceTimersByTime(10)
    expect(calls).toEqual(types.map((_, i) => `sync ses_${i}`))
  })

  it("deletes right away and drops a pending sync", () => {
    const router = eventRouter(fake)
    router.handle(event("session.renamed", "ses_a"))
    router.handle(event("session.deleted", "ses_a"))
    expect(calls).toEqual(["delete ses_a"])
    vi.advanceTimersByTime(10_000)
    expect(calls).toEqual(["delete ses_a"])
  })

  it("ignores deltas, progress, other buses and events without a session", () => {
    const router = eventRouter(fake, { debounceMs: 10 })
    router.handle(event("session.message.delta", "ses_a"))
    router.handle(event("session.compaction.progress", "ses_a"))
    router.handle(event("session.deleted.delta", "ses_a"))
    router.handle(event("message.updated", "ses_a"))
    router.handle(event("session.idle"))
    router.handle(event("session.idle", ""))
    router.handle({ type: "session.idle", data: null })
    router.handle({ type: "session.idle", data: "ses_a" })
    router.handle({ type: "session.idle", data: { sessionID: 42 } })
    router.handle({ type: 7, data: { sessionID: "ses_a" } } as unknown as { type: string; data: unknown })
    vi.advanceTimersByTime(1000)
    expect(calls).toEqual([])
  })

  it("drops pending syncs on close and ignores later events", () => {
    const router = eventRouter(fake)
    router.handle(event("session.idle", "ses_a"))
    router.close()
    router.handle(event("session.idle", "ses_b"))
    router.handle(event("session.deleted", "ses_c"))
    vi.advanceTimersByTime(10_000)
    expect(calls).toEqual([])
  })

  it("never rejects when the indexer fails", async () => {
    fail = true
    const router = eventRouter(fake, { debounceMs: 10 })
    router.handle(event("session.idle", "ses_a"))
    router.handle(event("session.deleted", "ses_b"))
    vi.advanceTimersByTime(10)
    await tick()
    expect(calls).toEqual(["delete ses_b", "sync ses_a"])
  })
})

describe("eventRouter with an indexer", () => {
  let dir: string
  let store: IndexStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "history-events-"))
    store = IndexStore.open(join(dir, "index.db"))
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("indexes a session after it goes idle and removes it when deleted", async () => {
    const source = new FakeSource()
    source.add("ses_a", {}, chat(3))
    const indexer = new Indexer({ store, source, extract, titleDoc })
    const router = eventRouter(indexer)
    router.handle(event("session.idle", "ses_a"))
    vi.advanceTimersByTime(1500)
    for (let i = 0; i < 50 && !store.sessionState("ses_a"); i++) await tick()
    expect(store.sessionState("ses_a")?.indexedSeq).toBe(2)

    router.handle(event("session.deleted", "ses_a"))
    for (let i = 0; i < 50 && store.sessionCount() > 0; i++) await tick()
    expect(store.sessionCount()).toBe(0)
    router.close()
  })
})
