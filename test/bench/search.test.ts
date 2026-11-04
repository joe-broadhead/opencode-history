// Index size and search speed on a synthetic index of about 200,000 docs. Run with `npm run bench`; it is not part of
// `npm run check`. The index is built once into the system temp folder and reused while the generator and schema stay
// the same. BENCH_DOCS sets the size.
import { statSync } from "node:fs"
import { TEMP_BASE } from "../temp.js"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Caller, IndexState, SearchInput } from "../../src/domain/api.js"
import { openDb, type Db } from "../../src/domain/sqlite.js"
import { search } from "../../src/query/search.js"
import { BENCH_NOW, benchIndex } from "./corpus.js"

const DOCS = Number(process.env.BENCH_DOCS ?? 200_000)
/** The target for one search on this index. */
const TARGET_MS = 500
const STATE: IndexState = { ready: true, sessionsIndexed: 0, sessionsTotal: 0, lagSeconds: 0, source: "opencode-db", complete: true }
const CALLER: Caller = { sessionID: null, projectID: "prj_0", directory: "/work/p0" }

let db: Db
let path: string

beforeAll(() => {
  const started = performance.now()
  const index = benchIndex(join(TEMP_BASE, "opencode-history-bench"), { docs: DOCS })
  path = index.path
  if (index.built) console.log(`built ${DOCS} docs in ${Math.round(performance.now() - started)} ms`)
  db = openDb(path, { readOnly: true })
}, 3_600_000)

afterAll(() => db?.close())

const MB = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`

describe(`synthetic index of ${DOCS} docs`, () => {
  test("size by table", () => {
    const text = db.get<{ bytes: number; n: number }>("select sum(length(cast(text as blob))) as bytes, count(*) as n from doc_texts")!
    const tables = db.all<{ name: string; bytes: number }>("select name, sum(pgsize) as bytes from dbstat group by name order by bytes desc")
    const groups = new Map<string, number>()
    for (const table of tables) {
      const group = table.name.startsWith("docs_words") ? "docs_words" : table.name.startsWith("docs_sub") ? "docs_sub" : table.name
      groups.set(group, (groups.get(group) ?? 0) + table.bytes)
    }
    const file = statSync(path).size
    console.log(
      [`docs ${text.n}, text ${MB(text.bytes)}, file ${MB(file)} (${(file / text.bytes).toFixed(2)}× text)`, ...[...groups].filter(([, bytes]) => bytes > 1_048_576 / 2).map(([name, bytes]) => `  ${name}: ${MB(bytes)}`)].join("\n"),
    )
    expect(file).toBeGreaterThan(0)
  })

  const cases: [string, SearchInput][] = [
    ["words, rare", { query: "sys-health status report" }],
    ["words, three phrasings", { query: ["build error config", "fix the test", "update function return type"] }],
    ["words, three phrasings, near matches only", { query: ["fix the zzqx error", "check the quokka file", "update wombat return value"] }],
    ["words, all projects", { query: ["error config value", "test file"], scope: "all" }],
    ["substring, identifier", { query: "useAuthStore", match: "substring" }],
    ["substring, common", { query: "error", match: "substring" }],
    ["substring, path", { query: ["src/", ".ts:"], match: "substring" }],
    ["substring, all projects", { query: "commit", match: "substring", scope: "all" }],
    ["regex, literal", { query: "error: \\w+ is not", match: "regex" }],
    ["regex, rare", { query: "zzqx[0-9]+", match: "regex" }],
    ["regex, all projects", { query: "FAIL src/\\w+", match: "regex", scope: "all" }],
    ["regex, no literal", { query: "\\d{3} ms\\)$", match: "regex" }],
    ["words, nothing found", { query: "zzqx quokka" }],
    ["substring, nothing found", { query: "zzqxquokka", match: "substring" }],
  ]
  for (const [name, input] of cases) {
    test(name, async () => {
      await search(db, CALLER, input, STATE, { now: BENCH_NOW })
      const times: number[] = []
      let out!: Awaited<ReturnType<typeof search>>
      for (let i = 0; i < 3; i++) {
        const started = performance.now()
        out = await search(db, CALLER, input, STATE, { now: BENCH_NOW })
        times.push(performance.now() - started)
      }
      const median = times.sort((a, b) => a - b)[1]!
      console.log(`${name}: ${median.toFixed(0)} ms, ${out.total} sessions${out.truncated ? ", truncated" : ""}`)
      expect(median).toBeLessThan(TARGET_MS)
    })
  }
})
