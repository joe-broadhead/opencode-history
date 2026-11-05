// The complete source: OpenCode's own database, opened read-only. Layout of OpenCode 2.2.x.
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import type { Source, SourceMessage, SourceProject, SourceSession } from "../domain/contract.js"
import { openDb, type Db } from "../domain/sqlite.js"

/** Columns this module reads, per table. `todo` is optional. */
const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  session_v2: [
    "id",
    "project_id",
    "parent_id",
    "directory",
    "title",
    "agent",
    "model",
    "cost",
    "tokens_input",
    "tokens_output",
    "time_created",
    "time_updated",
    "time_archived",
  ],
  session_message: ["id", "session_id", "type", "seq", "time_created", "time_updated", "data"],
  project: ["id", "worktree", "name"],
}

const TODO_COLUMNS = ["session_id", "content", "status", "position"]

export function defaultDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const data = env.XDG_DATA_HOME
  // XDG says relative values are invalid and must be ignored.
  if (data && isAbsolute(data)) return join(data, "opencode", "opencode.db")
  return join(env.HOME || homedir(), ".local", "share", "opencode", "opencode.db")
}

interface SessionRow {
  id: string
  project_id: string
  parent_id: string | null
  directory: string
  title: unknown
  agent: unknown
  model: unknown
  cost: number | null
  tokens_input: number | null
  tokens_output: number | null
  time_created: number
  time_updated: number
  time_archived: number | null
}

interface MessageRow {
  id: string
  session_id: string
  type: string
  seq: number
  time_created: number
  time_updated: number
  data: string
}

const SESSION_SELECT = `select id, project_id, parent_id, directory, title, agent, model, cost, tokens_input, tokens_output,
  time_created, time_updated, time_archived from session_v2`

const MESSAGE_SELECT = `select id, session_id, type, seq, time_created, time_updated, data from session_message`

/** Whether OpenCode's database can be used; when not, whether it cannot be read or has a layout this version does not know. */
type DatabaseProbe = { readonly ok: true } | { readonly ok: false; readonly problem: "unreadable" | "layout" }

/** OpenCode's database as a source, with the probe that decides whether the plugin uses it. */
export function openOpencodeSource(path: string): Source & { probe(): Promise<DatabaseProbe> } {
  let db: Db | undefined
  let hasTodo: boolean | undefined
  // Open on first use so probe() can report a missing or unreadable file.
  const conn = () => (db ??= openDb(path, { readOnly: true }))

  return {
    kind: "opencode-db",
    async probe() {
      try {
        const missing = missingColumns(conn(), REQUIRED_COLUMNS)
        if (missing.length > 0) {
          // A file with none of the tables is some other database, not another layout of OpenCode's.
          const tables = missing.filter(item => item.startsWith("table ")).length
          return { ok: false, problem: tables < Object.keys(REQUIRED_COLUMNS).length ? "layout" : "unreadable" }
        }
        hasTodo = missingColumns(conn(), { todo: TODO_COLUMNS }).length === 0
        return { ok: true }
      } catch {
        return { ok: false, problem: "unreadable" }
      }
    },
    async session(id) {
      const row = conn().get<SessionRow>(`${SESSION_SELECT} where id = ?`, id)
      return row && toSession(row)
    },
    async changedSessions(since, limit) {
      return conn()
        .all<SessionRow>(`${SESSION_SELECT} where time_updated > ? order by time_updated, id limit ?`, since, count(limit))
        .map(toSession)
    },
    async sessionIDs() {
      return new Set(conn().all<{ id: string }>(`select id from session_v2`).map(row => row.id))
    },
    async messages(sessionID, fromSeq, limit) {
      return conn()
        .all<MessageRow>(`${MESSAGE_SELECT} where session_id = ? and seq >= ? order by seq limit ?`, sessionID, fromSeq, count(limit))
        .map(toMessage)
    },
    async message(sessionID, at) {
      const row =
        "seq" in at
          ? conn().get<MessageRow>(`${MESSAGE_SELECT} where session_id = ? and seq = ?`, sessionID, at.seq)
          : conn().get<MessageRow>(`${MESSAGE_SELECT} where session_id = ? and id = ?`, sessionID, at.id)
      return row && toMessage(row)
    },
    async projects() {
      return conn()
        .all<{ id: string; worktree: string; name: string | null }>(`select id, worktree, name from project order by id`)
        .map((row): SourceProject => ({ id: row.id, worktree: row.worktree, name: row.name || null }))
    },
    async todos(sessionID) {
      hasTodo ??= missingColumns(conn(), { todo: TODO_COLUMNS }).length === 0
      if (!hasTodo) return []
      return conn().all<{ content: string; status: string }>(`select content, status from todo where session_id = ? order by position`, sessionID)
    },
    close() {
      db?.close()
      db = undefined
      hasTodo = undefined
    },
  }
}

function missingColumns(db: Db, required: Record<string, readonly string[]>): string[] {
  const missing: string[] = []
  for (const [table, columns] of Object.entries(required)) {
    const have = new Set(db.all<{ name: string }>(`select name from pragma_table_info(?)`, table).map(row => row.name))
    if (have.size === 0) {
      missing.push(`table ${table}`)
      continue
    }
    for (const column of columns) if (!have.has(column)) missing.push(`column ${table}.${column}`)
  }
  return missing
}

function toSession(row: SessionRow): SourceSession {
  return {
    id: row.id,
    parentID: row.parent_id || null,
    projectID: row.project_id,
    directory: row.directory,
    title: label(row.title) ?? "",
    agent: label(row.agent),
    model: modelName(row.model),
    cost: Number(row.cost) || 0,
    tokensInput: Number(row.tokens_input) || 0,
    tokensOutput: Number(row.tokens_output) || 0,
    created: row.time_created,
    updated: row.time_updated,
    archived: row.time_archived ?? null,
  }
}

function toMessage(row: MessageRow): SourceMessage {
  return {
    id: row.id,
    sessionID: row.session_id,
    seq: row.seq,
    type: row.type,
    created: row.time_created,
    updated: row.time_updated,
    data: parseObject(row.data),
  }
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

/** A text column that may hold plain text, a JSON string or a JSON object. */
function label(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "string") return String(value)
  const parsed = parseJson(value)
  if (typeof parsed === "string") return parsed || null
  if (isRecord(parsed)) {
    for (const key of ["title", "text", "name", "id"]) {
      const field = parsed[key]
      if (typeof field === "string" && field) return field
    }
  }
  return value || null
}

/** `provider/model` from `{"id","providerID"}` JSON, or the stored text. */
export function modelName(value: unknown): string | null {
  const parsed = typeof value === "string" ? parseJson(value) : value
  if (isRecord(parsed)) {
    const id = parsed.id ?? parsed.modelID
    const provider = parsed.providerID
    if (typeof id === "string" && id) return typeof provider === "string" && provider ? `${provider}/${id}` : id
    return null
  }
  return label(value)
}

function parseJson(text: string): unknown {
  const first = text.trimStart()[0]
  if (first !== "{" && first !== '"') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function count(limit: number): number {
  return Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : -1
}
