// The partial fallback source: the plugin's session API. It only sees messages after the latest compaction,
// numbers them by position, and has no todos or project names.
import type { SessionInfo, SessionListInput, SessionMessageInfo } from "@opencode/client"
import type { Source, SourceMessage, SourceSession } from "../domain/contract.js"

/** The two calls of `ctx.session` this source needs. */
export interface ContextSessionApi {
  list(input?: SessionListInput): Promise<{ readonly data: readonly SessionInfo[]; readonly cursor: { readonly next?: string | null } }>
  context(input: { readonly sessionID: string }): Promise<readonly SessionMessageInfo[]>
}

interface ContextSourceOptions {
  /** Sessions per list call. */
  readonly pageSize?: number
  /** Stop listing after this many pages. */
  readonly maxPages?: number
  /** How long one listing or one session's messages are reused, in ms. */
  readonly cacheMs?: number
  readonly now?: () => number
}

export function contextSource(session: ContextSessionApi, options: ContextSourceOptions = {}): Source {
  const pageSize = options.pageSize ?? 100
  const maxPages = options.maxPages ?? 1000
  const cacheMs = options.cacheMs ?? 5000
  const now = options.now ?? Date.now
  let listing: { at: number; sessions: readonly SourceSession[] } | undefined
  let thread: { at: number; sessionID: string; messages: readonly SourceMessage[] } | undefined

  const cached = () => listing !== undefined && now() - listing.at < cacheMs

  const sessions = async (fresh = false): Promise<readonly SourceSession[]> => {
    if (!fresh && listing && cached()) return listing.sessions
    const all: SourceSession[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < maxPages; page++) {
      const result = await session.list({ limit: pageSize, order: "desc", ...(cursor ? { cursor } : {}) })
      for (const info of result.data) {
        if (seen.has(info.id)) continue
        seen.add(info.id)
        all.push(toSession(info))
      }
      const next = result.cursor.next
      if (!next || next === cursor || result.data.length === 0) break
      cursor = next
    }
    all.sort((a, b) => a.updated - b.updated || compare(a.id, b.id))
    listing = { at: now(), sessions: all }
    return all
  }

  const messagesOf = async (sessionID: string): Promise<readonly SourceMessage[]> => {
    if (thread && thread.sessionID === sessionID && now() - thread.at < cacheMs) return thread.messages
    const messages = (await session.context({ sessionID })).map((message, seq) => toMessage(message, sessionID, seq))
    thread = { at: now(), sessionID, messages }
    return messages
  }

  return {
    kind: "context",
    async session(id) {
      // A session created since the cached listing is not in it yet, so a miss there lists again once.
      const reused = cached()
      const found = (await sessions()).find(item => item.id === id)
      if (found || !reused) return found
      return (await sessions(true)).find(item => item.id === id)
    },
    async changedSessions(since, limit) {
      return (await sessions()).filter(item => item.updated > since).slice(0, Math.max(0, Math.floor(limit)))
    },
    async sessionIDs() {
      return new Set((await sessions()).map(item => item.id))
    },
    async messages(sessionID, fromSeq, limit) {
      return (await messagesOf(sessionID)).filter(message => message.seq >= fromSeq).slice(0, Math.max(0, Math.floor(limit)))
    },
    async message(sessionID, at) {
      const messages = await messagesOf(sessionID)
      return "seq" in at ? messages[at.seq] : messages.find(message => message.id === at.id)
    },
    async projects() {
      return []
    },
    async todos() {
      return []
    },
    close() {
      listing = undefined
      thread = undefined
    },
  }
}

function toSession(info: SessionInfo): SourceSession {
  return {
    id: info.id,
    parentID: info.parentID ?? null,
    projectID: info.projectID,
    directory: info.location.directory,
    title: info.title ?? "",
    agent: info.agent ?? null,
    model: info.model ? `${info.model.providerID}/${info.model.id}` : null,
    cost: info.cost,
    tokensInput: info.tokens.input,
    tokensOutput: info.tokens.output,
    created: info.time.created,
    updated: info.time.updated,
    archived: info.time.archived ?? null,
  }
}

function toMessage(message: SessionMessageInfo, sessionID: string, seq: number): SourceMessage {
  // Same shape as the database row: `data` holds everything but id and type.
  const { id, type, ...data } = message
  const time: { created: number; completed?: number } = message.time
  return { id, sessionID, seq, type, created: time.created, updated: time.completed ?? time.created, data }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
