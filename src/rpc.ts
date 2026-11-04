import { Rpc } from "@opencode/plugin/rpc"
import { PLUGIN_ID } from "./domain/contract.js"

// The status RPC contract in plain JSON Schema, so the TUI bundle carries no zod. A unit test keeps it identical to the
// server's zod status schema (host/schemas.ts).
const string = { type: "string" } as const
const integer = { type: "integer" } as const
const number = { type: "number" } as const
const boolean = { type: "boolean" } as const
const choice = <const T extends readonly string[]>(values: T) => ({ type: "string", enum: values }) as const
const list = <T extends object>(items: T) => ({ type: "array", items }) as const
const nullable = <const T extends "string" | "integer">(schema: { readonly type: T }) => ({ type: [schema.type, "null"] }) as const
const object = <P extends Record<string, object>, R extends readonly (keyof P & string)[]>(properties: P, required: R) =>
  ({ type: "object", properties, required, additionalProperties: false }) as const

const INDEX = object({ ready: boolean, sessionsIndexed: integer, sessionsTotal: integer, lagSeconds: number, source: choice(["opencode-db", "context"]), complete: boolean },
  ["ready", "sessionsIndexed", "sessionsTotal", "lagSeconds", "source", "complete"])
export const STATUS_OUTPUT = object({
  version: string,
  host: object({ version: nullable(string), range: string, tested: boolean }, ["version", "range", "tested"]),
  state: choice(["ready", "connecting", "failed"]),
  index: INDEX,
  fallback: choice(["SOURCE_UNAVAILABLE", "SOURCE_SCHEMA_UNKNOWN"]),
  tools: object({ visible: integer, unknown: list(string) }, ["visible", "unknown"]),
  database: string, indexPath: string, indexBytes: nullable(integer), masksChanged: boolean, defaultScope: choice(["project", "directory", "all"]),
  recall: object({ synthesize: boolean, model: nullable(string) }, ["synthesize", "model"]),
  unguardedAgents: list(string),
  permissionsBlock: list(object({ action: string, resource: string, effect: choice(["allow", "deny", "ask"]) }, ["action", "resource", "effect"])),
  mismatch: object({ file: nullable(string), build: string }, ["file", "build"]),
  nextStep: string,
}, ["version", "host", "state", "index", "tools", "database", "indexPath", "indexBytes", "masksChanged", "defaultScope", "recall", "unguardedAgents", "nextStep"])

/** A failure: the code, the full `CODE: ... Next step: ...` text as the message, and the next step. */
const errors = { failed: object({ code: string, next: string }, ["code", "next"]) }

/**
 * The plugin's status RPC, the one status view, which the TUI dialog reads. Scripts call the tools through the tools
 * RPC, `history.sessions.tools` (host/scripting.ts), as a session and its agent.
 */
export const History = Rpc.define({
  id: PLUGIN_ID,
  methods: {
    status: { input: object({}, []), output: STATUS_OUTPUT, errors },
  },
  events: {},
})
export type HistoryMethod = keyof typeof History.methods
