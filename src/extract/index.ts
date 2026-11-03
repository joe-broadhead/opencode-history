// Turns one source message into searchable docs, file touches, subagent links and session facts.
import { isAbsolute, normalize, resolve } from "node:path"
import { DEFAULT_EXTRACT } from "../domain/contract.js"
import type { Doc, DocKind, ExtractOptions, Extracted, FileOp, FileTouch, SessionFacts, SessionLink, SourceMessage, SourceSession } from "../domain/contract.js"

export const MASK = "[masked]"
export const FIRST_PROMPT_CHARS = 500
export const LAST_REPLY_CHARS = 1000

/**
 * Common credential formats, masked unless the `maskDefaults` option is false: private key blocks, API keys and
 * tokens by their published prefixes, JSON Web Tokens, the credential in a Bearer or Authorization header, and the
 * value of a password, secret, token or API key setting. A named group `keep` stays in the text, so the setting's name
 * still reads. Each pattern starts with a literal or a word boundary, so it scans text in one pass.
 */
export const DEFAULT_MASK: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // OpenAI, Anthropic and others (sk-, sk-proj-, sk-ant-), xAI, Groq, Tavily and Linear.
  /\b(?:sk|xai|tvly)-[A-Za-z0-9_-]{20,}/g,
  /\b(?:gsk|lin_api)_[A-Za-z0-9]{20,}/g,
  // GitHub, GitLab, npm and Hugging Face.
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  // Slack, Stripe, Google and AWS access key IDs.
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Header credentials: `Bearer <token>`, and `Authorization: <scheme> <credential>`.
  /(?<keep>\b[Bb]earer\s+)[A-Za-z0-9._~+/=-]{20,}/g,
  /(?<keep>\bAuthorization:\s*(?:Basic|Token|Digest)\s+)[^\s"']{8,}/gi,
  // password=hunter2, DB_PASSWORD=..., ?token=..., and "apiKey": "...", password: '...'.
  /(?<keep>\b[A-Za-z0-9_]*(?:password|passwd|secret|token|api_?key|access_?key)=)[^\s"'&;,)<>=][^\s"'&;,)<>]*/gi,
  /(?<keep>\b[A-Za-z0-9_]*(?:password|passwd|secret|token|api_?key|access_?key)["']?\s*[:=]\s*["'])[^"'\s]{3,}(?=["'])/gi,
]

const globals = new WeakMap<RegExp, RegExp>()

/**
 * Replaces every match of every pattern with `[masked]`, after the text of a named group `keep` when the pattern has
 * one. Patterns without the g flag still replace all matches.
 */
export function maskText(text: string, patterns: readonly RegExp[]): string {
  let out = text
  for (const pattern of patterns) {
    out = out.replace(globalOf(pattern), (match: string, ...rest: unknown[]) => {
      if (match === "") return match
      const groups = rest.at(-1)
      const keep = typeof groups === "object" && groups !== null ? (groups as Record<string, string | undefined>).keep : undefined
      return `${keep ?? ""}${MASK}`
    })
  }
  return out
}

function globalOf(pattern: RegExp): RegExp {
  if (pattern.global) return pattern
  let global = globals.get(pattern)
  if (!global) {
    global = new RegExp(pattern.source, `${pattern.flags}g`)
    globals.set(pattern, global)
  }
  return global
}

/** The session title as a doc; null when the title is empty. */
export function titleDoc(session: SourceSession, options: Pick<ExtractOptions, "redact" | "maxDocChars"> = DEFAULT_EXTRACT): Doc | null {
  const text = clip(maskText(session.title.trim(), options.redact), options.maxDocChars)
  if (!text) return null
  return { sessionID: session.id, messageID: "", seq: -1, part: 0, time: session.created, kind: "title", tool: null, text }
}

/**
 * Facts are per message: counts are this message's share, so the indexer sums them; firstPrompt is set on user
 * messages (keep the first), lastReply on assistant messages with text and outcome on idle messages (keep the last).
 */
export function extractMessage(message: SourceMessage, session: SourceSession, options: ExtractOptions): Extracted {
  const docs: Doc[] = []
  const files: FileTouch[] = []
  const links: SessionLink[] = []
  const facts: { -readonly [K in keyof SessionFacts]?: SessionFacts[K] } = { messages: 1, userMessages: 0, compactions: 0, toolCalls: 0 }
  const data = message.data
  const mask = (text: string) => maskText(text, options.redact)
  // Mask before any cut, so a cut cannot leave half a secret that no longer matches.
  const push = (part: number, kind: DocKind, tool: string | null, masked: string) => {
    const text = clip(masked, options.maxDocChars)
    if (text) docs.push({ sessionID: message.sessionID, messageID: message.id, seq: message.seq, part, time: message.created, kind, tool, text })
  }
  const doc = (part: number, kind: DocKind, tool: string | null, raw: string) => push(part, kind, tool, mask(raw.trim()))

  switch (message.type) {
    case "user": {
      const text = (str(data.text) ?? "").trim()
      const attached = array(data.files)
        .map(file => (isRecord(file) ? str(file.name) : undefined))
        .filter((name): name is string => !!name)
        .map(name => `[file: ${name}]`)
      doc(0, "user", null, [text, ...attached].filter(Boolean).join("\n"))
      facts.userMessages = 1
      const prompt = clip(mask(text), FIRST_PROMPT_CHARS)
      if (prompt) facts.firstPrompt = prompt
      break
    }
    case "assistant": {
      let reply: string | undefined
      array(data.content).forEach((item, index) => {
        if (!isRecord(item)) return
        // Part 0 is reserved for whole-message docs, so content parts count from 1.
        const part = index + 1
        if (item.type === "text") {
          const text = str(item.text) ?? ""
          doc(part, "assistant", null, text)
          if (text.trim()) reply = text
        } else if (item.type === "reasoning") {
          if (options.reasoning) doc(part, "reasoning", null, str(item.text) ?? "")
        } else if (item.type === "tool") {
          facts.toolCalls = (facts.toolCalls ?? 0) + 1
          tool(item, part)
        }
      })
      if (reply !== undefined) facts.lastReply = clip(mask(reply.trim()), LAST_REPLY_CHARS)
      break
    }
    case "synthetic":
      doc(0, "synthetic", null, str(data.text) ?? "")
      break
    case "shell": {
      // A command the user ran in the session. It reads like a shell tool call, but the model did not make it, so it
      // is not counted as one.
      const command = (str(data.command) ?? "").trim()
      if (command) doc(0, "tool_call", "shell", `shell: ${command}`)
      const output = isRecord(data.output) ? str(data.output.output) : undefined
      if (options.toolResults && output?.trim()) push(0, "tool_result", "shell", headTail(mask(output.trim()), options.resultHeadChars, options.resultTailChars))
      break
    }
    case "compaction":
      doc(0, "summary", null, str(data.summary) ?? "")
      if (data.status !== "failed") facts.compactions = 1
      break
    case "idle": {
      const outcome = str(data.outcome)
      if (outcome) facts.outcome = outcome
      break
    }
  }

  return { docs, files, links, facts }

  function tool(item: Record<string, unknown>, part: number) {
    const name = str(item.name) ?? "unknown"
    const state = isRecord(item.state) ? item.state : {}
    const input = isRecord(state.input) ? state.input : {}
    const metadata = isRecord(state.metadata) ? state.metadata : {}
    doc(part, "tool_call", name, `${name}: ${callText(name, state.input)}`)
    if (options.toolResults && name !== "read") {
      const result = resultText(state)
      if (result !== undefined) push(part, "tool_result", name, headTail(mask(result.trim()), options.resultHeadChars, options.resultTailChars))
    }
    if (state.status === "completed") {
      const seen = new Set<string>()
      for (const touch of touches(name, input, metadata)) {
        const path = mask(resolvePath(touch.path, session.directory))
        if (!path || seen.has(`${touch.op}\0${path}`)) continue
        seen.add(`${touch.op}\0${path}`)
        files.push({ sessionID: message.sessionID, messageID: message.id, seq: message.seq, time: message.created, path, op: touch.op, tool: name })
      }
    }
    const link = childLink(name, input, metadata)
    if (link && link.childID !== session.id) {
      const description = link.description && clip(mask(link.description.trim()), options.maxDocChars)
      links.push({ parentID: session.id, childID: link.childID, messageID: message.id, description: description || null, agent: link.agent })
    }
  }
}

/** The compact text of a tool call, without the `name: ` prefix. */
function callText(name: string, input: unknown): string {
  const i = isRecord(input) ? input : {}
  let text: string | undefined
  switch (name) {
    case "bash":
    case "shell":
      text = lines(str(i.command), str(i.description))
      break
    case "edit":
      text = lines(str(i.filePath) ?? str(i.path), str(i.newString))
      break
    case "write":
      text = lines(str(i.filePath) ?? str(i.path), str(i.content))
      break
    case "apply_patch":
      text = str(i.patchText)
      break
    case "grep":
    case "glob":
      text = [str(i.pattern), str(i.path)].filter(Boolean).join(" in ")
      break
    case "task":
    case "subagent":
      text = lines(str(i.description), str(i.prompt))
      break
    case "webfetch":
      text = str(i.url)
      break
  }
  if (text) return text
  if (typeof input === "string") return input
  return inputText(input)
}

/**
 * String inputs that hold code or text, such as Code Mode's `code`, taken as they are. Inside JSON their newlines and
 * quotes would be escaped, which shows in snippets and breaks substring matches.
 */
export const RAW_FIELDS = ["code", "command", "script", "query", "sql", "patchText", "prompt"] as const

/** A call's input as compact JSON, with each string in RAW_FIELDS after it on its own line as `field: value`. */
function inputText(input: unknown): string {
  if (!isRecord(input)) return compactJson(input ?? {})
  const raw = RAW_FIELDS.filter(field => str(input[field])?.trim())
  if (raw.length === 0) return compactJson(input)
  const rest = Object.fromEntries(Object.entries(input).filter(([key]) => !(raw as readonly string[]).includes(key)))
  return lines(Object.keys(rest).length > 0 ? compactJson(rest) : undefined, ...raw.map(field => `${field}: ${str(input[field])!}`))
}

function resultText(state: Record<string, unknown>): string | undefined {
  const content = array(state.content)
    .map(item => (isRecord(item) && item.type === "text" ? (str(item.text) ?? "") : ""))
    .filter(Boolean)
    .join("\n")
  if (content.trim()) return content
  const error = isRecord(state.error) ? str(state.error.message) : str(state.error)
  return error ? `error: ${error}` : undefined
}

function touches(name: string, input: Record<string, unknown>, metadata: Record<string, unknown>): { path: string; op: FileOp }[] {
  const path = str(input.filePath) ?? str(input.path)
  switch (name) {
    case "read":
      return path ? [{ path, op: "read" }] : []
    case "edit":
      return path ? [{ path, op: "edit" }] : []
    case "write":
      return path ? [{ path, op: "write" }] : []
    case "grep":
    case "glob": {
      const dir = str(input.path)
      return dir ? [{ path: dir, op: "search" }] : []
    }
    case "apply_patch": {
      const listed = array(metadata.files)
        .filter(isRecord)
        .flatMap(file => [str(file.filePath) ?? str(file.relativePath), str(file.movePath)])
        .filter((item): item is string => !!item)
      const paths = listed.length > 0 ? listed : patchPaths(str(input.patchText) ?? "")
      return paths.map(item => ({ path: item, op: "patch" }))
    }
  }
  return []
}

const PATCH_HEADER = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm

function patchPaths(patch: string): string[] {
  return [...patch.matchAll(PATCH_HEADER)].map(match => (match[1] ?? "").trim()).filter(Boolean)
}

function childLink(name: string, input: Record<string, unknown>, metadata: Record<string, unknown>): { childID: string; description: string | null; agent: string | null } | null {
  if (name !== "task" && name !== "subagent") return null
  const childID = str(metadata.sessionId) ?? str(metadata.sessionID)
  if (!childID) return null
  const agent = name === "task" ? (str(input.subagent_type) ?? str(input.agent)) : (str(input.agent) ?? str(input.subagent_type))
  return { childID, description: str(input.description) ?? null, agent: agent ?? null }
}

function resolvePath(path: string, directory: string): string {
  const trimmed = path.trim()
  if (!trimmed) return ""
  if (isAbsolute(trimmed)) return normalize(trimmed)
  return directory ? resolve(directory, trimmed) : normalize(trimmed)
}

/** Keeps the first `head` and last `tail` characters, marking what was left out. */
function headTail(text: string, head: number, tail: number): string {
  const h = Math.max(0, Math.floor(head))
  const t = Math.max(0, Math.floor(tail))
  if (text.length <= h + t) return text
  const start = safeEnd(text, h)
  const end = safeStart(text, text.length - t)
  return `${text.slice(0, start)}\n…[${end - start} chars omitted]…\n${text.slice(end)}`
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const limit = Math.max(0, Math.floor(max))
  if (limit === 0) return ""
  return `${text.slice(0, safeEnd(text, limit - 1))}…`
}

/** Moves a cut point back so it does not split a surrogate pair. */
function safeEnd(text: string, at: number): number {
  return at > 0 && isHighSurrogate(text.charCodeAt(at - 1)) ? at - 1 : at
}

/** Moves a cut point forward so it does not start on the second half of a surrogate pair. */
function safeStart(text: string, at: number): number {
  return at < text.length && isLowSurrogate(text.charCodeAt(at)) ? at + 1 : at
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

function lines(...parts: (string | undefined)[]): string {
  return parts.filter(part => part !== undefined && part.trim() !== "").join("\n")
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
