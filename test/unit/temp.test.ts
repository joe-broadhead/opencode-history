// Every test's temp root sits where OpenCode's upward search for .opencode folders and opencode.json files finds
// nothing of the user's (QA X7).
import { existsSync, realpathSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, sep } from "node:path"
import { expect, test } from "vitest"
import { TEMP_BASE, tempDir } from "../temp.js"

test("temp roots are under /tmp, outside the home folder, with no OpenCode config above them", () => {
  const home = realpathSync(homedir())
  const dir = tempDir("history-temp-")
  expect(dir.startsWith(TEMP_BASE + sep)).toBe(true)
  expect(TEMP_BASE).toBe(realpathSync("/tmp"))
  expect(dir.startsWith(home + sep)).toBe(false)
  for (let folder = dir; dirname(folder) !== folder; folder = dirname(folder)) {
    for (const name of [".opencode", "opencode.json", "opencode.jsonc"]) expect(existsSync(join(dirname(folder), name)), join(dirname(folder), name)).toBe(false)
  }
  rmSync(dir, { recursive: true, force: true })
})
