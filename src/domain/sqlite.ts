// One SQLite driver for Node (tests) and Bun (the OpenCode host): node:sqlite works in both.
import { DatabaseSync, type SQLInputValue } from "node:sqlite"

export type Value = SQLInputValue
export type Row = Record<string, unknown>

export interface Db {
  all<T = Row>(sql: string, ...params: Value[]): T[]
  get<T = Row>(sql: string, ...params: Value[]): T | undefined
  run(sql: string, ...params: Value[]): void
  exec(sql: string): void
  transaction<T>(fn: () => T): T
  close(): void
}

export function openDb(path: string, options: { readOnly?: boolean; busyMs?: number } = {}): Db {
  const db = new DatabaseSync(path, { readOnly: options.readOnly ?? false })
  db.exec(`pragma busy_timeout = ${Math.max(0, Math.floor(options.busyMs ?? 5000))}`)
  if (options.readOnly) db.exec("pragma query_only = 1")
  const cache = new Map<string, ReturnType<DatabaseSync["prepare"]>>()
  const prepare = (sql: string) => {
    let statement = cache.get(sql)
    if (!statement) {
      statement = db.prepare(sql)
      cache.set(sql, statement)
    }
    return statement
  }
  return {
    all: <T>(sql: string, ...params: Value[]) => prepare(sql).all(...params) as T[],
    get: <T>(sql: string, ...params: Value[]) => prepare(sql).get(...params) as T | undefined,
    run: (sql, ...params) => {
      prepare(sql).run(...params)
    },
    exec: sql => db.exec(sql),
    transaction: fn => {
      db.exec("begin immediate")
      try {
        const result = fn()
        db.exec("commit")
        return result
      } catch (error) {
        db.exec("rollback")
        throw error
      }
    },
    close: () => {
      cache.clear()
      db.close()
    },
  }
}

/** SQLite's busy or locked result, by its primary code, or by its text where a driver gives no code. */
export function locked(cause: unknown): boolean {
  const code = typeof cause === "object" && cause !== null ? (cause as { errcode?: unknown }).errcode : undefined
  if (typeof code === "number") return (code & 0xff) === 5 || (code & 0xff) === 6
  return cause instanceof Error && /\bdatabase (?:table )?is locked\b/i.test(cause.message)
}
