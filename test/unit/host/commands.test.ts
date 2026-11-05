import { describe, expect, test, vi } from "vitest"
import { FAILURES, HistoryError } from "../../../src/domain/common.js"
import { commandTransform, COMMANDS, reindexMode, type CommandSources } from "../../../src/host/commands.js"
import { HOST_RANGE } from "../../../src/host/compat.js"
import { formatStatus } from "../../../src/host/format.js"
import { buildStatus, type StatusView } from "../../../src/host/status.js"
import { failure, fakeRuntime } from "../../host/runtime.js"
import { INDEX } from "../../host/samples.js"

const VIEW: StatusView = { version: "1.0.0", host: { version: "2.2.3", range: HOST_RANGE, tested: true }, state: "ready", tools: { visible: 9, unknown: [] }, index: INDEX, database: "/d", indexPath: "/i", indexBytes: 1_536_000, masksChanged: false, defaultScope: "project", unguardedAgents: [], nextStep: "Nothing to do." }

function setup(overrides: Partial<CommandSources> = {}) {
  const runtime = fakeRuntime(), posts: Record<string, unknown>[] = []
  const added: { name: string; description?: string; execute(input: object): Promise<void> }[] = []
  commandTransform({ synthetic: (async (input: Record<string, unknown>) => { posts.push(input) }) as never, runtime, status: async () => VIEW, ...overrides })({ add: (c: never) => { added.push(c) } })
  const run = (name: string, text = "") => added.find(c => c.name === name)!.execute({ sessionID: "ses_1", delivery: "steer", prompt: { text } })
  return { runtime, posts, added, run }
}

describe("commands", () => {
  test("/history-status posts the status as a note that does not resume the session", async () => {
    const t = setup()
    expect(t.added.map(c => c.name)).toEqual(["history-status", "history-reindex"])
    expect(COMMANDS).toEqual({ status: "history-status", reindex: "history-reindex" })
    await t.run("history-status")
    expect(t.posts).toEqual([{ sessionID: "ses_1", delivery: "steer", text: formatStatus(VIEW), description: "History status", resume: false, metadata: { source: "history.sessions" } }])
  })

  test("/history-status shows an index file at another schema, with the INDEX_MISMATCH next step", async () => {
    const runtime = fakeRuntime()
    runtime.indexSchema = { file: "1", build: "3" }
    const t = setup({ status: () => buildStatus({ version: "1.0.0", host: VIEW.host, config: { database: "/d", indexPath: "/i", defaultScope: "project" }, runtime, agents: async () => [] }) })
    await t.run("history-status")
    const lines = String(t.posts[0]!.text).split("\n")
    expect(lines.slice(7, 9)).toEqual(["Index file: /i (1.5 MB)", "Index schema: version 1 in the file, but this build uses version 3, so every query fails (INDEX_MISMATCH)"])
    expect(lines.at(-1)).toBe(`Next step: ${FAILURES.INDEX_MISMATCH[1]}`)
    expect(lines[1]).toBe("Connection: failed")
  })

  test("a status that cannot be read is reported, not thrown, and logged without its text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const t = setup({ status: async () => { throw new Error("boom") } })
    await t.run("history-status")
    expect(t.posts[0]!.text).toBe("STATUS_UNAVAILABLE: History status could not be read. Next step: Run /history-status again, or check the OpenCode server log.")
    expect(warn.mock.calls).toEqual([[expect.stringMatching(/^opencode-history: STATUS_UNAVAILABLE in \/history-status: Error(, thrown in .*)?\.$/)]])
    warn.mockRestore()
    const coded = setup({ status: async () => { throw new HistoryError("INDEX_UNAVAILABLE") } })
    await coded.run("history-status")
    expect(coded.posts[0]!.text).toMatch(/^INDEX_UNAVAILABLE: /)
  })

  test("/history-reindex catches up by default, rebuilds when asked, and rejects anything else", async () => {
    const t = setup()
    await t.run("history-reindex")
    await t.run("history-reindex", "  Rebuild ")
    await t.run("history-reindex", "everything")
    expect(t.runtime.reindexed).toEqual(["catch-up", "rebuild"])
    expect(t.posts.map(p => p.text)).toEqual([
      "Index caught up: 42 of 42 sessions.",
      "Index rebuilt: 42 of 42 sessions.",
      "INPUT_INVALID: /history-reindex takes no argument or rebuild. Next step: Run /history-reindex, or /history-reindex rebuild to index everything again.",
    ])
    expect(t.posts.every(p => p.resume === false && p.description === "History reindex")).toBe(true)
    expect([reindexMode(""), reindexMode("catch-up"), reindexMode("REBUILD"), reindexMode("x")]).toEqual(["catch-up", "catch-up", "rebuild", undefined])
  })

  test("a reindex still building, or failing, says so", async () => {
    const t = setup()
    t.runtime.index = { ...INDEX, ready: false, sessionsIndexed: 7 }
    await t.run("history-reindex")
    expect(t.posts[0]!.text).toBe("Index caught up: 7 of 42 sessions, still building.")
    t.runtime.reindex = vi.fn(async () => { throw failure("INDEX_BUSY", "The history index is being rebuilt.", "Retry in a moment.") })
    await t.run("history-reindex", "rebuild")
    expect(t.posts[1]!.text).toBe("INDEX_BUSY: The history index is being rebuilt. Next step: Retry in a moment.")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    t.runtime.reindex = vi.fn(async () => { throw new Error("disk") })
    await t.run("history-reindex")
    expect(t.posts[2]!.text).toMatch(/^INDEX_FAILED: Updating the history index failed\./)
    expect(warn.mock.calls).toEqual([[expect.stringMatching(/^opencode-history: INDEX_FAILED in \/history-reindex: Error(, thrown in .*)?\.$/)]])
    warn.mockRestore()
  })
})
