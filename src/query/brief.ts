// What one session did, from the index: prompt, compaction summaries, last reply, files, commands, subagents, todos.
import type { BriefInput, BriefOutput } from "../domain/api.js"
import type { Source } from "../domain/contract.js"
import type { Db } from "../domain/sqlite.js"
import { placeholders, SUMMARY_COLUMNS, toSummary, type Mask, type SummaryRow } from "./common.js"
import { HistoryError } from "../domain/common.js"

/** The latest compaction summaries kept, oldest first. */
export const MAX_SUMMARIES = 10
export const MAX_FILES_EDITED = 50
/** Distinct shell commands kept, the most used first, then the most recent. */
export const MAX_COMMANDS = 30
export const MAX_SUBAGENTS = 50

const SHELL_TOOLS = ["bash", "shell"]
const EDIT_OPS = ["edit", "write", "patch"]

export type TodoSource = Pick<Source, "todos">

/** The session and, with `children`, every session below it. */
function tree(db: Db, sessionID: string, children: boolean): string[] {
  if (!children) return [sessionID]
  return db
    .all<{ id: string }>(
      `with recursive tree(id) as (select ? union select s.id from sessions s join tree t on s.parent_id = t.id) select id from tree`,
      sessionID,
    )
    .map(row => row.id)
}

/** The command from a shell tool_call doc, which reads `bash: <command>\n<description>`. */
function command(text: string, tool: string): string {
  const prefix = `${tool}: `
  const body = text.startsWith(prefix) ? text.slice(prefix.length) : text
  return body.split("\n")[0]!.trim()
}

/**
 * With `children`, files, commands, summaries, models and subagents cover the whole tree below the session.
 * Todos are the session's own. Index text is already masked; `mask` covers the todos read from the source.
 */
export async function brief(db: Db, source: TodoSource, input: BriefInput, mask: Mask): Promise<BriefOutput> {
  const row = db.get<SummaryRow & { cost: number; outcome: string | null; lastReply: string | null }>(
    `select ${SUMMARY_COLUMNS}, s.cost as cost, s.outcome as outcome, s.last_reply as lastReply
      from sessions s left join projects p on p.id = s.project_id where s.id = ?`,
    input.sessionID,
  )
  if (!row) throw new HistoryError("SESSION_NOT_FOUND")
  const ids = tree(db, input.sessionID, input.children ?? false)
  const inTree = `(${placeholders(ids.length)})`

  const models = db
    .all<{ model: string }>(`select model from sessions where id in ${inTree} and model is not null group by model order by min(created)`, ...ids)
    .map(item => item.model)
  const summaries = db
    .all<{ text: string }>(
      `select t.text as text from docs d join doc_texts t on t.id = d.id where d.session_id in ${inTree} and d.kind = 'summary' order by d.time desc, d.seq desc limit ?`,
      ...ids,
      MAX_SUMMARIES,
    )
    .map(item => item.text)
    .reverse()
  const filesEdited = db.all<{ path: string; edits: number }>(
    `select path, count(*) as edits from files where session_id in ${inTree} and op in (${placeholders(EDIT_OPS.length)})
      group by path order by edits desc, max(time) desc, path limit ?`,
    ...ids,
    ...EDIT_OPS,
    MAX_FILES_EDITED,
  )
  const calls = db.all<{ tool: string; text: string }>(
    `select d.tool as tool, t.text as text from docs d join doc_texts t on t.id = d.id
      where d.session_id in ${inTree} and d.kind = 'tool_call' and d.tool in (${placeholders(SHELL_TOOLS.length)})
      order by d.time, d.seq, d.part`,
    ...ids,
    ...SHELL_TOOLS,
  )
  // Each command once, with how often it ran and its last use; the most used first, then the most recent.
  const uses = new Map<string, { count: number; last: number }>()
  calls.forEach((call, index) => {
    const text = command(call.text, call.tool)
    if (!text) return
    const seen = uses.get(text)
    uses.set(text, { count: (seen?.count ?? 0) + 1, last: index })
  })
  const commands = [...uses]
    .sort(([, a], [, b]) => b.count - a.count || b.last - a.last)
    .slice(0, MAX_COMMANDS)
    .map(([text]) => text)

  // Subagents from links where the parent recorded them, and from child sessions that have no link.
  const subagents = db.all<{ sessionID: string; description: string | null; agent: string | null }>(
    `select id as sessionID, description, agent from (
        select l.child_id as id, coalesce(l.description, c.title) as description, coalesce(l.agent, c.agent) as agent, coalesce(c.created, 0) as created
          from links l left join sessions c on c.id = l.child_id where l.parent_id in ${inTree}
        union
        select c.id, c.title, c.agent, c.created from sessions c
          where c.parent_id in ${inTree} and c.id not in (select child_id from links)
      ) order by created, id limit ?`,
    ...ids,
    ...ids,
    MAX_SUBAGENTS,
  )

  let todos: readonly { content: string; status: string }[] = []
  try {
    todos = await source.todos(input.sessionID)
  } catch {
    // A partial source may not keep todos; the brief is still useful without them.
  }

  return {
    session: { ...toSummary(row), cost: row.cost, outcome: row.outcome, models },
    firstPrompt: row.firstPrompt,
    summaries,
    lastReply: row.lastReply,
    filesEdited,
    commands,
    subagents,
    todos: todos.map(todo => ({ content: mask(todo.content), status: todo.status })),
  }
}
