import { describe, expect, it } from "vitest"
import { DEFAULT_EXTRACT, type ExtractOptions, type SourceMessage, type SourceSession } from "../../../src/domain/contract.js"
import { DEFAULT_MASK, extractMessage, maskText, titleDoc } from "../../../src/extract/index.js"
import { assistantData, compactionData, idleData, reasoningPart, shellData, syntheticData, textPart, toolPart, userData } from "../../fixtures/opencode-db.js"

const session: SourceSession = {
  id: "ses_main",
  parentID: null,
  projectID: "proj_app",
  directory: "/work/app",
  title: "Fix the parser",
  agent: "build",
  model: "anthropic/claude-sonnet-5-5",
  cost: 0,
  tokensInput: 0,
  tokensOutput: 0,
  created: 1000,
  updated: 2000,
  archived: null,
}

function message(type: string, data: Record<string, unknown>, seq = 3): SourceMessage {
  return { id: `msg_${seq}`, sessionID: session.id, seq, type, created: 5000, updated: 5000, data }
}

const extract = (type: string, data: Record<string, unknown>, options: Partial<ExtractOptions> = {}) =>
  extractMessage(message(type, data), session, { ...DEFAULT_EXTRACT, ...options })

const tool = (part: Record<string, unknown>, options: Partial<ExtractOptions> = {}) => extract("assistant", assistantData([part]), options)

describe("maskText", () => {
  it("replaces every match, with or without the g flag", () => {
    expect(maskText("key sk-123 and sk-456", [/sk-\d+/])).toBe("key [masked] and [masked]")
    expect(maskText("key sk-123 and sk-456", [/sk-\d+/g])).toBe("key [masked] and [masked]")
  })

  it("applies patterns in order and keeps flags", () => {
    expect(maskText("Token ABC, token def", [/token \w+/i, /def/])).toBe("[masked], [masked]")
  })

  it("ignores empty matches and leaves text alone without patterns", () => {
    expect(maskText("abc", [/x*/])).toBe("abc")
    expect(maskText("abc", [])).toBe("abc")
  })

  it("does not leave state on a global pattern", () => {
    const pattern = /secret/g
    expect(maskText("secret", [pattern])).toBe("[masked]")
    expect(maskText("secret", [pattern])).toBe("[masked]")
  })

  it("leaves a named group `keep` in place", () => {
    expect(maskText("pass=abc pass=def", [/(?<keep>pass=)\w+/g])).toBe("pass=[masked] pass=[masked]")
    expect(maskText("id: 7", [/(?<other>id: )\d/g])).toBe("[masked]")
  })
})

describe("built-in masks", () => {
  // Credential-shaped values, built here so no key-like literal is in the repository.
  const run = (length: number, alphabet = "aB3dE5gH7jK9mN1pQ") => Array.from({ length }, (_, i) => alphabet[i % alphabet.length]).join("")
  const mask = (text: string) => maskText(text, DEFAULT_MASK)

  it("masks common API key and token formats by their prefixes", () => {
    const keys = [
      `sk-${run(40)}`, `sk-proj-${run(48)}`, `sk-ant-api03-${run(60)}`, `xai-${run(40)}`, `tvly-dev-${run(32)}`, `gsk_${run(40)}`, `lin_api_${run(40)}`,
      `ghp_${run(36)}`, `gho_${run(36)}`, `github_pat_${run(22)}_${run(59)}`, `glpat-${run(20)}`, `npm_${run(36)}`, `hf_${run(34)}`,
      `xoxb-${run(12, "0123456789")}-${run(24)}`, `sk_live_${run(24)}`, `rk_test_${run(24)}`, `AIza${run(35)}`, `AKIA${run(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`,
      `eyJ${run(20)}.eyJ${run(30)}.${run(43)}`,
    ]
    for (const key of keys) expect(mask(`use ${key} here`), key.slice(0, 8)).toBe("use [masked] here")
  })

  it("masks private key blocks and header credentials, keeping the header", () => {
    expect(mask(`a\n-----BEGIN OPENSSH PRIVATE KEY-----\n${run(64)}\n${run(64)}\n-----END OPENSSH PRIVATE KEY-----\nb`)).toBe("a\n[masked]\nb")
    expect(mask(`curl -H "Authorization: Bearer ${run(32)}" x`)).toBe('curl -H "Authorization: Bearer [masked]" x')
    expect(mask(`authorization: basic ${run(24)}`)).toBe("authorization: basic [masked]")
  })

  it("masks password, secret, token and API key values, keeping the name", () => {
    expect(mask("export DB_PASSWORD=hunter2 && run")).toBe("export DB_PASSWORD=[masked] && run")
    expect(mask("mysql --password=hunter2")).toBe("mysql --password=[masked]")
    expect(mask("GET /cb?state=x&token=abc123&next=1")).toBe("GET /cb?state=x&token=[masked]&next=1")
    expect(mask(`{"apiKey": "${run(12)}", "name": "x"}`)).toBe('{"apiKey": "[masked]", "name": "x"}')
    expect(mask("password: 'hunter2'")).toBe("password: '[masked]'")
    expect(mask("CLIENT_SECRET = \"abc-def\"")).toBe('CLIENT_SECRET = "[masked]"')
  })

  it("leaves ordinary code and prose alone", () => {
    for (const text of [
      "password: string", "const token = await getToken()", "max_tokens=1000", "tokenizer=porter", '"tokens": "12"', "if (token === other) return",
      "Bearer tokens are short-lived", "task-runner-implementation-details-here", "sk-short", 'type="password"', "password==expected", "AKIAshort",
      `${"a".repeat(30)}`,
    ]) expect(mask(text), text).toBe(text)
  })

  it("stays fast on long and repetitive text", () => {
    const started = performance.now()
    for (const text of ["a_".repeat(200_000), "password".repeat(50_000), `"password": "`.repeat(30_000), "-----BEGIN RSA PRIVATE KEY-----\n" + "x".repeat(400_000), "Bearer ".repeat(50_000)]) mask(text)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe("titleDoc", () => {
  it("makes a title doc", () => {
    expect(titleDoc(session)).toEqual({ sessionID: "ses_main", messageID: "", seq: -1, part: 0, time: 1000, kind: "title", tool: null, text: "Fix the parser" })
  })

  it("returns null for an empty title", () => {
    expect(titleDoc({ ...session, title: "" })).toBeNull()
    expect(titleDoc({ ...session, title: "   " })).toBeNull()
  })

  it("masks and caps the title", () => {
    expect(titleDoc({ ...session, title: "use sk-123 now" }, { redact: [/sk-\d+/], maxDocChars: 100 })?.text).toBe("use [masked] now")
    expect(titleDoc(session, { redact: [], maxDocChars: 5 })?.text).toBe("Fix …")
  })
})

describe("extractMessage user", () => {
  it("makes a user doc and the first prompt", () => {
    const result = extract("user", userData("  How do I parse dates?  ", { files: [{ name: "log.txt", mime: "text/plain", data: "aGk=" }, { mime: "image/png" }] }))
    expect(result.docs).toEqual([
      { sessionID: "ses_main", messageID: "msg_3", seq: 3, part: 0, time: 5000, kind: "user", tool: null, text: "How do I parse dates?\n[file: log.txt]" },
    ])
    expect(result.facts).toEqual({ messages: 1, userMessages: 1, compactions: 0, toolCalls: 0, firstPrompt: "How do I parse dates?" })
    expect(result.files).toEqual([])
    expect(result.links).toEqual([])
  })

  it("caps the first prompt at 500 characters and docs at maxDocChars", () => {
    const result = extract("user", userData("x".repeat(2000)), { maxDocChars: 1000 })
    expect(result.facts.firstPrompt).toHaveLength(500)
    expect(result.facts.firstPrompt?.endsWith("…")).toBe(true)
    expect(result.docs[0]?.text).toHaveLength(1000)
  })

  it("skips empty prompts", () => {
    const result = extract("user", userData("   "))
    expect(result.docs).toEqual([])
    expect(result.facts.firstPrompt).toBeUndefined()
    expect(result.facts.userMessages).toBe(1)
  })
})

describe("extractMessage assistant", () => {
  const data = assistantData([reasoningPart("thinking hard"), textPart("First part."), toolPart("glob", { pattern: "*.ts" }), textPart("Final answer.")])

  it("makes assistant docs with parts counted from 1 and keeps the last reply", () => {
    const result = extract("assistant", data, { toolResults: false })
    expect(result.docs.map(d => [d.part, d.kind, d.tool, d.text])).toEqual([
      [2, "assistant", null, "First part."],
      [3, "tool_call", "glob", "glob: *.ts"],
      [4, "assistant", null, "Final answer."],
    ])
    expect(result.facts).toEqual({ messages: 1, userMessages: 0, compactions: 0, toolCalls: 1, lastReply: "Final answer." })
  })

  it("includes reasoning only when asked", () => {
    const result = extract("assistant", data, { reasoning: true, toolResults: false })
    expect(result.docs[0]).toMatchObject({ part: 1, kind: "reasoning", text: "thinking hard" })
  })

  it("caps the last reply at 1000 characters", () => {
    const result = extract("assistant", assistantData([textPart("y".repeat(5000))]))
    expect(result.facts.lastReply).toHaveLength(1000)
  })

  it("has no last reply without text", () => {
    expect(extract("assistant", assistantData([textPart("  ")])).facts.lastReply).toBeUndefined()
  })
})

describe("tool_call docs", () => {
  const call = (name: string, input: Record<string, unknown>, options: Partial<ExtractOptions> = {}) =>
    tool(toolPart(name, input), { toolResults: false, ...options }).docs.find(d => d.kind === "tool_call")?.text

  it("summarises known tools", () => {
    expect(call("bash", { command: "npm test", description: "Run tests" })).toBe("bash: npm test\nRun tests")
    expect(call("bash", { command: "ls" })).toBe("bash: ls")
    expect(call("edit", { filePath: "/work/app/a.ts", oldString: "old", newString: "new code" })).toBe("edit: /work/app/a.ts\nnew code")
    expect(call("edit", { path: "b.ts", oldString: "old", newString: "new" })).toBe("edit: b.ts\nnew")
    expect(call("write", { filePath: "/work/app/c.ts", content: "export {}" })).toBe("write: /work/app/c.ts\nexport {}")
    expect(call("apply_patch", { patchText: "*** Begin Patch\n*** Add File: d.ts\n+x\n*** End Patch" })).toBe(
      "apply_patch: *** Begin Patch\n*** Add File: d.ts\n+x\n*** End Patch",
    )
    expect(call("grep", { pattern: "TODO", path: "/work/app/src", include: "*.ts" })).toBe("grep: TODO in /work/app/src")
    expect(call("glob", { pattern: "**/*.md" })).toBe("glob: **/*.md")
    expect(call("task", { description: "Find callers", prompt: "Search for parseDate", subagent_type: "explore" })).toBe("task: Find callers\nSearch for parseDate")
    expect(call("subagent", { description: "Review", prompt: "Check the diff", agent: "review" })).toBe("subagent: Review\nCheck the diff")
    expect(call("webfetch", { url: "https://example.com", format: "markdown" })).toBe("webfetch: https://example.com")
  })

  it("uses compact JSON for other tools and for known tools missing their fields", () => {
    expect(call("read", { filePath: "/work/app/a.ts", limit: 10 })).toBe('read: {"filePath":"/work/app/a.ts","limit":10}')
    expect(call("linear_get_issue", { id: "ENG-1" })).toBe('linear_get_issue: {"id":"ENG-1"}')
    expect(call("bash", {})).toBe("bash: {}")
  })

  it("takes code, commands, queries and prompts as they are, as `field: value` after the JSON of the other fields", () => {
    const code = 'const issue = await tools.linear.get_issue({ id: "ENG-1" })\nreturn issue.title'
    expect(call("execute", { code })).toBe(`execute: code: ${code}`)
    expect(call("execute", { code, timeout: 30 })).toBe(`execute: {"timeout":30}\ncode: ${code}`)
    expect(call("history_sql", { sql: "select title\nfrom v_sessions where title like '%\"x\"%'", limit: 5 })).toBe(
      "history_sql: {\"limit\":5}\nsql: select title\nfrom v_sessions where title like '%\"x\"%'",
    )
    expect(call("mcp_search", { query: "login bug", prompt: "Say \"hi\"", page: 2 })).toBe('mcp_search: {"page":2}\nquery: login bug\nprompt: Say "hi"')
    expect(call("runner", { script: "echo 1\necho 2", command: "sh", patchText: "*** Begin Patch" })).toBe("runner: command: sh\nscript: echo 1\necho 2\npatchText: *** Begin Patch")
    // Only strings with text; anything else stays in the JSON.
    expect(call("execute", { code: 42, query: "  ", prompt: ["a"] })).toBe('execute: {"code":42,"query":"  ","prompt":["a"]}')
  })

  it("matches code from a Code Mode call as a substring, without JSON escapes", () => {
    const text = call("execute", { code: 'const a = "x"\nreturn a' })!
    expect(text).toContain('const a = "x"\nreturn a')
    expect(text).not.toMatch(/\\n|\\"/)
  })

  it("caps tool_call text at maxDocChars", () => {
    const text = call("bash", { command: "z".repeat(500) }, { maxDocChars: 100 })
    expect(text).toHaveLength(100)
    expect(text?.startsWith("bash: zzz")).toBe(true)
  })
})

describe("tool_result docs", () => {
  it("keeps the head and tail of long results", () => {
    const output = `${"a".repeat(30)}${"m".repeat(100)}${"z".repeat(20)}`
    const result = tool(toolPart("bash", { command: "build" }, { output }), { resultHeadChars: 30, resultTailChars: 20 })
    expect(result.docs[1]).toMatchObject({ part: 1, kind: "tool_result", tool: "bash", text: `${"a".repeat(30)}\n…[100 chars omitted]…\n${"z".repeat(20)}` })
  })

  it("joins text content and keeps short results whole", () => {
    const result = tool(toolPart("grep", { pattern: "x" }, { output: ["one", "two"] }))
    expect(result.docs[1]?.text).toBe("one\ntwo")
  })

  it("uses the error message when there is no content", () => {
    const result = tool(toolPart("bash", { command: "false" }, { error: "exit code 1" }))
    expect(result.docs[1]).toMatchObject({ kind: "tool_result", text: "error: exit code 1" })
  })

  it("skips read results, empty results and all results when disabled", () => {
    expect(tool(toolPart("read", { filePath: "/a" }, { output: "file body" })).docs.map(d => d.kind)).toEqual(["tool_call"])
    expect(tool(toolPart("bash", { command: "true" }, { output: "" })).docs.map(d => d.kind)).toEqual(["tool_call"])
    expect(tool(toolPart("bash", { command: "ls" }, { output: "a b" }), { toolResults: false }).docs.map(d => d.kind)).toEqual(["tool_call"])
    expect(tool(toolPart("bash", { command: "sleep" }, { status: "running" })).docs.map(d => d.kind)).toEqual(["tool_call"])
  })

  it("caps the result at maxDocChars as well", () => {
    const result = tool(toolPart("bash", { command: "x" }, { output: "r".repeat(5000) }), { maxDocChars: 100 })
    expect(result.docs[1]?.text).toHaveLength(100)
  })
})

describe("file touches", () => {
  const files = (part: Record<string, unknown>) => tool(part).files.map(f => [f.op, f.path, f.tool])

  it("records read, edit, write and search paths", () => {
    expect(files(toolPart("read", { filePath: "/work/app/a.ts" }))).toEqual([["read", "/work/app/a.ts", "read"]])
    expect(files(toolPart("edit", { filePath: "src/b.ts", oldString: "a", newString: "b" }))).toEqual([["edit", "/work/app/src/b.ts", "edit"]])
    expect(files(toolPart("edit", { path: "../lib/c.ts", oldString: "a", newString: "b" }))).toEqual([["edit", "/work/lib/c.ts", "edit"]])
    expect(files(toolPart("write", { filePath: "/work/app/./d.ts", content: "" }))).toEqual([["write", "/work/app/d.ts", "write"]])
    expect(files(toolPart("grep", { pattern: "x", path: "src" }))).toEqual([["search", "/work/app/src", "grep"]])
    expect(files(toolPart("glob", { pattern: "*.ts", path: "/work/app" }))).toEqual([["search", "/work/app", "glob"]])
    expect(files(toolPart("glob", { pattern: "*.ts" }))).toEqual([])
    expect(files(toolPart("bash", { command: "cat a.ts" }))).toEqual([])
  })

  it("takes apply_patch paths from metadata, then from patch headers", () => {
    const metadata = { files: [{ filePath: "/work/app/a.ts", relativePath: "a.ts", type: "update" }, { filePath: "/work/app/old.ts", movePath: "/work/app/new.ts", type: "move" }] }
    expect(files(toolPart("apply_patch", { patchText: "" }, { metadata }))).toEqual([
      ["patch", "/work/app/a.ts", "apply_patch"],
      ["patch", "/work/app/old.ts", "apply_patch"],
      ["patch", "/work/app/new.ts", "apply_patch"],
    ])
    const patchText = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Delete File: /tmp/b.ts\n*** Add File: c.ts\n+z\n*** End Patch"
    expect(files(toolPart("apply_patch", { patchText }))).toEqual([
      ["patch", "/work/app/src/a.ts", "apply_patch"],
      ["patch", "/tmp/b.ts", "apply_patch"],
      ["patch", "/work/app/c.ts", "apply_patch"],
    ])
  })

  it("records only completed calls, once per path", () => {
    expect(files(toolPart("edit", { filePath: "/a", oldString: "a", newString: "b" }, { error: "no match" }))).toEqual([])
    expect(files(toolPart("read", { filePath: "/a" }, { status: "running" }))).toEqual([])
    const metadata = { files: [{ filePath: "/a" }, { filePath: "/a" }] }
    expect(files(toolPart("apply_patch", { patchText: "" }, { metadata }))).toEqual([["patch", "/a", "apply_patch"]])
  })

  it("carries message position and time", () => {
    expect(tool(toolPart("read", { filePath: "/a" })).files).toEqual([
      { sessionID: "ses_main", messageID: "msg_3", seq: 3, time: 5000, path: "/a", op: "read", tool: "read" },
    ])
  })
})

describe("subagent links", () => {
  it("links task children with description and agent", () => {
    const part = toolPart(
      "task",
      { description: "Find callers", prompt: "...", subagent_type: "explore" },
      { metadata: { sessionId: "ses_child", parentSessionId: "ses_main", model: { modelID: "m", providerID: "p" } } },
    )
    expect(tool(part).links).toEqual([{ parentID: "ses_main", childID: "ses_child", messageID: "msg_3", description: "Find callers", agent: "explore" }])
  })

  it("links subagent children, even when the call failed", () => {
    const part = toolPart("subagent", { description: "Review", prompt: "...", agent: "review" }, { error: "aborted", metadata: { sessionID: "ses_kid" } })
    expect(tool(part).links).toEqual([{ parentID: "ses_main", childID: "ses_kid", messageID: "msg_3", description: "Review", agent: "review" }])
  })

  it("needs a child ID", () => {
    expect(tool(toolPart("task", { description: "x", prompt: "y" })).links).toEqual([])
    expect(tool(toolPart("task", { prompt: "y" }, { metadata: { sessionId: "ses_c" } })).links).toEqual([
      { parentID: "ses_main", childID: "ses_c", messageID: "msg_3", description: null, agent: null },
    ])
  })
})

describe("other message types", () => {
  it("makes summary docs from compactions", () => {
    const result = extract("compaction", compactionData("We fixed the parser."))
    expect(result.docs).toMatchObject([{ part: 0, kind: "summary", tool: null, text: "We fixed the parser." }])
    expect(result.facts.compactions).toBe(1)
    expect(extract("compaction", { ...compactionData(""), status: "failed" }).facts.compactions).toBe(0)
  })

  it("makes synthetic docs", () => {
    expect(extract("synthetic", syntheticData("Background job finished", { description: "notice" })).docs).toMatchObject([{ kind: "synthetic", text: "Background job finished" }])
  })

  it("takes the outcome from idle messages", () => {
    const result = extract("idle", idleData("failed"))
    expect(result.docs).toEqual([])
    expect(result.facts).toEqual({ messages: 1, userMessages: 0, compactions: 0, toolCalls: 0, outcome: "failed" })
  })

  it("makes no docs for system and switch messages", () => {
    for (const [type, data] of [
      ["system", { text: "You are an agent", time: { created: 1 } }],
      ["agent-switched", { agent: "plan", time: { created: 1 } }],
      ["model-switched", { model: { id: "m", providerID: "p" }, time: { created: 1 } }],
      ["location-switched", { location: { directory: "/x" }, time: { created: 1 } }],
      ["something-new", { text: "unknown type" }],
    ] as const) {
      const result = extract(type, data)
      expect(result.docs, type).toEqual([])
      expect(result.facts, type).toEqual({ messages: 1, userMessages: 0, compactions: 0, toolCalls: 0 })
    }
  })

  it("survives malformed data", () => {
    expect(extract("assistant", { content: "nope" }).docs).toEqual([])
    expect(extract("assistant", { content: [null, 3, { type: "tool" }] }).docs).toEqual([
      { sessionID: "ses_main", messageID: "msg_3", seq: 3, part: 3, time: 5000, kind: "tool_call", tool: "unknown", text: "unknown: {}" },
    ])
    expect(extract("user", {}).docs).toEqual([])
  })
})

describe("shell messages", () => {
  it("index the user's command as a shell tool_call and its output as a shell tool_result, without counting a tool call", () => {
    const result = extract("shell", shellData("  npm test -- --watch=false ", "  12 passed\n"))
    expect(result.docs).toEqual([
      { sessionID: "ses_main", messageID: "msg_3", seq: 3, part: 0, time: 5000, kind: "tool_call", tool: "shell", text: "shell: npm test -- --watch=false" },
      { sessionID: "ses_main", messageID: "msg_3", seq: 3, part: 0, time: 5000, kind: "tool_result", tool: "shell", text: "12 passed" },
    ])
    expect(result.facts).toEqual({ messages: 1, userMessages: 0, compactions: 0, toolCalls: 0 })
    expect(result.files).toEqual([])
    expect(result.links).toEqual([])
  })

  it("keep the head and tail of long output, and only with toolResults on", () => {
    const output = `${"a".repeat(30)}${"m".repeat(100)}${"z".repeat(20)}`
    expect(extract("shell", shellData("make", output), { resultHeadChars: 30, resultTailChars: 20 }).docs[1]).toMatchObject({
      kind: "tool_result",
      text: `${"a".repeat(30)}\n…[100 chars omitted]…\n${"z".repeat(20)}`,
    })
    expect(extract("shell", shellData("make", output), { toolResults: false }).docs.map(d => d.kind)).toEqual(["tool_call"])
  })

  it("skip an empty command or output, and survive malformed data", () => {
    expect(extract("shell", shellData("sleep 60", undefined, { status: "running", exit: undefined })).docs.map(d => d.kind)).toEqual(["tool_call"])
    expect(extract("shell", shellData("true", "  ")).docs.map(d => d.kind)).toEqual(["tool_call"])
    expect(extract("shell", shellData("   ", "orphan output")).docs.map(d => d.kind)).toEqual(["tool_result"])
    expect(extract("shell", { command: 3, output: "not an object" }).docs).toEqual([])
  })

  it("mask the command and the output before cutting", () => {
    const redact = [/sk-[a-z0-9]+/]
    const output = `${"a".repeat(10)}sk-secretvalue${"b".repeat(50)}`
    const result = extract("shell", shellData("curl -H 'key: sk-abc1' x", output), { redact, resultHeadChars: 15, resultTailChars: 5 })
    expect(result.docs[0]!.text).toBe("shell: curl -H 'key: [masked]' x")
    expect(result.docs[1]!.text).not.toMatch(/sk-|secret/)
  })
})

describe("redaction", () => {
  const redact = [/sk-[a-z0-9]+/]

  it("masks every stored text", () => {
    const user = extract("user", userData("my key is sk-abc123", { files: [{ name: "sk-file1" }] }), { redact })
    expect(user.docs[0]?.text).toBe("my key is [masked]\n[file: [masked]]")
    expect(user.facts.firstPrompt).toBe("my key is [masked]")

    const assistant = extract(
      "assistant",
      assistantData([
        textPart("use sk-zzz9"),
        toolPart("bash", { command: "curl -H sk-q1" }, { output: "ok sk-q2" }),
        toolPart("read", { filePath: "/keys/sk-path1" }),
        toolPart("task", { description: "check sk-d1", prompt: "p" }, { metadata: { sessionId: "ses_c" } }),
      ]),
      { redact },
    )
    const texts = [...assistant.docs.map(d => d.text), ...assistant.files.map(f => f.path), ...assistant.links.map(l => l.description), assistant.facts.lastReply]
    expect(texts.join("\n")).not.toMatch(/sk-/)
    expect(assistant.files[0]?.path).toBe("/keys/[masked]")
    expect(assistant.links[0]?.description).toBe("check [masked]")
    expect(assistant.facts.lastReply).toBe("use [masked]")

    expect(extract("compaction", compactionData("sk-c1 rotated"), { redact }).docs[0]?.text).toBe("[masked] rotated")
    expect(extract("synthetic", syntheticData("sk-s1"), { redact }).docs[0]?.text).toBe("[masked]")
  })

  it("masks before cutting, so a secret across the cut is not half kept", () => {
    const output = `${"a".repeat(10)}sk-secretvalue${"b".repeat(50)}`
    const result = tool(toolPart("bash", { command: "x" }, { output }), { redact, resultHeadChars: 15, resultTailChars: 5 })
    expect(result.docs[1]?.text).not.toMatch(/sk-|secret/)
    expect(result.docs[1]?.text.startsWith(`${"a".repeat(10)}[mas`)).toBe(true)
  })
})
