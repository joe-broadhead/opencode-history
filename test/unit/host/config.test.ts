import { describe, expect, test } from "vitest"
import { homedir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { loadConfig } from "../../../src/domain/config.js"
import { DEFAULT_MASK } from "../../../src/extract/index.js"
import { checkHost, HOST_RANGE, tested } from "../../../src/host/compat.js"

describe("host check", () => {
  test("the tested line is 2.2.3 up to, not including, 2.3.0, as package.json states", () => {
    expect(HOST_RANGE).toBe(">=2.2.3 <2.3.0")
    expect(JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).opencode.host).toBe(HOST_RANGE)
    for (const version of ["2.2.3", "2.2.4", "2.2.10"]) expect(tested(version), version).toBe(true)
    for (const version of ["2.2.2", "2.3.0", "3.0.0", "2.2.4-beta.1", "0.0.0-dev-377", "unknown", "", "v2.2.3"]) expect(tested(version), version).toBe(false)
  })
  test("an untested host is refused with the next step", () => {
    expect(() => checkHost("2.3.0", false)).toThrow("HOST_UNTESTED: History is tested on OpenCode >=2.2.3 <2.3.0, found 2.3.0. Next step: Use OpenCode 2.2.3 or a later 2.2.x release, or set the plugin option allowUntestedHost: true to run anyway.")
    expect(() => checkHost("unknown", false)).toThrow("found unknown")
  })
  test("allowUntestedHost runs an untested host and keeps a warning for the status", () => {
    expect(checkHost("2.3.0", true)).toEqual({ required: HOST_RANGE, found: "2.3.0", availability: "HOST_UNTESTED", next: expect.stringContaining("untested") })
    expect(checkHost("2.2.4", false)).toEqual({ required: HOST_RANGE, found: "2.2.4", availability: "AVAILABLE" })
  })
})

describe("plugin options", () => {
  const env = { XDG_DATA_HOME: "/xdg/data" }
  test("defaults: OpenCode's database and the index under XDG data, project scope, extraction defaults, the built-in masks, no recall model", () => {
    expect(loadConfig(undefined, env)).toEqual({
      database: "/xdg/data/opencode/opencode.db",
      indexPath: "/xdg/data/opencode-history/index.db",
      defaultScope: "project",
      index: { reasoning: false, toolResults: true, maxDocChars: 8000 },
      mask: DEFAULT_MASK,
      recall: { synthesize: false },
      allowUntestedHost: false,
    })
    expect(loadConfig({}, { XDG_DATA_HOME: "relative/data" })).toMatchObject({
      database: join(homedir(), ".local/share/opencode/opencode.db"),
      indexPath: join(homedir(), ".local/share/opencode-history/index.db"),
    })
  })

  test("each option is applied", () => {
    const config = loadConfig({
      database: "/db/opencode.db", indexPath: "/idx/history.db", defaultScope: "all",
      index: { reasoning: true, toolResults: false, maxDocChars: 2000 },
      mask: ["sk-[A-Za-z0-9]{20,}", "password=\\S+"],
      maskDefaults: false,
      recall: { synthesize: true, model: "openrouter/anthropic/claude-sonnet" },
      allowUntestedHost: true,
    }, env)
    expect(config).toEqual({
      database: "/db/opencode.db", indexPath: "/idx/history.db", defaultScope: "all",
      index: { reasoning: true, toolResults: false, maxDocChars: 2000 },
      mask: [/sk-[A-Za-z0-9]{20,}/g, /password=\S+/g],
      recall: { synthesize: true, model: { providerID: "openrouter", id: "anthropic/claude-sonnet" } },
      allowUntestedHost: true,
    })
    expect("key sk-abcdefghijklmnopqrstuvwx end".replace(config.mask[0]!, "[masked]")).toBe("key [masked] end")
    expect(loadConfig({ index: { reasoning: true } }, env).index).toEqual({ reasoning: true, toolResults: true, maxDocChars: 8000 })
  })

  test("mask adds to the built-in patterns, and maskDefaults: false turns them off", () => {
    expect(loadConfig({ mask: ["internal-[0-9]+"] }, env).mask).toEqual([...DEFAULT_MASK, /internal-[0-9]+/g])
    expect(loadConfig({ maskDefaults: true }, env).mask).toEqual(DEFAULT_MASK)
    expect(loadConfig({ maskDefaults: false }, env).mask).toEqual([])
    expect(() => loadConfig({ maskDefaults: "no" }, env)).toThrow(/options\.maskDefaults/)
  })

  test("every invalid key is named, and no value is echoed", () => {
    let message = ""
    try {
      loadConfig({
        database: "relative/secret.db", indexPath: 7, defaultScope: "session", index: { maxDocChars: 10, extra: true },
        mask: ["(secret-unclosed"], recall: { model: "secret-no-provider" }, policy: { x: "allow" },
      }, env)
    } catch (error) { message = (error as Error).message }
    expect(message).toMatch(/^OPTIONS_INVALID: The plugin options are invalid: .*\. Next step: Fix /)
    for (const key of [
      "options.database must be an absolute path", "options.indexPath", "options.defaultScope", "options.index.maxDocChars",
      "options.index.extra is not a History option", "options.mask.0 must be a valid regular expression", "options.recall.model must be provider/model",
      "options.policy is not a History option",
    ]) expect(message).toContain(key)
    expect(message).not.toContain("secret")
    expect(message).toContain("Configure in the README")
  })
})
