import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { canonicalPath, indexPathProblem } from "../../src/domain/paths.js"

let root: string
let env: Record<string, string>
let database: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "history-paths-")))
  env = { HOME: join(root, "home"), XDG_DATA_HOME: join(root, "home", ".local", "share") }
  database = join(env.XDG_DATA_HOME!, "opencode", "opencode.db")
  mkdirSync(join(env.XDG_DATA_HOME!, "opencode"), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const check = (indexPath: string, over: { database?: string; projectFolders?: string[]; custom?: boolean } = {}) =>
  indexPathProblem(indexPath, { database, projectFolders: [], custom: true, env, ...over })

describe("indexPathProblem", () => {
  it("accepts the default path and a custom file outside OpenCode's data and the project", () => {
    expect(check(join(env.XDG_DATA_HOME!, "opencode-history", "index.db"), { custom: false, projectFolders: [env.HOME!] })).toBeUndefined()
    expect(check(join(root, "elsewhere", "history.db"), { projectFolders: [join(root, "work", "app")] })).toBeUndefined()
  })

  it("refuses OpenCode's own database and its -wal, -shm and -journal files", () => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) expect(check(database + suffix)).toBe("database")
  })

  it("refuses a configured database outside the data folder, also through a symlink or another spelling", () => {
    const other = join(root, "db", "opencode.db")
    mkdirSync(join(root, "db"))
    symlinkSync(join(root, "db"), join(root, "link"))
    expect(check(join(root, "link", "opencode.db"), { database: other })).toBe("database")
    expect(check(join(root, "db", ".", "..", "db", "opencode.db"), { database: other })).toBe("database")
  })

  it("refuses anything inside OpenCode's data folder", () => {
    expect(check(join(env.XDG_DATA_HOME!, "opencode", "history.db"))).toBe("opencode-data")
    expect(check(join(env.XDG_DATA_HOME!, "opencode", "deep", "x.db"))).toBe("opencode-data")
  })

  it("uses ~/.local/share/opencode when XDG_DATA_HOME is unset", () => {
    delete env.XDG_DATA_HOME
    expect(check(join(env.HOME!, ".local", "share", "opencode", "index.db"))).toBe("opencode-data")
  })

  it("refuses a custom path inside the project, where a committed config could make the index be committed", () => {
    const project = join(root, "work", "app")
    mkdirSync(project, { recursive: true })
    expect(check(join(project, ".history", "index.db"), { projectFolders: [join(project, "pkg"), project] })).toBe("project")
    expect(check(join(project + "-other", "index.db"), { projectFolders: [project] })).toBeUndefined()
  })

  it("does not treat the home folder or the file system root as a project", () => {
    expect(check(join(env.HOME!, "history", "index.db"), { projectFolders: [env.HOME!, "/"] })).toBeUndefined()
  })
})

describe("canonicalPath", () => {
  it("resolves symlinks in the part that exists and keeps the rest", () => {
    mkdirSync(join(root, "real"))
    symlinkSync(join(root, "real"), join(root, "alias"))
    expect(canonicalPath(join(root, "alias", "missing", "index.db"))).toBe(join(root, "real", "missing", "index.db"))
  })
})
