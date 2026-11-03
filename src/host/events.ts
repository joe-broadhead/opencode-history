// Keeps the index fresh: OpenCode's session events go to runtime.onEvent as they happen.
import type { Plugin } from "@opencode/plugin"
import { formatFailure, HistoryError } from "../domain/common.js"
import type { HostEvent } from "./runtime.js"

type Subscribe = Plugin.Context["event"]["subscribe"]
type EventType = NonNullable<NonNullable<Parameters<Subscribe>[0]>["types"]>[number]
type SessionType = Extract<EventType, `session.${string}`>

/** Token and progress streams. Each ends in an event below, so they carry nothing new for the index. */
export const STREAMING_EVENTS = [
  "session.text.delta", "session.reasoning.delta", "session.tool.input.delta", "session.compaction.delta",
  "session.tool.progress", "session.status", "session.usage.updated",
] as const satisfies readonly SessionType[]

/** Every other `session.*` event a plugin can subscribe to in OpenCode 2.2: the durable ones, which record a change, and `session.idle`. */
export const SESSION_EVENTS = [
  "session.created", "session.deleted", "session.forked", "session.moved", "session.renamed", "session.archived", "session.unarchived",
  "session.metadata.updated", "session.permissions", "session.agent.selected", "session.model.selected", "session.instructions.updated", "session.viewed",
  "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.idle",
  "session.inbox.enqueued", "session.inbox.delivered", "session.inbox.delivery.changed", "session.inbox.cancelled", "session.synthetic",
  "session.step.started", "session.step.streamed", "session.step.ended", "session.step.failed", "session.retry.scheduled",
  "session.text.started", "session.text.ended", "session.reasoning.started", "session.reasoning.ended",
  "session.tool.input.started", "session.tool.input.ended", "session.tool.called", "session.tool.success", "session.tool.failed",
  "session.shell.started", "session.shell.ended", "session.skill.activated",
  "session.compaction.started", "session.compaction.ended", "session.compaction.failed",
  "session.revert.staged", "session.revert.committed", "session.revert.cleared",
] as const satisfies readonly SessionType[]

// A session event type that is in neither list fails the typecheck, so a host update cannot add one unnoticed.
type Unlisted = Exclude<SessionType, typeof SESSION_EVENTS[number] | typeof STREAMING_EVENTS[number]>
const complete: [Unlisted] extends [never] ? true : Unlisted = true
void complete

const pause = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) return resolve()
  const timer = setTimeout(done, ms)
  function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve() }
  signal.addEventListener("abort", done, { once: true })
})

/**
 * Passes SESSION_EVENTS to `onEvent` until `signal` aborts. A stream that fails or ends is subscribed again after 1 s,
 * doubling to 30 s, with one warning per outage.
 */
export async function followEvents(subscribe: Subscribe, onEvent: (event: HostEvent) => void, signal: AbortSignal, { warn = console.warn, retryMs = 1000 }: { readonly warn?: (message: string) => void; readonly retryMs?: number } = {}) {
  let delay = retryMs, warned = false
  const types = new Set<string>(SESSION_EVENTS)
  while (!signal.aborted) {
    try {
      for await (const event of subscribe({ types: SESSION_EVENTS, signal })) {
        if (signal.aborted) break
        delay = retryMs; warned = false
        if (types.has(event.type)) {
          try { onEvent({ type: event.type, data: event.data }) } catch { /* onEvent must not throw; a bad one cannot stop the stream */ }
        }
      }
    } catch {
      if (signal.aborted) break
    }
    if (signal.aborted) break
    if (!warned) { warn(formatFailure(new HistoryError("EVENTS_UNAVAILABLE"))); warned = true }
    await pause(delay, signal)
    delay = Math.min(delay * 2, 30_000)
  }
}
