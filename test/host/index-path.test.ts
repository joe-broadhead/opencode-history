// The audit's live cases for indexPath, on the public @opencode/sdk host: the plugin pointed at OpenCode's own
// database, at another SQLite file a project's config names, and at a file inside the project. Each one must fail
// the plugin's setup and leave the file as it was, and OpenCode must keep working.
import { HOST_VERSION, project, removeRoot, root, startHost, waitFor, withOptions } from "./harness.js"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import plugin from "../../src/index.js"
import { openDb } from "../../src/domain/sqlite.js"

const database = join(root, "opencode.db")
const victim = join(root, "victim.db")
const directory = project("c")
const inside = join(directory, ".history", "index.db")
const location = { directory }

/** The plugin under another ID, so several copies with different options can load into one host. */
const copy = (id: string, options: Record<string, unknown>): Plugin.Plugin => ({ ...withOptions(plugin, options), id })
let host: Awaited<ReturnType<typeof startHost>>
const tables = (path: string) => {
  const db = openDb(path, { readOnly: true })
  try { return db.all<{ name: string }>("select name from sqlite_master where type = 'table' order by name").map(row => row.name) } finally { db.close() }
}
const refusals = () => host.logs.filter(entry => entry.text.includes("INDEX_PATH_REFUSED")).length

beforeAll(async () => {
  const db = openDb(victim)
  db.exec("create table precious (x)")
  db.exec("create table other (y)")
  db.run("insert into precious values (?)", "keep")
  db.close()
  host = await startHost([
    copy("history.d1", { database, indexPath: database }),
    copy("history.d2", { database, indexPath: victim }),
    copy("history.inside", { database, indexPath: inside }),
  ], database)
  await waitFor(async () => {
    await host.sdk.agent.list({ location }).catch(() => undefined)
    return refusals() >= 3
  }, 30_000, "the three plugin copies to refuse their indexPath")
})
afterAll(async () => {
  await host?.sdk.close()
  removeRoot()
})

describe(`indexPath refusals on @opencode/sdk, host version ${HOST_VERSION}`, () => {
  test("OpenCode's own database keeps its tables, and sessions still work", async () => {
    expect(tables(database)).toContain("session_v2")
    expect(tables(database)).not.toContain("docs")
    const session = await host.sdk.session.create({ title: "Still works", location })
    expect(session.id).toMatch(/^ses_/)
  })

  test("another SQLite file named by a project's config keeps its tables and rows", () => {
    expect(tables(victim)).toEqual(["other", "precious"])
    const db = openDb(victim, { readOnly: true })
    expect(db.all("select x from precious")).toEqual([{ x: "keep" }])
    db.close()
  })

  test("a path inside the project is never created", () => {
    expect(existsSync(inside)).toBe(false)
    expect(existsSync(join(directory, ".history"))).toBe(false)
  })
})
