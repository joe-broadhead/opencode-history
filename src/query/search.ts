// Rank past sessions for a query: full-text, substring or regex matches over docs, grouped by session tree, with snippets.
import type { Caller, Hidden, IndexState, SearchHit, SearchInput, SearchOutput, Snippet } from "../domain/api.js"
import { BOUNDS, MAX_PHRASINGS } from "../domain/bounds.js"
import { DOC_KINDS, KIND_WEIGHT, type DocKind } from "../domain/contract.js"
import type { Db } from "../domain/sqlite.js"
import { refused } from "../domain/common.js"
import { bounded, cite, iso, placeholders, summaries, trimSlash } from "./common.js"
import { filterSql, hiddenCounts, hidingColumns, type Filtered, type Where } from "./filters.js"
import {
  decodeCursor, encodeCursor, hasJoined, highlightTerms, joinedPattern, joinedWords, MIN_SUBSTRING, nearMatch, parseQuery, parseRegex, QUERY_HINTS,
  requiredLiteral, substringCandidates, termMatch, toMatch, trigramMatch, usableQuery, type ParsedQuery, type Term,
} from "./parse.js"

export const SNIPPET_CHARS = 240
/** Best-ranked docs kept per phrasing, and per phrasing's near matches in substring mode, before grouping. */
const MAX_DOC_HITS = 5000
/** Words mode: the near matches of a phrasing are its best texts by bm25, at most this many, before the filters. */
export const NEAR_CANDIDATES = 2000
/** Candidate docs substring and regex modes read at most per phrasing, newest first. */
export const SCAN_DOCS = 20_000
/** Substring and regex modes stop reading new docs after this long. */
const SCAN_BUDGET_MS = 5000
/** Share of its score a near match keeps: a text with only some of a phrasing's terms. */
export const NEAR_WEIGHT = 0.4
/** Snippet highlight and cut marks. */
export const MARK = { open: "«", close: "»", cut: "…" } as const

const DAY = 86_400_000
const SECOND_WEIGHT = 0.3
const REST_WEIGHT = 0.1
/** The rest of a session's matches add at most this share of its best match. */
const REST_CAP = 0.5
/** Extra share of the score for each phrasing matched beyond the first. A phrasing matched only nearly counts NEAR_WEIGHT. */
const PHRASING_BONUS = 0.25
const PROJECT_BOOST = 1.5
const DIRECTORY_BOOST = 1.2
const HALF_LIFE = 45 * DAY
/** Share of the score that decays with age when recency is on. */
const RECENCY_SHARE = 0.3
const TEXT_BATCH = 500
const MAX_RANGES = 50
/** Rows read per phrasing when counting what the filters left out of an empty search. */
const HIDDEN_ROWS = 50_000

interface SearchOptions {
  /** Epoch milliseconds that durations and recency count back from. */
  readonly now?: number
}

/** A doc that may match, with what ranking and grouping need. */
interface Candidate {
  readonly id: number
  readonly sessionID: string
  readonly rootID: string
  readonly messageID: string
  readonly seq: number
  readonly time: number
  readonly kind: DocKind
  readonly tool: string | null
  readonly projectID: string
  readonly directory: string
  /** The tree's title, for folding near-duplicate sessions. */
  readonly rootTitle: string
}

interface DocHit extends Candidate {
  readonly score: number
  /** It has only some of the phrasing's terms. */
  readonly near: boolean
}

interface Ranked extends DocHit {
  /** The phrasing that scored this doc best, for its snippet. */
  readonly phrasing: number
}

interface Group {
  readonly rootID: string
  readonly docs: readonly Ranked[]
  /** Phrasings matched with every term. */
  readonly phrasings: number
  readonly newest: number
  readonly score: number
}

const HIT_COLUMNS = `d.id as id, d.session_id as sessionID, d.root_id as rootID, d.message_id as messageID, d.seq as seq, d.time as time,
  d.kind as kind, d.tool as tool, coalesce(r.project_id, s.project_id) as projectID, coalesce(r.directory, s.directory) as directory,
  coalesce(r.title, s.title) as rootTitle`
const JOINS = "join sessions s on s.id = d.session_id left join sessions r on r.id = d.root_id"
const WEIGHT_SQL = `case d.kind ${DOC_KINDS.map(kind => `when '${kind}' then ${KIND_WEIGHT[kind]}`).join(" ")} else 1 end`
const NONE: Where = { sql: "", params: [] }

/** Hits per phrasing, and whether a cap left full matches unread. */
interface Hits {
  readonly lists: DocHit[][]
  readonly truncated: boolean
}

const ftsFailure = (error: unknown) =>
  error instanceof Error && /fts5|syntax error/i.test(error.message) ? refused("QUERY_INVALID", "the query could not be searched", QUERY_HINTS.words) : error

/** The best docs for one words-mode MATCH, scored by bm25 and kind. */
function ftsHits(db: Db, match: string, where: Where): { hits: DocHit[]; truncated: boolean } {
  let rows: (Candidate & { score: number })[]
  try {
    rows = db.all(
      `select ${HIT_COLUMNS}, -bm25(docs_words) * ${WEIGHT_SQL} as score
        from docs_words join docs d on d.id = docs_words.rowid ${JOINS}
        where docs_words match ? and ${where.sql}
        order by score desc, d.time desc limit ?`,
      match,
      ...where.params,
      MAX_DOC_HITS + 1,
    )
  } catch (error) {
    throw ftsFailure(error)
  }
  const hits = rows.slice(0, MAX_DOC_HITS).map(row => ({ ...row, near: false }))
  return { hits, truncated: rows.length > MAX_DOC_HITS }
}

/**
 * The near matches of one words-mode phrasing, scored like full matches at NEAR_WEIGHT. An any-term query can match
 * most of the index, so FTS5 ranks its matches by bm25 alone and only the best NEAR_CANDIDATES are joined and filtered.
 */
function nearHits(db: Db, match: string, where: Where): DocHit[] {
  let rows: (Candidate & { score: number })[]
  try {
    rows = db.all(
      `select ${HIT_COLUMNS}, -c.bm25 * ${WEIGHT_SQL} as score
        from (select rowid, bm25(docs_words) as bm25 from docs_words where docs_words match ? order by bm25 limit ?) c
          join docs d on d.id = c.rowid ${JOINS}
        where ${where.sql}
        order by score desc, d.time desc`,
      match,
      NEAR_CANDIDATES,
      ...where.params,
    )
  } catch (error) {
    throw ftsFailure(error)
  }
  return rows.map(row => ({ ...row, score: row.score * NEAR_WEIGHT, near: true }))
}

/** How many session trees the full matches reach, at most `enough`. */
function fullTrees(lists: readonly (readonly DocHit[])[], enough: number): number {
  const roots = new Set<string>()
  for (const list of lists) {
    for (const hit of list) {
      if (hit.near) continue
      roots.add(hit.rootID)
      if (roots.size >= enough) return roots.size
    }
  }
  return roots.size
}

/** Lets the server's event loop run between scan batches, so a long substring or regex scan never blocks OpenCode. */
const pause = () => new Promise<void>(resolve => setImmediate(resolve))

/**
 * Read candidate docs newest first, at most SCAN_DOCS: those whose trigrams match `match`, a superset of the real
 * matches, or every filtered doc. `visit` gets each with its text, in batches, until it returns false or `deadline`
 * passes, and the event loop runs between batches. Returns whether every candidate was read. `extra` adds columns to
 * each candidate row.
 */
async function scan(db: Db, where: Where, match: string | undefined, deadline: number, visit: (doc: Candidate & Record<string, unknown>, text: string) => boolean, extra: Where = NONE): Promise<boolean> {
  const from = match === undefined ? `docs d ${JOINS}` : `docs_sub join docs d on d.id = docs_sub.rowid ${JOINS}`
  let candidates: (Candidate & Record<string, unknown>)[]
  try {
    candidates = db.all(
      `select ${HIT_COLUMNS}${extra.sql} from ${from}
        where ${match === undefined ? "" : "docs_sub match ? and "}${where.sql}
        order by d.time desc, d.id desc limit ?`,
      ...extra.params,
      ...(match === undefined ? [] : [match]),
      ...where.params,
      SCAN_DOCS + 1,
    )
  } catch (error) {
    throw ftsFailure(error)
  }
  const reading = candidates.slice(0, SCAN_DOCS)
  for (let at = 0; at < reading.length; at += TEXT_BATCH) {
    if (at > 0) await pause()
    if (performance.now() > deadline) return false
    const batch = reading.slice(at, at + TEXT_BATCH)
    const rows = db.all<{ id: number; text: string }>(`select id, text from doc_texts where id in (${placeholders(batch.length)})`, ...batch.map(doc => doc.id))
    const texts = new Map(rows.map(row => [row.id, row.text]))
    for (const [index, doc] of batch.entries()) {
      const text = texts.get(doc.id)
      if (text !== undefined && !visit(doc, text)) return at + index + 1 >= candidates.length
    }
  }
  return candidates.length <= SCAN_DOCS
}

interface Range {
  readonly start: number
  readonly end: number
}

/** Non-empty matches of a global regex in `text`, at most `cap`. */
function findRanges(pattern: RegExp, text: string, cap = MAX_RANGES): Range[] {
  const ranges: Range[] = []
  pattern.lastIndex = 0
  for (let match = pattern.exec(text); match && ranges.length < cap; match = pattern.exec(text)) {
    if (match[0].length === 0) {
      pattern.lastIndex++
      if (pattern.lastIndex > text.length) break
      continue
    }
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  pattern.lastIndex = 0
  return ranges
}

/**
 * `text` in lower case with every character at the same index, so positions found in it hold in `text`. A character
 * whose lower case is longer, such as `İ`, stays as it is.
 */
function fold(text: string): string {
  const lower = text.toLowerCase()
  if (lower.length === text.length) return lower
  let out = ""
  for (const char of text) {
    const folded = char.toLowerCase()
    out += folded.length === char.length ? folded : char
  }
  return out
}

/** Where each of `terms`, already folded, occurs in `folded`, without overlaps, at most `cap` in all. */
function literalRanges(folded: string, terms: readonly string[], cap = MAX_RANGES): Range[] {
  const ranges: Range[] = []
  for (const term of terms) {
    for (let at = folded.indexOf(term); at >= 0 && ranges.length < cap; at = folded.indexOf(term, at + term.length)) {
      ranges.push({ start: at, end: at + term.length })
    }
  }
  return ranges.sort((a, b) => a.start - b.start || b.end - a.end)
}

/** A substring phrasing as folded literals: every group must have a term in the text, and no exclusion may be in it. */
interface Literals {
  readonly groups: readonly (readonly string[])[]
  readonly exclude: readonly string[]
  readonly terms: readonly string[]
}

function literalsOf(parsed: ParsedQuery): Literals {
  const usable = usableQuery(parsed, "substring")
  const groups = usable.groups.map(group => [...new Set(group.map(term => fold(term.text)))])
  return { groups, exclude: usable.exclude.map(term => fold(term.text)), terms: [...new Set(groups.flat())] }
}

/** How `text` matches a substring phrasing: occurrences, and whether every group has one. Undefined for no match. */
function literalMatch(text: string, literals: Literals): { count: number; full: boolean } | undefined {
  const folded = fold(text)
  if (literals.exclude.some(term => folded.includes(term))) return undefined
  let count = 0
  let found = 0
  for (const group of literals.groups) {
    let inGroup = 0
    for (const term of group) inGroup += literalRanges(folded, [term], MAX_RANGES - count).length
    if (inGroup > 0) found++
    count += inGroup
  }
  return found === 0 ? undefined : { count: Math.max(1, count), full: found === literals.groups.length }
}

/** Score of a substring or regex match: its kind's weight, growing with the log of the occurrences. */
const countScore = (kind: DocKind, count: number) => (KIND_WEIGHT[kind] ?? 1) * (1 + Math.log2(Math.min(count, MAX_RANGES)))

const hit = (doc: Candidate, score: number, near: boolean): DocHit => ({
  id: doc.id, sessionID: doc.sessionID, rootID: doc.rootID, messageID: doc.messageID, seq: doc.seq, time: doc.time, kind: doc.kind,
  tool: doc.tool, projectID: doc.projectID, directory: doc.directory, rootTitle: doc.rootTitle, score: near ? score * NEAR_WEIGHT : score, near,
})

/** Read the texts of `ids` that `texts` does not hold yet. */
function readTexts(db: Db, ids: readonly number[], texts: Map<number, string>): void {
  const unread = ids.filter(id => !texts.has(id))
  for (let at = 0; at < unread.length; at += TEXT_BATCH) {
    const batch = unread.slice(at, at + TEXT_BATCH)
    for (const row of db.all<{ id: number; text: string }>(`select id, text from doc_texts where id in (${placeholders(batch.length)})`, ...batch)) texts.set(row.id, row.text)
  }
}

/**
 * How each of `ids` matches a words phrasing with joined words, checked term by term: a term matches a text that FTS5
 * matches it in and that holds each of its joined words whole (`joinedPattern`). True for a full match, false for a
 * near match, and absent for no match or a match of an excluded term with joined words. Exclusions without joined
 * words are already in the MATCH strings.
 */
function checkJoined(db: Db, parsed: ParsedQuery, ids: readonly number[]): Map<number, boolean> {
  const { groups, exclude } = usableQuery(parsed, "words")
  const texts = new Map<number, string>()
  const matched = new Map<Term, ReadonlySet<number>>()
  const matching = (term: Term): ReadonlySet<number> => {
    const known = matched.get(term)
    if (known) return known
    const found = new Set<number>()
    for (let at = 0; at < ids.length; at += TEXT_BATCH) {
      const batch = ids.slice(at, at + TEXT_BATCH)
      const rows = db.all<{ id: number }>(`select rowid as id from docs_words where docs_words match ? and rowid in (${placeholders(batch.length)})`, termMatch(term), ...batch)
      for (const row of rows) found.add(row.id)
    }
    const patterns = joinedWords(term).map(joinedPattern)
    if (patterns.length > 0) {
      readTexts(db, [...found], texts)
      for (const id of found) if (!patterns.every(pattern => pattern.test(texts.get(id) ?? ""))) found.delete(id)
    }
    matched.set(term, found)
    return found
  }
  const excluded = exclude.filter(term => joinedWords(term).length > 0).map(matching)
  const out = new Map<number, boolean>()
  for (const id of ids) {
    if (excluded.some(set => set.has(id))) continue
    const found = groups.filter(group => group.some(term => matching(term).has(id))).length
    if (found > 0) out.set(id, found === groups.length)
  }
  return out
}

/**
 * The hits of a words phrasing as their texts match it. A joined word's phrase also matches other text, such as "2 2 3"
 * for 2.2.3, so with joined words a hit stays full only when its text has every group, becomes a near match when it has
 * some, and is left out when it has none.
 */
function checked(db: Db, parsed: ParsedQuery, hits: DocHit[]): DocHit[] {
  if (hits.length === 0 || !hasJoined(parsed)) return hits
  const matched = checkJoined(db, parsed, hits.map(hit => hit.id))
  return hits.flatMap(hit => {
    const full = matched.get(hit.id)
    if (full === undefined) return []
    return full || hit.near ? [hit] : [{ ...hit, score: hit.score * NEAR_WEIGHT, near: true }]
  })
}

/**
 * Full matches of every phrasing, then near matches, only when the full matches reach fewer than `limit` session
 * trees: a page they fill has no room for weaker results. A phrasing whose full matches fill the cap gets none either.
 */
function wordsHits(db: Db, parsed: readonly ParsedQuery[], where: Where, limit: number): Hits {
  const full = parsed.map(query => {
    const strict = toMatch(query, "words")
    return strict === undefined ? { hits: [], truncated: false } : ftsHits(db, strict, where)
  })
  const lists = full.map((result, index) => checked(db, parsed[index]!, result.hits))
  if (fullTrees(lists, limit) < limit) {
    parsed.forEach((query, index) => {
      const near = full[index]!.truncated ? undefined : nearMatch(query)
      if (near !== undefined) lists[index] = [...lists[index]!, ...checked(db, query, nearHits(db, near, where))]
    })
  }
  return { lists, truncated: full.some(result => result.truncated) }
}

/** As words mode: full matches of every phrasing first, then near matches only for a page they leave short. */
async function substringHits(db: Db, parsed: readonly ParsedQuery[], where: Where, deadline: number, limit: number): Promise<Hits> {
  let truncated = false
  type Pass = { hits: DocHit[]; near: { match: string; visit: (doc: Candidate, text: string) => boolean; count: () => number } | undefined }
  const passes: Pass[] = []
  for (const query of parsed) {
    const candidates = substringCandidates(query)
    if (!candidates) {
      passes.push({ hits: [], near: undefined })
      continue
    }
    const literals = literalsOf(query)
    const hits: DocHit[] = []
    let full = 0
    let near = 0
    const visit = (doc: Candidate, text: string) => {
      const match = literalMatch(text, literals)
      if (match?.full && full < MAX_DOC_HITS) {
        full++
        hits.push(hit(doc, countScore(doc.kind, match.count), false))
      } else if (match && !match.full && near < MAX_DOC_HITS) {
        near++
        hits.push(hit(doc, countScore(doc.kind, match.count), true))
      }
      return full < MAX_DOC_HITS
    }
    // A text a strict candidate may still hold only some groups: then it is a near match.
    const complete = await scan(db, where, candidates.strict, deadline, visit)
    truncated ||= !complete
    // As in words mode, full matches that fill the cap already rank above any near match.
    const nearPass = candidates.near && complete ? { match: candidates.near, visit, count: () => near } : undefined
    passes.push({ hits, near: nearPass })
  }
  const lists = passes.map(pass => pass.hits)
  if (fullTrees(lists, limit) < limit) {
    for (const { near } of passes) {
      if (!near) continue
      await scan(db, where, near.match, deadline, (doc, text) => {
        near.visit(doc, text)
        return near.count() < MAX_DOC_HITS
      })
    }
  }
  return { lists, truncated }
}

/** Patterns with the same candidates share one read: by their required literal, or every filtered doc. */
async function regexHits(db: Db, patterns: readonly RegExp[], where: Where, deadline: number): Promise<Hits> {
  const lists: DocHit[][] = patterns.map(() => [])
  const byMatch = new Map<string | undefined, number[]>()
  patterns.forEach((pattern, index) => {
    const literal = requiredLiteral(pattern)
    const match = literal === undefined ? undefined : trigramMatch(literal)
    byMatch.set(match, [...(byMatch.get(match) ?? []), index])
  })
  let truncated = false
  for (const [match, indexes] of byMatch) {
    const complete = await scan(db, where, match, deadline, (doc, text) => {
      for (const index of indexes) {
        const count = findRanges(patterns[index]!, text).length
        if (count > 0 && lists[index]!.length < MAX_DOC_HITS) lists[index]!.push(hit(doc, countScore(doc.kind, count), false))
      }
      return indexes.some(index => lists[index]!.length < MAX_DOC_HITS)
    })
    truncated ||= !complete
  }
  return { lists, truncated }
}

const sameDirectory = (a: string, b: string) => trimSlash(a) === trimSlash(b)

/** Merge the phrasings' hits, group them by session tree and score each tree. */
function rank(lists: readonly (readonly DocHit[])[], caller: Caller, recency: boolean, now: number): Group[] {
  const docs = new Map<number, Ranked>()
  const full = new Map<string, Set<number>>()
  const near = new Map<string, Set<number>>()
  lists.forEach((list, phrasing) => {
    for (const hit of list) {
      const seen = docs.get(hit.id)
      if (!seen || hit.score > seen.score) docs.set(hit.id, { ...hit, phrasing })
      const matched = hit.near ? near : full
      let set = matched.get(hit.rootID)
      if (!set) matched.set(hit.rootID, (set = new Set()))
      set.add(phrasing)
    }
  })

  const trees = new Map<string, Ranked[]>()
  for (const doc of docs.values()) {
    const tree = trees.get(doc.rootID)
    if (tree) tree.push(doc)
    else trees.set(doc.rootID, [doc])
  }

  const groups: Group[] = []
  for (const [rootID, tree] of trees) {
    tree.sort((a, b) => b.score - a.score || b.time - a.time || a.id - b.id)
    const best = tree[0]!
    const rest = tree.slice(2).reduce((sum, doc) => sum + doc.score, 0)
    let score = best.score + SECOND_WEIGHT * (tree[1]?.score ?? 0) + Math.min(REST_WEIGHT * rest, REST_CAP * best.score)
    const fully = full.get(rootID) ?? new Set<number>()
    const nearly = [...(near.get(rootID) ?? [])].filter(phrasing => !fully.has(phrasing)).length
    score *= 1 + PHRASING_BONUS * Math.max(0, fully.size + NEAR_WEIGHT * nearly - 1)
    if (best.projectID === caller.projectID) score *= PROJECT_BOOST
    if (sameDirectory(best.directory, caller.directory)) score *= DIRECTORY_BOOST
    const newest = tree.reduce((latest, doc) => Math.max(latest, doc.time), 0)
    if (recency) score *= 1 - RECENCY_SHARE + RECENCY_SHARE * 0.5 ** (Math.max(0, now - newest) / HALF_LIFE)
    groups.push({ rootID, docs: tree, phrasings: fully.size, newest, score })
  }
  return groups.sort((a, b) => b.score - a.score || b.newest - a.newest || (a.rootID < b.rootID ? -1 : a.rootID > b.rootID ? 1 : 0))
}

/** A title or prompt for comparing near-duplicates: lower case, with runs of anything but letters and digits as one space. */
const sameTitleKey = (title: string) => title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()

/** Words that say little about what a title is about, left out when titles are compared word by word. */
const TITLE_STOPWORDS = new Set("a an and are as at be by for from in into is it of on or the to with".split(" "))
/** Titles with fewer words in common are never near-identical, and prompts with fewer words are too short to fold on. */
const MIN_SHARED_WORDS = 3

/** The distinct words of a title key, without stop words. */
const titleWords = (key: string) => new Set(key.split(" ").filter(word => word && !TITLE_STOPWORDS.has(word)))

/**
 * Near-identical titles, such as the generated titles of one scheduled prompt's runs: at least MIN_SHARED_WORDS words in
 * common and at least two thirds of all their words, and no number in only one of them, since numbers tell issues,
 * versions and timestamps apart.
 */
function nearTitles(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  let shared = 0
  for (const word of a) {
    if (b.has(word)) shared++
    else if (/\p{N}/u.test(word)) return false
  }
  for (const word of b) if (!a.has(word) && /\p{N}/u.test(word)) return false
  return shared >= MIN_SHARED_WORDS && 3 * shared >= 2 * (a.size + b.size - shared)
}

/** Root first prompts by root ID, normalised with `sameTitleKey`, for the trees that have one long enough to fold on. */
function promptKeys(db: Db, rootIDs: readonly string[]): Map<string, string> {
  const keys = new Map<string, string>()
  for (let at = 0; at < rootIDs.length; at += TEXT_BATCH) {
    const batch = rootIDs.slice(at, at + TEXT_BATCH)
    const rows = db.all<{ id: string; prompt: string }>(`select id, first_prompt as prompt from sessions where first_prompt is not null and id in (${placeholders(batch.length)})`, ...batch)
    for (const row of rows) {
      const key = sameTitleKey(row.prompt)
      if (key.split(" ").length >= MIN_SHARED_WORDS) keys.set(row.id, key)
    }
  }
  return keys
}

/**
 * Keep the best of the trees in one directory that are runs of the same thing, such as one scheduled prompt; the rest
 * count in its `similar`. Trees are the same when their titles are equal by `sameTitleKey` or near-identical by
 * `nearTitles`, or their first prompts are equal by `sameTitleKey`. A tree joins the group of the first tree it is the
 * same as, also when that tree was itself folded. Trees with no title and no prompt to compare are never folded.
 */
function foldSimilar(db: Db, groups: readonly Group[]): { kept: Group[]; similar: Map<string, number> } {
  const kept: Group[] = []
  const similar = new Map<string, number>()
  const prompts = promptKeys(db, groups.map(group => group.rootID))
  /** The kept tree for a directory and exact title or prompt key. */
  const exact = new Map<string, string>()
  /** Titles seen per directory and word, for finding near-identical ones without comparing every pair. */
  const byWord = new Map<string, { readonly words: ReadonlySet<string>; readonly best: string }[]>()
  for (const group of groups) {
    const doc = group.docs[0]!
    const directory = trimSlash(doc.directory)
    const title = sameTitleKey(doc.rootTitle)
    const prompt = prompts.get(group.rootID)
    const keys = [...title ? [`t\u0000${directory}\u0000${title}`] : [], ...prompt ? [`p\u0000${directory}\u0000${prompt}`] : []]
    const words = titleWords(title)
    let best = keys.map(key => exact.get(key)).find(found => found !== undefined)
    if (best === undefined && words.size >= MIN_SHARED_WORDS) {
      const seen = new Set<object>()
      lookup: for (const word of words) {
        for (const other of byWord.get(`${directory}\u0000${word}`) ?? []) {
          if (seen.has(other)) continue
          seen.add(other)
          if (nearTitles(words, other.words)) {
            best = other.best
            break lookup
          }
        }
      }
    }
    if (best !== undefined) similar.set(best, (similar.get(best) ?? 0) + 1)
    else kept.push(group)
    const owner = best ?? group.rootID
    for (const key of keys) if (!exact.has(key)) exact.set(key, owner)
    if (words.size >= MIN_SHARED_WORDS) {
      const entry = { words, best: owner }
      for (const word of words) {
        const key = `${directory}\u0000${word}`
        const list = byWord.get(key)
        if (list) list.push(entry)
        else byWord.set(key, [entry])
      }
    }
  }
  return { kept, similar }
}

/** Collapse whitespace, keeping `ranges` pointing at the same characters. */
function collapse(text: string, ranges: readonly Range[]): { text: string; ranges: Range[] } {
  let out = ""
  let gap = false
  const at = new Array<number>(text.length + 1)
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    at[index] = out.length
    if (/\s/.test(char)) {
      gap = true
      continue
    }
    if (gap && out.length > 0) out += " "
    gap = false
    at[index] = out.length
    out += char
  }
  at[text.length] = out.length
  const mapped = ranges.map(range => ({ start: at[range.start]!, end: at[range.end]! })).filter(range => range.end > range.start)
  return { text: out, ranges: mapped }
}

/** About `width` characters of `text` around its first range, with ranges marked and cuts shown. */
function excerpt(text: string, ranges: readonly Range[], width = SNIPPET_CHARS, cut: { start?: boolean; end?: boolean } = {}): string {
  const flat = collapse(text, [...ranges].sort((a, b) => a.start - b.start))
  const body = flat.text
  const first = flat.ranges[0]
  let start = first ? Math.max(0, first.start - Math.floor(width * 0.3)) : 0
  let end = Math.min(body.length, start + width)
  start = Math.max(0, end - width)
  // Cut at spaces when one is near, so words stay whole.
  if (start > 0) {
    const space = body.indexOf(" ", start)
    if (space >= 0 && space - start < 20 && (!first || space < first.start)) start = space + 1
  }
  if (end < body.length) {
    const space = body.lastIndexOf(" ", end)
    if (space > start && end - space < 20 && (!first || space >= first.end)) end = space
  }
  let out = ""
  let at = start
  for (const range of flat.ranges) {
    if (range.end <= at || range.start >= end) continue
    const from = Math.max(range.start, at)
    const to = Math.min(range.end, end)
    out += `${body.slice(at, from)}${MARK.open}${body.slice(from, to)}${MARK.close}`
    at = to
  }
  out += body.slice(at, end)
  const before = start > 0 || cut.start ? MARK.cut : ""
  const after = end < body.length || cut.end ? MARK.cut : ""
  return `${before}${out.trim()}${after}`
}

// FTS5 snippet() marks, chosen so they cannot be confused with text; they are swapped for MARK.
const FTS_OPEN = "\u0002"
const FTS_CLOSE = "\u0003"
const FTS_CUT = "\u0004"

/**
 * Turn FTS5 snippet() output back into text and ranges, then cut it to size. Marked words joined by punctuation with no
 * space, the parts of a joined word such as 2.2.3, are marked as one.
 */
function ftsExcerpt(marked: string): string {
  const cut = { start: marked.startsWith(FTS_CUT), end: marked.endsWith(FTS_CUT) }
  const ranges: Range[] = []
  let text = ""
  let open = -1
  for (const char of marked.replaceAll(FTS_CUT, "")) {
    if (char === FTS_OPEN) open = text.length
    else if (char === FTS_CLOSE) {
      const last = ranges.at(-1)
      if (open >= 0 && last && /^[^\s\p{L}\p{N}]+$/u.test(text.slice(last.end, open))) ranges[ranges.length - 1] = { start: last.start, end: text.length }
      else if (open >= 0) ranges.push({ start: open, end: text.length })
      open = -1
    } else text += char
  }
  return excerpt(text, ranges, SNIPPET_CHARS, cut)
}

/**
 * How to draw snippets for each phrasing: FTS5 snippet() for words, with the loose query for near matches so their
 * terms are marked; the literal terms for substring; the pattern for regex.
 */
type Highlighter =
  | { readonly kind: "fts"; readonly full: string; readonly near: string }
  | { readonly kind: "literal"; readonly terms: readonly string[] }
  | { readonly kind: "regex"; readonly pattern: RegExp }
  | undefined

function snippetsFor(db: Db, docs: readonly Ranked[], highlighters: readonly Highlighter[]): Map<number, string> {
  const texts = new Map<number, string>()
  const fts = new Map<string, number[]>()
  const plain: Ranked[] = []
  for (const doc of docs) {
    const highlighter = highlighters[doc.phrasing]
    if (highlighter?.kind === "fts") {
      const match = doc.near ? highlighter.near : highlighter.full
      const ids = fts.get(match)
      if (ids) ids.push(doc.id)
      else fts.set(match, [doc.id])
    } else plain.push(doc)
  }
  for (const [match, ids] of fts) {
    const rows = db.all<{ id: number; text: string }>(
      `select rowid as id, snippet(docs_words, 0, ?, ?, ?, 64) as text from docs_words where docs_words match ? and rowid in (${placeholders(ids.length)})`,
      FTS_OPEN,
      FTS_CLOSE,
      FTS_CUT,
      match,
      ...ids,
    )
    for (const row of rows) texts.set(row.id, ftsExcerpt(row.text))
  }
  if (plain.length > 0) {
    const rows = db.all<{ id: number; text: string }>(`select id, text from doc_texts where id in (${placeholders(plain.length)})`, ...plain.map(doc => doc.id))
    const byID = new Map(rows.map(row => [row.id, row.text]))
    for (const doc of plain) {
      const text = byID.get(doc.id)
      if (text === undefined) continue
      const highlighter = highlighters[doc.phrasing]
      // Substring snippets centre on the first literal match, found in the text itself.
      const ranges = highlighter?.kind === "regex" ? findRanges(highlighter.pattern, text) : highlighter?.kind === "literal" ? literalRanges(fold(text), highlighter.terms) : []
      texts.set(doc.id, excerpt(text, ranges))
    }
  }
  return texts
}

/**
 * The best docs of a tree, at most one per message. Title docs (seq -1) still score but give no snippet:
 * the result already carries the title, and a snippet's seq must be a message to read.
 */
function pickSnippets(group: Group, count: number): Ranked[] {
  const picked: Ranked[] = []
  const messages = new Set<string>()
  for (const doc of group.docs) {
    if (picked.length >= count) break
    if (doc.seq < 0) continue
    const key = `${doc.sessionID}\u0000${doc.messageID}`
    if (messages.has(key)) continue
    messages.add(key)
    picked.push(doc)
  }
  return picked
}

function phrasingsOf(query: string | readonly string[], caseSensitive: boolean): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of typeof query === "string" ? [query] : query) {
    const text = typeof raw === "string" ? raw.trim() : ""
    const key = caseSensitive ? text : text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out.slice(0, MAX_PHRASINGS)
}

/**
 * What a phrasing matches in a text, for counting what the filters left out; true when the text matches at all. A words
 * phrasing with joined words has its matches checked against it.
 */
type Probe =
  | { readonly kind: "fts"; readonly match: string; readonly check?: ParsedQuery }
  | { readonly kind: "scan"; readonly match: string | undefined; readonly test: (text: string) => boolean }

/** Session trees that one more input would have shown, when the search found none. */
async function hiddenTrees(db: Db, where: Filtered, probes: readonly Probe[]): Promise<Hidden> {
  const columns = hidingColumns(where.hiding)
  const rows: { key: string; row: Record<string, unknown> }[] = []
  const deadline = performance.now() + SCAN_BUDGET_MS
  for (const probe of probes) {
    if (probe.kind === "fts") {
      let found = db.all<Record<string, unknown> & { id: number }>(
        `select d.id as id, d.root_id as rootID${columns.sql} from docs_words join docs d on d.id = docs_words.rowid ${JOINS}
          where docs_words match ? and ${where.base.sql} limit ?`,
        ...columns.params,
        probe.match,
        ...where.base.params,
        HIDDEN_ROWS,
      )
      if (probe.check) {
        const matched = checkJoined(db, probe.check, found.map(row => row.id))
        found = found.filter(row => matched.has(row.id))
      }
      for (const row of found) rows.push({ key: String(row.rootID), row })
    } else {
      await scan(db, where.base, probe.match, deadline, (doc, text) => {
        if (probe.test(text)) rows.push({ key: doc.rootID, row: doc })
        return true
      }, columns)
    }
  }
  return hiddenCounts(rows, where.hiding)
}

export async function search(db: Db, caller: Caller, input: SearchInput, state: IndexState, options: SearchOptions = {}): Promise<SearchOutput> {
  const now = options.now ?? Date.now()
  const mode = input.match ?? "words"
  const limit = bounded(input.limit, BOUNDS.search.limit)
  const snippetCount = bounded(input.snippets, BOUNDS.search.snippets)
  const offset = decodeCursor(input.cursor)
  const texts = phrasingsOf(input.query, mode === "regex")
  const where = filterSql(db, caller, input, now, "docs")
  const deadline = performance.now() + SCAN_BUDGET_MS

  let hits: Hits
  let highlighters: Highlighter[]
  let probes: Probe[]
  if (mode === "regex") {
    const patterns = texts.map(parseRegex)
    hits = await regexHits(db, patterns, where, deadline)
    highlighters = patterns.map(pattern => ({ kind: "regex", pattern }))
    probes = patterns.map(pattern => {
      const literal = requiredLiteral(pattern)
      return { kind: "scan", match: literal === undefined ? undefined : trigramMatch(literal), test: text => findRanges(pattern, text, 1).length > 0 }
    })
  } else if (mode === "substring") {
    const parsed = texts.map(parseQuery)
    if (parsed.every(query => !substringCandidates(query))) throw refused("QUERY_INVALID", `substring search needs a term of at least ${MIN_SUBSTRING} characters`, QUERY_HINTS.substring)
    hits = await substringHits(db, parsed, where, deadline, limit)
    highlighters = parsed.map(query => ({ kind: "literal", terms: highlightTerms(query, "substring").map(fold) }))
    probes = parsed.flatMap(query => {
      const candidates = substringCandidates(query)
      if (!candidates) return []
      const literals = literalsOf(query)
      // Any term counts, as a near match would.
      return [{ kind: "scan" as const, match: candidates.any, test: (text: string) => literalMatch(text, literals) !== undefined }]
    })
  } else {
    const parsed = texts.map(parseQuery)
    if (parsed.every(query => toMatch(query, "words") === undefined)) throw refused("QUERY_INVALID", "query has nothing to include; excluded terms need at least one word to search for", QUERY_HINTS.excluded)
    hits = wordsHits(db, parsed, where, limit)
    highlighters = parsed.map(query => {
      const full = toMatch(query, "words")
      return full === undefined ? undefined : { kind: "fts", full, near: toMatch(query, "words", true)! }
    })
    probes = parsed.flatMap(query => {
      const match = toMatch(query, "words", true)
      return match === undefined ? [] : [{ kind: "fts" as const, match, ...hasJoined(query) ? { check: query } : {} }]
    })
  }

  const { kept, similar } = foldSimilar(db, rank(hits.lists, caller, input.recency !== false, now))
  const page = kept.slice(offset, offset + limit)
  const picks = new Map(page.map(group => [group.rootID, pickSnippets(group, snippetCount)]))
  const snippetTexts = snippetsFor(db, [...picks.values()].flat(), highlighters)
  const known = summaries(db, page.flatMap(group => [group.rootID, group.docs[0]!.sessionID]))

  const results: SearchHit[] = []
  for (const group of page) {
    const summary = known.get(group.rootID) ?? known.get(group.docs[0]!.sessionID)
    if (!summary) continue
    const snippets: Snippet[] = (picks.get(group.rootID) ?? []).map(doc => ({
      messageID: doc.messageID,
      seq: doc.seq,
      kind: doc.kind,
      tool: doc.tool,
      time: iso(doc.time),
      text: snippetTexts.get(doc.id) ?? "",
      sessionID: doc.sessionID,
      cite: cite(doc.sessionID, doc.seq),
    }))
    // Significant digits, not decimals: bm25 of a very common term is tiny but still orders results.
    results.push({
      ...summary,
      score: Number(group.score.toPrecision(6)),
      matches: group.docs.length,
      queriesMatched: group.phrasings,
      similar: similar.get(group.rootID) ?? 0,
      snippets,
    })
  }

  return {
    results,
    total: kept.length,
    relaxed: results.some(result => result.queriesMatched === 0),
    truncated: hits.truncated,
    next: offset + limit < kept.length ? encodeCursor(offset + limit) : null,
    hidden: kept.length === 0 ? await hiddenTrees(db, where, probes) : null,
    index: state,
  }
}
