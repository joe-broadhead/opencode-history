import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ReadInput } from "../../../src/domain/api.js"
import { BOUNDS } from "../../../src/domain/bounds.js"
import type { Db } from "../../../src/domain/sqlite.js"
import { read } from "../../../src/query/read.js"
import { OUTPUT_HEAD, OUTPUT_TAIL, renderMessage } from "../../../src/query/render.js"
import {
  NO_MASK,
  assistantData,
  fakeSource,
  reasoningPart,
  session,
  sidecar,
  textPart,
  titleDoc,
  toolPart,
  userData,
  type FakeSource,
  type Sidecar,
} from "./fixture.js"

let index: Sidecar
let db: Db
let source: FakeSource

const open = (input: Partial<ReadInput> = {}, mask = NO_MASK) => read(db, source, { sessionID: "ses_r", ...input }, mask)
const seqs = async (input: Partial<ReadInput> = {}) => (await open(input)).messages.map(message => message.seq)
const render = (type: string, data: Record<string, unknown>, options: { full?: boolean; kinds?: never[] | string[] } = {}) =>
  renderMessage({ id: "m", sessionID: "s", seq: 0, type, created: 0, updated: 0, data }, { full: options.full ?? false, mask: NO_MASK, ...(options.kinds ? { kinds: options.kinds as never } : {}) })

beforeEach(() => {
  index = sidecar()
  db = index.db
  source = fakeSource()
  session(db, { id: "ses_r", title: "Reading", messages: 15 })
  titleDoc(db, "ses_r", "Reading")
  for (let seq = 0; seq < 15; seq++) source.add("ses_r", seq % 2 === 0 ? "user" : "assistant", seq % 2 === 0 ? userData(`question ${seq}`) : assistantData([textPart(`answer ${seq}`)]))
})

afterEach(() => index.close())

describe("read windows", () => {
  it("starts at the first message without `at`", async () => {
    const out = await open()
    expect(out.messages.map(message => message.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(out).toMatchObject({ firstSeq: 0, lastSeq: 10, totalMessages: 15, previous: null, next: 11, truncated: false })
    expect(out.session).toMatchObject({ sessionID: "ses_r", title: "Reading" })
    expect(out.messages[0]).toEqual({ seq: 0, messageID: "msg_ses_r_0", type: "user", time: out.messages[0]!.time, text: "question 0", cite: "(ses_r #0)" })
    expect(out.messages.every(message => message.cite === `(ses_r #${message.seq})`)).toBe(true)
  })

  it("centres on a seq with before and after", async () => {
    const out = await open({ at: 7, before: 2, after: 1 })
    expect(out.messages.map(message => message.seq)).toEqual([5, 6, 7, 8])
    expect(out).toMatchObject({ previous: 4, next: 9 })
    expect(await seqs({ at: 14, before: 1 })).toEqual([13, 14])
    expect((await open({ at: 14 })).next).toBeNull()
    expect(await seqs({ at: "3", before: 0, after: 0 })).toEqual([3])
  })

  it("centres on a message ID", async () => {
    expect(await seqs({ at: "msg_ses_r_9", before: 1, after: 1 })).toEqual([8, 9, 10])
  })

  it("never shows the title doc, which only the index has at seq -1", async () => {
    expect(await seqs({ at: 0, before: 5, after: 0 })).toEqual([0])
  })

  it("reports missing sessions and messages by reason", async () => {
    await expect(read(db, source, { sessionID: "ses_nope" }, NO_MASK)).rejects.toMatchObject({ name: "HistoryError", code: "SESSION_NOT_FOUND" })
    await expect(open({ at: "msg_missing" })).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" })
    await expect(open({ at: 99 })).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" })
  })

  it("returns an empty window for a session without messages", async () => {
    session(db, { id: "ses_empty" })
    expect(await read(db, source, { sessionID: "ses_empty" }, NO_MASK)).toMatchObject({ messages: [], previous: null, next: null, truncated: false })
  })

  it("finds the next message across a seq gap", async () => {
    session(db, { id: "ses_gap" })
    for (const seq of [0, 1, 2, 6, 7]) source.add("ses_gap", "user", userData(`m${seq}`), { seq })
    const out = await read(db, source, { sessionID: "ses_gap", at: 1, before: 1, after: 2 }, NO_MASK)
    expect(out.messages.map(message => message.seq)).toEqual([0, 1, 2])
    expect(out).toMatchObject({ previous: null, next: 6 })
  })

  it("stops before the message that would pass maxChars, so the next page starts with it", async () => {
    session(db, { id: "ses_big" })
    for (let seq = 0; seq < 4; seq++) source.add("ses_big", "user", userData(String(seq).repeat(450)))
    const out = await read(db, source, { sessionID: "ses_big", maxChars: 1000 }, NO_MASK)
    expect(out.messages.map(message => message.seq)).toEqual([0, 1])
    expect(out).toMatchObject({ lastSeq: 1, next: 2, truncated: true })
  })

  it("trims the messages before `at` first, earliest first, so `at` is shown whole", async () => {
    session(db, { id: "ses_at" })
    for (let seq = 0; seq < 12; seq++) source.add("ses_at", "user", userData(String(seq % 10).repeat(450)))
    const read_ = (input: Partial<ReadInput>) => read(db, source, { sessionID: "ses_at", maxChars: 1000, ...input }, NO_MASK)
    const out = await read_({ at: 7, before: 3, after: 4 })
    expect(out.messages.map(message => message.seq)).toEqual([6, 7])
    expect(out.messages.every(message => message.text.length === 450)).toBe(true)
    expect(out).toMatchObject({ firstSeq: 6, lastSeq: 7, previous: 5, next: 8, truncated: true })
    // With room for all of them, nothing before `at` is dropped.
    expect((await read_({ at: 7, before: 3, after: 4, maxChars: 5000 })).messages.map(message => message.seq)).toEqual([4, 5, 6, 7, 8, 9, 10, 11])
    expect(await read_({ at: 7, before: 3, after: 4, maxChars: 5000 })).toMatchObject({ previous: 3, truncated: false })
  })

  it("cuts an `at` message longer than maxChars after dropping the messages before it", async () => {
    session(db, { id: "ses_bigat" })
    source.add("ses_bigat", "user", userData("before"))
    source.add("ses_bigat", "user", userData("y".repeat(3000)))
    source.add("ses_bigat", "user", userData("after"))
    const out = await read(db, source, { sessionID: "ses_bigat", at: 1, maxChars: 1000 }, NO_MASK)
    expect(out.messages.map(message => [message.seq, message.text.length])).toEqual([[1, 1000]])
    expect(out).toMatchObject({ previous: 0, next: 2, truncated: true })
  })

  it("cuts a first message longer than maxChars", async () => {
    session(db, { id: "ses_huge" })
    source.add("ses_huge", "user", userData("x".repeat(5000)))
    source.add("ses_huge", "user", userData("after"))
    const out = await read(db, source, { sessionID: "ses_huge", maxChars: 1000 }, NO_MASK)
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0]!.text).toHaveLength(1000)
    expect(out).toMatchObject({ truncated: true, next: 1 })
  })

  it("defaults and clamps before, after and maxChars to the tool's BOUNDS", async () => {
    const { before, after, maxChars } = BOUNDS.read
    expect(await seqs({ at: 7 })).toEqual(Array.from({ length: before.default + 1 + Math.min(after.default, 7) }, (_, i) => 7 - before.default + i))
    session(db, { id: "ses_many" })
    for (let seq = 0; seq < before.max + after.max + 10; seq++) source.add("ses_many", "user", userData("m"))
    const wide = await read(db, source, { sessionID: "ses_many", at: before.max + 5, before: 10_000, after: 10_000 }, NO_MASK)
    expect(wide).toMatchObject({ firstSeq: 5, lastSeq: before.max + 5 + after.max })
    session(db, { id: "ses_long" })
    source.add("ses_long", "user", userData("y".repeat(maxChars.min * 3)))
    expect((await read(db, source, { sessionID: "ses_long", maxChars: 1 }, NO_MASK)).messages[0]!.text).toHaveLength(maxChars.min)
  })

  it("masks what the source returns", async () => {
    session(db, { id: "ses_secret" })
    source.add("ses_secret", "user", userData("my key is sk-123456"))
    source.add("ses_secret", "assistant", assistantData([toolPart("bash", { command: "export KEY=sk-999999" }, { output: "set sk-999999" })]))
    const out = await read(db, source, { sessionID: "ses_secret" }, text => text.replace(/sk-\d+/g, "[masked]"))
    expect(out.messages.map(message => message.text).join("\n")).not.toMatch(/sk-\d/)
    expect(out.messages[1]!.text).toBe("▸ bash: export KEY=[masked]\n  set [masked]")
  })

  it("shows only the asked kinds, still covering hidden messages", async () => {
    session(db, { id: "ses_kinds" })
    source.add("ses_kinds", "user", userData("please run tests"))
    source.add("ses_kinds", "assistant", assistantData([textPart("running"), toolPart("bash", { command: "npm test" }, { output: "ok" })]))
    source.add("ses_kinds", "user", userData("thanks"))
    const out = await read(db, source, { sessionID: "ses_kinds", kinds: ["tool_call"] }, NO_MASK)
    expect(out.messages).toMatchObject([{ seq: 1, text: "▸ bash: npm test" }])
    expect(out).toMatchObject({ firstSeq: 0, lastSeq: 2 })
  })

  describe("a kinds filter that leaves the window empty", () => {
    /** 40 messages: user questions at 3, 4 and 35 to 37, a reasoning part at 20, and assistant replies in between. */
    beforeEach(() => {
      session(db, { id: "ses_wide", messages: 40 })
      for (let seq = 0; seq < 40; seq++) {
        if (seq === 3 || seq === 4 || (seq >= 35 && seq <= 37)) source.add("ses_wide", "user", userData(`question ${seq}`))
        else source.add("ses_wide", "assistant", assistantData([...seq === 20 ? [reasoningPart("thinking 20")] : [], textPart(`answer ${seq}`)]))
      }
    })
    const wide = (input: Partial<ReadInput>) => read(db, source, { sessionID: "ses_wide", kinds: ["user"], ...input }, NO_MASK)

    it("widens both ways to the nearest messages with them, up to before and after, and says which window it widened", async () => {
      const out = await wide({ at: 20, before: 2, after: 2 })
      expect(out.messages.map(message => message.seq)).toEqual([3, 4, 35, 36])
      expect(out).toMatchObject({ widened: { from: 18, to: 22 }, firstSeq: 3, lastSeq: 36, previous: 2, next: 37, truncated: false })
      expect((await wide({ at: 20, before: 1, after: 10 })).messages.map(message => message.seq)).toEqual([4, 35, 36, 37])
      expect(await wide({ at: 20, before: 1, after: 10 })).toMatchObject({ previous: 3, next: null })
    })

    it("does not widen a window that has them, or a read without kinds", async () => {
      expect(await wide({ at: 4, before: 0, after: 1 })).toMatchObject({ widened: null, messages: [{ seq: 4 }] })
      expect(await read(db, source, { sessionID: "ses_wide", at: 20, before: 0, after: 0 }, NO_MASK)).toMatchObject({ widened: null, messages: [{ seq: 20, text: "answer 20" }] })
    })

    it("keeps to the direction a count allows, and looks the other way only when that finds none", async () => {
      // The paging calls: Later reads with before 0, Earlier with after 0.
      expect((await wide({ at: 10, before: 0, after: 3 })).messages.map(message => message.seq)).toEqual([35, 36, 37])
      expect(await wide({ at: 10, before: 0, after: 3 })).toMatchObject({ widened: { from: 10, to: 13 }, previous: 9 })
      expect((await wide({ at: 30, before: 5, after: 0 })).messages.map(message => message.seq)).toEqual([3, 4])
      expect((await wide({ at: 38, before: 0, after: 5 })).messages.map(message => message.seq)).toEqual([37])
      // Without `at` the window starts at the first message, so only later messages count.
      session(db, { id: "ses_late" })
      for (let seq = 0; seq < 30; seq++) source.add("ses_late", seq === 25 ? "user" : "assistant", seq === 25 ? userData("late question") : assistantData([textPart(`a ${seq}`)]))
      expect(await read(db, source, { sessionID: "ses_late", kinds: ["user"], after: 5 }, NO_MASK)).toMatchObject({ widened: { from: 0, to: 5 }, messages: [{ seq: 25 }], previous: null })
    })

    it("pages across the whole session to find them, and keeps the nearest when maxChars is short", async () => {
      session(db, { id: "ses_long" })
      for (let seq = 0; seq < 450; seq++) {
        if (seq === 2 || seq === 3) source.add("ses_long", "user", userData(String(seq).repeat(300)))
        else if (seq === 440) source.add("ses_long", "user", userData("late question"))
        else source.add("ses_long", "assistant", assistantData([textPart("filler")]))
      }
      const long = (input: Partial<ReadInput>) => read(db, source, { sessionID: "ses_long", kinds: ["user"], at: 220, ...input }, NO_MASK)
      expect(await long({ before: 2, after: 0, maxChars: 500 })).toMatchObject({ widened: { from: 218, to: 220 }, messages: [{ seq: 3 }], previous: 2, truncated: true })
      expect(await long({ before: 2, after: 0, maxChars: 5000 })).toMatchObject({ messages: [{ seq: 2 }, { seq: 3 }], previous: 1, truncated: false })
      expect(await long({ before: 0, after: 1 })).toMatchObject({ widened: { from: 220, to: 221 }, messages: [{ seq: 440, text: "late question" }], next: 441 })
    })

    it("returns no messages, with the window, when the session has none of those kinds", async () => {
      const out = await wide({ at: 20, kinds: ["tool_result"] })
      expect(out).toMatchObject({ messages: [], widened: { from: 18, to: 30 }, firstSeq: 18, lastSeq: 30, previous: null, next: null })
      expect(await wide({ kinds: ["reasoning"], at: 0, before: 0, after: 0 })).toMatchObject({ widened: { from: 0, to: 0 }, messages: [{ seq: 20, text: "(thinking) thinking 20" }] })
    })
  })

  it("shows the user's shell commands as tool calls, masked", async () => {
    session(db, { id: "ses_shell" })
    source.add("ses_shell", "user", userData("check the tests"))
    source.add("ses_shell", "shell", { command: "TOKEN=sk-123456 npm test", status: "exited", exit: 0, output: { output: "ok sk-123456", cursor: 0, size: 14, truncated: false } })
    const mask = (text: string) => text.replace(/sk-\d+/g, "[masked]")
    expect((await read(db, source, { sessionID: "ses_shell", kinds: ["tool_call"] }, mask)).messages).toMatchObject([{ seq: 1, type: "shell", text: "▸ shell: TOKEN=[masked] npm test" }])
    expect((await read(db, source, { sessionID: "ses_shell" }, mask)).messages[1]!.text).toBe("▸ shell: TOKEN=[masked] npm test\n  ok [masked]")
  })
})

describe("renderMessage", () => {
  it("renders user text with attached file names", () => {
    expect(render("user", userData("look at this", { files: [{ name: "log.txt" }, { mime: "image/png" }] }))).toBe("look at this\n[file: log.txt]")
  })

  it("puts each tool call on one line with its output indented and cut", () => {
    const output = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")
    const text = render("assistant", assistantData([textPart("Running the tests."), toolPart("bash", { command: "npm test\n  --force", description: "Run tests" }, { output })]))
    const [prose, call, ...rest] = text.split("\n")
    expect(prose).toBe("Running the tests.")
    expect(call).toBe("▸ bash: npm test --force")
    expect(rest.join("\n")).toMatch(/^ {2}line 0\n/)
    expect(text).toMatch(/…\[\d+ chars cut; full: true shows them\]…/)
    // The cut keeps about head + tail characters; indenting each kept line adds two more per line.
    expect(text.length).toBeLessThan(1.5 * (OUTPUT_HEAD + OUTPUT_TAIL))
    const whole = render("assistant", assistantData([toolPart("bash", { command: "npm test" }, { output })]), { full: true })
    expect(whole).not.toContain("chars cut")
    expect(whole).toContain("line 199")
  })

  it("summarises common tools and shows the edit, the error and unfinished states", () => {
    expect(render("assistant", assistantData([toolPart("read", { filePath: "/a/b.ts" }, { output: "1: x" })]))).toBe("▸ read: /a/b.ts\n  1: x")
    expect(render("assistant", assistantData([toolPart("grep", { pattern: "TODO", path: "src" })]))).toBe("▸ grep: TODO in src")
    expect(render("assistant", assistantData([toolPart("edit", { filePath: "/a.ts", oldString: "a", newString: "b" }, { output: "Edit applied" })]))).toBe(
      "▸ edit: /a.ts\n  replace:\n  a\n  with:\n  b\n  Edit applied",
    )
    expect(render("assistant", assistantData([toolPart("task", { description: "Find callers", subagent_type: "explore", prompt: "Look" })]))).toBe("▸ task: @explore Find callers\n  Look")
    expect(render("assistant", assistantData([toolPart("bash", { command: "false" }, { error: "exit 1" })]))).toBe("▸ bash: false (error)\n  error: exit 1")
    expect(render("assistant", assistantData([toolPart("bash", { command: "sleep 9" }, { status: "running" })]))).toBe("▸ bash: sleep 9 (running)")
    expect(render("assistant", assistantData([toolPart("custom_mcp", { q: 1 })]))).toBe('▸ custom_mcp: {"q":1}')
    const long = render("assistant", assistantData([toolPart("bash", { command: "x".repeat(1000) })]))
    expect(long.length).toBeLessThanOrEqual(310)
  })

  it("draws each known tool by what it did, and falls back to its input as JSON", () => {
    const call = (name: string, input: Record<string, unknown>) => render("assistant", assistantData([toolPart(name, input)]))
    expect(call("shell", { command: "ls -la" })).toBe("▸ shell: ls -la")
    expect(call("write", { filePath: "/a/new.ts", content: "export {}" })).toBe("▸ write: /a/new.ts\n  export {}")
    expect(call("list", { path: "/a" })).toBe("▸ list: /a")
    expect(call("read", { offset: 3 })).toBe('▸ read: {"offset":3}')
    expect(call("glob", { pattern: "**/*.ts" })).toBe("▸ glob: **/*.ts")
    expect(call("grep", {})).toBe("▸ grep: {}")
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** End Patch"
    expect(call("apply_patch", { patchText: patch })).toBe(`▸ apply_patch: src/a.ts, src/b.ts\n${patch.replace(/^/gm, "  ")}`)
    expect(call("apply_patch", { patchText: "no headers" })).toBe('▸ apply_patch: {"patchText":"no headers"}\n  no headers')
    expect(call("subagent", { agent: "general", description: "Port it", prompt: "Port the parser" })).toBe("▸ subagent: @general Port it\n  Port the parser")
    expect(call("task", {})).toBe("▸ task: {}")
    expect(call("webfetch", { url: "https://example.com/doc" })).toBe("▸ webfetch: https://example.com/doc")
    expect(call("websearch", { query: "sqlite fts5 trigram" })).toBe("▸ websearch: sqlite fts5 trigram")
    expect(call("webfetch", {})).toBe("▸ webfetch: {}")
    expect(call("edit", { filePath: "/a.ts" })).toBe("▸ edit: /a.ts")
  })

  it("renders a shell message like a shell call: the command, its state, and its output cut to head and tail", () => {
    const output = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")
    const shell = (over: Record<string, unknown> = {}) => ({ shellID: "sh_1", command: "npm   test", status: "exited", exit: 0, output: { output, cursor: 0, size: output.length, truncated: false }, ...over })
    const text = render("shell", shell())
    expect(text.split("\n")[0]).toBe("▸ shell: npm test")
    expect(text).toMatch(/^ {2}line 0$/m)
    expect(text).toMatch(/…\[\d+ chars cut; full: true shows them\]…/)
    expect(render("shell", shell(), { full: true })).toContain("line 199")
    expect(render("shell", shell({ exit: 2, output: undefined }))).toBe("▸ shell: npm test (exit 2)")
    expect(render("shell", shell({ status: "timeout", exit: undefined, output: undefined }))).toBe("▸ shell: npm test (timeout)")
    expect(render("shell", shell(), { kinds: ["tool_call"] })).toBe("▸ shell: npm test")
    expect(render("shell", shell(), { kinds: ["user"] })).toBe("")
  })

  it("hides reasoning unless full or asked for", () => {
    const data = assistantData([reasoningPart("let me think"), textPart("done")])
    expect(render("assistant", data)).toBe("done")
    expect(render("assistant", data, { full: true })).toBe("(thinking) let me think\ndone")
    expect(render("assistant", data, { kinds: ["reasoning"] })).toBe("(thinking) let me think")
  })

  it("renders compaction summaries, synthetic text, outcomes and unknown types", () => {
    expect(render("compaction", { summary: "We fixed auth.", status: "completed" })).toBe("We fixed auth.")
    expect(render("compaction", { summary: "partial", status: "failed" })).toBe("(failed) partial")
    expect(render("synthetic", { text: "context note" })).toBe("context note")
    expect(render("idle", { outcome: "succeeded" })).toBe("outcome: succeeded")
    expect(render("idle", { outcome: "succeeded" }, { kinds: ["user"] })).toBe("")
    expect(render("future", { a: 1 })).toBe('{"a":1}')
  })
})
