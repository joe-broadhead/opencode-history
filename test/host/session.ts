// A fake of the plugin context's instruction entries, with OpenCode's key and size rules.
import type { ActionSources } from "../../src/host/actions.js"

type Entries = ActionSources["session"]["instructions"]["entry"]
type Value = Parameters<Entries["put"]>[0]["value"]

/** InstructionEntry.Key and InstructionEntry.MaxValueBytes in @opencode/schema 2.2.3; a unit test compares them. */
export const HOST_KEY = /^[a-z0-9][a-z0-9._-]*$/u
export const HOST_MAX_VALUE_BYTES = 256 * 1024

export function fakeSession() {
  const store = new Map<string, Map<string, Value>>()
  const calls: { readonly op: "list" | "put" | "remove"; readonly sessionID: string; readonly key?: string }[] = []
  const of = (sessionID: string) => store.get(sessionID) ?? store.set(sessionID, new Map()).get(sessionID)!
  const entry: Entries = {
    async list({ sessionID }) {
      calls.push({ op: "list", sessionID })
      return [...of(sessionID)].sort(([a], [b]) => a < b ? -1 : 1).map(([key, value]) => ({ key, value }))
    },
    async put({ sessionID, key, value }) {
      calls.push({ op: "put", sessionID, key })
      if (!HOST_KEY.test(key)) throw Object.assign(new Error("Invalid instruction entry key"), { _tag: "SchemaError" })
      if (Buffer.byteLength(JSON.stringify(value)) > HOST_MAX_VALUE_BYTES) throw Object.assign(new Error("too large"), { _tag: "InstructionEntryValueTooLargeError" })
      of(sessionID).set(key, value)
    },
    async remove({ sessionID, key }) {
      calls.push({ op: "remove", sessionID, key })
      of(sessionID).delete(key)
    },
  }
  return { store, calls, session: { instructions: { entry } } satisfies ActionSources["session"] }
}
