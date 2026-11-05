import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { FAILURES } from "../../src/domain/common.js"
import { loadConfig } from "../../src/domain/config.js"
import { checkHost } from "../../src/host/compat.js"
import { loadSkills } from "../../src/host/skills.js"

const root = join(import.meta.dirname, "../..")
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [])

/** The codes in the Errors table of docs/configuration.md. */
function documented(): string[] {
  const text = readFileSync(join(root, "docs/configuration.md"), "utf8")
  const section = text.slice(text.indexOf("\n## Errors\n"))
  return [...section.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map(match => match[1]!)
}

describe("the error table", () => {
  test("documents every code the plugin has, once, and no other", () => {
    const codes = documented()
    expect(new Set(codes).size).toBe(codes.length)
    expect([...codes].sort()).toEqual(Object.keys(FAILURES).sort())
  })

  test("every code is raised somewhere outside the table", () => {
    const text = sources(join(root, "src")).filter(file => !file.endsWith(join("domain", "common.ts"))).map(file => readFileSync(file, "utf8")).join("\n")
    for (const code of Object.keys(FAILURES)) expect(text, code).toContain(`"${code}"`)
  })
})

describe("setup failures and warnings", () => {
  test("show the next step from the table, the one source", async () => {
    const hint = (code: keyof typeof FAILURES) => `Next step: ${FAILURES[code][1]}`
    expect(() => loadConfig({ unknown: true })).toThrow(hint("OPTIONS_INVALID"))
    expect(() => checkHost("2.3.0", false)).toThrow(hint("HOST_UNTESTED"))
    const warnings: string[] = []
    await loadSkills("/nonexistent-history-package", message => { warnings.push(message) })
    expect(warnings[0]).toMatch(/^SKILLS_INVALID: /)
    expect(warnings[0]!.endsWith(hint("SKILLS_INVALID"))).toBe(true)
  })
})
