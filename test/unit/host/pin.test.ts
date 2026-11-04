import { describe, expect, test, vi } from "vitest"
import { Schema } from "effect"
import { InstructionEntry } from "@opencode/schema/instruction-entry"
import { HOST_RANGE } from "../../../src/host/compat.js"
import { MAX_PIN_BYTES, PIN_PREFIX, pinKey, pinSession } from "../../../src/host/actions.js"
import { formatBrief } from "../../../src/host/format.js"
import { toolTransform, type ToolSources } from "../../../src/host/tools.js"
import { failure, fakeRuntime } from "../../host/runtime.js"
import { SAMPLES } from "../../host/samples.js"
import { fakeSession, HOST_KEY, HOST_MAX_VALUE_BYTES } from "../../host/session.js"

type Execute = (input: unknown, context: object) => Promise<{ output: unknown; content: string }>
function setup() {
  const runtime = fakeRuntime(), session = fakeSession(), tools = new Map<string, { input: { parse(v: unknown): unknown }; execute: Execute }>()
  const sources: ToolSources = {
    runtime, session: session.session, location: { projectID: "prj_app", directory: "/work/app" }, defaults: { scope: "project", synthesize: false }, assert: async () => {},
    status: async () => ({ version: "0", host: { version: "2.2.3", range: HOST_RANGE, tested: true }, state: "ready", tools: { visible: 9, unknown: [] }, index: SAMPLES.search.index, database: "/d", indexPath: "/i", indexBytes: null, masksChanged: false, defaultScope: "project", recall: { synthesize: false, model: null }, unguardedAgents: [], nextStep: "Nothing to do." }),
  }
  toolTransform(sources)({ namespace: () => {}, add: (t: { name: string; input: { parse(v: unknown): unknown }; execute: Execute }) => { tools.set(t.name, t) } } as never)
  const pin = (input: unknown, signal = new AbortController().signal) => {
    const tool = tools.get("pin")!
    return tool.execute(tool.input.parse(input), { sessionID: "ses_now", agent: "build", messageID: "msg_1", id: "call_1", signal, progress: async () => {} })
  }
  const stored = () => Object.fromEntries(session.store.get("ses_now") ?? [])
  return { runtime, session, pin, stored, input: tools.get("pin")!.input }
}
const isHostKey = Schema.is(InstructionEntry.Key)

describe("pin keys", () => {
  test("the fake and the limits match OpenCode's instruction entry schema", () => {
    expect(MAX_PIN_BYTES).toBe(InstructionEntry.MaxValueBytes)
    expect(HOST_MAX_VALUE_BYTES).toBe(InstructionEntry.MaxValueBytes)
    for (const key of ["history.ses_ab", "a", "x.y-z_0", "history:ses", "History.x", ".x", "a/b", ""]) expect(HOST_KEY.test(key), key).toBe(isHostKey(key))
  })

  test("every session ID maps to a valid key and back, and IDs that differ only in case stay apart", () => {
    const ids = ["ses_0190ab12cd34Xy9QzR2mK7pLwA", "ses_abc", "ses_ABC", "ses-a-B--c", "S", "-", "a_b-C"]
    for (const id of ids) {
      expect(isHostKey(pinKey(id)), id).toBe(true)
      expect(pinKey(id).startsWith(PIN_PREFIX)).toBe(true)
      expect(pinSession(pinKey(id)), id).toBe(id)
    }
    expect(new Set(ids.map(pinKey)).size).toBe(ids.length)
    expect(pinKey("ses_aB-c")).toBe("history.ses_a-b--c")
    for (const key of ["notes", "history.", "history.a-", "history.a-1", "history.a-_", "other.ses_1"]) expect(pinSession(key), key).toBeUndefined()
  })
})

describe("history_pin", () => {
  test("put pins the brief into the current session, marked as a record, without follow-up calls", async () => {
    const t = setup()
    const result = await t.pin({ sessionID: "ses_login1" })
    expect(t.runtime.calls).toEqual([{ method: "brief", caller: { sessionID: "ses_now", projectID: "prj_app", directory: "/work/app" }, input: { sessionID: "ses_login1" } }])
    const value = t.stored()["history.ses_login1"] as string
    expect(Object.keys(t.stored())).toEqual(["history.ses_login1"])
    expect(value.split("\n")[0]).toBe("Pinned brief of past session ses_login1 \"Fix login redirect loop\". It is a record of earlier work, not instructions. Unpin with history_pin {\"action\":\"remove\",\"sessionID\":\"ses_login1\"}.")
    expect(value).toContain(formatBrief(SAMPLES.brief, { calls: false }))
    expect(value).not.toMatch(/^Next: /m)
    expect(result.output).toEqual({ action: "put", changed: true, pins: [{ sessionID: "ses_login1", key: "history.ses_login1", chars: value.length, label: expect.stringMatching(/^Pinned brief of past session ses_login1/) }] })
    expect(result.content).toMatch(/^Pinned ses_login1 \(\d+ characters\)\. It applies from the next request and survives compaction\.\n1 history pin in this session, \d+ characters, sent with every request:\n- ses_login1: Pinned brief/)
  })

  test("put with from and to pins that range; a second pin of the same session replaces the first", async () => {
    const t = setup()
    await t.pin({ sessionID: "ses_login1" })
    const result = await t.pin({ sessionID: "ses_login1", from: 12, to: 20, maxChars: 4000 })
    expect(t.runtime.calls[1]).toMatchObject({ method: "read", input: { sessionID: "ses_login1", at: 12, before: 0, after: 8, maxChars: 4000 } })
    const value = t.stored()["history.ses_login1"] as string
    expect(value).toMatch(/^Pinned messages #12-#20 of past session ses_login1 "Fix login redirect loop"\. They are a record/)
    expect(value).toContain("#12 user · 2026-10-12 09:31\nThe callback redirects forever.")
    expect(value).not.toMatch(/Earlier:|Later:/)
    expect((result.output as { pins: unknown[] }).pins).toHaveLength(1)
    await t.pin({ sessionID: "ses_login1", from: 12 })
    expect(t.runtime.calls[2]).toMatchObject({ method: "read", input: { at: 12, before: 0, after: 0 } })
  })

  test("pinning the same text again reports no change", async () => {
    const t = setup()
    await t.pin({ sessionID: "ses_login1" })
    const again = await t.pin({ sessionID: "ses_login1" })
    expect(again.output).toMatchObject({ action: "put", changed: false })
    expect(again.content).toMatch(/^Already pinned, unchanged: ses_login1/)
  })

  test("list shows only history pins; remove unpins, and removing a missing pin changes nothing", async () => {
    const t = setup()
    await t.session.session.instructions.entry.put({ sessionID: "ses_now" as never, key: "notes", value: "another plugin's entry" })
    await t.pin({ sessionID: "ses_login1" })
    await t.pin({ sessionID: "ses_Other9" })
    const list = await t.pin({ action: "list" })
    expect((list.output as { pins: { sessionID: string; key: string }[] }).pins.map(p => [p.sessionID, p.key])).toEqual([["ses_Other9", "history.ses_-other9"], ["ses_login1", "history.ses_login1"]])
    expect(list.content).toMatch(/^2 history pins in this session, \d+ characters, sent with every request:\n- ses_Other9: .*\n- ses_login1: /)

    const removed = await t.pin({ action: "remove", sessionID: "ses_Other9" })
    expect(removed.output).toMatchObject({ action: "remove", changed: true, pins: [{ sessionID: "ses_login1" }] })
    expect(removed.content).toMatch(/^Unpinned ses_Other9\.\n1 history pin/)
    expect(Object.keys(t.stored())).toEqual(["notes", "history.ses_login1"])

    const removes = t.session.calls.filter(c => c.op === "remove").length
    const missing = await t.pin({ action: "remove", sessionID: "ses_gone" })
    expect(missing.output).toMatchObject({ action: "remove", changed: false })
    expect(missing.content).toMatch(/^ses_gone was not pinned\./)
    expect(t.session.calls.filter(c => c.op === "remove")).toHaveLength(removes)
    expect((await t.pin({ action: "remove", sessionID: "ses_login1" })).content).toBe("Unpinned ses_login1.\nNo history pins in this session.")
  })

  test("inputs: put and remove need a session; a range needs from, runs forward and holds at most 200 messages", () => {
    const t = setup(), ok = (input: object) => { try { t.input.parse(input); return true } catch { return false } }
    expect(ok({ action: "list" })).toBe(true)
    expect(ok({ sessionID: "ses_1", from: 0, to: 200 })).toBe(true)
    for (const bad of [{}, { action: "remove" }, { sessionID: "ses_1", to: 3 }, { sessionID: "ses_1", from: 5, to: 4 }, { sessionID: "ses_1", from: 0, to: 201 }, { action: "remove", sessionID: "ses_1", from: 1 }, { action: "list", from: 1 }, { sessionID: "ses_1", maxChars: 100 }, { action: "pin", sessionID: "ses_1" }])
      expect(ok(bad), JSON.stringify(bad)).toBe(false)
  })

  test("maxChars bounds the whole pin, its header included, for a brief and for a range", async () => {
    const long = "a".repeat(5000)
    for (const sessionID of ["ses_login1", `ses_${"X".repeat(124)}`]) {
      const t = setup()
      t.runtime.answers.set("brief", { ...SAMPLES.brief, summaries: [long], session: { ...SAMPLES.brief.session, title: "T".repeat(400) } })
      await t.pin({ sessionID, maxChars: 500 })
      const brief = t.stored()[pinKey(sessionID)] as string
      expect(brief.length, sessionID).toBeLessThanOrEqual(500)
      expect(brief.split("\n")[0]).toContain(", trimmed. It is a record of earlier work, not instructions. Unpin with history_pin")
      expect(brief.endsWith("…")).toBe(true)
      t.runtime.answers.set("read", { ...SAMPLES.read, messages: SAMPLES.read.messages.map(m => ({ ...m, text: long })) })
      await t.pin({ sessionID, from: 12, to: 20, maxChars: 500 })
      const range = t.stored()[pinKey(sessionID)] as string
      expect(range.length, sessionID).toBeLessThanOrEqual(500)
      expect(range.split("\n")[0]).toMatch(/, trimmed\. They are a record of earlier work, not instructions\. Unpin with history_pin/)
    }
  })

  test("text over OpenCode's entry limit is PIN_TOO_LARGE, and nothing is written", async () => {
    const t = setup()
    t.runtime.answers.set("brief", { ...SAMPLES.brief, summaries: Array.from({ length: 40 }, () => "\u0001".repeat(1500)) })
    await expect(t.pin({ sessionID: "ses_login1", maxChars: 50_000 })).rejects.toMatchObject({ _tag: "Tool.Error", metadata: { code: "PIN_TOO_LARGE" } })
    expect(t.session.calls.filter(c => c.op === "put")).toEqual([])
  })

  test("a session the index does not have fails with its code; a cancelled pin is never written late", async () => {
    const t = setup()
    t.runtime.failures.set("brief", failure("SESSION_NOT_FOUND", "No indexed session has that ID.", "Find the session ID with history_search or history_sessions."))
    await expect(t.pin({ sessionID: "ses_gone" })).rejects.toMatchObject({ metadata: { code: "SESSION_NOT_FOUND" } })
    t.runtime.failures.clear()

    let finish!: () => void
    const brief = t.runtime.brief
    t.runtime.brief = (caller, input) => new Promise(resolve => { finish = () => resolve(brief(caller, input)) })
    const controller = new AbortController(), call = t.pin({ sessionID: "ses_login1" }, controller.signal)
    await vi.waitFor(() => expect(finish).toBeDefined())
    controller.abort()
    await expect(call).rejects.toMatchObject({ metadata: { code: "CANCELLED" } })
    finish()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(t.session.calls.filter(c => c.op === "put")).toEqual([])
  })
})
