import { describe, expect, test } from "vitest"
import { homedir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { loadConfig } from "../../../src/domain/config.js"
import { DEFAULT_MASK } from "../../../src/extract/index.js"
import { HOST_RANGE, TESTED_HOSTS } from "../../../src/domain/hosts.js"
import { checkHost, inRange } from "../../../src/host/compat.js"

describe("host check", () => {
  test("the supported line is 2.2.3 up to, not including, 2.3.0, as package.json states", () => {
    expect(HOST_RANGE).toBe(">=2.2.3 <2.3.0")
    expect(JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).opencode.host).toBe(HOST_RANGE)
    for (const version of ["2.2.3", "2.2.4", "2.2.10"]) expect(inRange(version), version).toBe(true)
    for (const version of ["2.2.2", "2.3.0", "3.0.0", "2.2.4-beta.1", "0.0.0-dev-377", "unknown", "", "v2.2.3"]) expect(inRange(version), version).toBe(false)
  })
  test("the tested releases are 2.2.3, 2.2.4 and 2.2.5, all inside the range", () => {
    expect(TESTED_HOSTS).toEqual(["2.2.3", "2.2.4", "2.2.5"])
    for (const version of TESTED_HOSTS) expect(checkHost(version, false)).toEqual({ version, range: HOST_RANGE, tested: true })
  })
  test("a release inside the range that is not tested sets up normally, untested, with no next step of its own", () => {
    expect(checkHost("2.2.6", false)).toEqual({ version: "2.2.6", range: HOST_RANGE, tested: false })
  })
  test("a host outside the range is refused with the next step", () => {
    expect(() => checkHost("2.3.0", false)).toThrow("HOST_UNTESTED: History supports OpenCode >=2.2.3 <2.3.0, found 2.3.0. Next step: Use OpenCode 2.2.3, 2.2.4 or 2.2.5, or another release inside >=2.2.3 <2.3.0, or set the plugin option allowUntestedHost: true to run anyway.")
    expect(() => checkHost("unknown", false)).toThrow("found unknown")
    expect(() => checkHost("", false)).toThrow("found no version")
  })
  test("allowUntestedHost runs a host outside the range and keeps a warning for the status", () => {
    expect(checkHost("2.3.0", true)).toEqual({ version: "2.3.0", range: HOST_RANGE, tested: false, next: expect.stringContaining("outside the supported range and allowUntestedHost is set") })
    expect(checkHost("", true)).toMatchObject({ version: null, tested: false })
  })
})

describe("plugin options", () => {
  const env = { XDG_DATA_HOME: "/xdg/data" }
  test("defaults: OpenCode's database and the index under XDG data, project scope, extraction defaults, the built-in masks", () => {
    expect(loadConfig(undefined, env)).toEqual({
      database: "/xdg/data/opencode/opencode.db",
      indexPath: "/xdg/data/opencode-history/index.db",
      defaultScope: "project",
      index: { reasoning: false, toolResults: true, maxDocChars: 8000 },
      mask: DEFAULT_MASK,
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
      allowUntestedHost: true,
    }, env)
    expect(config).toEqual({
      database: "/db/opencode.db", indexPath: "/idx/history.db", defaultScope: "all",
      index: { reasoning: true, toolResults: false, maxDocChars: 2000 },
      mask: [/sk-[A-Za-z0-9]{20,}/g, /password=\S+/g],
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
        mask: ["(secret-unclosed"], recall: { synthesize: true }, policy: { x: "allow" },
      }, env)
    } catch (error) { message = (error as Error).message }
    expect(message).toMatch(/^OPTIONS_INVALID: The plugin options are invalid: .*\. Next step: Fix /)
    for (const key of [
      "options.database must be an absolute path", "options.indexPath", "options.defaultScope", "options.index.maxDocChars",
      "options.index.extra is not a History option", "options.mask.0 must be a valid regular expression", "options.recall is not a History option",
      "options.policy is not a History option",
    ]) expect(message).toContain(key)
    expect(message).not.toContain("secret")
    expect(message).toContain("Configure in the README")
  })
})
