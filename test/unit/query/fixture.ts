// A temporary sidecar index built from schema.ts, helpers to insert rows directly, and an in-memory source.
import { rmSync } from "node:fs"
import { join } from "node:path"
import type { Caller, IndexState } from "../../../src/domain/api.js"
import type { DocKind, FileOp, SourceMessage } from "../../../src/domain/contract.js"
import { openDb, type Db } from "../../../src/domain/sqlite.js"
import { TABLES, TRIGGERS, VIEWS } from "../../../src/index/schema.js"
import type { MessageSource } from "../../../src/query/read.js"
import type { TodoSource } from "../../../src/query/brief.js"
import { tempDir } from "../../temp.js"

export const DAY = 86_400_000
export const NOW = Date.parse("2026-11-01T12:00:00Z")

export const STATE: IndexState = { ready: true, sessionsIndexed: 10, sessionsTotal: 10, lagSeconds: 0, source: "opencode-db", complete: true }

export const CALLER: Caller = { sessionID: null, projectID: "prj_app", directory: "/work/app" }

export const NO_MASK = (text: string) => text

export interface Sidecar {
  readonly db: Db
  readonly path: string
  close(): void
}

export function sidecar(): Sidecar {
  const dir = tempDir("history-query-")
  const path = join(dir, "index.db")
  const db = openDb(path)
  db.exec("pragma journal_mode = wal")
  for (const sql of [...TABLES, ...TRIGGERS, ...VIEWS]) db.exec(sql)
  return {
    db,
    path,
    close: () => {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function project(db: Db, id: string, worktree: string, name: string | null = null): void {
  db.run("insert into projects (id, worktree, name) values (?, ?, ?)", id, worktree, name)
}

export interface SessionRow {
  id: string
  parentID?: string | null
  rootID?: string
  projectID?: string
  directory?: string
  title?: string
  agent?: string | null
  model?: string | null
  cost?: number
  created?: number
  updated?: number
  archived?: number | null
  firstPrompt?: string | null
  lastReply?: string | null
  outcome?: string | null
  messages?: number
}

export function session(db: Db, row: SessionRow): void {
  const parent = row.parentID ? db.get<{ root_id: string }>("select root_id from sessions where id = ?", row.parentID)?.root_id : undefined
  db.run(
    `insert into sessions (id, parent_id, root_id, project_id, directory, title, agent, model, cost, created, updated, archived,
        first_prompt, last_reply, outcome, messages)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.parentID ?? null,
    row.rootID ?? parent ?? row.parentID ?? row.id,
    row.projectID ?? "prj_app",
    row.directory ?? "/work/app",
    row.title ?? row.id,
    row.agent ?? "build",
    row.model ?? null,
    row.cost ?? 0,
    row.created ?? row.updated ?? NOW - DAY,
    row.updated ?? NOW - DAY,
    row.archived ?? null,
    row.firstPrompt ?? null,
    row.lastReply ?? null,
    row.outcome ?? null,
    row.messages ?? 0,
  )
}

export interface DocRow {
  sessionID: string
  text: string
  rootID?: string
  messageID?: string
  seq?: number
  part?: number
  time?: number
  kind?: DocKind
  tool?: string | null
}

let nextSeq = 0

const rootOf = (db: Db, sessionID: string) => db.get<{ root_id: string }>("select root_id from sessions where id = ?", sessionID)?.root_id ?? sessionID

export function doc(db: Db, row: DocRow): void {
  const seq = row.seq ?? nextSeq++
  db.run(
    "insert into docs (session_id, root_id, message_id, seq, part, time, kind, tool) values (?, ?, ?, ?, ?, ?, ?, ?)",
    row.sessionID,
    row.rootID ?? rootOf(db, row.sessionID),
    row.messageID ?? `msg_${row.sessionID}_${seq}`,
    seq,
    row.part ?? 0,
    row.time ?? db.get<{ updated: number }>("select updated from sessions where id = ?", row.sessionID)?.updated ?? NOW - DAY,
    row.kind ?? "user",
    row.tool ?? null,
  )
  db.run("insert into doc_texts (id, text) values (last_insert_rowid(), ?)", row.text)
}

/** The title doc the extractor writes: seq -1, part 0 and no message ID. */
export function titleDoc(db: Db, sessionID: string, text: string): void {
  doc(db, { sessionID, seq: -1, messageID: "", kind: "title", text })
}

/** Unrelated docs in another project, so test terms are rare enough for bm25 to score them. */
export function noise(db: Db, count = 50): void {
  session(db, { id: "ses_noise", projectID: "prj_noise", directory: "/noise", updated: NOW - 400 * DAY })
  for (let i = 0; i < count; i++) doc(db, { sessionID: "ses_noise", text: `unrelated background chatter number ${i}` })
}

export function file(db: Db, sessionID: string, path: string, op: FileOp = "edit", over: { seq?: number; time?: number; tool?: string } = {}): void {
  db.run(
    "insert into files (session_id, root_id, message_id, seq, time, path, op, tool) values (?, ?, ?, ?, ?, ?, ?, ?)",
    sessionID,
    rootOf(db, sessionID),
    `msg_${sessionID}_${over.seq ?? 0}`,
    over.seq ?? 0,
    over.time ?? NOW - DAY,
    path,
    op,
    over.tool ?? op,
  )
}

export function link(db: Db, parentID: string, childID: string, description: string | null, agent: string | null): void {
  // Later schemas add a required seq (the parent message that spawned the child); fill it when present.
  const withSeq = db.all<{ name: string }>("pragma table_info(links)").some(column => column.name === "seq")
  if (withSeq) db.run("insert into links (parent_id, child_id, message_id, seq, description, agent) values (?, ?, ?, 0, ?, ?)", parentID, childID, null, description, agent)
  else db.run("insert into links (parent_id, child_id, message_id, description, agent) values (?, ?, ?, ?, ?)", parentID, childID, null, description, agent)
}

// Message data in the shapes OpenCode 2.2.x stores, as the source fixture on master builds them.

export const userData = (text: string, extra: Record<string, unknown> = {}) => ({ text, ...extra })
export const textPart = (text: string) => ({ type: "text", text })
export const reasoningPart = (text: string) => ({ type: "reasoning", text })
export const assistantData = (content: readonly Record<string, unknown>[]) => ({ agent: "build", model: { id: "m", providerID: "p" }, content })

export function toolPart(name: string, input: Record<string, unknown>, options: { status?: string; output?: string; error?: string } = {}) {
  const state: Record<string, unknown> = { status: options.status ?? (options.error ? "error" : "completed"), input }
  if (options.output !== undefined) state.content = [{ type: "text", text: options.output }]
  if (options.error !== undefined) state.error = { type: "unknown", message: options.error }
  return { type: "tool", name, state }
}

export interface FakeSource extends MessageSource, TodoSource {
  /** Messages added so far, for building matching docs. */
  readonly all: SourceMessage[]
  add(sessionID: string, type: string, data: Record<string, unknown>, over?: { seq?: number; id?: string; created?: number }): SourceMessage
  setTodos(sessionID: string, todos: readonly { content: string; status: string }[]): void
}

/** An in-memory source with the read side of the `Source` contract. */
export function fakeSource(): FakeSource {
  const all: SourceMessage[] = []
  const todos = new Map<string, readonly { content: string; status: string }[]>()
  const ordered = (sessionID: string) => all.filter(message => message.sessionID === sessionID).sort((a, b) => a.seq - b.seq)
  return {
    all,
    add(sessionID, type, data, over = {}) {
      const seq = over.seq ?? (ordered(sessionID).at(-1)?.seq ?? -1) + 1
      const message: SourceMessage = { id: over.id ?? `msg_${sessionID}_${seq}`, sessionID, seq, type, created: over.created ?? NOW - DAY + seq * 1000, updated: NOW, data }
      all.push(message)
      return message
    },
    setTodos: (sessionID, list) => void todos.set(sessionID, list),
    messages: async (sessionID, fromSeq, limit) => ordered(sessionID).filter(message => message.seq >= fromSeq).slice(0, limit),
    message: async (sessionID, at) => ordered(sessionID).find(message => ("seq" in at ? message.seq === at.seq : message.id === at.id)),
    todos: async sessionID => todos.get(sessionID) ?? [],
  }
}
