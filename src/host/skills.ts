import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin, Skill } from "@opencode/plugin"
import { formatFailure, HistoryError } from "../domain/common.js"

type SkillEditor = Parameters<Parameters<Plugin.Context["skill"]["transform"]>[0]>[0]

/** The hand-written skills. Every History tool is always registered, so every skill is too. */
export const SKILLS = ["history-recall"] as const
type SkillID = typeof SKILLS[number]

interface LoadedSkill { readonly id: SkillID; readonly info: Skill.Info }

/** Reads `skills/<id>/SKILL.md`. A missing or malformed file is skipped with a SKILLS_INVALID warning; setup carries on. */
export async function loadSkills(packageRoot: string, warn: (message: string) => void = console.warn): Promise<LoadedSkill[]> {
  const loaded = await Promise.all(SKILLS.map(async id => {
    const path = join(packageRoot, "skills", id, "SKILL.md")
    try {
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(await readFile(path, "utf8"))
      const fields = Object.fromEntries((match?.[1] ?? "").split(/\r?\n/).map(line => /^(\w+):\s*(.+?)\s*$/.exec(line)).filter(m => m !== null).map(m => [m[1], m[2]]))
      if (!match || fields.name !== id || !fields.description) throw new Error("expected front matter with name and description")
      const info = { id, name: id, description: fields.description, path, content: match[2]!.trim(), autoinvoke: true } as Skill.Info
      return { id, info }
    } catch {
      // A bad skill must not fail setup: the plugin warns with the shared code and carries on without it.
      warn(formatFailure(new HistoryError("SKILLS_INVALID", { message: `The skill ${id} is missing or malformed, so it was skipped.` })))
      return undefined
    }
  }))
  return loaded.filter(skill => skill !== undefined)
}

export function skillTransform(skills: readonly LoadedSkill[]) {
  return (editor: SkillEditor) => { for (const skill of skills) editor.add(skill.info) }
}
