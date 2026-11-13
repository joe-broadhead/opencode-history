import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { ACCESS_VALUES, NAMESPACE } from "../../src/domain/contract.js"
import { loadConfig } from "../../src/domain/config.js"
import { SCOPES } from "../../src/domain/schemas.js"
import { DEFAULT_RULES, KNOWN_READS } from "../../src/host/permissions.js"
import { ACTIONS, TOOL_NAMES } from "../../src/host/tools.js"
import { type Declaration, type DeclaredTool, declarationProblems, docProblems, effectFromRules, readPackage } from "../support/jelly-kit.js"
import { ACCESS_CHOICES, type PluginSetting, settingChoices, settingsProblems, settingValueIssue } from "../support/jelly-settings.js"

/**
 * The `jelly` section of package.json, which Jelly reads without loading the plugin. Jelly's agents have no base
 * "allow everything" rule, so this plugin's own default rules never reach them; Jelly writes each declared "ask" or
 * "deny" as that tool's default instead. The shared kit checks the declaration against Jelly's plugin authors'
 * standard; the tests below add what only History declares.
 */

const ROOT = new URL("../../", import.meta.url)
const pkg = readPackage(ROOT)
const jelly = pkg.jelly as Declaration & { title: string; tools: DeclaredTool[]; signIns: unknown[]; rpc: unknown[]; views: unknown[] }
const doc = readFileSync(new URL("docs/jelly.md", ROOT), "utf8")

describe("the jelly declaration", () => {
  test("declares flat privacy-related options", () => {
    const settings = (jelly.contributes as { settings: { key: string; type: string; default: unknown }[] }).settings
    expect(settings.map(({ key, type }) => ({ key, type }))).toEqual([
      { key: "access", type: "string" }, { key: "defaultScope", type: "string" }, { key: "maskDefaults", type: "boolean" },
    ])
    expect(loadConfig({ access: "read-only", defaultScope: "project", maskDefaults: true }).access).toBe("read-only")
    const defaults = loadConfig({})
    expect(settings.find(setting => setting.key === "access")?.default).toBe(defaults.access)
    expect(settings.find(setting => setting.key === "defaultScope")?.default).toBe(defaults.defaultScope)
    const maskDefaults = settings.find(setting => setting.key === "maskDefaults")?.default
    expect(maskDefaults).toBe(true)
    expect(loadConfig({ maskDefaults }).mask.map(String)).toEqual(defaults.mask.map(String))
  })
  describe("settings declare their choices", () => {
    const settings = (jelly.contributes as { settings: PluginSetting[] }).settings
    const setting = (key: string) => settings.find(entry => entry.key === key) as PluginSetting
    const accepts = (options: Record<string, unknown>) => { try { loadConfig(options); return true } catch { return false } }

    test("Jelly's setting schema reads them", () => {
      expect(settingsProblems(settings)).toEqual([])
    })

    test("access offers Jelly's three choices, word for word, and the parser takes exactly those", () => {
      expect(setting("access").choices).toEqual(ACCESS_CHOICES)
      expect(settingChoices(setting("access"))?.map(choice => choice.value)).toEqual([...ACCESS_VALUES])
      for (const { value } of ACCESS_CHOICES) expect(accepts({ access: value })).toBe(true)
      for (const value of ["read", "write", "none", "ALL"]) {
        expect(settingValueIssue(setting("access"), value)).not.toBeNull()
        expect(accepts({ access: value })).toBe(false)
      }
    })

    test("defaultScope offers the parser's scopes, and the parser refuses one outside them", () => {
      expect(settingChoices(setting("defaultScope"))?.map(choice => choice.value)).toEqual([...SCOPES])
      for (const value of SCOPES) expect(accepts({ defaultScope: value })).toBe(true)
      for (const value of ["session", "everywhere"]) {
        expect(settingValueIssue(setting("defaultScope"), value)).not.toBeNull()
        expect(accepts({ defaultScope: value })).toBe(false)
      }
    })

    test("maskDefaults stays a plain switch", () => {
      expect(setting("maskDefaults")).toEqual(expect.not.objectContaining({ enum: expect.anything(), choices: expect.anything() }))
      expect(settingChoices(setting("maskDefaults"))).toBeUndefined()
    })
  })

  test("follows the plugin authors' standard, with the effects the plugin's own default rules give", () => {
    expect(declarationProblems(ROOT, { effectOf: effectFromRules(DEFAULT_RULES), registered: TOOL_NAMES.map(name => `${NAMESPACE}_${name}`) })).toEqual([])
  })

  test("is titled History, with no sign-ins, RPC or views", () => {
    expect(jelly.title).toBe("History")
    expect(jelly.signIns).toEqual([])
    expect(jelly.rpc).toEqual([])
    expect(jelly.views).toEqual([])
  })

  test("declares exactly the plugin's tools, in order", () => {
    expect(jelly.tools.map(tool => tool.permission)).toEqual(TOOL_NAMES.map(name => `${NAMESPACE}_${name}`))
  })

  test("allows every declared tool, the action included, as the default access does", () => {
    expect(jelly.tools.filter(tool => tool.effect !== "allow")).toEqual([])
    for (const name of ACTIONS) expect(jelly.tools.find(tool => tool.permission === `${NAMESPACE}_${name}`)).toMatchObject({ effect: "allow", readOnly: false })
  })

  test("marks exactly the known reads read-only", () => {
    expect(jelly.tools.filter(tool => tool.readOnly).map(tool => tool.permission).sort()).toEqual([...KNOWN_READS].sort())
  })
})

describe("docs/jelly.md", () => {
  test("follows the plugin authors' standard", () => {
    expect(docProblems(ROOT)).toEqual([])
  })

  test("names the action tool and the option that makes it ask", () => {
    expect(doc).toContain("`history.pin`")
    expect(doc).toContain('`access: "ask-changes"`')
  })
})
