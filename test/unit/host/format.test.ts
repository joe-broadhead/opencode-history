import { describe, expect, test } from "vitest"
import { HOST_RANGE } from "../../../src/host/compat.js"
import { formatBrief, formatFiles, formatRead, formatRecall, formatSearch, formatSessions, formatSql, formatStatus, indexNotes, oneLine, size, when } from "../../../src/host/format.js"
import { INDEX, SAMPLES } from "../../host/samples.js"

describe("result text", () => {
  test("search lists ranked sessions with excerpts and points at brief, then read at the first excerpt's seq", () => {
    const text = formatSearch(SAMPLES.search, { query: ["login redirect loop", "state mismatch"], scope: "project" })
    expect(text.split("\n")).toEqual([
      "3 sessions matched \"login redirect loop\" | \"state mismatch\" in scope project; showing 1.",
      "",
      "1. ses_login1 \"Fix login redirect loop\" · updated 2026-10-12 11:05 · /work/app",
      "   2 of 2 phrasings · 7 matches · 48 messages · 1 subagent · agent build · 2 similar",
      "   #12 user: The callback redirects forever",
      "   #30 tool_result (bash) in ses_login1_child: state mismatch",
      "",
      "Similar sessions are in the same directory as the one shown, with a near-identical title or the same first prompt; list those with its title with history_sessions {\"title\":\"Fix login redirect loop\"}.",
      "More: repeat the call with cursor: \"cur_2\".",
      "Next: history_brief {\"sessionID\":\"ses_login1\"} to see what that session did, then history_read {\"sessionID\":\"ses_login1\",\"at\":12} for the exact exchange.",
    ])
  })

  test("an empty or loosened search says how to rephrase; a building index or partial source is flagged", () => {
    const empty = formatSearch({ ...SAMPLES.search, results: [], total: 0, next: null }, { query: "nothing", scope: "all" })
    expect(empty).toMatch(/^No sessions matched "nothing" in scope all\.\nNext: search again with different phrasings/)
    const near = { ...SAMPLES.search.results[0]!, queriesMatched: 0, similar: 0 }
    const relaxed = formatSearch({ ...SAMPLES.search, results: [near], relaxed: true }, { query: ["a", "b"] })
    expect(relaxed).toContain("Sessions marked near match have only some words of a phrasing, so they rank below full matches")
    expect(relaxed).toContain("   near match · 7 matches")
    expect(relaxed).not.toContain("phrasings ·")
    expect(relaxed).not.toContain("similar")
    expect(relaxed).not.toContain("approximate")
    expect(formatSearch({ ...SAMPLES.search, truncated: true }, { query: "a" })).toContain("Too many texts matched to rank them all, so the count and order are approximate")
    expect(indexNotes({ ...INDEX, ready: false, sessionsIndexed: 5, source: "context", complete: false })).toEqual([
      "The index is still being built (5 of 42 sessions), so results may be incomplete.",
      "History comes from a partial source that keeps only the messages after each compaction; the user can run /history-status for the fix.",
    ])
    expect(indexNotes({ ...INDEX, complete: false })).toEqual(["The history source is incomplete; the user can run /history-status for the fix."])
    expect(indexNotes(INDEX)).toEqual([])
  })

  test("an empty result says what the default filters left out and which input shows it", () => {
    const hidden = { scope: 1, archived: 3, subagents: 0, current: 1 }
    const search = formatSearch({ ...SAMPLES.search, results: [], total: 0, next: null, hidden }, { query: "quokka" })
    expect(search.split("\n")).toEqual([
      "No sessions matched \"quokka\".",
      "Left out by default: 3 sessions archived (includeArchived: true), 1 session in other projects or folders (scope: \"all\"), 1 session in the current session or its subagents (includeCurrent: true).",
      "Next: repeat the call with includeArchived: true to include them, or search again with different phrasings.",
    ])
    expect(formatSessions({ ...SAMPLES.sessions, sessions: [], hidden: { ...hidden, archived: 0, subagents: 4 } })).toContain(
      "Left out by default: 4 sessions in subagent sessions (includeSubagents: true), 1 session in other projects or folders (scope: \"all\"), 1 session in the current session or its subagents (includeCurrent: true).\nNext: repeat the call with includeSubagents: true to include them.",
    )
    // The caller's own subagents count under both reasons, and need both inputs.
    expect(formatFiles({ ...SAMPLES.files, files: [], hidden: { scope: 0, archived: 0, subagents: 2, current: 2 } }, { path: "src/x" })).toMatch(
      /\nNext: repeat the call with includeSubagents: true and includeCurrent: true to include them\.$/,
    )
    expect(formatSessions({ ...SAMPLES.sessions, sessions: [], hidden: { scope: 0, archived: 0, subagents: 1, current: 3 } })).toMatch(/\nNext: repeat the call with includeCurrent: true to include them\.$/)
    expect(formatFiles({ ...SAMPLES.files, files: [], hidden: { scope: 2, archived: 0, subagents: 0, current: 0 } }, { path: "src/x" })).toMatch(/\nNext: repeat the call with scope: "all" to include them\.$/)
    const nothing = { scope: 0, archived: 0, subagents: 0, current: 0 }
    expect(formatSearch({ ...SAMPLES.search, results: [], total: 0, next: null, hidden: nothing }, { query: "q" })).not.toContain("Left out")
    expect(formatSessions({ ...SAMPLES.sessions, sessions: [], hidden: null })).toMatch(/^No sessions matched\.\nNext: widen scope/)
  })

  test("read shows each message with its seq and the calls for the previous and next pages", () => {
    const text = formatRead({ ...SAMPLES.read, truncated: true }, { sessionID: "ses_login1" })
    expect(text).toMatch(/^ses_login1 "Fix login redirect loop" · \/work\/app · messages #12-#13 of 48\n\n#12 user · 2026-10-12 09:31\nThe callback redirects forever\.\n\n#13 assistant/)
    expect(text).toContain("Text was trimmed to maxChars.")
    expect(text).toContain("Earlier: history_read {\"sessionID\":\"ses_login1\",\"at\":11,\"before\":10,\"after\":0}")
    expect(text).toContain("Later: history_read {\"sessionID\":\"ses_login1\",\"at\":14,\"before\":0}")
    const last = formatRead({ ...SAMPLES.read, messages: [], previous: null, next: null }, { sessionID: "ses_login1" })
    expect(last).toContain("no messages in that range (48 in total)")
    expect(last).not.toMatch(/Earlier|Later|widened/)
  })

  test("read says when a kinds filter widened the window, and what to do when the session has none of those kinds", () => {
    const widened = formatRead({ ...SAMPLES.read, widened: { from: 20, to: 32 } }, { sessionID: "ses_login1", kinds: ["user"] })
    expect(widened.split("\n").slice(0, 2)).toEqual([
      "ses_login1 \"Fix login redirect loop\" · /work/app · messages #12-#13 of 48",
      "No message in #20-#32 has kind user, so the window widened to the nearest messages that do.",
    ])
    expect(widened).toMatch(/\nLater: history_read \{"sessionID":"ses_login1","at":14,"before":0\}$/)
    const none = formatRead({ ...SAMPLES.read, messages: [], firstSeq: 20, lastSeq: 32, previous: null, next: null, widened: { from: 20, to: 32 } }, { sessionID: "ses_login1", kinds: ["tool_result", "reasoning"] })
    expect(none.split("\n")).toEqual([
      "ses_login1 \"Fix login redirect loop\" · /work/app · no messages of those kinds (48 in total)",
      "No message in this session has kinds tool_result, reasoning.",
      "",
      "Next: history_read {\"sessionID\":\"ses_login1\",\"at\":20} to read without kinds, or repeat the call with other kinds.",
    ])
    expect(formatRead({ ...SAMPLES.read, messages: [], previous: null, next: null, widened: { from: 20, to: 32 } }, { sessionID: "ses_login1" }, { calls: false })).not.toContain("Next:")
  })

  test("brief shows every section it has, and points at read", () => {
    const text = formatBrief(SAMPLES.brief)
    for (const part of [
      "ses_login1 \"Fix login redirect loop\"",
      "/work/app · project app · agent build · anthropic/claude-sonnet",
      "Created 2026-10-12 09:30 · updated 2026-10-12 11:05 · 48 messages · 1 subagent · $0.42",
      "Outcome: Fixed: the state cookie was dropped.",
      "Summaries:\n- Traced the loop",
      "Files edited: src/auth/callback.ts (3)",
      "Commands:\n- npm test -- auth",
      "Subagents:\n- ses_login1_child (explore): Find cookie settings",
      "Todos:\n- [completed] Add a regression test",
      "Next: history_read {\"sessionID\":\"ses_login1\"}",
    ]) expect(text).toContain(part)
    const bare = formatBrief({ ...SAMPLES.brief, summaries: [], commands: [], subagents: [], todos: [], filesEdited: [], lastReply: null })
    expect(bare).not.toMatch(/Summaries|Commands|Subagents|Todos|Files edited|Last reply/)
  })

  test("sessions, files, sql and recall", () => {
    expect(formatSessions(SAMPLES.sessions)).toContain("   48 messages · 1 subagent · agent build · $0.42\n   Asked: The login page")
    expect(formatSessions({ ...SAMPLES.sessions, sessions: [] })).toMatch(/^No sessions matched\./)
    expect(formatFiles(SAMPLES.files, { path: "src/auth" })).toContain("/work/app/src/auth/callback.ts\n  ses_login1 \"Fix login redirect loop\" · last 2026-10-12 10:40 · edit 3, read 2 · first at #14")
    expect(formatFiles(SAMPLES.files, { path: "src/auth" })).toContain("Next: history_read {\"sessionID\":\"ses_login1\",\"at\":14}")
    expect(formatFiles({ ...SAMPLES.files, files: [] }, { path: "src/x", scope: "project" })).toMatch(/^No session touched "src\/x" in scope project\./)
    expect(formatSql(SAMPLES.sql).split("\n")).toEqual(["3 rows; more rows exist, so raise limit or narrow the query.", "week | cost", "2026-41 | 1.5", "2026-42 | null", "multi\\nline | x"])
    expect(formatSql({ ...SAMPLES.sql, index: { ...INDEX, ready: false, sessionsIndexed: 3, sessionsTotal: 9 } }).split("\n")[1]).toBe("The index is still being built (3 of 9 sessions), so results may be incomplete.")
    const recall = formatRecall(SAMPLES.recall, {})
    expect(recall).toMatch(/^Evidence from 1 session:/)
    expect(recall).toContain("Evidence from 1 session:\n[ses_login1 #40 · 2026-10-12 10:50 · \"Fix login redirect loop\"]\nSet SameSite=Lax")
    expect(recall).toContain("Searched for \"login redirect loop\" | \"state cookie samesite\".")
    expect(formatRecall({ ...SAMPLES.recall, evidence: [] }, { scope: "all" })).toMatch(/^No evidence found in scope all\./)
  })

  test("status rows end with exactly one next step", () => {
    const view = { version: "0.1.0", host: { version: "2.3.0", range: HOST_RANGE, tested: false }, state: "ready" as const, tools: { visible: 9, unknown: [] as string[] }, index: { ...INDEX, lagSeconds: 3.4 }, database: "/d/opencode.db", indexPath: "/d/index.db", indexBytes: 535_822_336, masksChanged: false, defaultScope: "project" as const, unguardedAgents: [] as string[], nextStep: "Use 2.2.x." }
    expect(formatStatus(view).split("\n")).toEqual([
      "History status",
      "Connection: connected",
      "Account: none; History needs no sign-in",
      "Access: reads OpenCode's database read-only and writes only its own index; history_pin asks before it changes a session",
      "Index: ready, 42 of 42 sessions, 3 s behind",
      "Source: OpenCode database",
      "Database: /d/opencode.db",
      "Index file: /d/index.db (511 MB)",
      "Default scope: project",
      "Tools: 9 available",
      "Agents without default rules: none",
      "OpenCode: 2.3.0 (untested; supported range >=2.2.3 <2.3.0). History 0.1.0",
      "Next step: Use 2.2.x.",
    ])
    const mismatched = formatStatus({ ...view, mismatch: { file: "1", build: "3" }, nextStep: "Restart." }).split("\n")
    expect(mismatched.slice(7, 9)).toEqual(["Index file: /d/index.db (511 MB)", "Index schema: version 1 in the file, but this build uses version 3, so every query fails (INDEX_MISMATCH)"])
    expect(mismatched.filter(line => line.startsWith("Next step:"))).toEqual(["Next step: Restart."])
    const tested = formatStatus({ ...view, host: { version: "2.2.5", range: HOST_RANGE, tested: true }, state: "ready", indexBytes: null, nextStep: "Nothing to do." }).split("\n")
    expect(tested).toContain("Connection: connected")
    expect(tested).toContain("Index file: /d/index.db")
    expect(tested).toContain("OpenCode: 2.2.5 (tested). History 0.1.0")
    const masks = formatStatus({ ...view, masksChanged: true }).split("\n")
    expect(masks.slice(7, 9)).toEqual(["Index file: /d/index.db (511 MB)", "Masks: changed since text was indexed, so the index file holds that text masked the old way until /history-reindex rebuild"])
  })

  test("sizes read in the largest unit that keeps them at least 1", () => {
    expect([0, 512, 1536, 10 * 1024, 535_822_336, 3 * 1024 ** 3].map(size)).toEqual(["0 B", "512 B", "1.5 KB", "10 KB", "511 MB", "3.0 GB"])
  })

  test("helpers", () => {
    expect(when("2026-10-12T09:30:00.000Z")).toBe("2026-10-12 09:30")
    expect(when("yesterday")).toBe("yesterday")
    expect(oneLine("a\n\n b\tc", 10)).toBe("a b c")
    expect(oneLine("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`)
  })
})
