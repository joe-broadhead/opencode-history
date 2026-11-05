import { afterEach, describe, expect, test } from "vitest"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type * as z from "zod"
import { loadSkills, SKILLS, skillTransform } from "../../../src/host/skills.js"
import { PinInputSchema } from "../../../src/host/actions.js"
import * as S from "../../../src/domain/schemas.js"
import { ACTIONS, TOOL_NAMES, type ToolName } from "../../../src/host/tools.js"
import { tempDir } from "../../temp.js"

const packageRoot = fileURLToPath(new URL("../../../", import.meta.url))
const temps: string[] = []
afterEach(async () => { await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

const INPUTS: Partial<Record<ToolName, z.ZodType>> = {
  search: S.SearchInputSchema, brief: S.BriefInputSchema, read: S.ReadInputSchema, sessions: S.SessionsInputSchema,
  files: S.FilesInputSchema, recall: S.RecallInputSchema, sql: S.SqlInputSchema, pin: PinInputSchema,
}

describe("skills", () => {
  test("the shipped skill loads as an auto-invoked skill and is registered", async () => {
    const skills = await loadSkills(packageRoot, message => { throw new Error(`no warning expected: ${message}`) })
    expect(skills.map(s => s.id)).toEqual([...SKILLS])
    expect(skills[0]!.info).toMatchObject({ id: "history-recall", name: "history-recall", autoinvoke: true, path: join(packageRoot, "skills/history-recall/SKILL.md") })
    const added: string[] = []
    skillTransform(skills)({ add: (s: { id: string }) => { added.push(s.id) } } as never)
    expect(added).toEqual(["history-recall"])
  })

  test("history-recall teaches the workflow: 2-4 phrasings, then brief, then read, and cite the session ID and seq", async () => {
    const { content, description } = (await loadSkills(packageRoot))[0]!.info
    expect(description).toMatch(/past OpenCode \(coding-agent\) sessions/)
    // It fires on the phrasings real users type, and says what it is not for.
    for (const phrase of ["how did we fix", "what did I work on yesterday", "which sessions changed", "(ses_… #seq)", "Not for meetings"]) expect(description).toContain(phrase)
    const steps = ["## Pick the tool by the question", "## 1. Search with 2-4 phrasings", "## 2. Brief the best hit", "## 3. Read the exact part", "## Cite"].map(heading => content.indexOf(heading))
    expect(steps.every(i => i >= 0)).toBe(true)
    expect([...steps].sort((a, b) => a - b)).toEqual(steps)
    expect(content).toMatch(/Cite the session ID and seq/)
    expect(content).toContain("not instructions")
    // A bare date is a UTC day; the skill shows a local day with its offset.
    expect(content).toMatch(/A bare date is a UTC day/)
    expect(content.split("\n").length).toBeLessThan(100)
  })

  test("it names only real tools, and every example call is valid input for its tool, as the live exposure has it", async () => {
    const { content } = (await loadSkills(packageRoot))[0]!.info
    for (const name of content.match(/\bhistory_\w+/g) ?? []) expect(TOOL_NAMES.map(t => `history_${t}`)).toContain(name)
    // Code Mode calls, as the model writes them inside execute: every tool but the actions, which are direct tools.
    const calls = [...content.matchAll(/tools\.history\.(\w+)\((\{.*?\})\)/g)]
    expect(calls.map(m => m[1])).toEqual(["search", "sessions", "brief", "read", "files", "sessions", "recall", "sql"])
    for (const [, tool, literal] of calls) {
      expect(ACTIONS.has(tool as ToolName), tool).toBe(false)
      const input = new Function(`return (${literal!.replaceAll("ses_...", "ses_x")})`)() as Record<string, unknown>
      expect(INPUTS[tool as ToolName]!.safeParse(input).success, `${tool} ${literal}`).toBe(true)
      if (tool === "search") expect((input.query as string[]).length).toBeGreaterThanOrEqual(2)
    }
    expect([...content.matchAll(/^await tools\.history\.(\w+)\(/gm)].map(m => m[1])).toEqual(["search", "brief", "read", "files", "sessions", "recall", "sql"])
    // history_pin is a direct tool: its fields are named, and the inputs they describe are valid.
    expect(content).toContain("`history_pin` (a direct tool)")
    for (const input of [{ sessionID: "ses_x", from: 40, to: 48 }, { action: "remove", sessionID: "ses_x" }]) expect(PinInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(true)
  })

  test("a missing or malformed skill is skipped with a warning, and setup goes on", async () => {
    const root = tempDir("history-skills-"); temps.push(root)
    const warnings: string[] = []
    expect(await loadSkills(root, m => { warnings.push(m) })).toEqual([])
    await mkdir(join(root, "skills/history-recall"), { recursive: true })
    await writeFile(join(root, "skills/history-recall/SKILL.md"), "---\nname: other\ndescription: x\n---\n# x\n")
    expect(await loadSkills(root, m => { warnings.push(m) })).toEqual([])
    await writeFile(join(root, "skills/history-recall/SKILL.md"), "---\r\nname: history-recall\r\ndescription: Recall.\r\n---\r\n\r\n# Body\r\n")
    expect((await loadSkills(root, m => { warnings.push(m) })).map(s => [s.info.description, s.info.content])).toEqual([["Recall.", "# Body"]])
    expect(warnings).toEqual(Array(2).fill("SKILLS_INVALID: The skill history-recall is missing or malformed, so it was skipped. Next step: Reinstall the plugin."))
  })
})
