// One sample output per query method, typed against api.ts. A unit test checks each against its tool output schema.
import type { BriefOutput, FilesOutput, IndexState, ReadOutput, RecallOutput, SearchOutput, SessionSummary, SessionsOutput, SqlOutput } from "../../src/domain/api.js"

export const INDEX: IndexState = { ready: true, sessionsIndexed: 42, sessionsTotal: 42, lagSeconds: 0, source: "opencode-db", complete: true }

const SESSION: SessionSummary = {
  sessionID: "ses_login1",
  title: "Fix login redirect loop",
  directory: "/work/app",
  project: "app",
  created: "2026-10-12T09:30:00.000Z",
  updated: "2026-10-12T11:05:00.000Z",
  agent: "build",
  messages: 48,
  subagents: 1,
  firstPrompt: "The login page keeps redirecting back to itself after OAuth.",
  parentID: null,
}

export const SAMPLES = {
  search: {
    results: [{
      ...SESSION, score: 12.5, matches: 7, queriesMatched: 2, similar: 2,
      snippets: [
        { messageID: "msg_12", seq: 12, kind: "user", tool: null, time: "2026-10-12T09:31:00.000Z", text: "The callback\nredirects forever", sessionID: "ses_login1", cite: "(ses_login1 #12)" },
        { messageID: "msg_30", seq: 30, kind: "tool_result", tool: "bash", time: "2026-10-12T10:02:00.000Z", text: "state mismatch", sessionID: "ses_login1_child", cite: "(ses_login1_child #30)" },
      ],
    }],
    total: 3, relaxed: false, truncated: false, next: "cur_2", hidden: null, index: INDEX,
  },
  sessions: { sessions: [{ ...SESSION, cost: 0.42, outcome: "Fixed: the state cookie was dropped." }], next: null, hidden: null, index: INDEX },
  files: {
    files: [{ path: "/work/app/src/auth/callback.ts", sessions: [{ sessionID: "ses_login1", title: SESSION.title, ops: { read: 2, edit: 3 }, last: "2026-10-12T10:40:00.000Z", firstSeq: 14, seqs: [14, 15, 20], seqsCut: false }] }],
    truncated: false,
    hidden: null,
    index: INDEX,
  },
  read: {
    session: SESSION,
    messages: [
      { seq: 12, messageID: "msg_12", type: "user", time: "2026-10-12T09:31:00.000Z", text: "The callback redirects forever.", cite: "(ses_login1 #12)" },
      { seq: 13, messageID: "msg_13", type: "assistant", time: "2026-10-12T09:32:00.000Z", text: "Checking the state cookie.", cite: "(ses_login1 #13)" },
    ],
    firstSeq: 12, lastSeq: 13, totalMessages: 48, previous: 11, next: 14, truncated: false, widened: null,
  },
  brief: {
    session: { ...SESSION, cost: 0.42, outcome: "Fixed: the state cookie was dropped.", models: ["anthropic/claude-sonnet"] },
    firstPrompt: SESSION.firstPrompt,
    summaries: ["Traced the loop to a SameSite=Strict state cookie."],
    lastReply: "Set SameSite=Lax on the state cookie; the loop is gone.",
    filesEdited: [{ path: "src/auth/callback.ts", edits: 3 }],
    commands: ["npm test -- auth"],
    subagents: [{ sessionID: "ses_login1_child", description: "Find cookie settings", agent: "explore" }],
    todos: [{ content: "Add a regression test", status: "completed" }],
  },
  sql: { columns: ["week", "cost"], rows: [["2026-41", 1.5], ["2026-42", null], ["multi\nline", "x"]], truncated: true, index: INDEX },
  recall: {
    evidence: [{ sessionID: "ses_login1", title: SESSION.title, seq: 40, time: "2026-10-12T10:50:00.000Z", text: "Set SameSite=Lax on the state cookie.", cite: "(ses_login1 #40)" }],
    queries: ["login redirect loop", "state cookie samesite"],
    index: INDEX,
  },
} satisfies {
  search: SearchOutput; sessions: SessionsOutput; files: FilesOutput; read: ReadOutput; brief: BriefOutput; sql: SqlOutput; recall: RecallOutput
}
