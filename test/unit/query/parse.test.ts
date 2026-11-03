import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import {
  canRelax,
  decodeCursor,
  encodeCursor,
  hasJoined,
  highlightTerms,
  joinedPattern,
  joinedWords,
  nearMatch,
  parseQuery,
  parseRegex,
  parseTime,
  QueryError,
  requiredLiteral,
  substringCandidates,
  toMatch,
  trigramMatch,
} from "../../../src/query/parse.js"

const DAY = 86_400_000
const NOW = Date.parse("2026-11-01T12:00:00Z")

const words = (input: string, relaxed = false) => toMatch(parseQuery(input), "words", relaxed)
const sub = (input: string, relaxed = false) => toMatch(parseQuery(input), "substring", relaxed)

describe("parseQuery", () => {
  it("splits words into groups that must all match", () => {
    expect(parseQuery("fix login bug")).toEqual({
      groups: [[{ text: "fix", phrase: false, prefix: false }], [{ text: "login", phrase: false, prefix: false }], [{ text: "bug", phrase: false, prefix: false }]],
      exclude: [],
    })
  })

  it("keeps quoted phrases whole, including an unterminated one", () => {
    expect(parseQuery('"null pointer" crash').groups).toEqual([[{ text: "null pointer", phrase: true, prefix: false }], [{ text: "crash", phrase: false, prefix: false }]])
    expect(parseQuery('crash "null poin').groups[1]).toEqual([{ text: "null poin", phrase: true, prefix: false }])
  })

  it("excludes -terms and -\"phrases\" but not --flags or a lone dash", () => {
    const parsed = parseQuery('login -password -"stack trace" --force - x-ray')
    expect(parsed.exclude.map(term => term.text)).toEqual(["password", "stack trace"])
    expect(parsed.groups.flat().map(term => term.text)).toEqual(["login", "--force", "x-ray"])
  })

  it("marks prefix* terms", () => {
    expect(parseQuery("migr* *").groups).toEqual([[{ text: "migr", phrase: false, prefix: true }]])
    expect(parseQuery('"null poin"*').groups).toEqual([[{ text: "null poin", phrase: true, prefix: true }]])
  })

  it("joins neighbours with OR and ignores AND", () => {
    expect(parseQuery("a b OR c d").groups.map(group => group.map(term => term.text))).toEqual([["a"], ["b", "c"], ["d"]])
    expect(parseQuery("a | b AND c").groups.map(group => group.map(term => term.text))).toEqual([["a", "b"], ["c"]])
    expect(parseQuery("OR a").groups.map(group => group.map(term => term.text))).toEqual([["a"]])
    expect(parseQuery("a or b").groups).toHaveLength(3)
  })

  it("treats NOT as excluding the next term", () => {
    expect(parseQuery("login NOT oauth")).toMatchObject({ groups: [[{ text: "login" }]], exclude: [{ text: "oauth" }] })
  })
})

describe("toMatch", () => {
  it("quotes every term and joins groups with AND", () => {
    expect(words("fix login")).toBe('"fix" AND "login"')
    expect(words("a b OR c d")).toBe('"a" AND ("b" OR "c") AND "d"')
    expect(words('"null pointer" migr*')).toBe('"null pointer" AND "migr"*')
  })

  it("adds exclusions with NOT", () => {
    expect(words('login -password -"stack trace"')).toBe('("login") NOT "password" NOT "stack trace"')
  })

  it("joins every term with OR when relaxed", () => {
    expect(words("a b OR c d -x", true)).toBe('("a" OR "b" OR "c" OR "d") NOT "x"')
    expect(canRelax(parseQuery("a b"), "words")).toBe(true)
    expect(canRelax(parseQuery("a OR b"), "words")).toBe(false)
  })

  it("escapes double quotes and FTS5 syntax", () => {
    expect(words('say"hi NEAR(x')).toBe('"say""hi" AND "NEAR(x"')
    expect(words("col:value ^start {a b}")).toBe('"col:value" AND "^start" AND "{a" AND "b}"')
  })

  it("drops words-mode terms with no letters or digits", () => {
    expect(words("fix ... --")).toBe('"fix"')
    expect(words("... -login")).toBeUndefined()
  })

  it("needs three characters per substring term and ignores prefix marks there", () => {
    expect(sub("ab auth.ts uth*")).toBe('"auth.ts" AND "uth"')
    expect(sub("ab cd")).toBeUndefined()
    expect(sub("login -ab -pass")).toBe('("login") NOT "pass"')
    expect(highlightTerms(parseQuery("ab auth uth -pass auth"), "substring")).toEqual(["auth", "uth"])
  })

  it("builds near matches: some terms, not every group, no exclusion", () => {
    expect(nearMatch(parseQuery("fix login -flaky"))).toBe('(("fix" OR "login") NOT ("fix" AND "login")) NOT "flaky"')
    expect(nearMatch(parseQuery("a OR b"))).toBeUndefined()
    expect(nearMatch(parseQuery("login ..."))).toBeUndefined()
  })

  it("leaves excluded joined words out of words MATCH strings, for the text check", () => {
    expect(words("release 2.2.3 -v1.4.0 -beta")).toBe('("release" AND "2.2.3") NOT "beta"')
    expect(words("release -v1.4.0")).toBe('"release"')
    expect(nearMatch(parseQuery("release notes -10.0.0.1"))).toBe('(("release" OR "notes") NOT ("release" AND "notes"))')
    expect(sub("release -v1.4.0")).toBe('("release") NOT "v1.4.0"')
  })

  it("never produces a MATCH string FTS5 rejects", () => {
    const db = new DatabaseSync(":memory:")
    db.exec("create virtual table w using fts5(text, tokenize='porter unicode61'); create virtual table t using fts5(text, tokenize='trigram')")
    db.exec("create virtual table n using fts5(text, tokenize='trigram', detail='none')")
    db.exec("insert into w values ('the login form'); insert into t values ('the login form'); insert into n values ('the login form')")
    const nasty = [
      'foo" OR bar NEAR(',
      "NEAR(a b, 3)",
      "text:login",
      "^login",
      "a AND OR NOT b",
      "(((",
      '"""',
      "* - -- -* OR",
      "{text}: login",
      "login +form",
      "\\x00 \u0000 login",
      "'; drop table w; --",
      "ünïcødé 中文 login",
      'login -"" -"-"',
      "NOT login",
      "a* *b c*d",
    ]
    for (const input of nasty) {
      for (const [table, mode] of [["w", "words"], ["t", "substring"]] as const) {
        for (const relaxed of [false, true]) {
          const match = toMatch(parseQuery(input), mode, relaxed)
          if (match === undefined) continue
          expect(() => db.prepare(`select count(*) from ${table} where ${table} match ?`).get(match), `${mode} ${input}`).not.toThrow()
        }
      }
      const near = nearMatch(parseQuery(input))
      if (near !== undefined) expect(() => db.prepare("select count(*) from w where w match ?").get(near), `near ${input}`).not.toThrow()
      const candidates = substringCandidates(parseQuery(input))
      for (const match of candidates ? [candidates.strict, candidates.near, candidates.any] : []) {
        if (match !== undefined) expect(() => db.prepare("select count(*) from n where n match ?").get(match), `trigrams ${input}`).not.toThrow()
      }
    }
    db.close()
  })
})

describe("joined words", () => {
  const term = (text: string, prefix = false) => ({ text, phrase: false, prefix })
  const matches = (query: string, text: string, prefix = false) => joinedWords(term(query, prefix)).every(word => joinedPattern(word).test(text))

  it("are the words unicode61 splits, without their edge punctuation", () => {
    expect(joinedWords(term("2.2.3"))).toEqual([{ text: "2.2.3", prefix: false }])
    expect(joinedWords(term("(v1.4.0),"))).toEqual([{ text: "v1.4.0", prefix: false }])
    expect(joinedWords({ text: "opencode 192.0.2.10 foo.bar.baz", phrase: true, prefix: true }).map(word => [word.text, word.prefix])).toEqual([["192.0.2.10", false], ["foo.bar.baz", true]])
    expect(joinedWords(term("x-ray"))).toEqual([{ text: "x-ray", prefix: false }])
    for (const plain of ["login", "404", "--force", "...", "v2", "中文"]) expect(joinedWords(term(plain)), plain).toEqual([])
    expect(hasJoined(parseQuery("login -2.2.3"))).toBe(true)
    expect(hasJoined(parseQuery('login "null pointer"'))).toBe(false)
  })

  it("match the whole word, ignoring case, and not inside a longer joined word", () => {
    for (const text of ["opencode 2.2.3", "@opencode/plugin@2.2.3", "(2.2.3)", "2.2.3.", "2.2.3-beta", ">=2.2.3 <2.3.0"]) expect(matches("2.2.3", text), text).toBe(true)
    for (const text of ["2 2 3", "2, 2, 3", "12.2.3", "2.2.30", "10.2.2.3", "2.2.3.4", "v2.2.3", "x_2.2.3"]) expect(matches("2.2.3", text), text).toBe(false)
    expect(matches("Foo.Bar", "import FOO.BAR")).toBe(true)
    expect(matches("foo.bar", "my_foo.bar")).toBe(false)
    expect(matches("a+b(c)", "with a+b(c) in it")).toBe(true)
    expect(matches("v1.4", "v1.4.01", true)).toBe(true)
    expect(matches("v1.4", "v1.4.01")).toBe(false)
    expect(matches("src/auth.ts", "/work/app/src/auth.ts:12")).toBe(true)
  })
})

describe("trigram candidates", () => {
  const db = new DatabaseSync(":memory:")
  db.exec("create virtual table n using fts5(text, tokenize='trigram', detail='none')")
  for (const text of ["the auth.ts file", "ts.auth swapped", "ÄRGER mit Umlauten", 'say "hi" there']) db.prepare("insert into n values (?)").run(text)
  const found = (match: string | undefined) => db.prepare("select rowid from n where n match ?").all(match!).map(row => Number(row.rowid))

  it("asks for every trigram of a literal, which finds a superset of the texts that hold it", () => {
    expect(trigramMatch("auth.ts")).toBe('"aut" AND "uth" AND "th." AND "h.t" AND ".ts"')
    expect(trigramMatch("ab")).toBeUndefined()
    expect(trigramMatch("aaaa")).toBe('"aaa"')
    expect(found(trigramMatch("auth.ts"))).toEqual([1])
    expect(found(trigramMatch("ärger"))).toEqual([3])
    expect(found(trigramMatch('"hi"'))).toEqual([4])
    const long = "x".repeat(10) + Array.from({ length: 40 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("")
    expect(trigramMatch(long)!.split(" AND ")).toHaveLength(16)
  })

  it("gives strict, near and any candidates for a substring query", () => {
    expect(substringCandidates(parseQuery("ab"))).toBeUndefined()
    expect(substringCandidates(parseQuery("auth"))).toEqual({ strict: '("aut" AND "uth")', near: undefined, any: '("aut" AND "uth")' })
    const both = substringCandidates(parseQuery("auth file -ab"))!
    expect(found(both.strict)).toEqual([1])
    expect(found(both.near)).toEqual([2])
    expect(found(both.any)).toEqual([1, 2])
  })
})

describe("requiredLiteral", () => {
  const literal = (pattern: string) => requiredLiteral(parseRegex(pattern))

  it("finds the longest run of literal characters every match holds", () => {
    expect(literal("error: \\w+ is not")).toBe("error: ")
    expect(literal("src/auth\\.ts")).toBe("src/auth.ts")
    expect(literal("/usr/local/bin")).toBe("/usr/local/bin")
    expect(literal("^filler \\d*0$")).toBe("filler ")
    expect(literal("abcd+ef")).toBe("abcd")
    expect(literal("abcde?fgh")).toBe("abcd")
    expect(literal("abc{2}defg")).toBe("defg")
    expect(literal("x{1,3}yzw")).toBe("yzw")
    expect(literal("a{b}cde")).toBe("a{b}cde")
    expect(literal("(?:foo|bar)baz")).toBe("baz")
    expect(literal("[abc]defg\\b")).toBe("defg")
    expect(literal("\\u0041bcd\\x41bcd\\p{L}ef")).toBe("bcd")
  })

  it("gives none when a match need not hold three literal characters", () => {
    for (const pattern of ["foo|bar", "fo.o", "\\d{4}-\\d{2}", "ab?", "(abc)", "[abc]{3}", "\\bz\\w{3}a\\b", "/abc/v", "a😀bc"]) expect(literal(pattern), pattern).toBeUndefined()
  })

  it("only ever names text that every match contains", () => {
    const texts = ["error: Foo is not set", "src/auth.ts:12", "abcddddef", "abcdfgh", "abcefgh", "xxyzw", "a{b}cde", "barbaz", "xdefg", "filler 10"]
    for (const pattern of ["error: \\w+ is not", "src/auth\\.ts", "abcd+ef", "abcde?fgh", "x{1,3}yzw", "a{b}cde", "(?:foo|bar)baz", "[abc]defg\\b", "^filler \\d*0$"]) {
      const regex = parseRegex(pattern)
      const required = requiredLiteral(regex)!
      for (const text of texts) if (regex.test(text)) expect(text.toLowerCase(), `${pattern} on ${text}`).toContain(required.toLowerCase())
      regex.lastIndex = 0
    }
  })
})

describe("parseTime", () => {
  it("counts durations back from now", () => {
    expect(parseTime("7d", NOW, "since")).toBe(NOW - 7 * DAY)
    expect(parseTime("2w", NOW, "since")).toBe(NOW - 14 * DAY)
    expect(parseTime("3m", NOW, "since")).toBe(NOW - 90 * DAY)
    expect(parseTime("36h", NOW, "since")).toBe(NOW - 1.5 * DAY)
    expect(parseTime("1y", NOW, "since")).toBe(NOW - 365 * DAY)
    expect(parseTime(" 2 weeks ", NOW, "since")).toBe(NOW - 14 * DAY)
    expect(parseTime("6 months", NOW, "since")).toBe(NOW - 180 * DAY)
  })

  it("reads ISO dates, with a bare date covering its whole UTC day", () => {
    expect(parseTime("2026-10-01", NOW, "since")).toBe(Date.parse("2026-10-01T00:00:00Z"))
    expect(parseTime("2026-10-01", NOW, "until")).toBe(Date.parse("2026-10-02T00:00:00Z") - 1)
    expect(parseTime("2026-10-01T08:30:00Z", NOW, "until")).toBe(Date.parse("2026-10-01T08:30:00Z"))
    expect(parseTime("2026-10-01T08:30:00+02:00", NOW, "since")).toBe(Date.parse("2026-10-01T06:30:00Z"))
  })

  it("rejects anything else with a clear message", () => {
    for (const bad of ["yesterday", "7", "7x", "", "October 1"]) {
      expect(() => parseTime(bad, NOW, "since")).toThrow(QueryError)
    }
    expect(() => parseTime("soon", NOW, "until")).toThrow(/^until must be an ISO date/)
    expect(() => parseTime("soon", NOW, "until")).not.toThrow(/soon/)
  })
})

describe("parseRegex", () => {
  it("ignores case for a bare pattern and honours /flags/", () => {
    expect(parseRegex("fix(ed)?").test("FIXED")).toBe(true)
    const strict = parseRegex("/Fix/")
    expect(strict.flags).toBe("g")
    expect(strict.test("fix")).toBe(false)
    expect(parseRegex("/a.b/s").flags).toBe("gs")
    expect(parseRegex("/usr/local/bin").source).toBe("\\/usr\\/local\\/bin")
  })

  it("reports invalid patterns clearly", () => {
    expect(() => parseRegex("(unclosed")).toThrow(QueryError)
    expect(() => parseRegex("(unclosed")).toThrow("invalid regex: Unterminated group")
    expect(() => parseRegex("/x/q")).not.toThrow()
    expect(() => parseRegex("(unclosed")).not.toThrow(/unclosed/)
    expect(() => parseRegex("")).toThrow("regex pattern is empty")
  })
})

describe("cursor", () => {
  it("round-trips an offset and rejects anything else", () => {
    expect(decodeCursor(encodeCursor(16))).toBe(16)
    expect(decodeCursor(undefined)).toBe(0)
    expect(() => decodeCursor("garbage")).toThrow(expect.objectContaining({ reason: "cursor" }))
    expect(() => decodeCursor(Buffer.from("o:-3").toString("base64url"))).toThrow(QueryError)
  })
})
