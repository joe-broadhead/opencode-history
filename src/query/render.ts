// Render one source message as compact text: prose as written, each tool call on one line, long output cut.
import type { DocKind, SourceMessage } from "../domain/contract.js"
import { clip, headTail, type Mask } from "./common.js"

/** A tool call line is cut to this many characters unless `full`. */
export const CALL_CHARS = 300
/** Tool output and tool input bodies keep this head and tail unless `full`. */
export const OUTPUT_HEAD = 400
export const OUTPUT_TAIL = 200

export interface RenderOptions {
  /** Whole text: no cuts, and reasoning is shown. */
  readonly full: boolean
  /** Show only these kinds. Without it everything is shown, apart from reasoning when not `full`. */
  readonly kinds?: readonly DocKind[]
  readonly mask: Mask
}

const str = (value: unknown) => (typeof value === "string" ? value : undefined)
const array = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const flat = (text: string) => text.replace(/\s+/g, " ").trim()
const indent = (text: string) => text.replace(/^/gm, "  ")

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

/** What a call did, in a few words: the command, the file, the pattern. */
function callSummary(name: string, input: Record<string, unknown>): string {
  const path = str(input.filePath) ?? str(input.path)
  switch (name) {
    case "bash":
    case "shell":
      return str(input.command) ?? json(input)
    case "read":
    case "edit":
    case "write":
    case "list":
      return path ?? json(input)
    case "grep":
    case "glob":
      return [str(input.pattern), str(input.path)].filter(Boolean).join(" in ") || json(input)
    case "apply_patch": {
      const files = [...(str(input.patchText) ?? "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1]!.trim())
      return files.length > 0 ? files.join(", ") : json(input)
    }
    case "task":
    case "subagent": {
      const agent = str(input.subagent_type) ?? str(input.agent)
      return `${agent ? `@${agent} ` : ""}${str(input.description) ?? ""}`.trim() || json(input)
    }
    case "webfetch":
      return str(input.url) ?? json(input)
    case "websearch":
      return str(input.query) ?? json(input)
  }
  return json(input)
}

/** The part of a call's input worth reading below its line: the edit, the written content, the patch, the prompt. */
function callBody(name: string, input: Record<string, unknown>): string | undefined {
  switch (name) {
    case "edit": {
      const before = str(input.oldString)
      const after = str(input.newString)
      return before === undefined && after === undefined ? undefined : `replace:\n${before ?? ""}\nwith:\n${after ?? ""}`
    }
    case "write":
      return str(input.content)
    case "apply_patch":
      return str(input.patchText)
    case "task":
    case "subagent":
      return str(input.prompt)
  }
  return undefined
}

function toolOutput(state: Record<string, unknown>): string | undefined {
  const content = array(state.content)
    .map(item => (isRecord(item) && item.type === "text" ? (str(item.text) ?? "") : ""))
    .filter(Boolean)
    .join("\n")
  if (content.trim()) return content
  const error = isRecord(state.error) ? str(state.error.message) : str(state.error)
  return error ? `error: ${error}` : undefined
}

/** The message as text, or "" when nothing in it is shown. */
export function renderMessage(message: SourceMessage, options: RenderOptions): string {
  const { full, kinds, mask } = options
  const show = (kind: DocKind) => (kinds ? kinds.includes(kind) : kind !== "reasoning" || full)
  const untyped = !kinds
  // Mask before cutting, so a cut cannot leave half a secret that no longer matches.
  const body = (text: string) => (full ? mask(text) : headTail(mask(text), OUTPUT_HEAD, OUTPUT_TAIL))
  const data = message.data
  const out: string[] = []

  switch (message.type) {
    case "user": {
      if (!show("user")) break
      const files = array(data.files)
        .map(file => (isRecord(file) ? str(file.name) : undefined))
        .filter((name): name is string => !!name)
        .map(name => `[file: ${mask(name)}]`)
      out.push(...[mask((str(data.text) ?? "").trim()), ...files].filter(Boolean))
      break
    }
    case "assistant":
      for (const item of array(data.content)) {
        if (!isRecord(item)) continue
        if (item.type === "text" && show("assistant")) out.push(mask((str(item.text) ?? "").trim()))
        else if (item.type === "reasoning" && show("reasoning")) out.push(`(thinking) ${mask((str(item.text) ?? "").trim())}`)
        else if (item.type === "tool" && (show("tool_call") || show("tool_result"))) {
          const name = str(item.name) ?? "unknown"
          const state = isRecord(item.state) ? item.state : {}
          const input = isRecord(state.input) ? state.input : {}
          const status = str(state.status)
          const summary = flat(mask(callSummary(name, input)))
          const lines = [`▸ ${name}: ${full ? summary : clip(summary, CALL_CHARS)}${status && status !== "completed" ? ` (${status})` : ""}`]
          const extra = show("tool_call") ? callBody(name, input) : undefined
          if (extra?.trim()) lines.push(indent(body(extra.trim())))
          const output = show("tool_result") ? toolOutput(state) : undefined
          if (output?.trim()) lines.push(indent(body(output.trim())))
          out.push(lines.join("\n"))
        }
      }
      break
    case "synthetic":
      if (show("synthetic")) out.push(mask((str(data.text) ?? "").trim()))
      break
    case "shell": {
      // A command the user ran, shown like a shell tool call: the command, then its output.
      if (!show("tool_call") && !show("tool_result")) break
      const command = flat(mask(str(data.command) ?? ""))
      const status = str(data.status)
      const exit = typeof data.exit === "number" && data.exit !== 0 ? ` (exit ${data.exit})` : ""
      const lines = [`▸ shell: ${full ? command : clip(command, CALL_CHARS)}${status && status !== "exited" ? ` (${status})` : exit}`]
      const output = show("tool_result") && isRecord(data.output) ? str(data.output.output) : undefined
      if (output?.trim()) lines.push(indent(body(output.trim())))
      out.push(lines.join("\n"))
      break
    }
    case "compaction":
      if (show("summary")) out.push(`${data.status === "failed" ? "(failed) " : ""}${mask((str(data.summary) ?? "").trim())}`)
      break
    case "idle":
      if (untyped && str(data.outcome)) out.push(`outcome: ${data.outcome}`)
      break
    default:
      if (untyped) out.push(full ? mask(json(data)) : clip(mask(json(data)), CALL_CHARS))
  }
  return out.filter(text => text.trim()).join("\n")
}
