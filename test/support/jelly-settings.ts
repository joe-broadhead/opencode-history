/**
 * Jelly's plugin setting contract, vendored for tests. `PluginSettingSchema`, `settingChoices` and
 * `settingValueIssue` are copied from we-the-rebel-alliance/app protocol/contracts/src/plugin-setting.ts and
 * plugin-setting.light.ts (master 6af624591, which includes app#1301, 34274b8c7). Jelly reads
 * `jelly.contributes.settings` with this schema: every object in it is strict, so a Jelly before app#1301, which does
 * not know `enum` or `choices`, refuses the whole declaration. Keep the rules a copy of Jelly's; never loosen them here.
 * `ACCESS_CHOICES` is Jelly's wording for the shared `access` option, word for word.
 */
import * as z from "zod"

/** The longest value a setting may carry, a secret included. */
export const PLUGIN_SETTING_MAX_LENGTH = 8192

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/)
const label = z.string().min(1).max(200)

export const PluginSettingChoiceSchema = z
  .object({ value: z.string().min(1).max(200), label: label.optional(), description: z.string().max(300).optional() })
  .strict()
export type PluginSettingChoice = z.infer<typeof PluginSettingChoiceSchema>

const settingValue = z.union([z.string().max(PLUGIN_SETTING_MAX_LENGTH), z.boolean(), z.number()])

interface Bounds {
  readonly enum?: readonly string[] | undefined
  readonly choices?: readonly PluginSettingChoice[] | undefined
  readonly min?: number | undefined
  readonly max?: number | undefined
  readonly step?: number | undefined
  readonly integer?: boolean | undefined
}

/** The closed set a string setting declares, as choices; undefined for free values. */
export function settingChoices(setting: Bounds): readonly PluginSettingChoice[] | undefined {
  return setting.choices ?? (setting.enum === undefined ? undefined : setting.enum.map(value => ({ value })))
}

/** Why a value does not fit the setting's declared set or bounds, or null when it does. Jelly refuses with this. */
export function settingValueIssue(setting: Bounds, value: string | number | boolean): string | null {
  const closed = settingChoices(setting)
  if (closed !== undefined && typeof value === "string" && !closed.some(c => c.value === value)) return "not one of the declared values"
  if (typeof value !== "number") return null
  if (setting.integer === true && !Number.isInteger(value)) return "not a whole number"
  if (setting.min !== undefined && value < setting.min) return "below the minimum"
  if (setting.max !== undefined && value > setting.max) return "above the maximum"
  if (setting.step !== undefined) {
    const from = setting.min ?? 0
    const steps = (value - from) / setting.step
    if (Math.abs(steps - Math.round(steps)) > 1e-9) return "not on a step"
  }
  return null
}

export const PluginSettingSchema = z
  .object({
    key: id,
    label,
    type: z.enum(["string", "boolean", "number", "secret"]),
    description: z.string().max(1000),
    enum: z.array(z.string().min(1).max(200)).min(2).max(64).optional(),
    choices: z.array(PluginSettingChoiceSchema).min(2).max(64).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    step: z.number().finite().positive().optional(),
    integer: z.boolean().optional(),
    visibleWhen: z.object({ setting: id, equals: settingValue }).strict().optional(),
    default: settingValue.optional(),
  })
  .strict()
  .superRefine((setting, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message })
    if (setting.default !== undefined) {
      if (setting.type === "secret" || typeof setting.default !== setting.type)
        issue("default", "A default must match the setting type; secrets never declare a default")
    }
    const closed = settingChoices(setting)
    if (setting.enum !== undefined && setting.choices !== undefined) issue("choices", "Declare a closed set as enum or as choices, not both")
    if (closed !== undefined) {
      if (setting.type !== "string") issue("choices", "Only a string setting has a closed set")
      if (new Set(closed.map(choice => choice.value)).size !== closed.length) issue("choices", "The values of a closed set must be unique")
      if (typeof setting.default === "string" && !closed.some(c => c.value === setting.default))
        issue("default", "A default must be one of the closed set's values")
    }
    const bounded = setting.min !== undefined || setting.max !== undefined || setting.step !== undefined || setting.integer !== undefined
    if (bounded && setting.type !== "number") issue("min", "Only a number setting has min, max, step or integer")
    if (setting.min !== undefined && setting.max !== undefined && setting.min > setting.max) issue("min", "min may not be above max")
    if (typeof setting.default === "number" && settingValueIssue(setting, setting.default) !== null)
      issue("default", "A default must satisfy the setting's own bounds")
  })
export type PluginSetting = z.infer<typeof PluginSettingSchema>

/** `contributes.settings` as Jelly reads it. */
export const PluginSettingsSchema = z.array(PluginSettingSchema).max(32)

/** Every problem Jelly's schema finds in a declaration's settings, as `path: message`; empty when Jelly reads them. */
export function settingsProblems(settings: unknown): string[] {
  const parsed = PluginSettingsSchema.safeParse(settings)
  return parsed.success ? [] : parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`)
}

/** Jelly's choices for the shared `access` option, verbatim (app#172). */
export const ACCESS_CHOICES = [
  { value: "all", label: "Allowed", description: "Every tool runs without asking, reads and changes alike." },
  { value: "ask-changes", label: "Ask before changes", description: "Reads run without asking. Each change asks you first." },
  { value: "read-only", label: "Read only", description: "Reads run. Changes never run." },
] as const
