// The README, the docs and the shipped code are one contract: the error codes, the tested releases and the scripting
// examples must match the source. A drift fails this file; run UPDATE_DOCS=1 npm test to regenerate the README block.
import { describe, expect, test } from "vitest"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { FAILURES } from "../../src/domain/common.js"
import { NEXT_STEPS, TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { TOOL_DEFINITIONS } from "../../src/host/tools.js"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))
const read = (path: string) => readFileSync(`${ROOT}${path}`, "utf8")
const UPDATE = process.env.UPDATE_DOCS === "1"

function walk(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(`${ROOT}${dir}`, { withFileTypes: true })
    .flatMap(entry => {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : walk(path, extensions)
      return extensions.some(extension => entry.name.endsWith(extension)) ? [path] : []
    })
    .sort()
}

const SOURCES = walk("src", [".ts", ".tsx"])
const TESTS = walk("test", [".ts", ".tsx"])
const DOCS = walk("docs", [".md"])
const FILES = ["README.md", "AGENTS.md", "SECURITY.md", "CHANGELOG.md", "CONTRIBUTING.md"]
/** The one list, read as data: the status, the checks and CI all read this file. */
const TESTED_HOSTS = JSON.parse(read("src/host/tested-hosts.json")) as string[]

/** Every code a caller can see: the plugin's own, and the refusals its tools RPC adds. */
const CODES = [...new Set<string>([...Object.keys(FAILURES), ...Object.keys(NEXT_STEPS)])].sort()

const storyOf = (code: string): readonly [string, string] =>
  Object.hasOwn(FAILURES, code)
    ? [FAILURES[code as keyof typeof FAILURES][0], FAILURES[code as keyof typeof FAILURES][1] ?? "Nothing further."]
    : ["The tools RPC refused the call.", NEXT_STEPS[code as keyof typeof NEXT_STEPS]!]

test("the README's code table is the code table: every code, in both directions", () => {
  const open = "<!-- generated:codes -->"
  const close = "<!-- /generated:codes -->"
  const body = ["| Code | What happened | Next step |", "| --- | --- | --- |", ...CODES.map(code => {
    const [what, next] = storyOf(code)
    return `| \`${code}\` | ${what} | ${next} |`
  })].join("\n")
  const text = read("README.md")
  const start = text.indexOf(open)
  const end = text.indexOf(close)
  expect(start !== -1 && end > start).toBe(true)
  const expected = `${text.slice(0, start + open.length)}\n\n${body}\n\n${text.slice(end)}`
  if (UPDATE && expected !== text) writeFileSync(`${ROOT}README.md`, expected)
  expect(read("README.md"), "the README codes block is stale; run UPDATE_DOCS=1 npm test").toBe(expected)
  const raised = new Set<string>()
  for (const path of SOURCES) {
    if (path.endsWith("src/host/tools-rpc.ts")) continue
    const source = read(path)
    for (const match of source.matchAll(/\b(?:fail|failure|error)\(\s*"([A-Z][A-Z0-9_]{2,})"/g)) raised.add(match[1]!)
    for (const match of source.matchAll(/"(?:code|reason)":\s*"([A-Z][A-Z0-9_]{2,})"/g)) raised.add(match[1]!)
  }
  expect([...raised].filter(code => !CODES.includes(code))).toEqual([])
})

describe("the tested releases", () => {
  test("every tested-host mention is TESTED_HOSTS, in the same order", () => {
    const unreleased = read("CHANGELOG.md").split(/^## \[/m).find(section => section.startsWith("[Unreleased]")) ?? ""
    for (const file of [...FILES.filter(name => name !== "CHANGELOG.md"), ...DOCS]) {
      const text = read(file)
      for (const match of text.matchAll(/tested on ([0-9][0-9.,\s]*(?:and\s+[0-9][0-9.]*)?)/g)) {
        const said = match[1]!.replace(/[.,\s]+$/u, "").split(/,\s*|\s+and\s+/).map(part => part.trim()).filter(Boolean)
        expect({ file, said }).toEqual({ file, said: [...TESTED_HOSTS] })
      }
    }
    for (const match of unreleased.matchAll(/tested on ([0-9][0-9.,\s]*(?:and\s+[0-9][0-9.]*)?)/g)) {
      const said = match[1]!.replace(/[.,\s]+$/u, "").split(/,\s*|\s+and\s+/).map(part => part.trim()).filter(Boolean)
      expect(said).toEqual([...TESTED_HOSTS])
    }
    expect(TESTED_HOSTS).toContain("2.2.6")
  })
})

test("no shipped text carries internal wording", () => {
  const banned = [/\bowner'?s? (decision|ruling)\b/iu, /\bthe lead\b/iu, /\blane\b/iu, /hey-jelly #/iu, /\b(?:G[1-4]|W2|R1[0-8])\b/u]
  for (const file of [...FILES, ...DOCS, ...SOURCES, ...TESTS]) {
    if (file === "test/unit/docs.test.ts") continue
    const text = read(file)
    for (const pattern of banned) expect({ file, pattern: String(pattern), hit: pattern.test(text) }).toEqual({ file, pattern: String(pattern), hit: false })
  }
})

describe("docs/scripting.md", () => {
  // Continuation lines joined, so a call split over lines is read whole.
  const text = read("docs/scripting.md").replace(/\\\n\s*/g, " ")
  const prefix = `/api/rpc/${TOOLS_RPC_ID}/`

  test("every call has the location header and the envelope, and names a method the plugin has", () => {
    const methods = new Set<string>(TOOL_DEFINITIONS.map(tool => tool.name))
    const calls = [...text.matchAll(/opencode api post (\/api\/rpc\/[^\s\\]+)([^\n]*)/g)]
    expect(calls.length).toBeGreaterThan(0)
    for (const [, url, rest] of calls) {
      const method = url!.startsWith(prefix) ? url!.slice(prefix.length).split(/[?#]/)[0]! : (url ?? "")
      expect({ url, known: methods.has(method) || method === "describe" }).toEqual({ url, known: true })
      expect({ url, header: rest!.includes('-H "x-opencode-directory:$PWD"') }).toEqual({ url, header: true })
    }
    for (const match of text.matchAll(/-d '(\{"input":\{[\s\S]*?\}\})'/g)) {
      if (match[1]!.includes("…")) continue
      const body = JSON.parse(match[1]!) as { input: Record<string, unknown> }
      expect(Object.keys(body)).toEqual(["input"])
      const keys = Object.keys(body.input)
      expect(keys.filter(key => !["sessionID", "input"].includes(key))).toEqual([])
      if (keys.length === 0) continue
      expect(typeof body.input["sessionID"]).toBe("string")
    }
  })

  test("documents every method", () => {
    for (const tool of TOOL_DEFINITIONS) expect(text).toContain(`\`${tool.name}\``)
  })
})
