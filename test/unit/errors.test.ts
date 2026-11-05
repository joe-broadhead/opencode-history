import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { FAILURES } from "../../src/domain/common.js"

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
