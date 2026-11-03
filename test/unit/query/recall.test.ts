import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RecallInput } from "../../../src/domain/api.js"
import type { Db } from "../../../src/domain/sqlite.js"
import { keyTerms, phrasingsFor, recall, recallPrompt, type Synthesize } from "../../../src/query/recall.js"
import { CALLER, DAY, NOW, NO_MASK, STATE, assistantData, doc, fakeSource, noise, project, session, sidecar, textPart, userData, type FakeSource, type Sidecar } from "./fixture.js"

let index: Sidecar
let db: Db
let source: FakeSource

/** Add a message to the source and the matching doc to the index, a second apart from the session's update time. */
function say(sessionID: string, type: "user" | "assistant", text: string) {
  const updated = db.get<{ updated: number }>("select updated from sessions where id = ?", sessionID)!.updated
  const seq = source.all.filter(message => message.sessionID === sessionID).length
  const message = source.add(sessionID, type, type === "user" ? userData(text) : assistantData([textPart(text)]), { created: updated + seq * 1000 })
  doc(db, { sessionID, seq: message.seq, messageID: message.id, kind: type, text, time: message.created })
}

const ask = (input: Partial<RecallInput>, synthesize?: Synthesize, mask = NO_MASK) =>
  recall(db, source, CALLER, { question: "How did we fix the flaky upload test?", ...input }, STATE, synthesize, mask, { now: NOW })

beforeEach(() => {
  index = sidecar()
  db = index.db
  source = fakeSource()
  project(db, "prj_app", "/work/app")
  noise(db, 100)
  session(db, { id: "ses_upload", title: "Flaky upload test", updated: NOW - DAY })
  say("ses_upload", "user", "the upload test is flaky on CI")
  say("ses_upload", "assistant", "The flaky upload test races the temp dir cleanup.")
  say("ses_upload", "user", "fix it")
  say("ses_upload", "assistant", "Fixed the flaky upload test by awaiting cleanup before the next test.")
  for (let i = 0; i < 6; i++) say("ses_upload", "user", `unrelated chatter ${i}`)
  say("ses_upload", "assistant", "Later note: the upload test stayed green after the fix.")
  session(db, { id: "ses_other", title: "Upload size limit", updated: NOW - 5 * DAY })
  say("ses_other", "user", "uploads over 10MB fail; is the upload test covering that?")
  say("ses_other", "assistant", "Added an upload test for the 10MB limit.")
})

afterEach(() => index.close())

describe("phrasingsFor", () => {
  it("joins the key terms with OR, then adds pairs of neighbouring key terms", () => {
    expect(phrasingsFor("How did we fix the flaky upload test?")).toEqual(["fix OR flaky OR upload OR test", "fix flaky", "flaky upload", "upload test"])
    expect(phrasingsFor('Why does "ENOENT: no such file" happen in src/auth.ts?')).toEqual([
      '"ENOENT: no such file" OR happen OR src/auth.ts',
      '"ENOENT: no such file" happen',
      "happen src/auth.ts",
    ])
  })

  it("drops stopwords and edge punctuation and lowers case, so OR and NOT stay words", () => {
    expect(keyTerms("NOT working OR broken?!")).toEqual(["working", "broken"])
    expect(phrasingsFor("NOT working OR broken")).toEqual(["working OR broken", "working broken"])
    expect(phrasingsFor("Kubernetes?")).toEqual(["kubernetes"])
    expect(phrasingsFor("what is it?")).toEqual(["what is it?"])
  })

  it("keeps the three longest pairs, in question order, and at most eight terms", () => {
    expect(phrasingsFor("How did we configure the redis cache eviction policy for the staging cluster deployment?")).toEqual([
      "configure OR redis OR cache OR eviction OR policy OR staging OR cluster OR deployment",
      "configure redis",
      "eviction policy",
      "cluster deployment",
    ])
    expect(phrasingsFor("a1 b2 c3 d4 e5 f6 g7 h8 i9 j10")[0]!.split(" OR ")).toHaveLength(8)
  })
})

describe("recall", () => {
  it("returns windows of messages around the best snippets, best session first", async () => {
    const out = await ask({})
    expect(out.queries).toEqual(["fix OR flaky OR upload OR test", "fix flaky", "flaky upload", "upload test"])
    expect(out.answer).toBeNull()
    expect(out.index).toBe(STATE)
    const first = out.evidence[0]!
    expect(first).toMatchObject({ sessionID: "ses_upload", title: "Flaky upload test", seq: 0 })
    expect(first.text).toBe(
      ["#0 user: the upload test is flaky on CI", "#1 assistant: The flaky upload test races the temp dir cleanup.", "#2 user: fix it"].join("\n"),
    )
    // The session's next snippet, the fix, gets a window of its own after every session's best.
    const fix = out.evidence.find(item => item.sessionID === "ses_upload" && item.seq === 3)
    expect(fix?.text).toBe(
      [
        "#2 user: fix it",
        "#3 assistant: Fixed the flaky upload test by awaiting cleanup before the next test.",
        "#4 user: unrelated chatter 0",
        "#5 user: unrelated chatter 1",
      ].join("\n"),
    )
  })

  it("finds sessions that share only part of the question's wording", async () => {
    session(db, { id: "ses_partial", title: "CI timeouts", updated: NOW - 2 * DAY })
    say("ses_partial", "user", "the upload test times out on CI again")
    const sessions = new Set((await ask({})).evidence.map(item => item.sessionID))
    expect(sessions).toEqual(new Set(["ses_upload", "ses_other", "ses_partial"]))
  })

  it("takes each session's best snippet before anyone's second, and skips snippets a window covers", async () => {
    const out = await ask({ queries: ["upload test"] })
    expect(out.queries).toEqual(["upload test"])
    const sessions = out.evidence.map(item => item.sessionID)
    expect(new Set(sessions.slice(0, 2))).toEqual(new Set(["ses_upload", "ses_other"]))
    const seen = new Map<string, number[]>()
    for (const item of out.evidence) seen.set(item.sessionID, [...(seen.get(item.sessionID) ?? []), item.seq])
    for (const seqs of seen.values()) {
      for (const [i, seq] of seqs.entries()) for (const other of seqs.slice(0, i)) expect(seq < other - 1 || seq > other + 2).toBe(true)
    }
  })

  it("stays within maxChars and the session count", async () => {
    const out = await ask({ queries: ["upload test"], maxChars: 1000, sessions: 1 })
    expect(out.evidence.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(1000)
    expect(new Set(out.evidence.map(item => item.sessionID))).toEqual(new Set(["ses_upload"]))
  })

  it("passes filters to the search", async () => {
    expect((await ask({ queries: ["upload test"], since: "3d" })).evidence.every(item => item.sessionID === "ses_upload")).toBe(true)
    expect((await ask({ queries: ["upload test"], scope: "all", sessionID: "ses_other" })).evidence.map(item => item.sessionID)).toEqual(["ses_other"])
  })

  it("falls back to the indexed snippet when the source lacks the messages", async () => {
    session(db, { id: "ses_gone", title: "Gone", updated: NOW })
    doc(db, { sessionID: "ses_gone", seq: 0, kind: "user", text: "zebra upload crossing", time: NOW })
    const out = await ask({ queries: ["zebra"] })
    expect(out.evidence).toMatchObject([{ sessionID: "ses_gone", seq: 0, text: "#0 user: zebra upload crossing" }])
  })

  it("masks text read from the source", async () => {
    session(db, { id: "ses_key", title: "Keys", updated: NOW })
    say("ses_key", "user", "the zebra key is sk-424242")
    const out = await ask({ queries: ["zebra"] }, undefined, text => text.replace(/sk-\d+/g, "[masked]"))
    expect(out.evidence[0]!.text).toBe("#0 user: the zebra key is [masked]")
  })

  it("asks the model for a cited answer when synthesize is given and allowed", async () => {
    const synthesize = vi.fn(async (prompt: string) => `  Awaiting cleanup fixed it [ses_upload#3].\n`)
    const out = await ask({ synthesize: true }, synthesize)
    expect(out.answer).toBe("Awaiting cleanup fixed it [ses_upload#3].")
    const prompt = synthesize.mock.calls[0]![0]
    expect(prompt).toContain("Question: How did we fix the flaky upload test?")
    expect(prompt).toContain('[ses_upload#3] "Flaky upload test"')
    expect(prompt).toContain("#3 assistant: Fixed the flaky upload test")
    expect(prompt).toContain("[sessionID#seq]")
    expect(prompt).toBe(recallPrompt("How did we fix the flaky upload test?", out.evidence))

    synthesize.mockClear()
    expect((await ask({ synthesize: false }, synthesize)).answer).toBeNull()
    expect((await ask({ queries: ["nothing matches this"] }, synthesize)).answer).toBeNull()
    expect(synthesize).not.toHaveBeenCalled()
  })

  it("reports a failed model call as a recall failure", async () => {
    await expect(ask({}, async () => Promise.reject(new Error("rate limited")))).rejects.toMatchObject({ reason: "recall" })
  })

  it("rejects an empty question", async () => {
    await expect(ask({ question: "   " })).rejects.toMatchObject({ reason: "query" })
  })
})

describe("recall over subagents", () => {
  it("cites the subagent session its evidence came from", async () => {
    session(db, { id: "ses_parent", title: "Parent", updated: NOW })
    session(db, { id: "ses_kid", parentID: "ses_parent", title: "Kid", updated: NOW })
    say("ses_kid", "assistant", "the zebra lives in the subagent")
    const out = await ask({ queries: ["zebra"], includeSubagents: true })
    expect(out.evidence).toMatchObject([{ sessionID: "ses_kid", title: "Kid", seq: 0, time: new Date(NOW).toISOString() }])
    expect(out.evidence[0]!.text).toBe("#0 assistant: the zebra lives in the subagent")
  })
})
