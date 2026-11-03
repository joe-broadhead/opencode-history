import * as z from "zod"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { DEFAULT_MASK } from "../extract/index.js"
import { defaultDatabasePath } from "../source/opencode-db.js"
import { formatFailure } from "./common.js"
import { DEFAULT_EXTRACT } from "./contract.js"

export const SCOPES = ["project", "directory", "all"] as const
export type DefaultScope = typeof SCOPES[number]

/** A user regex source; it must compile, because every match is replaced before storage and output. */
const pattern = z.string().min(1).max(1024).refine(source => { try { new RegExp(source, "g"); return true } catch { return false } }, "must be a valid regular expression")
/** `provider/model`. The model part may itself contain slashes, as in `openrouter/anthropic/claude-sonnet`. */
const model = z.string().max(256).regex(/^[^/\s]+\/\S+$/, "must be provider/model")
const absolute = z.string().max(4096).refine(isAbsolute, "must be an absolute path")

/** Plugin options. Every key is optional; see the defaults in `loadConfig`. */
const ConfigSchema = z.strictObject({
  database: absolute.optional(),
  indexPath: absolute.optional(),
  defaultScope: z.enum(SCOPES).optional(),
  index: z.strictObject({
    reasoning: z.boolean().optional(),
    toolResults: z.boolean().optional(),
    maxDocChars: z.number().int().min(500).max(100_000).optional(),
  }).optional(),
  mask: z.array(pattern).max(64).optional(),
  maskDefaults: z.boolean().optional(),
  recall: z.strictObject({ synthesize: z.boolean().optional(), model: model.optional() }).optional(),
  allowUntestedHost: z.boolean().optional(),
})
export type Config = z.input<typeof ConfigSchema>

export interface ResolvedConfig {
  /** OpenCode's database, opened read-only. */
  readonly database: string
  /** The plugin's own index, a cache that can be rebuilt at any time. */
  readonly indexPath: string
  readonly defaultScope: DefaultScope
  readonly index: { readonly reasoning: boolean; readonly toolResults: boolean; readonly maxDocChars: number }
  /** The built-in patterns unless `maskDefaults` is false, then the compiled `mask` patterns; their matches are replaced before storage and output. */
  readonly mask: readonly RegExp[]
  /** `synthesize` is off by default, so recall makes no model call unless asked. Without `model`, the host's default model answers. */
  readonly recall: { readonly synthesize: boolean; readonly model?: { readonly providerID: string; readonly id: string } }
  readonly allowUntestedHost: boolean
}

/** Validates the plugin options. An invalid option fails setup with every offending key named, never its value. */
export function loadConfig(options: unknown, env: Readonly<Record<string, string | undefined>> = process.env): ResolvedConfig {
  const parsed = ConfigSchema.safeParse(options ?? {})
  if (!parsed.success) {
    const problems = parsed.error.issues.flatMap(issue => {
      const path = ["options", ...issue.path.map(String)].join(".")
      return issue.code === "unrecognized_keys" ? issue.keys.map(key => `${path}.${key} is not a History option`) : [`${path} ${issue.message.replace(/^Invalid input: /, "is invalid: ")}`]
    })
    throw new Error(formatFailure({ code: "OPTIONS_INVALID", message: `The plugin options are invalid: ${problems.join("; ")}.`, hint: "Fix the History plugin options in opencode.json (see Configure in the README), then restart OpenCode." }))
  }
  const value = parsed.data
  const data = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(homedir(), ".local/share")
  const recallModel = value.recall?.model
  const slash = recallModel?.indexOf("/") ?? -1
  return {
    database: value.database ?? defaultDatabasePath(env),
    indexPath: value.indexPath ?? join(data, "opencode-history", "index.db"),
    defaultScope: value.defaultScope ?? "project",
    index: {
      reasoning: value.index?.reasoning ?? DEFAULT_EXTRACT.reasoning,
      toolResults: value.index?.toolResults ?? DEFAULT_EXTRACT.toolResults,
      maxDocChars: value.index?.maxDocChars ?? DEFAULT_EXTRACT.maxDocChars,
    },
    mask: [...(value.maskDefaults === false ? [] : DEFAULT_MASK), ...(value.mask ?? []).map(source => new RegExp(source, "g"))],
    recall: {
      synthesize: value.recall?.synthesize ?? false,
      ...(recallModel ? { model: { providerID: recallModel.slice(0, slash), id: recallModel.slice(slash + 1) } } : {}),
    },
    allowUntestedHost: value.allowUntestedHost ?? false,
  }
}
