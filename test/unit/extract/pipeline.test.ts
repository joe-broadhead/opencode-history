import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_EXTRACT } from "../../../src/domain/contract.js"
import { extractMessage, titleDoc } from "../../../src/extract/index.js"
import { openOpencodeSource } from "../../../src/source/opencode-db.js"
import { assistantData, compactionData, createOpencodeDb, idleData, textPart, toolPart, userData, type OpencodeDbFixture } from "../../fixtures/opencode-db.js"

let fixture: OpencodeDbFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

describe("database source to extraction", () => {
  it("extracts a whole session read from the fixture", async () => {
    fixture = createOpencodeDb()
    fixture.insertSession({ id: "ses_main", directory: "/work/app", title: "Date parsing" })
    fixture.insertMessage({ sessionID: "ses_main", type: "user", data: userData("Fix parseDate in utils") })
    fixture.insertMessage({
      sessionID: "ses_main",
      type: "assistant",
      data: assistantData([
        toolPart("read", { filePath: "src/utils.ts" }, { output: "export function parseDate() {}" }),
        toolPart("edit", { filePath: "src/utils.ts", oldString: "{}", newString: "{ return new Date() }" }),
        toolPart("task", { description: "Check callers", prompt: "Find parseDate callers", subagent_type: "explore" }, { metadata: { sessionId: "ses_child" } }),
        textPart("Fixed parseDate."),
      ]),
    })
    fixture.insertMessage({ sessionID: "ses_main", type: "compaction", seq: 4, data: compactionData("parseDate fixed") })
    fixture.insertMessage({ sessionID: "ses_main", type: "idle", data: idleData("succeeded") })

    const source = openOpencodeSource(fixture.path)
    try {
      const [session] = await source.changedSessions(0, 10)
      if (!session) throw new Error("no session")
      const messages = await source.messages(session.id, 0, 100)
      const results = messages.map(message => extractMessage(message, session, DEFAULT_EXTRACT))

      expect(titleDoc(session)?.text).toBe("Date parsing")
      expect(messages.map(m => m.seq)).toEqual([0, 1, 4, 5])
      expect(results.flatMap(r => r.docs).map(d => [d.seq, d.kind, d.tool])).toEqual([
        [0, "user", null],
        [1, "tool_call", "read"],
        [1, "tool_call", "edit"],
        [1, "tool_call", "task"],
        [1, "assistant", null],
        [4, "summary", null],
      ])
      expect(results.flatMap(r => r.files).map(f => [f.op, f.path])).toEqual([
        ["read", "/work/app/src/utils.ts"],
        ["edit", "/work/app/src/utils.ts"],
      ])
      expect(results.flatMap(r => r.links)).toEqual([
        { parentID: "ses_main", childID: "ses_child", messageID: "msg_ses_main_1", description: "Check callers", agent: "explore" },
      ])
      const sum = (key: "messages" | "userMessages" | "compactions" | "toolCalls") => results.reduce((total, r) => total + (r.facts[key] ?? 0), 0)
      expect([sum("messages"), sum("userMessages"), sum("compactions"), sum("toolCalls")]).toEqual([4, 1, 1, 3])
      expect(results.map(r => r.facts.firstPrompt).find(Boolean)).toBe("Fix parseDate in utils")
      expect(results.map(r => r.facts.lastReply).filter(Boolean).at(-1)).toBe("Fixed parseDate.")
      expect(results.map(r => r.facts.outcome).filter(Boolean).at(-1)).toBe("succeeded")
    } finally {
      source.close()
    }
  })
})
