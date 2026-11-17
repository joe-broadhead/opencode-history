// Where history_events_list lists a session version (`listed`), from the independent review of #27 (b6a8326): a version
// indexed late stays after the cursors issued before it, across every rebuild; bursts and subagent sessions.
import { rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resultProblems, PAGE, type EventsListResult } from "@we-the-rebel-alliance/source-contract/events"
import { LATE_LISTING_MS, SETTLE_MS } from "../../src/domain/contract.js"
import { identityOf } from "../../src/host/identity.js"
import { openDb } from "../../src/domain/sqlite.js"
import { SCHEMA_VERSION } from "../../src/index/schema.js"
import { IndexStore, REBUILT_AT } from "../../src/index/store.js"
import { Indexer } from "../../src/index/sync.js"
import { eventsList, eventsRequest, PAGE_MAX_BYTES, SESSIONS_SOURCE } from "../../src/query/events.js"
import { chat, extract, FakeSource, titleDoc } from "./index/fakes.js"
import { tempDir } from "../temp.js"

const IDENTITY = identityOf("sam", "Studio-Mac.local")
const READY = { ready: true, sessionsIndexed: 1, sessionsTotal: 1, lagSeconds: 0, source: "opencode-db" as const, complete: true }
const NO_MASK = (text: string) => text

let dir: string
let store: IndexStore
let source: FakeSource
let time: number

const indexer = () => new Indexer({ store, source, extract, titleDoc, now: () => time })
const list = (input: Record<string, unknown>, now = time): EventsListResult =>
  eventsList(store.db, eventsRequest({ source: SESSIONS_SOURCE, ...input }), IDENTITY, READY, NO_MASK, now)
const ids = (page: EventsListResult) => page.events.map(event => event.external_id.split("@")[0]!)

beforeEach(() => {
  dir = tempDir("history-27-")
  store = IndexStore.open(join(dir, "index.db"))
  source = new FakeSource()
  time = 10_000_000
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("a version indexed late, across a rebuild", () => {
  async function setup() {
    source.add("ses_y", { updated: 2_000_000 }, chat(2))
    await indexer().backfill()
    const first = list({ since: new Date(0).toISOString() })
    expect(ids(first)).toEqual(["ses_y"])
    // A version that changed before the cursor's place, indexed only now (an import, another process's write).
    source.add("ses_x", { updated: 1_500_000 }, chat(2))
    time += 100_000
    await indexer().syncSession("ses_x")
    expect(store.db.get("select listed, updated from sessions where id = 'ses_x'")).toEqual({ listed: time - LATE_LISTING_MS, updated: 1_500_000 })
    return first.cursor
  }

  it("control: without a rebuild the late version is listed after the cursor", async () => {
    const cursor = await setup()
    time += SETTLE_MS * 2
    expect(ids(list({ account: IDENTITY.account, cursor }))).toEqual(["ses_x"])
  })

  const placed = () => store.db.get("select listed, updated from sessions where id = 'ses_x'")

  it("a rebuild (store.reset, then the backfill) before the reader's next page keeps its place, so it is listed", async () => {
    const cursor = await setup()
    const place = placed()
    store.reset(time)
    expect(store.meta(REBUILT_AT)).toBe(String(time))
    await indexer().backfill()
    expect(placed()).toEqual(place)
    // The rebuild is over: nothing carried is left.
    expect(store.db.get("select count(*) as n from carried")).toEqual({ n: 0 })
    expect(store.meta(REBUILT_AT)).toBeUndefined()
    time += SETTLE_MS * 2
    const after = list({ account: IDENTITY.account, cursor })
    expect(ids(after)).toEqual(["ses_x"])
    expect(after.gap).toBeUndefined()
  })

  it("the drop on opening an index of another layout keeps its place too", async () => {
    const cursor = await setup()
    const place = placed()
    store.setMeta("schema_version", String(SCHEMA_VERSION + 1))
    store.close()
    store = IndexStore.open(join(dir, "index.db"))
    expect(store.meta("schema_version")).toBe(String(SCHEMA_VERSION))
    expect(store.sessionCount()).toBe(0)
    await indexer().backfill()
    expect(placed()).toEqual(place)
    time += SETTLE_MS * 2
    expect(ids(list({ account: IDENTITY.account, cursor }))).toEqual(["ses_x"])
  })

  it("an index of an older layout without listed carries each version at the time it changed", async () => {
    source.add("ses_y", { updated: 2_000_000 }, chat(2))
    await indexer().backfill()
    store.db.exec("drop index sessions_listed")
    store.db.exec("alter table sessions drop column listed")
    store.setMeta("schema_version", String(SCHEMA_VERSION - 1))
    store.close()
    store = IndexStore.open(join(dir, "index.db"))
    expect(store.db.all("select id, updated, listed from carried")).toEqual([{ id: "ses_y", updated: 2_000_000, listed: 2_000_000 }])
    await indexer().backfill()
    expect(store.db.get("select listed from sessions where id = 'ses_y'")).toEqual({ listed: 2_000_000 })
  })

  it("a version the replaced index never listed is listed after every cursor issued before the rebuild", async () => {
    const cursor = await setup()
    // ses_z changed long ago, but the replaced index never had it (another process's write it had not caught up).
    source.add("ses_z", { updated: 1_000_000 }, chat(1))
    // And ses_y has a new version the replaced index had not indexed yet.
    source.touch("ses_y", 1_800_000)
    store.reset(time)
    await indexer().backfill()
    expect(store.db.get("select listed from sessions where id = 'ses_z'")).toEqual({ listed: time - LATE_LISTING_MS })
    expect(store.db.get("select listed from sessions where id = 'ses_y'")).toEqual({ listed: time - LATE_LISTING_MS })
    time += SETTLE_MS * 2
    expect(ids(list({ account: IDENTITY.account, cursor })).sort()).toEqual(["ses_x", "ses_y", "ses_z"])
  })

  it("a rebuild interrupted and started again keeps what the first one carried", async () => {
    const cursor = await setup()
    const place = placed()
    store.reset(time)
    // The first rebuild stops before it indexes anything; a second starts over.
    store.reset(time + 1)
    await indexer().backfill()
    expect(placed()).toEqual(place)
    time += SETTLE_MS * 2
    expect(ids(list({ account: IDENTITY.account, cursor }))).toEqual(["ses_x"])
  })

  it("a first build of an empty index lists each version when it changed, and carries nothing", async () => {
    store.close()
    const raw = openDb(join(dir, "fresh.db"))
    raw.close()
    store = IndexStore.open(join(dir, "fresh.db"))
    expect(store.meta(REBUILT_AT)).toBeUndefined()
    source.add("ses_y", { updated: 2_000_000 }, chat(2))
    store.reset(time)
    expect(store.meta(REBUILT_AT)).toBeUndefined()
    await indexer().backfill()
    expect(store.db.get("select listed from sessions where id = 'ses_y'")).toEqual({ listed: 2_000_000 })
  })
})

describe("a burst of thousands of sessions with one update time", () => {
  it("indexed promptly: paged at odd sizes, every one listed exactly once", async () => {
    for (let i = 0; i < 3000; i++) source.add(`ses_${String(i).padStart(5, "0")}`, { updated: 5_000_000 }, chat(1))
    await indexer().backfill()
    let page = list({ since: new Date(0).toISOString(), limit: 7 })
    const seen: string[] = [...ids(page)]
    for (let n = 0; page.more && n < 2000; n++) {
      expect(resultProblems(page, PAGE.max, PAGE_MAX_BYTES)).toEqual([])
      page = list({ account: IDENTITY.account, cursor: page.cursor, limit: n % 2 ? 100 : 13 })
      seen.push(...ids(page))
    }
    expect(seen.length).toBe(3000)
    expect(new Set(seen).size).toBe(3000)
  })

  it("indexed late in one catch-up (all share one listed time), while a reader pages through the middle of it", async () => {
    source.add("ses_first", { updated: 1_000 }, chat(1))
    await indexer().backfill()
    let page = list({ since: new Date(0).toISOString() })
    expect(ids(page)).toEqual(["ses_first"])
    // 2,000 sessions changed in one millisecond long ago appear only now (behind the cursor's time).
    for (let i = 0; i < 2000; i++) source.add(`ses_b${String(i).padStart(5, "0")}`, { updated: 500 + 1 }, chat(1))
    for (let i = 0; i < 2000; i++) source.touch(`ses_b${String(i).padStart(5, "0")}`, 500)
    const sync = indexer()
    for (let i = 0; i < 1000; i++) await sync.syncSession(`ses_b${String(i).padStart(5, "0")}`)
    time += SETTLE_MS * 2
    const seen: string[] = []
    page = list({ account: IDENTITY.account, cursor: page.cursor, limit: 37 })
    seen.push(...ids(page))
    // The rest are indexed while the reader is partway through.
    time += 1
    for (let i = 1000; i < 2000; i++) await sync.syncSession(`ses_b${String(i).padStart(5, "0")}`)
    time += SETTLE_MS * 2
    for (let n = 0; n < 500; n++) {
      page = list({ account: IDENTITY.account, cursor: page.cursor, limit: 41 })
      seen.push(...ids(page))
      if (!page.more && page.events.length === 0) break
    }
    expect(new Set(seen).size).toBe(2000)
    expect(seen.length).toBe(2000)
  })
})

describe("a subagent (child) session", () => {
  it("a child's later work is never its own event; the parent is listed only when the parent changes", async () => {
    source.add("ses_parent", { updated: 1_000_000 }, chat(2))
    source.add("ses_child", { updated: 1_000_100, parentID: "ses_parent" }, chat(2))
    await indexer().backfill()
    const first = list({ since: new Date(0).toISOString() })
    expect(ids(first)).toEqual(["ses_parent"])
    source.touch("ses_child", 3_000_000)
    time += 10_000
    await indexer().syncSession("ses_child")
    time += SETTLE_MS * 2
    expect(ids(list({ account: IDENTITY.account, cursor: first.cursor }))).toEqual([])
  })
})
