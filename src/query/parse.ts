// Turn free text from agents and people into safe FTS5 MATCH strings, time bounds, regexes and cursors.

/**
 * What went wrong, for the host to pick its failure code: query (QUERY_INVALID), cursor (CURSOR_INVALID),
 * session (SESSION_NOT_FOUND), message (MESSAGE_NOT_FOUND), sql_rejected (SQL_REJECTED), sql_failed (SQL_FAILED)
 * and sql_timeout (SQL_TIMEOUT).
 */
export type QueryFailure = "query" | "cursor" | "session" | "message" | "sql_rejected" | "sql_failed" | "sql_timeout"

/**
 * The next step for each cause of QUERY_INVALID, so the advice fits the mistake. A cause without one gets the code's
 * general next step.
 */
export const QUERY_HINTS = {
  regex: 'Check the regular expression, or search with match: "words".',
  substring: 'Use a substring of at least 3 characters, or search with match: "words".',
  time: "Use an ISO date such as 2026-10-01 or an age such as 7d.",
  words: 'Search with plain words, or with match: "substring" for exact text.',
  excluded: "Add a word to search for besides the excluded terms.",
  empty: "Pass at least one search term in query.",
  match: 'Use match: "words", "substring" or "regex".',
  path: "Pass a file or folder path, such as src/auth.ts.",
  scope: 'Use scope "session", "directory", "project" or "all".',
  question: "Pass the question to answer.",
} as const

/** A request the query layer cannot serve. Messages say what to change and never repeat input values or history text. */
export class QueryError extends Error {
  /** The next step, when it is more specific than the failure code's own. */
  readonly hint?: string
  constructor(
    message: string,
    readonly reason: QueryFailure = "query",
    options?: { cause?: unknown; hint?: string },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = "QueryError"
    if (options?.hint !== undefined) this.hint = options.hint
  }
}

export interface Term {
  readonly text: string
  /** Written in double quotes: match the words in order. */
  readonly phrase: boolean
  /** Ended with `*`: the last word is a prefix. */
  readonly prefix: boolean
}

/** Every group must match; a group matches when any of its terms does. No doc may match an excluded term. */
export interface ParsedQuery {
  readonly groups: readonly (readonly Term[])[]
  readonly exclude: readonly Term[]
}

type Token = { readonly kind: "term"; readonly term: Term; readonly negate: boolean } | { readonly kind: "or" } | { readonly kind: "not" }

const space = (char: string) => /\s/.test(char)

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let at = 0
  while (at < input.length) {
    while (at < input.length && space(input[at]!)) at++
    if (at >= input.length) break
    // A leading `-` excludes, unless it starts `--flag` or stands alone.
    let negate = false
    if (input[at] === "-" && at + 1 < input.length && input[at + 1] !== "-" && !space(input[at + 1]!)) {
      negate = true
      at++
    }
    if (input[at] === '"') {
      const close = input.indexOf('"', at + 1)
      const end = close < 0 ? input.length : close
      const text = input.slice(at + 1, end).trim()
      at = close < 0 ? input.length : close + 1
      const prefix = input[at] === "*"
      if (prefix) at++
      if (text) tokens.push({ kind: "term", term: { text, phrase: true, prefix }, negate })
      continue
    }
    const start = at
    while (at < input.length && !space(input[at]!)) at++
    const word = input.slice(start, at)
    if (!negate && (word === "OR" || word === "|")) tokens.push({ kind: "or" })
    else if (!negate && word === "NOT") tokens.push({ kind: "not" })
    else if (!negate && (word === "AND" || word === "&&" || word === "-")) continue
    else {
      const prefix = word.length > 1 && word.endsWith("*")
      const text = word.replace(/\*+$/, "")
      if (text) tokens.push({ kind: "term", term: { text, phrase: false, prefix }, negate })
    }
  }
  return tokens
}

/**
 * Parse free text: words, "exact phrases", -excluded terms, prefix* terms and OR between neighbours.
 * Uppercase AND is ignored (it is the default) and uppercase NOT excludes the next term.
 */
export function parseQuery(input: string): ParsedQuery {
  const groups: Term[][] = []
  const exclude: Term[] = []
  let or = false
  let not = false
  let last: "term" | "other" = "other"
  for (const token of tokenize(input)) {
    if (token.kind === "or") {
      or = last === "term"
      continue
    }
    if (token.kind === "not") {
      not = true
      or = false
      continue
    }
    if (token.negate || not) {
      exclude.push(token.term)
      not = false
      or = false
      last = "other"
      continue
    }
    const previous = groups.at(-1)
    if (or && previous) previous.push(token.term)
    else groups.push([token.term])
    or = false
    last = "term"
  }
  return { groups, exclude }
}

export type FtsMode = "words" | "substring"

/** Trigram search cannot match fewer than three characters. */
export const MIN_SUBSTRING = 3

function usable(term: Term, mode: FtsMode): boolean {
  if (mode === "substring") return [...term.text].length >= MIN_SUBSTRING
  return /[\p{L}\p{N}]/u.test(term.text)
}

function quote(term: Term, mode: FtsMode): string {
  const text = `"${term.text.replaceAll('"', '""')}"`
  return term.prefix && mode === "words" ? `${text}*` : text
}

/** Keep only the terms the mode can search; drop groups left empty. */
export function usableQuery(parsed: ParsedQuery, mode: FtsMode): ParsedQuery {
  return {
    groups: parsed.groups.map(group => group.filter(term => usable(term, mode))).filter(group => group.length > 0),
    exclude: parsed.exclude.filter(term => usable(term, mode)),
  }
}

/** A word whose letters and digits are joined by other characters with no space, such as 2.2.3, v1.4.0 or x-ray. */
const JOINED = /[\p{L}\p{N}][^\p{L}\p{N}\s]+[\p{L}\p{N}]/u
const EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu

/** A joined word of a term, and whether it ends a prefix term, so more may follow it. */
export interface JoinedWord {
  readonly text: string
  readonly prefix: boolean
}

/**
 * The words of a term that unicode61 splits into parts, such as 2.2.3, v1.4.0, 192.0.2.10, foo.bar.baz or x-ray,
 * without the punctuation at their edges. FTS5 takes each as the phrase of its parts, "2 2 3", which "2, 2, 3" and other
 * numeric text match too, so words mode also checks the literal word against the text.
 */
export function joinedWords(term: Term): JoinedWord[] {
  const words = term.text.split(/\s+/).map(word => word.replace(EDGES, ""))
  return words.flatMap((text, at) => (JOINED.test(text) ? [{ text, prefix: term.prefix && at === words.length - 1 }] : []))
}

/**
 * A joined word as a whole word of a text, ignoring case: no letter or digit next to it, and no `.` or `_` that joins it
 * to one, so 2.2.3 matches "opencode@2.2.3" and "2.2.3-beta" but not "12.2.3", "10.2.2.3" or "2.2.3.4".
 */
export function joinedPattern(word: JoinedWord): RegExp {
  // The u flag allows escapes of syntax characters and `/` only.
  const literal = word.text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")
  return new RegExp(`(?<![\\p{L}\\p{N}]|[\\p{L}\\p{N}][._])${literal}${word.prefix ? "" : "(?![\\p{L}\\p{N}]|[._][\\p{L}\\p{N}])"}`, "iu")
}

/** Whether a words query has joined words, which its MATCH strings only find a superset of the texts for. */
export function hasJoined(parsed: ParsedQuery): boolean {
  const { groups, exclude } = usableQuery(parsed, "words")
  return [...groups.flat(), ...exclude].some(term => joinedWords(term).length > 0)
}

/**
 * Exclusions a words MATCH can apply. A term with joined words is left to the text check, since its phrase also matches
 * texts without it.
 */
const ftsExclusions = (exclude: readonly Term[], mode: FtsMode) => (mode === "words" ? exclude.filter(term => joinedWords(term).length === 0) : exclude)

/** The words-mode MATCH string for one term. */
export const termMatch = (term: Term) => quote(term, "words")

/** Whether `toMatch(parsed, mode, true)` would differ from the strict query. */
export function canRelax(parsed: ParsedQuery, mode: FtsMode): boolean {
  return usableQuery(parsed, mode).groups.length > 1
}

const strictInclude = (groups: readonly (readonly Term[])[], mode: FtsMode) =>
  groups.map(group => (group.length > 1 ? `(${group.map(term => quote(term, mode)).join(" OR ")})` : quote(group[0]!, mode))).join(" AND ")
const looseInclude = (groups: readonly (readonly Term[])[], mode: FtsMode) => groups.flat().map(term => quote(term, mode)).join(" OR ")

/**
 * The FTS5 MATCH string for a parsed query: every term quoted, groups joined with AND, or with OR when `relaxed`.
 * Undefined when no term is left to include, since FTS5 has no NOT on its own. In words mode, an excluded term with
 * joined words is left out, for the text check.
 */
export function toMatch(parsed: ParsedQuery, mode: FtsMode, relaxed = false): string | undefined {
  const { groups, exclude } = usableQuery(parsed, mode)
  if (groups.length === 0) return undefined
  const include = relaxed ? looseInclude(groups, mode) : strictInclude(groups, mode)
  const excluded = ftsExclusions(exclude, mode)
  if (excluded.length === 0) return include
  return `(${include})${excluded.map(term => ` NOT ${quote(term, mode)}`).join("")}`
}

/**
 * The FTS5 MATCH string for the near matches of a words query: texts with some of its terms but not every group, and
 * none of its exclusions. Undefined when the query has one group, so every match is a full match.
 */
export function nearMatch(parsed: ParsedQuery): string | undefined {
  if (!canRelax(parsed, "words")) return undefined
  const { groups, exclude } = usableQuery(parsed, "words")
  return `((${looseInclude(groups, "words")}) NOT (${strictInclude(groups, "words")}))${ftsExclusions(exclude, "words").map(term => ` NOT ${quote(term, "words")}`).join("")}`
}

/** The literal texts to highlight in a substring snippet. */
export function highlightTerms(parsed: ParsedQuery, mode: FtsMode): string[] {
  return [...new Set(usableQuery(parsed, mode).groups.flat().map(term => term.text))]
}

/** Most trigrams of one literal that a candidate query asks for. Any subset finds a superset of the texts. */
const MAX_TRIGRAMS = 16

/**
 * A MATCH string for a trigram table without positions: every distinct trigram of `literal`, quoted and joined with
 * AND, at most MAX_TRIGRAMS of them spread over it. Texts that contain the literal all match; a few others may too,
 * so matches are candidates to check against the text. Undefined below three characters.
 */
export function trigramMatch(literal: string): string | undefined {
  const chars = [...literal]
  if (chars.length < MIN_SUBSTRING) return undefined
  const all = [...new Set(chars.slice(0, -2).map((_, at) => chars.slice(at, at + 3).join("")))]
  const step = Math.max(1, (all.length - 1) / (MAX_TRIGRAMS - 1))
  const picked = all.length <= MAX_TRIGRAMS ? all : [...new Set(Array.from({ length: MAX_TRIGRAMS }, (_, i) => all[Math.round(i * step)]!))]
  return picked.map(trigram => `"${trigram.replaceAll('"', '""')}"`).join(" AND ")
}

/**
 * Candidate MATCH strings for a substring query over the trigram table: `strict` finds texts that may hold every
 * group, `near` texts that may hold some term but not every group, and `any` texts that may hold any term. Exclusions
 * are left to the text check, because a text can hold every trigram of a term without the term. Undefined when no term
 * has three characters.
 */
export function substringCandidates(parsed: ParsedQuery): { strict: string; near: string | undefined; any: string } | undefined {
  const { groups } = usableQuery(parsed, "substring")
  if (groups.length === 0) return undefined
  const term = (item: Term) => `(${trigramMatch(item.text)!})`
  const group = (items: readonly Term[]) => (items.length > 1 ? `(${items.map(term).join(" OR ")})` : term(items[0]!))
  const strict = groups.map(group).join(" AND ")
  if (groups.length === 1) return { strict, near: undefined, any: strict }
  const any = groups.flat().map(term).join(" OR ")
  return { strict, near: `(${any}) NOT (${strict})`, any }
}

/**
 * The longest run of literal characters that every match of `pattern` must contain, when it has at least three, so a
 * regex search can ask the trigram table for candidates first. Conservative: a top-level `|`, and anything inside a
 * group or class, give no literal, and a character that a quantifier makes optional ends the run without it.
 */
export function requiredLiteral(pattern: RegExp): string | undefined {
  if (pattern.flags.includes("v")) return undefined
  const source = pattern.source
  let best = ""
  let run = ""
  const flush = () => {
    if ([...run].length > [...best].length) best = run
    run = ""
  }
  let at = 0
  while (at < source.length) {
    const char = source[at]!
    if (char === "|") return undefined
    let literal: string | undefined
    let next: number
    if (char === "(" || char === "[") {
      next = char === "(" ? skipGroup(source, at) : skipClass(source, at)
    } else if (char === "\\") {
      const escaped = source[at + 1] ?? ""
      if (/[\^$\\.*+?()[\]{}|/-]/.test(escaped)) {
        literal = escaped
        next = at + 2
      } else next = skipEscape(source, at)
    } else if (char === "." || char === "^" || char === "$") {
      next = at + 1
    } else if (char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff) {
      // Without the u flag a quantifier binds to half of an astral character; leave them out.
      next = at + 1
    } else {
      literal = char
      next = at + 1
    }
    const quantifier = readQuantifier(source, next)
    if (literal !== undefined && (!quantifier || quantifier.min > 0)) run += literal
    if (literal === undefined || quantifier) flush()
    at = quantifier ? quantifier.end : next
  }
  flush()
  return [...best].length >= MIN_SUBSTRING ? best : undefined
}

/** A quantifier at `at`: `?`, `*`, `+` or `{n}`, `{n,}`, `{n,m}`, with an optional lazy `?`. */
function readQuantifier(source: string, at: number): { min: number; end: number } | undefined {
  const char = source[at]
  let min: number
  let end: number
  if (char === "?" || char === "*") [min, end] = [0, at + 1]
  else if (char === "+") [min, end] = [1, at + 1]
  else {
    const braces = /^\{(\d+)(?:,\d*)?\}/.exec(source.slice(at, at + 24))
    if (!braces) return undefined
    ;[min, end] = [Number(braces[1]), at + braces[0].length]
  }
  if (source[end] === "?") end++
  return { min, end }
}

/** The index after the group that opens at `at`, skipping escapes, classes and nested groups. */
function skipGroup(source: string, at: number): number {
  let depth = 0
  for (let index = at; index < source.length; index++) {
    const char = source[index]
    if (char === "\\") index++
    else if (char === "[") index = skipClass(source, index) - 1
    else if (char === "(") depth++
    else if (char === ")" && --depth === 0) return index + 1
  }
  return source.length
}

/** The index after the character class that opens at `at`. */
function skipClass(source: string, at: number): number {
  for (let index = at + 1; index < source.length; index++) {
    if (source[index] === "\\") index++
    else if (source[index] === "]") return index + 1
  }
  return source.length
}

/** The index after an escape that is not a literal character, such as `\d`, `\b`, `\u{1F600}`, `\p{L}` or `\k<name>`. */
function skipEscape(source: string, at: number): number {
  const kind = source[at + 1] ?? ""
  const rest = source.slice(at + 2)
  const close = (open: string, end: string) => (rest.startsWith(open) ? at + 2 + Math.max(0, rest.indexOf(end)) + 1 : at + 2)
  if (kind === "u" && rest.startsWith("{")) return close("{", "}")
  if (kind === "u") return at + 2 + (/^[0-9a-fA-F]{4}/.test(rest) ? 4 : 0)
  if (kind === "x") return at + 2 + (/^[0-9a-fA-F]{2}/.test(rest) ? 2 : 0)
  if (kind === "c") return at + 3
  if (kind === "p" || kind === "P") return close("{", "}")
  if (kind === "k") return close("<", ">")
  if (/\d/.test(kind)) return at + 1 + (/^\d+/.exec(source.slice(at + 1))?.[0].length ?? 1)
  return at + 2
}

const DAY = 86_400_000
const UNITS: Record<string, number> = { h: DAY / 24, d: DAY, w: 7 * DAY, m: 30 * DAY, y: 365 * DAY }
const DURATION = /^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|d|days?|w|wks?|weeks?|m|mo|mos|months?|y|yrs?|years?)$/i
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i

/**
 * Epoch milliseconds for a `since` or `until` filter: a duration back from `now` ("36h", "7d", "2w", "3m" months, "1y")
 * or an ISO date or date-time. A bare date is UTC and covers the whole day, so `until: "2026-10-01"` includes that day.
 */
export function parseTime(value: string, now: number, edge: "since" | "until"): number {
  const text = value.trim()
  const duration = DURATION.exec(text)
  if (duration) {
    const unit = duration[2]!.toLowerCase()
    const size = unit.startsWith("mo") || unit === "m" ? UNITS.m! : UNITS[unit[0]!]!
    return now - Number(duration[1]) * size
  }
  const time = ISO.test(text) ? Date.parse(DATE_ONLY.test(text) ? `${text}T00:00:00Z` : text) : Number.NaN
  if (!Number.isFinite(time)) {
    throw new QueryError(`${edge} must be an ISO date such as "2026-10-01" or an age such as "36h", "7d", "2w", "3m" or "1y"`, "query", { hint: QUERY_HINTS.time })
  }
  return DATE_ONLY.test(text) && edge === "until" ? time + DAY - 1 : time
}

/**
 * A pattern for regex mode. `/source/flags` sets the flags; a bare pattern ignores case, like the other modes.
 * The returned RegExp is global so it can find every match.
 */
export function parseRegex(pattern: string): RegExp {
  const literal = /^\/(.+)\/([dgimsuvy]*)$/s.exec(pattern)
  const source = literal ? literal[1]! : pattern
  const flags = literal ? literal[2]! : "i"
  if (!source) throw new QueryError("regex pattern is empty", "query", { hint: QUERY_HINTS.regex })
  try {
    return new RegExp(source, flags.includes("g") ? flags : `${flags}g`)
  } catch (error) {
    // V8 puts the pattern before the last colon; keep only the reason.
    const reason = error instanceof Error && error.message.startsWith("Invalid regular expression") ? error.message.split(": ").at(-1) : "invalid flags"
    throw new QueryError(`invalid regex: ${reason}`, "query", { hint: QUERY_HINTS.regex })
  }
}

const CURSOR = "o:"

export function encodeCursor(offset: number): string {
  return Buffer.from(`${CURSOR}${offset}`).toString("base64url")
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0
  const text = Buffer.from(cursor, "base64url").toString("utf8")
  const offset = text.startsWith(CURSOR) ? Number(text.slice(CURSOR.length)) : Number.NaN
  if (!Number.isSafeInteger(offset) || offset < 0) throw new QueryError("cursor is not one this call returned; start again without it", "cursor")
  return offset
}
