// A synthetic index of coding sessions for measuring size and search speed. Deterministic: the same options give the
// same index. The text is made up from generated words, identifiers, paths and log lines; no real history is used.
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { DocKind } from "../../src/domain/contract.js"
import { SCHEMA_VERSION } from "../../src/index/schema.js"
import { IndexStore } from "../../src/index/store.js"

export interface CorpusOptions {
  /** Docs to write, about. */
  readonly docs: number
  readonly seed?: number
}

export const BENCH_NOW = Date.parse("2026-11-01T12:00:00Z")
const DAY = 86_400_000
/** Bump when the generator changes, so a cached index is rebuilt. */
const GENERATOR = 1

function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SYLLABLES = "ba be bi bo bu ca ce ci co cu da de di do du fa fe fi fo fu ga ge gi go gu ha he hi ho ka ke ki ko ku la le li lo lu ma me mi mo mu na ne ni no nu pa pe pi po pu ra re ri ro ru sa se si so su ta te ti to tu va ve vi vo wa we wi xo za ze zi zo str tr pl gr nd nt st ck sh th".split(" ")
const COMMON = "the a to of and in is it that for on with this as be at by we you not are from or have an but can if will so do test file error fix run build add use update check need function value return type config path line code change should when then new now data".split(" ")

export function corpus(options: CorpusOptions) {
  const rand = random(options.seed ?? 42)
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1))
  const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)]!
  // Zipf-like: low ranks far more often.
  const zipf = <T>(items: readonly T[]) => items[Math.min(items.length - 1, Math.floor(items.length * rand() ** 3))]!

  const words = Array.from({ length: 20_000 }, () => Array.from({ length: int(1, 4) }, () => pick(SYLLABLES)).join(""))
  const word = () => (rand() < 0.35 ? pick(COMMON) : zipf(words))
  const ident = () => {
    const parts = Array.from({ length: int(2, 3) }, () => zipf(words))
    return rand() < 0.5 ? parts.map((p, i) => (i ? p[0]!.toUpperCase() + p.slice(1) : p)).join("") : parts.join("_")
  }
  const dirs = Array.from({ length: 60 }, () => zipf(words))
  const path = () => `src/${zipf(dirs)}/${zipf(words)}.${pick(["ts", "ts", "tsx", "js", "json", "md", "py", "go"])}`
  const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[int(0, 15)]).join("")
  const sentence = () => {
    const out: string[] = []
    for (let i = int(5, 18); i > 0; i--) {
      const r = rand()
      out.push(r < 0.06 ? `\`${ident()}\`` : r < 0.09 ? path() : word())
    }
    return `${out.join(" ")}.`
  }
  const prose = (sentences: number) => Array.from({ length: sentences }, sentence).join(" ")
  const codeLine = () => {
    const r = rand()
    if (r < 0.3) return `  const ${ident()} = ${ident()}(${ident()}, ${int(0, 999)})`
    if (r < 0.5) return `  if (${ident()}.${ident()} === "${word()}") return ${ident()}`
    if (r < 0.7) return `import { ${ident()}, ${ident()} } from "./${zipf(words)}.js"`
    if (r < 0.85) return `  // ${prose(1)}`
    return `export function ${ident()}(${ident()}: ${pick(["string", "number", "boolean", "Db", "Caller"])}) {`
  }
  const code = (lines: number) => Array.from({ length: lines }, codeLine).join("\n")
  const logLine = () => {
    const r = rand()
    if (r < 0.25) return `${new Date(BENCH_NOW - int(0, 400) * DAY).toISOString()} INFO ${ident()} ${prose(1)}`
    if (r < 0.45) return `  at ${ident()} (${path()}:${int(1, 900)}:${int(1, 80)})`
    if (r < 0.6) return `${pick(["✓", "✗", "PASS", "FAIL"])} ${path()} (${int(1, 999)} ms)`
    if (r < 0.75) return `commit ${hex(40)} ${prose(1)}`
    if (r < 0.85) return `error: ${ident()} is not ${word()} (${hex(8)})`
    return prose(1)
  }
  const headTail = (text: string) => (text.length <= 3000 ? text : `${text.slice(0, 2000)}\n…[${text.length - 3000} chars omitted]…\n${text.slice(-1000)}`)
  const log = (lines: number) => headTail(Array.from({ length: lines }, logLine).join("\n"))

  /** One part of a message: its kind, tool and text. */
  const toolPair = (): [DocKind, string | null, string][] => {
    const r = rand()
    if (r < 0.4) {
      const command = pick([`npm test -- ${zipf(words)}`, `git diff ${path()}`, `rg ${ident()} src`, `node scripts/${zipf(words)}.mjs`, `ls ${zipf(dirs)}`, `git log --oneline -n ${int(5, 30)}`])
      return [["tool_call", "bash", `bash: ${command}\n${prose(1)}`], ["tool_result", "bash", log(int(3, 120))]]
    }
    if (r < 0.65) return [["tool_call", "edit", `edit: ${path()}\n${code(int(3, 60))}`], ["tool_result", "edit", "Edit applied successfully."]]
    if (r < 0.75) return [["tool_call", "write", `write: ${path()}\n${code(int(20, 200)).slice(0, 8000)}`], ["tool_result", "write", "Wrote file successfully."]]
    if (r < 0.9) return [["tool_call", "grep", `grep: ${ident()} in ${zipf(dirs)}`], ["tool_result", "grep", Array.from({ length: int(1, 30) }, () => `${path()}:${int(1, 500)}: ${codeLine()}`).join("\n")]]
    return [["tool_call", "read", `read: {"filePath":"${path()}"}`]]
  }

  const sessions: { id: string; parentID: string | null; projectID: string; directory: string; title: string; created: number; updated: number; archived: number | null }[] = []
  const docs: { sessionID: string; messageID: string; seq: number; part: number; time: number; kind: DocKind; tool: string | null; text: string }[] = []
  const projects = Array.from({ length: 12 }, (_, i) => ({ id: `prj_${i}`, worktree: `/work/p${i}` }))
  let n = 0
  while (docs.length < options.docs) {
    const id = `ses_bench${String(n++).padStart(6, "0")}`
    const parent = n > 10 && rand() < 0.12 ? sessions[sessions.length - int(1, 5)]! : undefined
    const project = parent ? projects.find(p => p.id === parent.projectID)! : zipf(projects)
    const created = BENCH_NOW - int(0, 365 * DAY)
    // Repeated scheduled runs share one title and directory.
    const title = rand() < 0.08 ? "sys-health.sh status report" : Array.from({ length: int(3, 7) }, word).join(" ")
    const directory = rand() < 0.8 ? project.worktree : `${project.worktree}/${zipf(dirs)}`
    const session = { id, parentID: parent?.id ?? null, projectID: project.id, directory, title, created, updated: created + int(1, 400) * 60_000, archived: rand() < 0.03 ? created + DAY : null }
    sessions.push(session)
    docs.push({ sessionID: id, messageID: "", seq: -1, part: 0, time: created, kind: "title", tool: null, text: title })
    let seq = 0
    const turns = int(2, 10)
    for (let turn = 0; turn < turns; turn++) {
      const time = () => created + seq * 30_000
      docs.push({ sessionID: id, messageID: `msg_${id}_${seq}`, seq, part: 0, time: time(), kind: "user", tool: null, text: prose(int(1, 5)) })
      seq++
      for (let step = int(1, 6); step > 0; step--) {
        let part = 1
        const message = `msg_${id}_${seq}`
        if (rand() < 0.7) docs.push({ sessionID: id, messageID: message, seq, part: part++, time: time(), kind: "assistant", tool: null, text: prose(int(1, 8)) })
        for (let calls = int(0, 3); calls > 0; calls--, part++) {
          for (const [kind, tool, text] of toolPair()) docs.push({ sessionID: id, messageID: message, seq, part, time: time(), kind, tool, text })
        }
        seq++
      }
      if (rand() < 0.04) docs.push({ sessionID: id, messageID: `msg_${id}_${seq}`, seq: seq++, part: 0, time: time(), kind: "summary", tool: null, text: prose(int(8, 20)) })
    }
  }
  return { projects, sessions, docs }
}

/** The index at `dir`, built once per generator, schema and size, and reused after that. */
export function benchIndex(dir: string, options: CorpusOptions): { path: string; built: boolean } {
  const path = join(dir, `index-g${GENERATOR}-s${SCHEMA_VERSION}-${options.docs}-${options.seed ?? 42}.db`)
  if (existsSync(path)) return { path, built: false }
  mkdirSync(dir, { recursive: true })
  const partial = `${path}.partial`
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${partial}${suffix}`, { force: true })
  const { projects, sessions, docs } = corpus(options)
  const store = IndexStore.open(partial)
  store.upsertProjects(projects.map(p => ({ ...p, name: null })))
  const roots = new Map<string, string>()
  store.transaction(() => {
    for (const s of sessions) {
      const root = s.parentID ? (roots.get(s.parentID) ?? s.parentID) : s.id
      roots.set(s.id, root)
      store.db.run(
        `insert into sessions (id, parent_id, root_id, project_id, directory, title, agent, created, updated, archived, messages)
          values (?, ?, ?, ?, ?, ?, 'build', ?, ?, ?, 0)`,
        s.id, s.parentID, root, s.projectID, s.directory, s.title, s.created, s.updated, s.archived,
      )
    }
    for (const d of docs) {
      store.db.run(
        "insert into docs (session_id, root_id, message_id, seq, part, time, kind, tool) values (?, ?, ?, ?, ?, ?, ?, ?)",
        d.sessionID, roots.get(d.sessionID)!, d.messageID, d.seq, d.part, d.time, d.kind, d.tool,
      )
      store.db.run("insert into doc_texts (id, text) values (last_insert_rowid(), ?)", d.text)
    }
    store.db.run("update sessions set messages = (select count(distinct seq) from docs where docs.session_id = sessions.id and seq >= 0)")
  })
  store.db.exec("pragma wal_checkpoint(truncate)")
  store.close()
  renameSync(partial, path)
  return { path, built: true }
}
