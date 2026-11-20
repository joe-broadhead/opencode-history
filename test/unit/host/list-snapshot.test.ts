// The list snapshot's own rules, through the real `sessions` RPC method: every project's sessions, newest first, 50
// at most, a repeated id once, a secret in an id left out, and the whole answer inside the declared maxBytes. Each
// assertion fails when its rule is removed, so the rules are guarded rather than documented.
import { describe, expect, it } from "vitest"
import { identityOf } from "../../../src/host/identity.js"
import { scriptMethods, type PluginMethod } from "../../../src/host/tools-rpc.js"
import { sessions as querySessions } from "../../../src/query/sessions.js"
import { fakeSession } from "../../host/session.js"
import { NOW, STATE, project, session, sidecar, type Sidecar } from "../query/fixture.js"

const IDENTITY = identityOf("sam", "studio-mac")
const ACCOUNT = IDENTITY.account
const HOUR = 3_600_000
const call = () => ({ sessionID: "ses_conformance", agent: "build", messageID: "msg_list", id: "call_list", signal: new AbortController().signal, progress: async () => {} })

/** The `sessions` method over a synthetic index, with the kit's recording permission. */
function method(db: Sidecar["db"]) {
  const table = scriptMethods({
    runtime: { sessions: async (caller: unknown, input: unknown) => querySessions(db, caller as never, input as never, STATE) } as never,
    session: fakeSession().session,
    location: { projectID: "prj_app", directory: "/work/app" },
    defaults: { scope: "project" },
    identity: () => IDENTITY,
    assert: async () => {},
  })
  return table.find((entry) => entry.name === "sessions") as PluginMethod
}

const listed = async (index: Sidecar, input: Record<string, unknown> = {}) =>
  (await method(index.db).run({ list: "sessions", account: ACCOUNT, ...input }, call() as never)) as {
    account?: string
    data: { items: { id: string; text: string }[]; editable: boolean }
    asOf: string
    trust: string
  }

function index(rows: (db: Sidecar["db"], at: (hours: number) => number) => void) {
  const s = sidecar()
  project(s.db, "prj_app", "/work/app")
  project(s.db, "prj_web", "/work/web")
  const at = (hours: number) => NOW - hours * HOUR
  rows(s.db, at)
  return s
}

describe("history.sessions.list's rules", () => {
  it("lists every project's sessions, newest first, and at most 50 of them", async () => {
    const s = index((db, at) => {
      // Three in one project, two in another, at different times.
      // Distinct costs, so a sort by cost would give a different order from newest first.
      session(db, { id: "ses_a", title: "App oldest", updated: at(30), cost: 2 })
      session(db, { id: "ses_b", title: "App newest", updated: at(2), cost: 1 })
      session(db, { id: "ses_c", title: "App middle", updated: at(12), cost: 9 })
      session(db, { id: "ses_d", title: "Web newest", updated: at(1), directory: "/work/web", projectID: "prj_web", cost: 5 })
      session(db, { id: "ses_e", title: "Web old", updated: at(40), directory: "/work/web", projectID: "prj_web", cost: 0 })
      // Enough more that the cap has to act.
      for (let i = 0; i < 60; i++) session(db, { id: `ses_pad_${i}`, title: `Pad ${i}`, updated: at(100 + i) })
    })
    const answer = await listed(s)
    const ids = answer.data.items.map((item) => item.id)
    // Both projects, and the order is newest first, not by cost, id or project.
    expect(ids).toContain("ses_d")
    expect(ids).toContain("ses_b")
    expect(ids).toHaveLength(50)
    const times = answer.data.items.map((item) => item.id)
    expect(times.slice(0, 5)).toEqual(["ses_d", "ses_b", "ses_c", "ses_a", "ses_e"])
    s.close()
  })

  it("leaves out a secret in the title and in the id, and screens before it cuts", async () => {
    const s = index((db, at) => {
      session(db, { id: "ses_ok", title: "A plain title", updated: at(1) })
      session(db, { id: "ses_secret_title", title: "Wifi password: Ku7pLm2QzR9w", updated: at(2) })
      // A secret that only appears after the 200-character cut.
      session(db, { id: "ses_straddle", title: `${"a".repeat(196)}Password: Ku7pLm2QzR9w`, updated: at(3) })
      // A secret inside the id itself: an id whose whole text is a token, so the id screen is what drops it.
      session(db, { id: "ghp_A1b2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8", title: "Plain", updated: at(4) })
    })
    const answer = await listed(s)
    const ids = answer.data.items.map((item) => item.id)
    expect(ids).toEqual(["ses_ok"])
    s.close()
  })

  it("holds the declared maxBytes with 50 maximal multi-byte items", async () => {
    // Four-byte characters in both the id and the title: the widest item the caps allow, 50 of them.
    const s = index((db, at) => {
      for (let i = 0; i < 50; i++) session(db, { id: `😀${i}`.padEnd(128, "😀"), title: "😀".repeat(100), updated: at(i) })
    })
    const answer = await listed(s)
    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(65_536)
    expect(answer.data.items).toHaveLength(50)
    // Every item is whole: an id and a title, cut to their limits, never a truncated JSON string.
    for (const item of answer.data.items) {
      expect(item.id.length).toBeLessThanOrEqual(128)
      expect(item.text.length).toBeLessThanOrEqual(200)
    }
    s.close()
  })

  it("refuses another machine's account, and reads the signed-in one when none is passed", async () => {
    const s = index((db, at) => void session(db, { id: "ses_a", title: "A", updated: at(1) }))
    expect(await method(s.db).run({ list: "sessions", account: "another-machine" }, call() as never).catch((error: { code?: string }) => error.code)).toBe("ACCOUNT_MISMATCH")
    // Without an account the read still answers the signed-in machine's sessions, and names no account.
    const answer = await listed(s, { account: undefined })
    expect(answer.account).toBeUndefined()
    expect(answer.data.items.map((item) => item.id)).toEqual(["ses_a"])
    s.close()
  })
})
