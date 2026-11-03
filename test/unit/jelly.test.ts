import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { NAMESPACE } from "../../src/domain/contract.js"
import { DEFAULT_RULES, KNOWN_READS } from "../../src/host/permissions.js"
import { ACTIONS, TOOL_NAMES } from "../../src/host/tools.js"

/**
 * The `jelly` section of package.json, which Jelly reads without loading the plugin. Jelly's agents have no base
 * "allow everything" rule, so this plugin's own default rules never reach them; Jelly writes each declared "ask" or
 * "deny" as that tool's default instead. So each declared effect must be the one these rules give the tool after a
 * base allow, the declared tools must be the plugin's tools, and the declared skills the ones the package ships.
 */

type Tool = { name: string; permission: string; effect: string; readOnly: boolean }
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
const jelly = pkg.jelly as { title: string; tools: Tool[]; skills: string[]; signIns: unknown[]; rpc: unknown[]; views: unknown[] }
const doc = readFileSync(new URL("../../docs/jelly.md", import.meta.url), "utf8")
const rules: readonly { action: string; resource: string; effect: string }[] = [{ action: "*", resource: "*", effect: "allow" }, ...DEFAULT_RULES]
const wildcard = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`)
const effectOf = (action: string) => [...rules].reverse().find(rule => wildcard(rule.action).test(action) && rule.resource === "*")?.effect

describe("the jelly declaration", () => {
  test("is titled History, with no sign-ins, RPC or views", () => {
    expect(jelly.title).toBe("History")
    expect(jelly.signIns).toEqual([])
    expect(jelly.rpc).toEqual([])
    expect(jelly.views).toEqual([])
  })

  test("declares exactly the plugin's tools, in order", () => {
    expect(jelly.tools.map(tool => tool.permission)).toEqual(TOOL_NAMES.map(name => `${NAMESPACE}_${name}`))
  })

  test("gives each tool the effect the plugin's own default rules give it", () => {
    for (const tool of jelly.tools) expect(effectOf(tool.permission), tool.permission).toBe(tool.effect)
    expect(jelly.tools.filter(tool => tool.effect === "ask").map(tool => tool.permission)).toEqual([...ACTIONS].map(name => `${NAMESPACE}_${name}`))
  })

  test("marks exactly the known reads read-only", () => {
    expect(jelly.tools.filter(tool => tool.readOnly).map(tool => tool.permission).sort()).toEqual([...KNOWN_READS].sort())
  })

  test("names each tool once, as the engine names its permission (namespace.tool for namespace_tool)", () => {
    const names = jelly.tools.map(tool => tool.name)
    expect(new Set(names).size).toBe(names.length)
    for (const tool of jelly.tools) expect(tool.name.replace(".", "_"), tool.name).toBe(tool.permission)
  })

  test("names every skill the package ships", () => {
    expect([...jelly.skills].sort()).toEqual(readdirSync(new URL("../../skills", import.meta.url)).sort())
  })
})

describe("docs/jelly.md", () => {
  test("counts the declared tools, names the asking ones and lists the declared skills", () => {
    const reads = jelly.tools.filter(tool => tool.readOnly).length
    expect(doc).toContain(`${jelly.tools.length} tools are declared (${reads} read-only)`)
    for (const tool of jelly.tools.filter(tool => tool.effect === "ask")) expect(doc).toContain(`\`${tool.name}\``)
    for (const skill of jelly.skills) expect(doc).toContain(`\`${skill}\``)
  })

  test("names no version, so that it stays true after a release", () => {
    expect(doc).not.toContain(pkg.version)
  })
})
