import { rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IndexStore, TITLE_SEQ } from "../../../src/index/store.js"
import { Indexer, SYNCED_AT, WATERMARK, type IndexerOptions, type Progress } from "../../../src/index/sync.js"
import { chat, extract, FakeSource, reply, tick, titleDoc, user } from "./fakes.js"
import { tempDir } from "../../temp.js"

let dir: string
let store: IndexStore
let source: FakeSource
let time: number
let errors: { error: unknown; sessionID: string | null }[]

const indexer = (over: Partial<IndexerOptions> = {}) =>
  new Indexer({ store, source, extract, titleDoc, now: () => time, onError: (error, sessionID) => errors.push({ error, sessionID }), ...over })

const row = (sql: string, ...params: (string | number)[]) => store.db.get<Record<string, unknown>>(sql, ...params)
const words = (query: string) => Number(row("select count(*) as n from docs_words where docs_words match ?", query)?.n)
const ftsIntact = () => {
  store.db.exec("insert into docs_words(docs_words) values ('integrity-check')")
  store.db.exec("insert into docs_sub(docs_sub) values ('integrity-check')")
}
const ranges = (id: string) => store.db.all<{ from_seq: number; to_seq: number }>("select from_seq, to_seq from batches where session_id = ? order by from_seq", id)
const snapshot = (id: string) => ({
  session: { ...row("select * from sessions where id = ?", id), indexed_at: 0 },
  docs: store.db.all("select message_id, seq, part, kind, text, root_id from v_docs where session_id = ? order by seq, part", id),
  files: store.db.all("select * from files where session_id = ? order by seq", id),
  links: store.db.all("select * from links where parent_id = ? order by child_id", id),
  batches: ranges(id),
})

beforeEach(() => {
  dir = tempDir("history-sync-")
  store = IndexStore.open(join(dir, "index.db"))
  source = new FakeSource()
  time = 100_000
  errors = []
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("syncSession", () => {
  it("indexes a session batch by batch and gives the newest message its own batch", async () => {
    source.add("ses_a", {}, chat(8))
    expect(await indexer({ batch: 3 }).syncSession("ses_a")).toBe(true)
    expect(source.calls("messages")).toEqual(["messages ses_a 0", "messages ses_a 3", "messages ses_a 6"])
    expect(ranges("ses_a")).toEqual([
      { from_seq: 0, to_seq: 2 },
      { from_seq: 3, to_seq: 5 },
      { from_seq: 6, to_seq: 6 },
      { from_seq: 7, to_seq: 7 },
    ])
    expect(row("select messages, user_messages, indexed_seq, first_prompt, last_reply from sessions")).toEqual({
      messages: 8,
      user_messages: 4,
      indexed_seq: 7,
      first_prompt: "question 0",
      last_reply: "answer 7",
    })
    expect(row("select seq, kind, text from v_docs where seq = ?", TITLE_SEQ)).toEqual({ seq: TITLE_SEQ, kind: "title", text: "title of ses_a" })
    expect(Number(row("select count(*) as n from docs where seq >= 0")?.n)).toBe(8)
    ftsIntact()
  })

  it("re-reads only the newest message next time, and replaces it when it changed", async () => {
    source.add("ses_a", {}, chat(8))
    const sync = indexer({ batch: 3 })
    await sync.syncSession("ses_a")
    source.edit("ses_a", 7, reply("answer 7, now with a stack trace"))
    source.say("ses_a", user("question 8"))
    source.log.length = 0
    await sync.syncSession("ses_a")
    expect(source.calls("messages")).toEqual(["messages ses_a 7"])
    expect(ranges("ses_a").slice(-2)).toEqual([
      { from_seq: 7, to_seq: 7 },
      { from_seq: 8, to_seq: 8 },
    ])
    expect(words('"stack trace"')).toBe(1)
    expect(row("select messages, user_messages, last_reply from sessions")).toEqual({ messages: 9, user_messages: 5, last_reply: "answer 7, now with a stack trace" })
    ftsIntact()
  })

  it("leaves the index unchanged when nothing changed", async () => {
    source.add("ses_a", {}, [...chat(5), reply("done", { child: "ses_child", file: "src/a.ts", outcome: "shipped" })])
    const sync = indexer({ batch: 2 })
    await sync.syncSession("ses_a")
    const before = snapshot("ses_a")
    await sync.syncSession("ses_a")
    await sync.syncSession("ses_a")
    expect(snapshot("ses_a")).toEqual(before)
    expect(before.links).toEqual([{ parent_id: "ses_a", child_id: "ses_child", message_id: "ses_a_m5", seq: 5, description: "done", agent: "explore" }])
    expect(before.session).toMatchObject({ outcome: "shipped", tool_calls: 1 })
    ftsIntact()
  })

  it("re-indexes context sessions from seq 0 every time", async () => {
    source.kind = "context"
    source.add("ses_a", {}, chat(4))
    const sync = indexer({ batch: 3 })
    await sync.syncSession("ses_a")
    // A compaction renumbers what is left.
    source.messagesOf.set("ses_a", [])
    source.say("ses_a", user("summary of the work so far"))
    source.say("ses_a", reply("carry on"))
    source.log.length = 0
    await sync.syncSession("ses_a")
    expect(source.calls("messages")).toEqual(["messages ses_a 0"])
    expect(words("question")).toBe(0)
    expect(row("select messages, first_prompt, indexed_seq from sessions")).toEqual({ messages: 2, first_prompt: "summary of the work so far", indexed_seq: 1 })
    ftsIntact()
  })

  it("masks the title before storing it", async () => {
    source.add("ses_a", { title: "rotate key sk-12345 today" }, chat(1))
    const seen: string[] = []
    await indexer({
      maskTitle: text => text.replace(/sk-\d+/g, "[key]"),
      extract: (message, session) => {
        seen.push(session.title)
        return extract(message, session)
      },
    }).syncSession("ses_a")
    expect(row("select title from sessions")).toEqual({ title: "rotate key [key] today" })
    expect(row("select text from v_docs where kind = 'title'")).toEqual({ text: "rotate key [key] today" })
    expect(seen).toEqual(["rotate key [key] today"])
    expect(words("12345")).toBe(0)
  })

  it("updates the title doc when the session is renamed", async () => {
    source.add("ses_a", {}, chat(2))
    const sync = indexer()
    await sync.syncSession("ses_a")
    source.sessions.set("ses_a", { ...source.sessions.get("ses_a")!, title: "renamed session", updated: ++source.clock })
    await sync.syncSession("ses_a")
    expect(store.db.all("select text from v_docs where kind = 'title'")).toEqual([{ text: "renamed session" }])
  })

  it("walks unindexed parents through the source to find the root", async () => {
    source.add("ses_g", {}, chat(1))
    source.add("ses_p", { parentID: "ses_g" }, chat(1))
    source.add("ses_c", { parentID: "ses_p" }, chat(1))
    await indexer().syncSession("ses_c")
    expect(store.sessionState("ses_c")?.rootID).toBe("ses_g")
    expect(source.calls("session")).toEqual(["session ses_c", "session ses_p", "session ses_g"])
  })

  it("uses an indexed parent's root without asking the source", async () => {
    source.add("ses_g", {}, chat(1))
    source.add("ses_p", { parentID: "ses_g" }, chat(1))
    source.add("ses_c", { parentID: "ses_p" }, chat(1))
    const sync = indexer()
    await sync.syncSession("ses_p")
    source.log.length = 0
    await sync.syncSession("ses_c")
    expect(source.calls("session")).toEqual(["session ses_c"])
    expect(store.sessionState("ses_c")?.rootID).toBe("ses_g")
  })

  it("guesses a parent the source does not have as the root and fixes it if the parent is indexed later", async () => {
    source.add("ses_p", { parentID: "ses_g" }, chat(1))
    source.add("ses_c", { parentID: "ses_p" }, chat(1))
    source.sessions.delete("ses_p")
    const sync = indexer()
    await sync.syncSession("ses_c")
    expect(store.sessionState("ses_c")?.rootID).toBe("ses_p")
    source.add("ses_g", {}, chat(1))
    source.add("ses_p", { parentID: "ses_g" }, chat(1))
    await sync.syncSession("ses_p")
    expect(store.db.all("select id, root_id from sessions order by id")).toEqual([
      { id: "ses_c", root_id: "ses_g" },
      { id: "ses_p", root_id: "ses_g" },
    ])
    expect(store.db.all("select distinct root_id from docs")).toEqual([{ root_id: "ses_g" }])
  })

  it("runs one sync per session at a time and folds overlapping calls into one rerun", async () => {
    source.add("ses_a", {}, chat(2))
    const sync = indexer()
    let added = false
    source.afterRead = () => {
      if (added) return
      added = true
      source.say("ses_a", user("arrived during the first run"))
    }
    await Promise.all([sync.syncSession("ses_a"), sync.syncSession("ses_a"), sync.syncSession("ses_a")])
    expect(source.maxActive).toBe(1)
    expect(source.calls("messages")).toEqual(["messages ses_a 0", "messages ses_a 1"])
    expect(words("arrived")).toBe(1)
    expect(row("select messages from sessions")).toEqual({ messages: 3 })
  })

  it("returns false for a session the source does not have", async () => {
    source.add("ses_a", {}, chat(1))
    expect(await indexer().syncSession("ses_missing")).toBe(false)
    expect(store.sessionCount()).toBe(0)
  })

  it("yields to the event loop between batches", async () => {
    source.add("ses_a", {}, chat(9))
    const seen: number[] = []
    let spinning = true
    const spin = () => {
      seen.push(source.calls("messages").length)
      if (spinning) setImmediate(spin)
    }
    setImmediate(spin)
    await indexer({ batch: 3 }).syncSession("ses_a")
    spinning = false
    expect(seen).toEqual(expect.arrayContaining([1, 2, 3]))
  })
})

describe("deleteSession", () => {
  it("removes the session and never indexes it again", async () => {
    source.add("ses_a", {}, chat(2))
    const sync = indexer()
    await sync.syncSession("ses_a")
    await sync.deleteSession("ses_a")
    expect(store.sessionCount()).toBe(0)
    expect(words("question")).toBe(0)
    expect(await sync.syncSession("ses_a")).toBe(false)
    await sync.catchUp()
    expect(store.sessionCount()).toBe(0)
    ftsIntact()
  })

  it("waits for a sync in flight and stops it before it writes", async () => {
    source.add("ses_a", {}, chat(2))
    const sync = indexer()
    let deleting: Promise<void> | null = null
    source.afterRead = () => {
      deleting ??= sync.deleteSession("ses_a")
    }
    const writes = vi.spyOn(store, "writeBatch")
    expect(await sync.syncSession("ses_a")).toBe(false)
    await deleting
    expect(writes).not.toHaveBeenCalled()
    expect(store.sessionCount()).toBe(0)
  })

  it("is not replaced by a sync queued after it", async () => {
    source.add("ses_a", {}, chat(2))
    const sync = indexer()
    await sync.syncSession("ses_a")
    let open = () => {}
    source.gate = new Promise(resolve => (open = resolve))
    const running = sync.syncSession("ses_a")
    while (source.active === 0) await tick()
    // The delete queues behind the running sync, then a catch-up queues a sync of the same session behind both.
    const deleting = sync.deleteSession("ses_a")
    source.say("ses_a", user("more"))
    const catching = sync.catchUp()
    while (source.calls("projects").length === 0) await tick()
    await tick()
    source.gate = null
    open()
    await Promise.all([running, deleting, catching])
    expect(store.sessionCount()).toBe(0)
  })
})

describe("health", () => {
  it("records the last error of a session and of a pass", async () => {
    source.add("ses_1", {}, [user("bad", { boom: true })])
    const sync = indexer()
    expect(sync.health()).toMatchObject({ lastError: null, failedSessions: 0, backfilling: false })
    time = 200_000
    await sync.catchUp()
    expect(sync.health()).toMatchObject({ lastError: { message: "cannot extract ses_1_m0", sessionID: "ses_1", at: 200_000 }, failedSessions: 1 })

    source.changedSessions = async () => {
      throw new Error("source is locked")
    }
    await expect(sync.catchUp()).rejects.toThrow("source is locked")
    expect(sync.health().lastError).toMatchObject({ message: "source is locked", sessionID: null })
    expect(errors.map(e => e.sessionID)).toEqual(["ses_1", "ses_1", null])
  })

  it("records a direct sync failure but not a backfill abort", async () => {
    source.add("ses_1", {}, [user("bad", { boom: true })])
    source.add("ses_2", {}, chat(1))
    const sync = indexer()
    await expect(sync.syncSession("ses_1")).rejects.toThrow("cannot extract")
    expect(sync.health().lastError?.sessionID).toBe("ses_1")

    const controller = new AbortController()
    controller.abort(new Error("stop"))
    await expect(sync.backfill(controller.signal)).rejects.toThrow("stop")
    expect(sync.health().lastError?.message).toBe("cannot extract ses_1_m0")
  })

  it("reports a running backfill", async () => {
    source.add("ses_1", {}, chat(1))
    const sync = indexer()
    let during: boolean | null = null
    await sync.backfill(undefined, () => {
      during ??= sync.health().backfilling
    })
    expect(during).toBe(true)
    expect(sync.health().backfilling).toBe(false)
  })
})

describe("catchUp", () => {
  it("pages through sessions updated at the same time and advances the watermark", async () => {
    source.add("ses_1", { updated: 10 }, chat(1))
    source.add("ses_2", { updated: 20 }, chat(1))
    source.add("ses_3", { updated: 20 }, chat(1))
    source.add("ses_4", { updated: 20 }, chat(1))
    source.add("ses_5", { updated: 30 }, chat(1))
    time = 500_000
    await indexer({ batch: 2 }).catchUp()
    expect(store.db.all("select id from sessions order by id").map(r => (r as { id: string }).id)).toEqual(["ses_1", "ses_2", "ses_3", "ses_4", "ses_5"])
    expect(source.calls("changed")).toEqual(["changed -1 2", "changed 19 2", "changed 19 4", "changed 29 2"])
    expect(store.meta(WATERMARK)).toBe("30")
    expect(store.meta(SYNCED_AT)).toBe("500000")
    expect(row("select name from projects")).toEqual({ name: "app" })
  })

  it("only indexes sessions changed since the last catch-up", async () => {
    source.add("ses_1", {}, chat(2))
    source.add("ses_2", {}, chat(2))
    const sync = indexer()
    await sync.catchUp()
    source.say("ses_2", reply("one more thing"))
    source.log.length = 0
    await sync.catchUp()
    expect(source.calls("messages")).toEqual(["messages ses_2 1"])
    expect(words("thing")).toBe(1)
    source.log.length = 0
    await sync.catchUp()
    expect(source.calls("messages")).toEqual([])
  })

  it("computes roots from sessions in the same page", async () => {
    source.add("ses_c", { parentID: "ses_p" }, chat(1))
    source.add("ses_p", { parentID: "ses_g" }, chat(1))
    source.add("ses_g", {}, chat(1))
    await indexer().catchUp()
    expect(store.db.all("select distinct root_id from sessions")).toEqual([{ root_id: "ses_g" }])
    expect(store.db.all("select distinct root_id from docs")).toEqual([{ root_id: "ses_g" }])
  })

  it("keeps going past a failing session and retries it next time", async () => {
    source.add("ses_1", {}, [user("fine"), reply("bad", { boom: true })])
    source.add("ses_2", {}, chat(2))
    const sync = indexer()
    await sync.catchUp()
    expect(errors.map(e => e.sessionID)).toEqual(["ses_1"])
    expect(store.sessionState("ses_2")).toBeDefined()
    expect(store.meta(WATERMARK)).toBe(String(source.sessions.get("ses_2")!.updated))
    expect(sync.state().complete).toBe(false)

    source.messagesOf.get("ses_1")![1] = { ...source.messagesOf.get("ses_1")![1]!, data: { ...reply("good") } }
    await sync.catchUp()
    expect(row("select last_reply from sessions where id = 'ses_1'")).toEqual({ last_reply: "good" })
    expect(sync.state().complete).toBe(true)
  })

  it("folds overlapping calls into one rerun", async () => {
    source.add("ses_1", {}, chat(1))
    const sync = indexer()
    await Promise.all([sync.catchUp(), sync.catchUp(), sync.catchUp()])
    expect(source.calls("projects")).toHaveLength(1)
    expect(source.calls("changed")).toEqual(["changed -1 200", `changed ${source.sessions.get("ses_1")!.updated} 200`])
  })
})

describe("backfill", () => {
  it("indexes every session newest first, reports progress and sets the watermark", async () => {
    source.add("ses_old", {}, chat(2))
    source.add("ses_mid", {}, chat(2))
    source.add("ses_new", {}, chat(2))
    const progress: Progress[] = []
    const sync = indexer()
    expect(sync.state().ready).toBe(false)
    await sync.backfill(undefined, p => progress.push(p))
    expect(source.calls("messages ").map(line => line.split(" ")[1])).toEqual(["ses_new", "ses_mid", "ses_old"])
    expect(progress).toEqual([
      { done: 0, total: 3, failed: 0 },
      { done: 1, total: 3, failed: 0 },
      { done: 2, total: 3, failed: 0 },
      { done: 3, total: 3, failed: 0 },
    ])
    expect(store.meta(WATERMARK)).toBe(String(source.sessions.get("ses_new")!.updated))
    expect(sync.state()).toMatchObject({ ready: true, sessionsIndexed: 3, sessionsTotal: 3, complete: true })
  })

  it("stops on abort without setting the watermark", async () => {
    source.add("ses_1", {}, chat(2))
    source.add("ses_2", {}, chat(2))
    const controller = new AbortController()
    const sync = indexer()
    const run = sync.backfill(controller.signal, p => {
      if (p.done === 1) controller.abort(new Error("stop"))
    })
    await expect(run).rejects.toThrow("stop")
    expect(store.sessionCount()).toBe(1)
    expect(store.meta(WATERMARK)).toBeUndefined()
    expect(sync.state().ready).toBe(false)
    expect(errors).toEqual([])
  })

  it("makes catch-up wait for it", async () => {
    source.add("ses_1", {}, chat(2))
    const sync = indexer()
    let during: Promise<void> | null = null
    await sync.backfill(undefined, () => {
      during ??= sync.catchUp()
    })
    await during
    expect(source.calls("changed")).toEqual(["changed -1 200"])
  })
})

describe("reconcile", () => {
  it("prunes sessions the source no longer has", async () => {
    source.add("ses_1", {}, chat(1))
    source.add("ses_2", {}, chat(1))
    const sync = indexer()
    await sync.catchUp()
    source.sessions.delete("ses_2")
    expect(await sync.reconcile()).toEqual(["ses_2"])
    expect(store.db.all("select id from sessions")).toEqual([{ id: "ses_1" }])
    expect(words("question")).toBe(1)
    expect(sync.state().sessionsTotal).toBe(1)
  })

  it("keeps a session written while the source was listing", async () => {
    source.add("ses_1", {}, chat(1))
    const sync = indexer()
    await sync.catchUp()
    source.afterIDs = async () => {
      source.add("ses_new", {}, chat(1))
      await sync.syncSession("ses_new")
    }
    expect(await sync.reconcile()).toEqual([])
    expect(store.sessionState("ses_new")).toBeDefined()
  })

  it("skips when the source reports no sessions but the index has some", async () => {
    source.add("ses_1", {}, chat(1))
    const sync = indexer()
    await sync.catchUp()
    source.sessions.clear()
    expect(await sync.reconcile()).toEqual([])
    expect(store.sessionCount()).toBe(1)
  })
})

describe("state", () => {
  it("reports readiness, counts, lag and source", async () => {
    source.add("ses_1", {}, chat(1))
    const sync = indexer()
    expect(sync.state()).toEqual({ ready: false, sessionsIndexed: 0, sessionsTotal: 0, lagSeconds: 0, source: "opencode-db", complete: false })
    await sync.catchUp()
    time += 61_000
    expect(sync.state()).toEqual({ ready: true, sessionsIndexed: 1, sessionsTotal: 1, lagSeconds: 61, source: "opencode-db", complete: true })
  })

  it("counts lag from the start of the last finished sync, event-driven ones included, and never moves it back", async () => {
    source.add("ses_1", {}, chat(1))
    source.add("ses_2", {}, chat(1))
    const sync = indexer()
    await sync.catchUp()
    time += 90_000
    expect(sync.state().lagSeconds).toBe(90)

    // An event-driven sync counts from when it started.
    source.say("ses_1", reply("more"))
    source.afterRead = () => { time += 4_000 }
    await sync.syncSession("ses_1")
    source.afterRead = null
    expect(store.meta(SYNCED_AT)).toBe(String(190_000))
    expect(sync.state().lagSeconds).toBe(4)

    // A pass that started before that sync, and so ends after it, does not set the time back.
    source.say("ses_2", reply("later"))
    const before = time - 10_000
    await indexer({ now: () => before }).catchUp()
    expect(store.sessionState("ses_2")?.indexedSeq).toBe(1)
    expect(store.meta(SYNCED_AT)).toBe(String(190_000))

    // A sync that finds nothing, or a deleted session, is not a sync.
    time += 30_000
    expect(await sync.syncSession("ses_gone")).toBe(false)
    await sync.deleteSession("ses_2")
    expect(await sync.syncSession("ses_2")).toBe(false)
    expect(sync.state().lagSeconds).toBe(34)
  })

  it("is never complete on the context source", async () => {
    source.kind = "context"
    source.add("ses_1", {}, chat(1))
    const sync = indexer()
    await sync.catchUp()
    expect(sync.state()).toMatchObject({ ready: true, source: "context", complete: false })
  })
})
