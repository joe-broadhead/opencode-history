import type { Plugin } from "@opencode/plugin"
import type { IndexState } from "../domain/api.js"
import { formatFailure, HistoryError, logUnexpected } from "../domain/common.js"
import { PLUGIN_ID } from "../domain/contract.js"
import { isFailure } from "./errors.js"
import { formatStatus } from "./format.js"
import type { HistoryRuntime, ReindexMode } from "./runtime.js"
import type { StatusView } from "./status.js"

type CommandEditor = Parameters<Parameters<Plugin.Context["command"]["transform"]>[0]>[0]

export const COMMANDS = { status: "history-status", reindex: "history-reindex" } as const

export interface CommandSources {
  readonly synthetic: Plugin.Context["session"]["synthetic"]
  readonly runtime: Pick<HistoryRuntime, "reindex">
  readonly status: () => Promise<StatusView>
}

function describe(error: unknown, fallback: "STATUS_UNAVAILABLE" | "INDEX_FAILED", command: string) {
  if (isFailure(error)) return formatFailure(error)
  logUnexpected(error, fallback, `/${command}`)
  return formatFailure(new HistoryError(fallback))
}
const indexed = (mode: ReindexMode, index: IndexState) =>
  `${mode === "rebuild" ? "Index rebuilt" : "Index caught up"}: ${index.sessionsIndexed} of ${index.sessionsTotal} sessions${index.ready ? "" : ", still building"}.`

/** The `/history-reindex` argument: nothing or `catch-up` catches up, `rebuild` starts again; anything else is undefined. */
export function reindexMode(text: string): ReindexMode | undefined {
  const argument = text.trim().toLowerCase()
  return argument === "" || argument === "catch-up" ? "catch-up" : argument === "rebuild" ? "rebuild" : undefined
}

/** `/history-status` posts the status into the session; `/history-reindex [rebuild]` catches the index up or rebuilds it, then reports. */
export function commandTransform(sources: CommandSources) {
  type Synthetic = Parameters<CommandSources["synthetic"]>[0]
  const post = (sessionID: Synthetic["sessionID"], delivery: Synthetic["delivery"], text: string, description: string) =>
    sources.synthetic({ sessionID, delivery, text, description, resume: false, metadata: { source: PLUGIN_ID } })
  return (editor: CommandEditor) => {
    editor.add({
      name: COMMANDS.status,
      description: "History status: index progress, source, options and the next step",
      async execute({ sessionID, delivery }) {
        let text: string
        try { text = formatStatus(await sources.status()) } catch (error) { text = describe(error, "STATUS_UNAVAILABLE", COMMANDS.status) }
        await post(sessionID, delivery, text, "History status")
      },
    })
    editor.add({
      name: COMMANDS.reindex,
      description: "Catch the history index up with OpenCode's sessions; `rebuild` drops it and indexes everything again",
      async execute({ sessionID, prompt, delivery }) {
        const mode = reindexMode(prompt.text)
        let text: string
        if (mode === undefined) text = `Unknown argument. Use /${COMMANDS.reindex} to catch up, or /${COMMANDS.reindex} rebuild to index everything again.`
        else try { text = indexed(mode, await sources.runtime.reindex(mode)) } catch (error) { text = describe(error, "INDEX_FAILED", COMMANDS.reindex) }
        await post(sessionID, delivery, text, "History reindex")
      },
    })
  }
}
