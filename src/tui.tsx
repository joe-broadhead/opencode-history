import type { Plugin } from "@opencode/plugin/tui"
import { createSignal, For, Show } from "solid-js"
import type { TUI_ID } from "./domain/contract.js"
import { formatStatus, MISMATCH_ROW, NOTHING_TO_DO } from "./host/format.js"
import type { StatusView } from "./host/status.js"
import { History } from "./rpc.js"

interface State { readonly lines?: readonly string[]; readonly error?: string; readonly loading: boolean }

const UNAVAILABLE = "STATUS_UNAVAILABLE: The History server part did not answer. Next step: Restart OpenCode."
const UNEXPECTED = "STATUS_UNAVAILABLE: The History server answered with an unexpected status. Next step: Restart OpenCode."
/** The `/history-status` text, line by line. The client does not check the answer's shape, so a wrong one fails here. */
function statusLines(view: unknown) {
  try { return formatStatus(view as StatusView).split("\n") } catch { throw new Error(UNEXPECTED) }
}
/** Server events that can change the status: a reload, changed agent rules, and sessions the index gains or loses. Heard only while the dialog is open; there is no polling. */
const EVENTS = ["server.connected", "agent.updated", "session.created", "session.deleted", "session.idle"] as const

/**
 * The `/history` status dialog: the same text as `/history-status`, read from the plugin's `status` RPC method. It can
 * change nothing. Keymap layers are registered from setup, where the host's keymap context exists, and in global mode
 * so the palette lists the command.
 */
export default {
  id: "history.sessions.tui" satisfies typeof TUI_ID,
  setup(context) {
    const [state, setState] = createSignal<State>({ loading: true })
    const [open, setOpen] = createSignal(false)
    let closed = false, generation = 0, controller: AbortController | undefined
    const refresh = async () => {
      if (closed) return
      const current = ++generation
      controller?.abort()
      const request = controller = new AbortController()
      setState(previous => ({ ...previous, loading: true }))
      try {
        const view = await context.client.rpc(History).status({}, { location: context.location ?? context.data.location.default(), signal: request.signal })
        if (closed || current !== generation) return
        setState({ lines: statusLines(view), loading: false })
      } catch (error) {
        if (!closed && current === generation) setState(previous => ({ ...previous, loading: false, error: error instanceof Error && error.message ? error.message : UNAVAILABLE }))
      }
    }
    const View = () => {
      const theme = context.theme
      return <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
        <text fg={theme.text.base}>{`${state().lines?.[0] ?? "History status"}${state().loading ? " · refreshing" : ""}`}</text>
        <Show when={state().lines} fallback={<text fg={theme.text.muted}>{state().loading ? "Loading status…" : `${state().error}`}</text>}>
          {lines => <scrollbox maxHeight={28}>
            <box flexDirection="column">
              <For each={lines().slice(1)}>{line =>
                <text fg={line.startsWith(MISMATCH_ROW) ? theme.text.feedback.error.base
                  : line.startsWith("Next step:") && !line.endsWith(NOTHING_TO_DO) ? theme.text.feedback.warning.base : theme.text.base}>{line}</text>}</For>
            </box>
          </scrollbox>}
        </Show>
        <Show when={state().lines && state().error}><text fg={theme.text.feedback.error.base}>{`Refresh failed: ${state().error}`}</text></Show>
        <text fg={theme.text.muted} onMouseUp={() => void refresh()}>r refresh · esc close</text>
      </box>
    }
    let stops: (() => void)[] = []
    const unsubscribe = () => { for (const stop of stops.splice(0)) stop() }
    const show = () => {
      if (closed) return
      setOpen(true)
      unsubscribe()
      stops = EVENTS.map(type => context.data.on(type, () => void refresh()))
      context.ui.dialog.show(() => <View />, () => { unsubscribe(); setOpen(false) })
      context.ui.dialog.set({ size: "large" })
      void refresh()
    }
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        { id: "history.status", title: "History: Status", group: "History", palette: true, slash: { name: "history" }, run: show },
        { id: "history.refresh", title: "Refresh History status", group: "History", bind: "r", enabled: () => open(), run: () => void refresh() },
      ],
    }))
    return () => {
      closed = true
      generation++
      controller?.abort()
      unsubscribe()
      if (open()) context.ui.dialog.clear()
    }
  },
} satisfies Plugin.Definition
