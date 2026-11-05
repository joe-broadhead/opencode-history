// Where the index may live. The plugin writes a full, masked copy of every session there, and drops the tables of a
// file it rebuilds, so `indexPath` must never name OpenCode's own data or a place inside the project.
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, parse, resolve, sep } from "node:path"
import { defaultDatabasePath } from "../source/opencode-db.js"

/** Why an `indexPath` is refused: OpenCode's database or one of its files, OpenCode's data folder, or the project. */
type IndexPathProblem = "database" | "opencode-data" | "project"

/** The path with every symlink in its existing part resolved, so two spellings of one file compare equal. */
export function canonicalPath(path: string): string {
  const full = resolve(path)
  const rest: string[] = []
  let head = full
  for (;;) {
    try {
      return join(realpathSync(head), ...rest)
    } catch {
      const parent = dirname(head)
      if (parent === head) return full
      rest.unshift(basename(head))
      head = parent
    }
  }
}

const within = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep)

/** What INDEX_PATH_REFUSED says, per reason. None repeats the path. */
export const INDEX_PATH_MESSAGES: Record<IndexPathProblem | "foreign", string> = {
  database: "The indexPath option names OpenCode's own database or one of its files, which the index would overwrite.",
  "opencode-data": "The indexPath option is inside OpenCode's data folder, which only OpenCode writes.",
  project: "The indexPath option is inside this project's folder, where the index, a copy of every session, could be committed.",
  foreign: "The indexPath option names an existing file that is not a History index, so it was left unchanged.",
}

interface IndexPathContext {
  /** OpenCode's database, from the `database` option or its default. */
  readonly database: string
  /** The folders of the plugin instance's location: its directory and its project's root. */
  readonly projectFolders: readonly string[]
  /** True when the user set `indexPath`; the default, in the user's data folder, is never inside a project. */
  readonly custom: boolean
  readonly env?: Readonly<Record<string, string | undefined>>
}

/**
 * The reason `indexPath` cannot be used, or undefined. Plugin options can come from a project's own `opencode.json`,
 * which the plugin cannot tell apart from the user's, so the rules hold for every source:
 * - never OpenCode's database, its -wal, -shm or -journal file, or anything in OpenCode's data folder;
 * - a custom path never inside the project's directory or root, where the index could be committed. The user's home
 *   folder and the file system root are not treated as projects here, since every path is inside them.
 */
export function indexPathProblem(indexPath: string, context: IndexPathContext): IndexPathProblem | undefined {
  const target = canonicalPath(indexPath)
  const database = canonicalPath(context.database)
  if (["", "-wal", "-shm", "-journal"].some(suffix => target === database + suffix)) return "database"
  const data = canonicalPath(dirname(defaultDatabasePath(context.env as NodeJS.ProcessEnv | undefined)))
  if (within(target, data)) return "opencode-data"
  if (!context.custom) return undefined
  const home = canonicalPath(context.env?.HOME || homedir())
  for (const folder of context.projectFolders) {
    const root = canonicalPath(folder)
    if (root === home || root === parse(root).root) continue
    if (within(target, root)) return "project"
  }
  return undefined
}
