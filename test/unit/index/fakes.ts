// Test doubles shared by the index tests: an in-memory source and a tiny extractor.
import type { Doc, Extracted, Source, SourceKind, SourceMessage, SourceProject, SourceSession } from "../../../src/domain/contract.js"
import { TITLE_SEQ } from "../../../src/index/store.js"

export interface Said {
  readonly role: "user" | "assistant"
  readonly text: string
  readonly child?: string
  readonly file?: string
  readonly outcome?: string
  readonly boom?: boolean
}

/** An in-memory source. Every call is logged; `messages` waits a microtask so overlapping calls show up. */
export class FakeSource implements Source {
  kind: SourceKind = "opencode-db"
  readonly sessions = new Map<string, SourceSession>()
  readonly messagesOf = new Map<string, SourceMessage[]>()
  readonly log: string[] = []
  active = 0
  maxActive = 0
  clock = 1_000
  /** Runs after `sessionIDs` has taken its snapshot. */
  afterIDs: (() => Promise<void>) | null = null
  /** Runs after `messages` has read, before it returns. */
  afterRead: ((sessionID: string) => void) | null = null
  /** `messages` waits for this before reading. */
  gate: Promise<void> | null = null

  add(id: string, over: Partial<SourceSession> = {}, said: Said[] = []): SourceSession {
    const time = ++this.clock
    this.sessions.set(id, {
      id,
      parentID: null,
      projectID: "prj_1",
      directory: "/work/app",
      title: `title of ${id}`,
      agent: "build",
      model: "anthropic/claude",
      cost: 0,
      tokensInput: 0,
      tokensOutput: 0,
      created: time,
      updated: time,
      archived: null,
      ...over,
    })
    this.messagesOf.set(id, [])
    for (const s of said) this.say(id, s)
    if (over.updated !== undefined) this.touch(id, over.updated)
    return this.sessions.get(id)!
  }

  say(id: string, said: Said): void {
    const list = this.messagesOf.get(id)!
    const seq = list.length === 0 ? 0 : list[list.length - 1]!.seq + 1
    const time = ++this.clock
    list.push({ id: `${id}_m${seq}`, sessionID: id, seq, type: said.role, created: time, updated: time, data: { ...said } })
    this.touch(id, time)
  }

  edit(id: string, seq: number, said: Said): void {
    const list = this.messagesOf.get(id)!
    const index = list.findIndex(message => message.seq === seq)
    const time = ++this.clock
    list[index] = { ...list[index]!, updated: time, data: { ...said } }
    this.touch(id, time)
  }

  touch(id: string, updated: number): void {
    this.sessions.set(id, { ...this.sessions.get(id)!, updated })
  }

  calls(prefix: string): string[] {
    return this.log.filter(line => line.startsWith(prefix))
  }

  async session(id: string): Promise<SourceSession | undefined> {
    this.log.push(`session ${id}`)
    return this.sessions.get(id)
  }

  async changedSessions(since: number, limit: number): Promise<readonly SourceSession[]> {
    this.log.push(`changed ${since} ${limit}`)
    return [...this.sessions.values()]
      .filter(session => session.updated > since)
      .sort((a, b) => a.updated - b.updated || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
  }

  async sessionIDs(): Promise<ReadonlySet<string>> {
    const ids = new Set(this.sessions.keys())
    await this.afterIDs?.()
    return ids
  }

  async messages(sessionID: string, fromSeq: number, limit: number): Promise<readonly SourceMessage[]> {
    this.log.push(`messages ${sessionID} ${fromSeq}`)
    this.active++
    this.maxActive = Math.max(this.maxActive, this.active)
    await (this.gate ?? Promise.resolve())
    const found = (this.messagesOf.get(sessionID) ?? []).filter(message => message.seq >= fromSeq).slice(0, limit)
    this.afterRead?.(sessionID)
    this.active--
    return found
  }

  async message(sessionID: string, at: { seq: number } | { id: string }): Promise<SourceMessage | undefined> {
    return this.messagesOf.get(sessionID)?.find(message => ("seq" in at ? message.seq === at.seq : message.id === at.id))
  }

  async projects(): Promise<readonly SourceProject[]> {
    this.log.push("projects")
    return [{ id: "prj_1", worktree: "/work/app", name: "app" }]
  }

  async todos(): Promise<readonly { content: string; status: string }[]> {
    return []
  }

  close(): void {}
}

export const extract = (message: SourceMessage, session: SourceSession): Extracted => {
  const data = message.data as unknown as Said
  if (data.boom) throw new Error(`cannot extract ${message.id}`)
  return {
    docs: [{ sessionID: message.sessionID, messageID: message.id, seq: message.seq, part: 0, time: message.created, kind: data.role, tool: null, text: data.text }],
    files: data.file
      ? [{ sessionID: message.sessionID, messageID: message.id, seq: message.seq, time: message.created, path: data.file, op: "edit", tool: "edit" }]
      : [],
    links: data.child ? [{ parentID: session.id, childID: data.child, messageID: message.id, description: data.text, agent: "explore" }] : [],
    facts:
      data.role === "user"
        ? { messages: 1, userMessages: 1, firstPrompt: data.text }
        : { messages: 1, toolCalls: data.file ? 1 : 0, lastReply: data.text, ...(data.outcome ? { outcome: data.outcome } : {}) },
  }
}

export const titleDoc = (session: SourceSession): Doc | null =>
  session.title ? { sessionID: session.id, messageID: session.id, seq: TITLE_SEQ, part: 0, time: session.updated, kind: "title", tool: null, text: session.title } : null

export const tick = () => new Promise<void>(resolve => setImmediate(resolve))
export const user = (text: string, over: Partial<Said> = {}): Said => ({ role: "user", text, ...over })
export const reply = (text: string, over: Partial<Said> = {}): Said => ({ role: "assistant", text, ...over })
export const chat = (n: number): Said[] => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? user(`question ${i}`) : reply(`answer ${i}`)))
