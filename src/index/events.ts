// Turns host bus events into index work: deletes right away, syncs debounced per session.
import type { Indexer } from "./sync.js"

interface RouterOptions {
  /** Quiet time after a session's last event before it is synced. */
  readonly debounceMs?: number
  /** Longest a busy session waits for a sync, however often its events arrive. */
  readonly maxWaitMs?: number
}

export interface EventRouter {
  handle(event: { type: string; data: unknown }): void
  /** Drop pending syncs and ignore later events. Syncs already running finish on their own. */
  close(): void
}

/** Events that fire many times a second and say nothing a later event will not. */
const noisy = (type: string) => type.endsWith(".delta") || type.endsWith(".progress")

function sessionID(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null
  const id = (data as { sessionID?: unknown }).sessionID
  return typeof id === "string" && id.length > 0 ? id : null
}

/**
 * Route `session.*` events: `session.deleted` deletes the session, and any other one that carries `data.sessionID`
 * (idle, compaction ended, renamed, created, step ended, ...) schedules a debounced sync. Errors land in the indexer's
 * health; the router never rejects.
 */
export function eventRouter(indexer: Pick<Indexer, "syncSession" | "deleteSession">, options: RouterOptions = {}): EventRouter {
  const debounceMs = Math.max(0, options.debounceMs ?? 1500)
  const maxWaitMs = Math.max(debounceMs, options.maxWaitMs ?? debounceMs * 4)
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; first: number }>()
  let closed = false

  const cancel = (id: string) => {
    const entry = pending.get(id)
    if (entry) clearTimeout(entry.timer)
    pending.delete(id)
  }

  const schedule = (id: string) => {
    const now = Date.now()
    const first = pending.get(id)?.first ?? now
    cancel(id)
    const timer = setTimeout(
      () => {
        pending.delete(id)
        indexer.syncSession(id).catch(() => {})
      },
      Math.max(0, Math.min(debounceMs, first + maxWaitMs - now)),
    )
    timer.unref?.()
    pending.set(id, { timer, first })
  }

  return {
    handle(event) {
      if (closed || typeof event?.type !== "string" || !event.type.startsWith("session.") || noisy(event.type)) return
      const id = sessionID(event.data)
      if (!id) return
      if (event.type === "session.deleted") {
        cancel(id)
        indexer.deleteSession(id).catch(() => {})
        return
      }
      schedule(id)
    },
    close() {
      closed = true
      for (const id of [...pending.keys()]) cancel(id)
    },
  }
}
