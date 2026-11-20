// The source contract's conformance kit over the source this plugin declares in package.json's `sources`
// (`history.sessions`), run on the plugin's own tools RPC methods `events_list` and `probe` (`scriptMethods`, the table
// setup registers), over a synthetic index of invented sessions: no OpenCode database, no network. Each method asserts
// its action through the kit's recording permission, as the host's `ctx.permission.assert` would, so the kit sees exactly
// what each read asserts. The report is written to reports/conformance-report.json, for a release to attach.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { declarationProblems, sourceConformance, type ConformanceReport, type PageCase, type SessionContext } from "@we-the-rebel-alliance/source-contract/conformance"
import { encodeBoundCursor, encodeCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import { readInstalledDescriptor } from "@we-the-rebel-alliance/source-contract/descriptor"
import { sessionRules } from "@we-the-rebel-alliance/source-contract/permission"
import { SOURCES_SCHEMA, type Sources } from "@we-the-rebel-alliance/source-contract/schema"
import type { ToolCall } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import type { EventsListOutput, ProbeOutput } from "../../src/domain/api.js"
import { identityOf } from "../../src/host/identity.js"
import type { PermissionRequest } from "../../src/host/permissions.js"
import { pluginError, scriptMethods, TOOLS_RPC_ID, type PluginMethod } from "../../src/host/tools-rpc.js"
import { eventsList, eventsRequest, PACKAGE, probe, SESSIONS_SOURCE } from "../../src/query/events.js"
import { sessions as querySessions } from "../../src/query/sessions.js"
import { fakeSession } from "../host/session.js"
import { DAY, NO_MASK, NOW, project, session, sidecar, STATE } from "./query/fixture.js"

const root = join(import.meta.dirname, "../..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string; sources: unknown; jelly: { tools: { name: string; readOnly: boolean }[] } }
const contract = JSON.parse(readFileSync(join(root, "node_modules/@we-the-rebel-alliance/source-contract/package.json"), "utf8")) as { version: string }
/** The declaration as Memory's schema parses it, which is what the kit takes. */
const checked = SOURCES_SCHEMA.check(pkg.sources)
if (!checked.ok) throw new Error(`the sources declaration is invalid: ${checked.problems.join("; ")}`)
const sources: Sources = checked.value
const tools = pkg.jelly.tools.map(tool => ({ id: tool.name.replace(/^history\./, ""), readOnly: tool.readOnly }))

/** An invented machine and OS user: the account is the machine, the owner the user on it. */
const IDENTITY = identityOf("sam", "studio-mac")
const ACCOUNT = IDENTITY.account
const HOUR = 3_600_000
const SINCE = new Date(NOW - DAY).toISOString()
const ATOMIC = "a page is one query of the local index, and no session is read on its own, so no single session can fail on its own"
const NO_EXPIRY =
  "History keeps every session OpenCode keeps, and OpenCode (2.2.3 to 2.3.0) has no retention: it deletes a session only when the person or their client deletes it, which leaves nothing to list; a cursor is a place in the local index, and a version indexed late is listed after every cursor issued before it, a rebuild keeping each place, so nothing a reader would have listed is lost and History never answers CURSOR_EXPIRED or a gap"

/** Invented sessions: four over the last day, one whose title holds a secret masking did not catch, and two later. */
function index() {
  const s = sidecar()
  project(s.db, "prj_app", "/work/projects/billing-app")
  const at = (hours: number) => NOW - hours * HOUR
  session(s.db, { id: "ses_conf_a", title: "Plan the invoice export", updated: at(20), agent: "build", firstPrompt: "Plan it", lastReply: "Planned." })
  session(s.db, { id: "ses_conf_b", title: "Wifi password: Ku7pLm2QzR9w", updated: at(18), firstPrompt: "Note it", lastReply: "Noted." })
  session(s.db, { id: "ses_conf_c", title: "Fix the rounding test", updated: at(16), agent: "build", firstPrompt: "Fix it", lastReply: "Fixed." })
  session(s.db, { id: "ses_conf_d", title: "Review the export PR", updated: at(14), agent: "plan", firstPrompt: "Review it", lastReply: "Reviewed." })
  return {
    s,
    later() {
      session(s.db, { id: "ses_conf_e", title: "Ship the export", updated: at(6), agent: "build", firstPrompt: "Ship it", lastReply: "Shipped." })
      session(s.db, { id: "ses_conf_f", title: "Write the changelog", updated: at(4), agent: "build", firstPrompt: "Write it", lastReply: "Written." })
      // Changed before the first listing's last session, indexed only after it: listed where it was indexed.
      session(s.db, { id: "ses_conf_g", title: "Tidy the fixtures", updated: at(15), agent: "build", firstPrompt: "Tidy it", lastReply: "Tidied." })
      s.db.run("update sessions set listed = ? where id = 'ses_conf_g'", at(5))
    },
  }
}

const call = (): ToolCall => ({ sessionID: "ses_conformance", agent: "build", messageID: "msg_conformance", id: "call_conformance", signal: new AbortController().signal, progress: async () => {} })

/** The tools RPC methods over the synthetic index, whose asserts reach whichever session the kit is calling with. */
function plugin(db: ReturnType<typeof sidecar>["db"]) {
  let current: SessionContext["permission"] | undefined
  const runtime = {
    eventsList: async (_caller: unknown, input: unknown) => eventsList(db, eventsRequest(input), IDENTITY, STATE, NO_MASK, NOW) as EventsListOutput,
    probe: async (_caller: unknown, input: { source?: string; account?: string }) => probe(input, IDENTITY) as ProbeOutput,
    sessions: async (caller: unknown, input: unknown) => querySessions(db, caller as never, input as never, STATE),
  }
  const table = scriptMethods({
    runtime: runtime as never,
    session: fakeSession().session,
    location: { projectID: "prj_app", directory: "/work/app" },
    defaults: { scope: "project" },
    identity: () => IDENTITY,
    assert: async (request: PermissionRequest) => {
      if (current === undefined) throw new Error("an assert ran outside a kit call")
      await current.assert({ action: request.action, resources: request.resources })
    },
  })
  const method = (name: string) => table.find(entry => entry.name === name) as PluginMethod
  // A refusal reaches a script as the transport words it, `CODE: what happened. Next step: …` (pluginError).
  const run = (name: string) => (input: Readonly<Record<string, unknown>>, context: SessionContext) => {
    current = context.permission
    return method(name).run(input, call()).then(
      answer => answer,
      (error: unknown) => {
        const failure = pluginError(error)
        throw failure ? new Error(`${failure.code}: ${failure.what} Next step: ${failure.next}`) : error
      },
    ).finally(() => (current = undefined))
  }
  return { list: run("events_list"), probe: run("probe"), snapshot: run("sessions") }
}

const open: SessionContext = { account: ACCOUNT, permission: { assert: async () => {} } }
const reports: ConformanceReport[] = []

afterAll(() => {
  if (reports.length === 0) return
  const installed = readInstalledDescriptor(root, { version: pkg.version })
  const report = {
    contract: `@we-the-rebel-alliance/source-contract@${contract.version}`,
    plugin: pkg.name,
    version: pkg.version,
    descriptorHash: installed.ok ? installed.value.hash : null,
    ok: reports.every(entry => entry.ok),
    sources: reports,
  }
  mkdirSync(join(root, "reports"), { recursive: true })
  writeFileSync(join(root, "reports", "conformance-report.json"), `${JSON.stringify(report, null, 2)}\n`)
})

describe("the source contract's conformance kit", () => {
  it("the declaration validates, as a consumer reads it from the installed package", () => {
    const installed = readInstalledDescriptor(root, { version: pkg.version })
    expect(installed.ok ? [] : installed.problems).toEqual([])
    expect(declarationProblems(pkg.sources, { tools })).toEqual([])
    expect(sources.rpc).toBe(TOOLS_RPC_ID)
    expect(pkg.name).toBe(PACKAGE)
    expect(sources.items.map(item => [item.id, item.kind, item.input?.["source"]])).toEqual([
      ["history.sessions", "events", SESSIONS_SOURCE],
      ["history.sessions.list", "snapshot", SESSIONS_SOURCE],
    ])
    expect(sources.items.find(item => item.id === "history.sessions.list")).toMatchObject({ output: "list", tool: "sessions" })
  })

  it("history.sessions keeps the contract", async () => {
    const { s, later } = index()
    const { list, probe: probed } = plugin(s.db)
    const first = (await list({ source: SESSIONS_SOURCE, account: ACCOUNT, since: SINCE }, open)) as { cursor: string }
    later()
    const done = (await list({ source: SESSIONS_SOURCE, account: ACCOUNT, cursor: first.cursor }, open)) as { cursor: string }
    const other = "other-mac"
    const cases: PageCase[] = [
      { name: "a first listing, one session refused for a secret its title still holds", input: { source: SESSIONS_SOURCE, account: ACCOUNT, since: SINCE }, expect: "page" },
      { name: "what changed after the first listing", input: { source: SESSIONS_SOURCE, account: ACCOUNT, cursor: first.cursor }, expect: "page" },
      { name: "the same, one at a time", input: { source: SESSIONS_SOURCE, account: ACCOUNT, cursor: first.cursor, limit: 1 }, expect: "page" },
      { name: "nothing new since the last listing", input: { source: SESSIONS_SOURCE, account: ACCOUNT, cursor: done.cursor }, expect: "empty" },
      { name: "a cursor without the account it reads", input: { source: SESSIONS_SOURCE, cursor: first.cursor }, expect: { refuses: "INPUT_INVALID" } },
      {
        name: "another machine's cursor",
        input: { source: SESSIONS_SOURCE, account: ACCOUNT, cursor: encodeBoundCursor({ plugin: "history", source: SESSIONS_SOURCE, account: other }, { a: other, o: `os-user:sam@${other}`, u: 0, i: "" }) },
        expect: { refuses: "ACCOUNT_MISMATCH" },
      },
      { name: "another machine's account", input: { source: SESSIONS_SOURCE, account: other, since: SINCE }, expect: { refuses: "ACCOUNT_MISMATCH" } },
      { name: "contract 1's cursor of this machine", input: { source: SESSIONS_SOURCE, account: ACCOUNT, cursor: encodeCursor("history", { a: ACCOUNT, u: 0, i: "" }) }, expect: { refuses: "CURSOR_INVALID" } },
      {
        name: "a cursor bound to another plugin",
        input: { source: SESSIONS_SOURCE, account: ACCOUNT, cursor: encodeBoundCursor({ plugin: "granola", source: SESSIONS_SOURCE, account: ACCOUNT }, { a: ACCOUNT, o: IDENTITY.owner.id, u: 0, i: "" }) },
        expect: { refuses: "CURSOR_INVALID" },
      },
      { name: "a source History does not have", input: { source: "meetings", account: ACCOUNT }, expect: { refuses: "SOURCE_UNKNOWN" } },
    ]
    const report = await sourceConformance({
      plugin: PACKAGE,
      source: sources.items[0]!,
      tools,
      calls: { list, probe: probed },
      cases,
      account: ACCOUNT,
      sources,
      describe: { id: TOOLS_RPC_ID },
      atomicPages: { reason: ATOMIC },
      noExpiry: { reason: NO_EXPIRY },
    })
    reports.push(report)
    s.close()
    expect(report.problems).toEqual([])
    // Every check that applies ran. The two History cannot exercise say why (failed[] and an expired cursor); the rest are
    // not applicable because the source has no gap, removal, price, details, suggest or snapshot output.
    expect(report.checks.filter(check => !check.ran && !check.notApplicable).map(check => check.name)).toEqual([])
    expect(report.checks.filter(check => check.reason !== undefined).map(check => [check.name, check.reason])).toEqual([
      ["failed-holds-cursor", ATOMIC],
      ["gap-and-cursor-expired", NO_EXPIRY],
    ])
    expect(report.ok).toBe(true)
  })

  it("history.sessions.list keeps the contract", async () => {
    const { s } = index()
    const { snapshot, probe: probed } = plugin(s.db)
    const listed = sources.items.find(item => item.id === "history.sessions.list")!
    const report = await sourceConformance({
      plugin: PACKAGE,
      source: listed,
      tools,
      calls: { snapshot, probe: probed },
      snapshotCases: [{ ...(listed.input ?? {}), account: ACCOUNT }],
      cases: [],
      account: ACCOUNT,
      sources,
      describe: { id: TOOLS_RPC_ID },
    })
    reports.push(report)
    s.close()
    expect(report.problems).toEqual([])
    expect(report.ok).toBe(true)
  })

  it("a consumer's fenced session allows only the method's own action: the source reads only the local index", () => {
    const source = sources.items[0]!
    const rules = sessionRules(source as never, { source: source.id, account: ACCOUNT })
    expect(rules.ok ? rules.value : rules.problems).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "history_events_list", resource: "*", effect: "allow" },
    ])
  })
})
