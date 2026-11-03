// One read-only SELECT over the index, in a child process with a deadline, on its own read-only connection, with capped rows, cells and bytes.
import { spawn } from "node:child_process"
import { dirname } from "node:path"
import type { SqlInput, SqlOutput } from "../domain/api.js"
import { BOUNDS } from "../domain/bounds.js"
import { HistoryError } from "../domain/common.js"
import { bounded } from "./common.js"
import { QueryError } from "./parse.js"

export const SQL_CELL_CHARS = 2000
export const SQL_BUSY_MS = 2000

/**
 * The statement with comments replaced by spaces and trailing semicolons dropped, ready to wrap in a subquery.
 * Rejects anything but one SELECT or WITH statement.
 */
export function checkSql(text: string): string {
  // `out` keeps strings and quoted names; `code` replaces them, so only real semicolons and keywords are seen.
  let out = ""
  let code = ""
  let at = 0
  while (at < text.length) {
    const char = text[at]!
    const pair = text.slice(at, at + 2)
    if (pair === "--") {
      const end = text.indexOf("\n", at)
      at = end < 0 ? text.length : end
      out += " "
      code += " "
    } else if (pair === "/*") {
      const end = text.indexOf("*/", at + 2)
      at = end < 0 ? text.length : end + 2
      out += " "
      code += " "
    } else if (char === "'" || char === '"' || char === "`" || char === "[") {
      // Strings and quoted names run to their closing quote; a doubled quote stays inside.
      const close = char === "[" ? "]" : char
      let end = at + 1
      for (;;) {
        end = text.indexOf(close, end)
        if (end < 0 || close === "]" || text[end + 1] !== close) break
        end += 2
      }
      if (end < 0) throw new QueryError("the SQL has an unclosed quote", "sql_rejected")
      out += text.slice(at, end + 1)
      code += "0"
      at = end + 1
    } else {
      out += char
      code += char
      at++
    }
  }
  const statement = code.trim().replace(/[;\s]+$/, "")
  if (!statement) throw new QueryError("the SQL is empty", "sql_rejected")
  if (statement.includes(";")) throw new QueryError("only one SQL statement is allowed", "sql_rejected")
  if (!/^(select|with)\b/i.test(statement)) throw new QueryError("only a SELECT or WITH statement is allowed", "sql_rejected")
  return out.trim().replace(/[;\s]+$/, "")
}

/**
 * The script the child process runs: one read-only connection, the statement, and the rows as JSON on stdout. It
 * reads its job from stdin, so nothing of the statement is on a command line. CommonJS, for `node -e` and `bun -e`.
 */
export const RUNNER = `"use strict"
const { DatabaseSync } = require("node:sqlite")
let raw = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => { raw += chunk })
process.stdin.on("end", () => {
  const job = JSON.parse(raw)
  const clip = text => {
    if (text.length <= job.cellChars) return text
    let end = Math.max(0, job.cellChars - 1)
    const code = text.charCodeAt(end - 1)
    if (end > 0 && code >= 0xd800 && code <= 0xdbff) end--
    return text.slice(0, end) + "\u2026"
  }
  const cell = value => {
    if (typeof value === "string") return clip(value)
    if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
    if (value instanceof Uint8Array) return "[blob, " + value.byteLength + " bytes]"
    return value === undefined ? null : value
  }
  let out
  try {
    const db = new DatabaseSync(job.path, { readOnly: true })
    try {
      db.exec("pragma busy_timeout = " + job.busyMs)
      db.exec("pragma query_only = 1")
      const statement = db.prepare(job.statement)
      let columns = typeof statement.columns === "function" ? statement.columns().map(column => column.name) : null
      const rows = []
      let bytes = 0, truncated = false
      for (const row of statement.iterate(...job.params)) {
        if (columns === null) columns = Object.keys(row)
        if (rows.length >= job.limit) { truncated = true; break }
        const cells = columns.map(name => cell(row[name]))
        bytes += JSON.stringify(cells).length
        if (bytes > job.maxBytes && rows.length > 0) { truncated = true; break }
        rows.push(cells)
      }
      out = { ok: true, columns: columns || [], rows, truncated }
    } finally {
      db.close()
    }
  } catch (error) {
    out = { ok: false, message: error && error.message ? String(error.message) : String(error), errcode: error && typeof error.errcode === "number" ? error.errcode : undefined }
  }
  process.stdout.write(JSON.stringify(out))
})
`

/** How long one statement may run before its process is killed. */
export const SQL_TIMEOUT_MS = 10_000
/** Most bytes of row data one statement returns; rows past it are cut and the result says truncated. */
export const SQL_OUTPUT_BYTES = 512 * 1024
/** Most bytes the child may write at all; past it, it is killed and the call fails with OUTPUT_LIMIT. */
export const SQL_STDOUT_BYTES = 4 * 1024 * 1024
/** Statements that run at once; more wait their turn. */
export const SQL_PARALLEL = 2

/** What the child answers. */
type Answer =
  | { readonly ok: true; readonly columns: string[]; readonly rows: unknown[][]; readonly truncated: boolean }
  | { readonly ok: false; readonly message: string; readonly errcode?: number }

/** The child's command: this runtime itself, as Bun or Node, with the runner script and an environment of its own. */
export function runnerCommand(): { readonly file: string; readonly args: string[]; readonly env: Record<string, string> } {
  const bun = typeof process.versions.bun === "string"
  const env: Record<string, string> = bun ? { BUN_BE_BUN: "1" } : {}
  // SQLite puts large sorts in temporary files.
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  return { file: process.execPath, args: bun ? ["-e", RUNNER] : ["--no-warnings", "-e", RUNNER], env }
}

let running = 0
const waiting: (() => void)[] = []
/** Waits for one of the SQL_PARALLEL slots, or rejects with CANCELLED. Returns the release. */
async function slot(signal?: AbortSignal): Promise<() => void> {
  while (running >= SQL_PARALLEL) {
    await new Promise<void>((resolve, reject) => {
      const wake = () => { signal?.removeEventListener("abort", cancel); resolve() }
      const cancel = () => {
        const at = waiting.indexOf(wake)
        if (at >= 0) waiting.splice(at, 1)
        reject(new HistoryError("CANCELLED"))
      }
      if (signal?.aborted) return cancel()
      waiting.push(wake)
      signal?.addEventListener("abort", cancel, { once: true })
    })
  }
  running++
  let released = false
  return () => {
    if (released) return
    released = true
    running--
    waiting.shift()?.()
  }
}

/** Runs one job in a child process, killed when it passes `timeoutMs`, writes too much, or `signal` aborts. */
function runChild(job: Record<string, unknown>, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<Answer> {
  const { file, args, env } = runnerCommand()
  return new Promise((resolve, reject) => {
    let stop: "timeout" | "output" | "cancelled" | undefined
    const chunks: Buffer[] = []
    let size = 0
    const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
    const kill = (why: typeof stop) => {
      stop ??= why
      child.kill("SIGKILL")
    }
    const timer = setTimeout(() => kill("timeout"), timeoutMs)
    const abort = () => kill("cancelled")
    signal?.addEventListener("abort", abort, { once: true })
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > SQL_STDOUT_BYTES) return kill("output")
      chunks.push(chunk)
    })
    child.stdin.on("error", () => {})
    child.on("error", error => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      reject(new QueryError("the SQL process could not start", "sql_failed", { cause: error }))
    })
    child.on("close", () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      if (stop === "timeout") return reject(new QueryError(`the SQL ran longer than ${timeoutMs / 1000} s and was stopped`, "sql_timeout"))
      if (stop === "output") return reject(new HistoryError("OUTPUT_LIMIT"))
      if (stop === "cancelled") return reject(new HistoryError("CANCELLED"))
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Answer)
      } catch (error) {
        reject(new QueryError("the SQL process gave no answer", "sql_failed", { cause: error }))
      }
    })
    child.stdin.end(JSON.stringify(job))
  })
}

export interface SqlOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/**
 * Runs `input.sql` with its params on a fresh read-only connection to the index at `path`, in a child process of its
 * own, so a slow or endless statement cannot block OpenCode: it is killed after SQL_TIMEOUT_MS with SQL_TIMEOUT. Rows
 * stop at the limit and at SQL_OUTPUT_BYTES of data.
 */
export async function sql(path: string, input: SqlInput, options: SqlOptions = {}): Promise<SqlOutput> {
  const body = checkSql(input.sql)
  const limit = bounded(input.limit, BOUNDS.sql.limit)
  if (options.signal?.aborted) throw new HistoryError("CANCELLED")
  const release = await slot(options.signal)
  let answer: Answer
  try {
    answer = await runChild({
      path,
      // The limit is our own integer, written into the SQL so it cannot shift the caller's ? numbering.
      // Wrapping renames duplicate columns (`id`, `id:1`), so names are unique and match the row keys.
      statement: `select * from (\n${body}\n) limit ${limit + 1}`,
      params: input.params ?? [],
      limit,
      cellChars: SQL_CELL_CHARS,
      maxBytes: SQL_OUTPUT_BYTES,
      busyMs: SQL_BUSY_MS,
    }, dirname(path), options.timeoutMs ?? SQL_TIMEOUT_MS, options.signal)
  } finally {
    release()
  }
  if (!answer.ok) {
    const cause = Object.assign(new Error(answer.message), answer.errcode === undefined ? {} : { errcode: answer.errcode })
    if (/unable to open|cannot open/i.test(answer.message)) throw new QueryError("the history index could not be opened for reading", "sql_failed", { cause })
    throw new QueryError("the SQL failed", "sql_failed", { cause })
  }
  return { columns: answer.columns, rows: answer.rows, truncated: answer.truncated }
}
