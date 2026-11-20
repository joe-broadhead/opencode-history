/**
 * The tools RPC, version 2.3: every History tool, and the source contract's `probe`, as RPC methods, so a script can
 * call them with no model.
 *
 *   POST /api/rpc/history.sessions.tools/<method>
 *   { "input": { "sessionID": "<session>", "input": <the tool's input> } }
 *
 * The transport is source-contract's `tools-rpc` module (pinned in package.json and bundled into dist/index.js): the
 * version 2 rules (resolve before dispatch, only `allow` runs, the one `evaluate` hook that turns an inner ask of this
 * RPC's own calls into a deny), `describe`, the envelope and the per-method resource resolver, which no History method
 * uses. This module is History's part of it, one `ToolsRpcPlugin` value: the plugin's id, its method table, its shapers,
 * its next steps and its own error mapping. It was the PLUGIN-SPECIFIC block of the shared copy every plugin carried.
 */
import * as z from "zod"
import {
  registerToolsRpc as register,
  toolsRpcId,
  type Failure,
  type JsonSchema,
  type McpResult,
  type MethodSpec,
  type NextSteps,
  type PluginMethod,
  type ShapeCall,
  type ToolsRpcContext,
  type ToolsRpcOptions as PackageOptions,
  type ToolsRpcPlugin,
} from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { fail, FAILURES, parse } from "../domain/common.js"
import { PLUGIN_ID as HISTORY_ID } from "../domain/contract.js"
import { ProbeInputSchema, ProbeOutputSchema } from "../domain/schemas.js"
import { sessionListItems, LIST_CAP } from "../query/sessions.js"
import { isFailure } from "./errors.js"
import { localIdentity } from "./identity.js"
import { PROBE_ACTION, permissionRequest } from "./permissions.js"
import { bounded, runTool, TOOL_DEFINITIONS, type ToolSources } from "./tools.js"

export { CLASSES, LOCATION_HEADER, LOCATION_HINT, evaluate, hidden, upstreamText } from "@we-the-rebel-alliance/source-contract/tools-rpc"
export type {
  Failure,
  JsonSchema,
  McpMethod,
  McpResult,
  MethodClass,
  MethodSpec,
  NextSteps,
  OwnedMethod,
  PluginMethod,
  Rule,
  ShapeCall,
  ToolCall,
  ToolsRpcContext,
  ToolsRpcPlugin,
} from "@we-the-rebel-alliance/source-contract/tools-rpc"

/** The plugin's id. The RPC id is `<PLUGIN_ID>.tools`: `history.sessions.tools`. */
export const PLUGIN_ID = HISTORY_ID

/**
 * History has no MCP server, so every method is plugin-owned. The table is `TOOL_DEFINITIONS`: it already carries each
 * tool's name, action, description, schemas and run function, and its class. Eight read the index; `pin` writes the
 * current session, which is why it is `codemode: false` on the model path and `directOnly` here. `scriptMethods` turns
 * that table into the module's methods, so a script runs the same tool code with the same assert as the model, then
 * adds `probe`, the source contract's, which is a method and not a tool.
 */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** The registry's `list` output, as a consumer validates it. */
const LIST_DATA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "editable"],
  properties: {
    items: {
      type: "array",
      maxItems: LIST_CAP,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text"],
        properties: { id: { type: "string", minLength: 1, maxLength: 128 }, text: { type: "string", maxLength: 200 } },
      },
    },
    editable: { type: "boolean" },
  },
}

/**
 * The `history.sessions.list` snapshot's answer: the family's snapshot envelope around the registry's `list` output.
 * The host validates every tools-RPC method's answer against the method's declared output, so `sessions` declares both
 * this and the model tool's own answer, and a list read is not refused `rpc.invalid_output`.
 */
const LIST_ANSWER: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data", "asOf", "trust"],
  properties: {
    account: { type: "string" },
    data: LIST_DATA,
    asOf: { type: "string" },
    trust: { type: "string", const: "untrusted" },
  },
}

/** The `list` and `account` inputs the `sessions` method takes for the snapshot. The model's tool keeps its own. */
const LIST_INPUT: JsonSchema = {
  list: { type: "string", enum: ["sessions"], description: 'A consumer\'s list snapshot: "sessions" answers the contract\'s `list` output, not a page of sessions.' },
  account: { type: "string", description: "This machine's account, as probe names it; another is refused." },
}

/** A tool's declared input with the snapshot's extra inputs, when the method takes them. */
function rpcInput(name: string, input: JsonSchema): JsonSchema {
  if (name !== "sessions") return input
  return { ...input, properties: { ...(input.properties ?? {}), ...LIST_INPUT } }
}

/** A tool's declared output, with the list answer beside it for the method that carries the snapshot. */
function rpcOutput(name: string, output: JsonSchema): JsonSchema {
  return name === "sessions" ? { anyOf: [output, LIST_ANSWER] } : output
}

export function scriptMethods(sources: ToolSources): readonly MethodSpec[] {
  return [
    ...TOOL_DEFINITIONS.map(
      (tool): PluginMethod => ({
        kind: "plugin",
        name: tool.name,
        action: tool.action,
        class: tool.class,
        ...(tool.codemode ? {} : { directOnly: true }),
        description: tool.description,
        input: rpcInput(tool.name, schemaOf(tool.input, "input")),
        output: rpcOutput(tool.name, schemaOf(tool.output, "output")),
        async run(input, call) {
          // history.sessions.list: the sessions read as the contract's list output. The model path does not pass list.
          if (tool.name === "sessions" && isRecord(input) && input["list"] === "sessions") {
            await sources.assert(permissionRequest(call, tool.action))
            const mine = (sources.identity ?? localIdentity)().account
            const account = typeof input["account"] === "string" ? input["account"] : undefined
            if (account !== undefined && account !== mine) {
              fail("ACCOUNT_MISMATCH", { hint: "Pass this machine's account, as probe names it." })
            }
            const caller = { sessionID: call.sessionID, projectID: sources.location.projectID, directory: sources.location.directory }
            const listed = await sources.runtime.sessions(caller, { limit: LIST_CAP, scope: "all" })
            const items = sessionListItems(listed.sessions)
            return {
              ...(account === undefined ? {} : { account }),
              data: { items, editable: false },
              asOf: new Date().toISOString(),
              trust: "untrusted" as const,
            }
          }
          const result = bounded(await runTool(tool, sources, call, parse(tool.input, input ?? {}, "INPUT_INVALID"), call.signal))
          // RPC output must be a JSON value: drop undefined keys.
          return JSON.parse(JSON.stringify(result.output))
        },
      }),
    ),
    probeMethod(sources),
  ]
}

/**
 * `probe` (the source contract's, `sources.probe.action` `history_probe`): whose this machine's History is, for the
 * `history.sessions` source, as every page names it: the account is this machine and the owner its OS user. It asserts
 * its own action and reads nothing else: no index, no session, no network.
 */
export function probeMethod(sources: Pick<ToolSources, "runtime" | "assert" | "location">): PluginMethod {
  return {
    kind: "plugin",
    name: "probe",
    action: PROBE_ACTION,
    class: "read",
    description:
      "For a consumer binding History's sessions source, not for answering questions: this machine's account and its OS user, as the sessions source's pages name them. It reads no session.",
    input: schemaOf(ProbeInputSchema, "input"),
    output: schemaOf(ProbeOutputSchema, "output"),
    async run(input, call) {
      const request = parse(ProbeInputSchema, input ?? {}, "INPUT_INVALID")
      await sources.assert(permissionRequest(call, PROBE_ACTION))
      return JSON.parse(JSON.stringify(await sources.runtime.probe({ sessionID: call.sessionID, ...sources.location }, request)))
    },
  }
}

/** A tool's Zod schema as the plain JSON Schema describe reports. If it cannot be represented, describe reports an empty object. */
function schemaOf(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  try {
    return z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema
  } catch {
    return { type: "object" }
  }
}

/** History has no `execute.before` hook: a script's arguments reach the tool exactly as a model's do. */
export function shapeInput(_method: string, input: unknown, _call: ShapeCall): unknown {
  return input
}

/** History has no `execute.after` hook: a tool's own formatting is inside its run, so a script reads the same output. */
export function shapeResult(_method: string, result: McpResult, _call: ShapeCall): McpResult {
  return result
}

/** The next step for each code. Each is one sentence that ends with a full stop. */
export const NEXT_STEPS: NextSteps = {
  SESSION_UNKNOWN: `Create a session in the location you mean, such as POST /api/session with {"agent":"build"} sent with the header "x-opencode-directory: <dir>" or the location[directory] query, and pass its id.`,
  SESSION_AGENT_REQUIRED: `Create a session that names an agent this project has, with its project as the location, such as POST /api/session with {"agent":"build","location":{"directory":"/path/to/project"}}, and pass its id.`,
  PERMISSION_DENIED: "Add an allow rule for the action to the session's agent or to the session, or use a session whose agent allows it.",
  CANCELLED: "Call the method again if you still need the result.",
}

/** A History failure from a tool's own run: its code, what happened and its next step, as the model reads them. */
export function pluginError(error: unknown): Failure | undefined {
  if (!isFailure(error)) return undefined
  return { code: error.code, what: error.message, next: error.hint ?? FAILURES[error.code]?.[1] ?? "Run /history-status and follow its next step." }
}

/** History's part of the tools RPC, as the package's one value. No method has a resource resolver. */
export const HISTORY: ToolsRpcPlugin = { id: PLUGIN_ID, nextSteps: NEXT_STEPS, shapeInput, shapeResult, pluginError }

/** `history.sessions.tools`, the id package.json's `sources.rpc` names. */
export const TOOLS_RPC_ID = toolsRpcId(PLUGIN_ID)

/** Everything setup and the tests pass: the table, and the shapers a test may spy on. */
export type ToolsRpcOptions = Omit<PackageOptions, "plugin">

/** The package's `registerToolsRpc` with History's value, so a caller passes only the table. */
export function registerToolsRpc(ctx: ToolsRpcContext, options: ToolsRpcOptions): Promise<() => Promise<void>> {
  return register(ctx, { ...options, plugin: HISTORY })
}
