import { afterEach, describe, expect, it } from "vitest"
import type { IndexState } from "../../../src/domain/api.js"
import { BOUNDS } from "../../../src/domain/bounds.js"
import { parse } from "../../../src/domain/common.js"
import { EventsListInputSchema } from "../../../src/domain/schemas.js"
import { assertEventsListConformance, encodeCursor, eventProblems, MAX_PAGE_BYTES, PAGE, resultProblems, type EventsListInput } from "../../../src/host/events-list.js"
import { identityOf } from "../../../src/host/identity.js"
import { EVENTS_SOURCE, eventsList, eventsRequest, SETTLE_MS } from "../../../src/query/events.js"
import { DAY, NO_MASK, NOW, project, session, sidecar, STATE, type Sidecar } from "./fixture.js"

const IDENTITY = identityOf("sam", "Studio-Mac.local")
const HOUR = 3_600_000

const sidecars: Sidecar[] = []
afterEach(() => {
  for (const s of sidecars.splice(0)) s.close()
})

function index(): Sidecar {
  const s = sidecar()
  sidecars.push(s)
  return s
}

/** events_list as the tool runs it: the tool's schema, then the contract's parser, then the query. */
function lister(s: Sidecar, options: { state?: IndexState; mask?: (text: string) => string; now?: number } = {}) {
  return async (input: EventsListInput) =>
    eventsList(s.db, eventsRequest(parse(EventsListInputSchema, input, "INPUT_INVALID")), IDENTITY, options.state ?? STATE, options.mask ?? NO_MASK, options.now ?? NOW)
}

/** Five synthetic top-level sessions over the last day, a subagent, one older session and one too new to have settled. */
function history(s: Sidecar): void {
  project(s.db, "prj_app", "/work/projects/Billing App")
  for (const [index, id] of ["ses_a", "ses_b", "ses_c", "ses_d", "ses_e"].entries()) {
    session(s.db, { id, title: `Synthetic task ${index + 1}`, updated: NOW - 20 * HOUR + index * HOUR, firstPrompt: `Prompt ${index + 1}`, lastReply: `Reply ${index + 1}` })
  }
  session(s.db, { id: "ses_sub", parentID: "ses_a", updated: NOW - 10 * HOUR })
  session(s.db, { id: "ses_old", updated: NOW - 3 * DAY })
  session(s.db, { id: "ses_new", updated: NOW - SETTLE_MS / 2 })
}

describe("history_events_list", () => {
  it("keeps the shared events_list contract", async () => {
    const s = index()
    history(s)
    await assertEventsListConformance(lister(s), {
      source: EVENTS_SOURCE,
      account: IDENTITY.account,
      owner: IDENTITY.owner,
      since: new Date(NOW - DAY).toISOString(),
      expected: ["ses_a", "ses_b", "ses_c", "ses_d", "ses_e"].map((id, index) => `${id}@${new Date(NOW - 20 * HOUR + index * HOUR).toISOString()}`),
    })
  })

  it("keeps the contract with a page of one and no since, from 24 hours back", async () => {
    const s = index()
    history(s)
    await assertEventsListConformance(lister(s), {
      source: EVENTS_SOURCE,
      expected: ["ses_a", "ses_b", "ses_c", "ses_d", "ses_e"].map((id, index) => `${id}@${new Date(NOW - 20 * HOUR + index * HOUR).toISOString()}`),
      pageSize: 1,
    })
  })

  it("makes one event per session change, with the session's facts and no local path", async () => {
    const s = index()
    project(s.db, "prj_app", "/work/projects/Billing App")
    session(s.db, { id: "ses_a", title: "Fix the\ninvoice rounding", updated: NOW - HOUR, agent: "build", firstPrompt: "Round half to even", lastReply: "Done: banker's rounding.", archived: NOW - HOUR })
    const result = await lister(s)({})
    expect(resultProblems(result)).toEqual([])
    expect(result.owner).toEqual({ id: "os-user:sam@studio-mac", label: "sam on studio-mac" })
    expect(result.trust).toBe("untrusted")
    expect(result.events).toEqual([
      expect.objectContaining({
        source: "history",
        account: "studio-mac",
        external_id: `ses_a@${new Date(NOW - HOUR).toISOString()}`,
        kind: "session",
        occurred_at: new Date(NOW - HOUR).toISOString(),
        thread: "history-session:ses_a",
        actors: [{ role: "agent", id: "opencode-agent:build", name: "build" }],
        title: "Fix the invoice rounding",
        text: "Prompt: Round half to even\n\nReply: Done: banker's rounding.",
        url: null,
        labels: ["project:billing-app", "archived"],
      }),
    ])
    expect(JSON.stringify(result)).not.toContain("/work/")

    // The same session changing later is a new event after the cursor.
    s.db.run("update sessions set updated = ?, last_reply = ? where id = 'ses_a'", NOW - HOUR / 2, "Reverted.")
    const next = await lister(s)({ cursor: result.cursor })
    expect(next.events.map(event => event.external_id)).toEqual([`ses_a@${new Date(NOW - HOUR / 2).toISOString()}`])
    expect(next.events[0]!.text).toBe("Prompt: Round half to even\n\nReply: Reverted.")
  })

  it("masks before it cuts and hashes, and keeps the first prompt to 1,500 characters", async () => {
    const s = index()
    const secret = "sk-test-0000000000000000"
    // The secret straddles the prompt's cut, so cutting first would leave its start behind.
    session(s.db, { id: "ses_a", updated: NOW - HOUR, title: `Rotate ${secret}`, firstPrompt: `${"p".repeat(1_495)}${secret} tail`, lastReply: "r".repeat(5_000) })
    const mask = (text: string) => text.replaceAll(secret, "[masked]")
    const [event] = (await lister(s, { mask })({})).events
    expect(event!.title).toBe("Rotate [masked]")
    expect(event!.text).not.toContain("sk-")
    expect(event!.text.startsWith(`Prompt: ${"p".repeat(1_495)}[mas…`)).toBe(true)
    expect(event!.text).toContain("…\n\nReply: rrr")
    expect(event!.text.length).toBe(4_096)
    expect(eventProblems(event)).toEqual([])
  })

  it("lists only sessions that have settled, and a session that settles later after the cursor", async () => {
    const s = index()
    session(s.db, { id: "ses_new", updated: NOW - SETTLE_MS / 2 })
    const first = await lister(s)({})
    expect(first).toMatchObject({ events: [], more: false })
    const later = await lister(s, { now: NOW + SETTLE_MS })({ cursor: first.cursor })
    expect(later.events.map(event => event.external_id)).toEqual([`ses_new@${new Date(NOW - SETTLE_MS / 2).toISOString()}`])
  })

  it("lists nothing while the index is being built, and keeps the cursor where it was", async () => {
    const s = index()
    history(s)
    const building = await lister(s, { state: { ...STATE, ready: false } })({ limit: 2 })
    expect(building).toMatchObject({ events: [], more: false })
    const ready = await lister(s)({ cursor: building.cursor, limit: 2 })
    expect(ready.events.map(event => event.external_id.split("@")[0])).toEqual(["ses_a", "ses_b"])
  })

  it("stops before the result passes the size cap, and the cursor carries on from there", async () => {
    const s = index()
    for (let index = 0; index < 300; index++) {
      session(s.db, { id: `ses_${String(index).padStart(3, "0")}`, updated: NOW - HOUR + index, firstPrompt: "p".repeat(1_500), lastReply: "r".repeat(3_000) })
    }
    const first = await lister(s)({ limit: PAGE.max })
    expect(first.more).toBe(true)
    expect(first.events.length).toBeGreaterThan(100)
    expect(first.events.length).toBeLessThan(300)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(MAX_PAGE_BYTES)
    const rest = await lister(s)({ cursor: first.cursor, limit: PAGE.max })
    expect(first.events.length + rest.events.length).toBe(300)
    expect(rest.more).toBe(false)
  })

  it("refuses another machine's account and cursor, and a malformed since", async () => {
    const s = index()
    history(s)
    await expect(lister(s)({ account: "other-mac" })).rejects.toMatchObject({ code: "ACCOUNT_UNKNOWN" })
    await expect(lister(s)({ cursor: encodeCursor(EVENTS_SOURCE, { a: "other-mac", u: NOW, i: "ses_a" }) })).rejects.toMatchObject({ code: "CURSOR_INVALID" })
    await expect(lister(s)({ since: "2026-13-45" })).rejects.toMatchObject({ code: "INPUT_INVALID" })
    await expect(lister(s)({ since: "2026-11-01T10:00" })).rejects.toMatchObject({ code: "INPUT_INVALID" })
    expect((await lister(s)({ account: IDENTITY.account })).events.length).toBe(5)
  })

  it("takes its limit's default and range from the contract", () => {
    expect(BOUNDS.events_list.limit).toEqual(PAGE)
  })
})

describe("identity", () => {
  it("names this machine by its host name, and the owner by the OS user on it", () => {
    expect(identityOf("Sam Doe", "Sam's MacBook-Pro.local")).toEqual({ account: "sam-s-macbook-pro", owner: { id: "os-user:sam-doe@sam-s-macbook-pro", label: "sam-doe on sam-s-macbook-pro" } })
    expect(identityOf("", "")).toEqual({ account: "local", owner: { id: "os-user:user@local", label: "user on local" } })
  })
})
