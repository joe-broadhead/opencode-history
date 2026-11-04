// A synthetic OpenCode 2.2.x database for tests. Table layouts follow session_v2, session_message, project and todo.
import { rmSync } from "node:fs"
import { join } from "node:path"
import { openDb, type Db } from "../../src/domain/sqlite.js"
import { tempDir } from "../temp.js"

export type FixtureTable = "project" | "session_v2" | "session_message" | "todo"

export const FIXTURE_TABLES: Record<FixtureTable, readonly string[]> = {
  project: [
    `create table project (
      id text primary key,
      worktree text not null,
      vcs text,
      name text,
      icon_url text,
      icon_color text,
      time_created integer not null,
      time_updated integer not null,
      time_initialized integer,
      sandboxes text not null,
      commands text,
      icon_url_override text,
      time_active integer default 0 not null,
      time_archived integer
    )`,
  ],
  session_v2: [
    `create table session_v2 (
      id text primary key,
      project_id text not null,
      workspace_id text,
      parent_id text,
      fork_session_id text,
      fork_boundary text,
      slug text not null,
      directory text not null,
      path text,
      title text,
      version text not null,
      share_url text,
      summary_additions integer,
      summary_deletions integer,
      summary_files integer,
      summary_diffs text,
      metadata text,
      cost real default 0 not null,
      tokens_input integer default 0 not null,
      tokens_output integer default 0 not null,
      tokens_reasoning integer default 0 not null,
      tokens_cache_read integer default 0 not null,
      tokens_cache_write integer default 0 not null,
      revert text,
      permission text,
      agent text,
      model text,
      time_created integer not null,
      time_updated integer not null,
      time_compacting integer,
      time_archived integer,
      time_suspended integer,
      resume_attempts integer default 0 not null,
      time_idle integer,
      time_viewed integer,
      idle_outcome text,
      time_busy integer,
      foreign key (project_id) references project(id) on delete cascade
    )`,
    `create index session_v2_project_idx on session_v2 (project_id)`,
    `create index session_v2_parent_idx on session_v2 (parent_id)`,
  ],
  session_message: [
    `create table session_message (
      id text primary key,
      session_id text not null,
      type text not null,
      seq integer not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null,
      foreign key (session_id) references session_v2(id) on delete cascade
    )`,
    `create unique index session_message_session_seq_idx on session_message (session_id, seq)`,
    `create index session_message_session_type_seq_idx on session_message (session_id, type, seq)`,
  ],
  todo: [
    `create table todo (
      session_id text not null,
      content text not null,
      status text not null,
      priority text not null,
      position integer not null,
      time_created integer not null,
      time_updated integer not null,
      primary key (session_id, position)
    )`,
    `create index todo_session_idx on todo (session_id)`,
  ],
}

export interface ModelJson {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
}

export interface FixtureProject {
  readonly id: string
  readonly worktree?: string
  readonly name?: string | null
}

export interface FixtureSession {
  readonly id: string
  /** Created in `project` when missing, with the session directory as worktree. */
  readonly projectID?: string
  readonly parentID?: string | null
  readonly directory?: string
  /** null stores SQL null; omitted gives "Session <id>". */
  readonly title?: string | null
  readonly agent?: string | null
  /** Objects are stored as JSON, strings as given. */
  readonly model?: ModelJson | string | null
  readonly cost?: number
  readonly tokensInput?: number
  readonly tokensOutput?: number
  readonly created?: number
  readonly updated?: number
  readonly archived?: number | null
}

export interface FixtureMessage {
  readonly sessionID: string
  readonly type: string
  /** Data object, stored as JSON; a string is stored as given, to test bad rows. */
  readonly data: Record<string, unknown> | string
  /** Defaults to one more than the session's highest seq, or 0. */
  readonly seq?: number
  readonly id?: string
  readonly created?: number
  readonly updated?: number
}

export interface FixtureTodo {
  readonly sessionID: string
  readonly content: string
  readonly status?: string
  readonly priority?: string
  readonly position?: number
}

export interface OpencodeDbFixture {
  readonly dir: string
  readonly path: string
  /** The writable connection the helpers use. */
  readonly db: Db
  insertProject(project: FixtureProject): void
  insertSession(session: FixtureSession): void
  /** Inserts the message and moves the session's time_updated forward to the message time. */
  insertMessage(message: FixtureMessage): { id: string; seq: number }
  insertTodo(todo: FixtureTodo): void
  touchSession(sessionID: string, updated: number): void
  /** Deletes the session; its messages go with it, as foreign keys cascade. */
  deleteSession(sessionID: string): void
  /** Closes the writable connection; the file stays until cleanup. */
  close(): void
  cleanup(): void
}

export interface FixtureOptions {
  /** Tables to create; defaults to all four. */
  readonly tables?: readonly FixtureTable[]
  /** WAL like OpenCode itself; default true. */
  readonly wal?: boolean
  /** Base time for defaults, epoch ms. */
  readonly now?: number
}

export const FIXTURE_NOW = Date.UTC(2026, 9, 1, 12)

export function createOpencodeDb(options: FixtureOptions = {}): OpencodeDbFixture {
  const dir = tempDir("opencode-history-fixture-")
  const path = join(dir, "opencode.db")
  const db = openDb(path)
  if (options.wal ?? true) db.exec("pragma journal_mode = wal")
  const tables = options.tables ?? (Object.keys(FIXTURE_TABLES) as FixtureTable[])
  for (const table of tables) {
    for (const sql of FIXTURE_TABLES[table]) db.exec(sql)
  }
  // node:sqlite enforces foreign keys; a layout without the referenced tables cannot.
  if (!tables.includes("project") || !tables.includes("session_v2")) db.exec("pragma foreign_keys = off")
  const now = options.now ?? FIXTURE_NOW
  let clock = now
  const tick = () => ++clock
  let closed = false

  const fixture: OpencodeDbFixture = {
    dir,
    path,
    db,
    insertProject(project) {
      db.run(
        // An upsert, not a replace: replacing would cascade-delete the project's sessions.
        `insert into project (id, worktree, name, time_created, time_updated, sandboxes) values (?, ?, ?, ?, ?, '[]')
         on conflict(id) do update set worktree = excluded.worktree, name = excluded.name`,
        project.id,
        project.worktree ?? `/work/${project.id}`,
        project.name ?? null,
        now,
        now,
      )
    },
    insertSession(session) {
      const projectID = session.projectID ?? "proj_app"
      if (tables.includes("project")) {
        db.run(
          `insert or ignore into project (id, worktree, time_created, time_updated, sandboxes) values (?, ?, ?, ?, '[]')`,
          projectID,
          session.directory ?? "/work/app",
          now,
          now,
        )
      }
      const created = session.created ?? tick()
      const model = session.model === undefined || session.model === null ? null : typeof session.model === "string" ? session.model : JSON.stringify(session.model)
      db.run(
        `insert into session_v2 (id, project_id, parent_id, slug, directory, title, version, cost, tokens_input, tokens_output,
          agent, model, time_created, time_updated, time_archived)
         values (?, ?, ?, ?, ?, ?, '2.2.3', ?, ?, ?, ?, ?, ?, ?, ?)`,
        session.id,
        projectID,
        session.parentID ?? null,
        session.id,
        session.directory ?? "/work/app",
        session.title === undefined ? `Session ${session.id}` : session.title,
        session.cost ?? 0,
        session.tokensInput ?? 0,
        session.tokensOutput ?? 0,
        session.agent === undefined ? "build" : session.agent,
        model,
        created,
        session.updated ?? created,
        session.archived ?? null,
      )
    },
    insertMessage(message) {
      const seq =
        message.seq ?? (db.get<{ seq: number | null }>(`select max(seq) as seq from session_message where session_id = ?`, message.sessionID)?.seq ?? -1) + 1
      const id = message.id ?? `msg_${message.sessionID}_${seq}`
      const created = message.created ?? tick()
      const updated = message.updated ?? created
      const data = typeof message.data === "string" ? message.data : JSON.stringify(message.data)
      db.run(
        `insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?)`,
        id,
        message.sessionID,
        message.type,
        seq,
        created,
        updated,
        data,
      )
      db.run(`update session_v2 set time_updated = max(time_updated, ?) where id = ?`, updated, message.sessionID)
      return { id, seq }
    },
    insertTodo(todo) {
      const position =
        todo.position ?? (db.get<{ position: number | null }>(`select max(position) as position from todo where session_id = ?`, todo.sessionID)?.position ?? -1) + 1
      db.run(
        `insert into todo (session_id, content, status, priority, position, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?)`,
        todo.sessionID,
        todo.content,
        todo.status ?? "pending",
        todo.priority ?? "medium",
        position,
        now,
        now,
      )
    },
    touchSession(sessionID, updated) {
      db.run(`update session_v2 set time_updated = ? where id = ?`, updated, sessionID)
    },
    deleteSession(sessionID) {
      db.run(`delete from session_v2 where id = ?`, sessionID)
    },
    close() {
      if (closed) return
      closed = true
      db.close()
    },
    cleanup() {
      fixture.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return fixture
}

// Builders for message `data` objects, in the shapes OpenCode 2.2.x stores.

export function userData(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { text, time: { created: FIXTURE_NOW }, ...extra }
}

export function textPart(text: string): Record<string, unknown> {
  return { type: "text", text, time: { created: FIXTURE_NOW, completed: FIXTURE_NOW } }
}

export function reasoningPart(text: string): Record<string, unknown> {
  return { type: "reasoning", text, time: { created: FIXTURE_NOW, completed: FIXTURE_NOW } }
}

export interface ToolPartOptions {
  readonly id?: string
  readonly status?: "completed" | "error" | "running"
  /** Text content of the result; omitted for error and running states unless given. */
  readonly output?: string | readonly string[]
  readonly error?: string
  readonly metadata?: Record<string, unknown>
}

export function toolPart(name: string, input: Record<string, unknown>, options: ToolPartOptions = {}): Record<string, unknown> {
  const status = options.status ?? (options.error === undefined ? "completed" : "error")
  const outputs = options.output === undefined ? (status === "completed" ? [""] : []) : typeof options.output === "string" ? [options.output] : options.output
  const state: Record<string, unknown> = { status, input }
  if (outputs.length > 0) state.content = outputs.map(text => ({ type: "text", text }))
  if (options.metadata !== undefined || status === "completed") state.metadata = options.metadata ?? { truncated: false }
  if (options.error !== undefined) state.error = { type: "unknown", message: options.error }
  return { type: "tool", id: options.id ?? `call_${name}`, name, state, time: { created: FIXTURE_NOW, completed: FIXTURE_NOW } }
}

export function assistantData(content: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: "build",
    model: { id: "claude-sonnet-5-5", providerID: "anthropic" },
    content,
    cost: 0,
    finish: "stop",
    time: { created: FIXTURE_NOW, completed: FIXTURE_NOW },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...extra,
  }
}

export function syntheticData(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { text, time: { created: FIXTURE_NOW }, ...extra }
}

/** A command the user ran in the session, with its output when it has any. */
export function shellData(command: string, output?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    shellID: "sh_fixture",
    command,
    status: "exited",
    exit: 0,
    ...(output === undefined ? {} : { output: { output, cursor: output.length, size: output.length, truncated: false } }),
    time: { created: FIXTURE_NOW, completed: FIXTURE_NOW },
    ...extra,
  }
}

export function compactionData(summary: string, status = "completed"): Record<string, unknown> {
  return { reason: "auto", status, summary, time: { created: FIXTURE_NOW } }
}

export function idleData(outcome: "succeeded" | "failed" | "interrupted"): Record<string, unknown> {
  return { outcome, time: { created: FIXTURE_NOW } }
}
