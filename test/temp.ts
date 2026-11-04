// Temporary folders for every test: under /tmp (/private/tmp on macOS), never under the home folder or the platform's
// per-user temp folder. OpenCode searches upward from a project for `.opencode/` folders and opencode.json files, so a
// temp root under $HOME would pick up the user's own agents and rules.
import { existsSync, mkdtempSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, sep } from "node:path"

/** The OpenCode config names that the upward search reads in each folder. */
const FOUND_UPWARD = [".opencode", "opencode.json", "opencode.jsonc"]

function base(): string {
  const root = realpathSync("/tmp")
  const home = realpathSync(homedir())
  if (root === home || root.startsWith(home + sep)) throw new Error(`test isolation: ${root} is inside the home folder ${home}`)
  for (let folder = root; ; folder = dirname(folder)) {
    const found = FOUND_UPWARD.map(name => join(folder, name)).filter(path => existsSync(path))
    if (found.length) throw new Error(`test isolation: OpenCode would read ${found.join(", ")} above every test project; remove it to run the tests`)
    if (dirname(folder) === folder) break
  }
  return root
}

/** The folder every test's temp root is made in. */
export const TEMP_BASE = base()

/** A new empty folder under TEMP_BASE, with symlinks resolved. */
export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(TEMP_BASE, prefix)))
}
