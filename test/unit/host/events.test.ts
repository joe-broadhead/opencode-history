import { describe, expect, test, vi } from "vitest"
import { followEvents, SESSION_EVENTS, STREAMING_EVENTS } from "../../../src/host/events.js"
import type { HostEvent } from "../../../src/host/runtime.js"

type Options = { types?: readonly string[]; signal?: AbortSignal }
const event = (type: string, data: object = { sessionID: "ses_1" }) => ({ type, data })
/** A subscription per entry: its events, then an end or an error. */
function streams(...plans: { events: object[]; end: "close" | "fail" | "hang" }[]) {
  const subscriptions: Options[] = []
  const subscribe = (options: Options) => {
    subscriptions.push(options)
    const plan = plans[subscriptions.length - 1] ?? { events: [], end: "hang" as const }
    return (async function* () {
      for (const e of plan.events) yield e
      if (plan.end === "fail") throw new Error("stream lost")
      if (plan.end === "hang") await new Promise<void>(resolve => options.signal?.addEventListener("abort", () => resolve(), { once: true }))
    })()
  }
  return { subscribe: subscribe as never, subscriptions }
}

describe("session events", () => {
  test("the lists are disjoint session events without repeats", () => {
    const all = [...SESSION_EVENTS, ...STREAMING_EVENTS]
    expect(new Set(all).size).toBe(all.length)
    expect(all.every(type => type.startsWith("session."))).toBe(true)
    expect(SESSION_EVENTS).toEqual(expect.arrayContaining(["session.created", "session.deleted", "session.idle", "session.step.ended", "session.compaction.ended", "session.renamed"]))
    expect(STREAMING_EVENTS.every(type => !(SESSION_EVENTS as readonly string[]).includes(type))).toBe(true)
  })

  test("listed events go to onEvent with their type and data; a throwing onEvent does not stop the stream", async () => {
    const received: HostEvent[] = [], controller = new AbortController()
    const s = streams({ events: [event("session.created"), event("session.text.delta"), event("agent.updated"), event("session.idle", { sessionID: "ses_2" })], end: "hang" })
    const onEvent = vi.fn((e: HostEvent) => { received.push(e); if (e.type === "session.created") throw new Error("bad listener") })
    const following = followEvents(s.subscribe, onEvent, controller.signal)
    await vi.waitFor(() => expect(received).toHaveLength(2))
    expect(received).toEqual([{ type: "session.created", data: { sessionID: "ses_1" } }, { type: "session.idle", data: { sessionID: "ses_2" } }])
    expect(s.subscriptions).toEqual([{ types: SESSION_EVENTS, signal: controller.signal }])
    controller.abort()
    await expect(following).resolves.toBeUndefined()
  })

  test("a failed or ended stream is subscribed again, with one warning per outage", async () => {
    const received: string[] = [], warnings: string[] = [], controller = new AbortController()
    const s = streams(
      { events: [event("session.created")], end: "fail" },
      { events: [], end: "close" },
      { events: [event("session.renamed")], end: "fail" },
      { events: [event("session.deleted")], end: "hang" },
    )
    const following = followEvents(s.subscribe, e => { received.push(e.type) }, controller.signal, { warn: m => { warnings.push(m) }, retryMs: 1 })
    await vi.waitFor(() => expect(received).toEqual(["session.created", "session.renamed", "session.deleted"]))
    expect(s.subscriptions).toHaveLength(4)
    expect(warnings).toEqual([
      "EVENTS_UNAVAILABLE: OpenCode's session events stopped, so the index may lag behind new sessions. Next step: Wait, since the plugin subscribes again by itself, and restart OpenCode if it persists.",
      expect.stringMatching(/^EVENTS_UNAVAILABLE/),
    ])
    controller.abort()
    await following
  })

  test("unloading ends the loop, even while it waits to subscribe again", async () => {
    const controller = new AbortController(), s = streams({ events: [], end: "fail" })
    const following = followEvents(s.subscribe, () => {}, controller.signal, { warn: () => {}, retryMs: 60_000 })
    await vi.waitFor(() => expect(s.subscriptions).toHaveLength(1))
    controller.abort()
    await expect(following).resolves.toBeUndefined()
    expect(s.subscriptions).toHaveLength(1)
  })
})
