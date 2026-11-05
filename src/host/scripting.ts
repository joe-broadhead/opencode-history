import { Rpc } from "@opencode/plugin/rpc"
import type { Plugin } from "@opencode/plugin"
import * as z from "zod"
import { HistoryError, parse } from "../domain/common.js"
import { PLUGIN_ID } from "../domain/contract.js"
import { isFailure } from "./errors.js"
import { SCRIPT_MARK, type Assert, type PermissionRequest, type ScriptCall } from "./permissions.js"
import { ACTIONS, bounded, runTool, TOOL_DEFINITIONS, type ToolDefinition, type ToolSources } from "./tools.js"

/**
 * The tools RPC: every tool except the actions (`history_pin`) as an RPC method of the same name, so a script can
 * search, read and report on past sessions through `opencode api` with no model.
 *
 *   POST /api/rpc/history.sessions.tools/<tool>
 *   { "input": { "sessionID": "<session>", "input": <the tool's input> } }
 *
 * One definition: each method runs the tool's own definition (`runTool`), so its input, output, errors and permission
 * assert are the tool's. A script runs as a session and the agent it names: the assert evaluates that agent's rules
 * and the session's own, so a deny that hides the tool from the model refuses the method, and an ask is refused,
 * because no one is there to answer it. The actions are excluded by name, so no script changes a session.
 */

export const TOOLS_RPC_ID = `${PLUGIN_ID}.tools`

/** The tools that are never RPC methods: the actions, which change a session. */
export const EXCLUDED: ReadonlySet<string> = new Set(ACTIONS)

export const UNATTENDED = "A script cannot answer an approval prompt; this needs an allow rule for the session's agent."

type JsonSchema = Record<string, unknown>
const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The envelope's messages: the one wording every plugin's tools RPC uses (the shared tools-rpc module's README,
 * "Envelope errors"). History checks its own envelope, but says the same.
 */
const ENVELOPE_MESSAGES = {
  notObject: `the envelope must be an object, such as {"sessionID":"<session>","input":<the tool's input>}`,
  unknownKey: (key: string) => `"${key}" is not allowed`,
  sessionID: `"sessionID" must be a non-empty string`,
  inputMissing: `"input" is missing`,
  describe: "describe takes no input",
} as const

/**
 * A plain JSON Schema with a strict Standard Schema validator attached, not enumerable. OpenCode prefers the validator
 * and answers its issues with `rpc.invalid_input`; it would otherwise drop unknown keys of an object that has
 * properties instead of refusing them. The contract still serialises as plain JSON Schema.
 */
const standard = (schema: JsonSchema, issues: (value: unknown) => string[]): JsonSchema =>
  Object.defineProperty({ ...schema }, "~standard", {
    value: { version: 1, vendor: "history", validate: (value: unknown) => {
      const found = issues(value)
      return found.length === 0 ? { value } : { issues: found.map(message => ({ message })) }
    } },
    enumerable: false,
  })

/** The envelope's problems, one message each; none when it is valid. `input` is checked by the tool's own schema. */
function envelopeIssues(value: unknown): string[] {
  if (!plainObject(value)) return [ENVELOPE_MESSAGES.notObject]
  return [
    ...Object.keys(value).filter(key => key !== "sessionID" && key !== "input").map(ENVELOPE_MESSAGES.unknownKey),
    ...typeof value["sessionID"] === "string" && value["sessionID"] !== "" ? [] : [ENVELOPE_MESSAGES.sessionID],
    ...Object.hasOwn(value, "input") ? [] : [ENVELOPE_MESSAGES.inputMissing],
  ]
}

const ENVELOPE = standard(
  { type: "object", properties: { sessionID: { type: "string", minLength: 1 }, input: {} }, required: ["sessionID", "input"], additionalProperties: false },
  envelopeIssues,
)
/** describe's input: nothing, or an empty object. */
const DESCRIBE_INPUT = standard({ type: "object", properties: {}, required: [], additionalProperties: false }, value =>
  value === undefined || value === null || (plainObject(value) && Object.keys(value).length === 0) ? [] : [ENVELOPE_MESSAGES.describe])

/** Every method's one declared error: the code from the error table and its next step. */
const Failure = z.strictObject({ code: z.string(), next: z.string() })

const Description = z.strictObject({
  id: z.string(),
  call: z.string(),
  methods: z.array(z.strictObject({
    name: z.string(),
    action: z.string(),
    description: z.string(),
    input: z.record(z.string(), z.unknown()),
    output: z.record(z.string(), z.unknown()),
  })),
})
type Description = z.output<typeof Description>

type Context = { signal: AbortSignal; error: (type: "failed", message: string, data: z.output<typeof Failure>) => unknown }

/** True when OpenCode refused a session lookup because the session does not exist: its Session.NotFoundError, or an HTTP 404. */
export function sessionNotFound(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false
  const record = error as Record<string, unknown>
  const tag = record["_tag"] ?? record["name"]
  return tag === "Session.NotFoundError" || tag === "SessionNotFoundError" || record["status"] === 404 || record["statusCode"] === 404
}

/** A refused assert, as PERMISSION_DENIED; a cancelled call stays CANCELLED. Never the input. */
function denied(request: PermissionRequest, error: unknown): HistoryError {
  if (isFailure(error) && error.code === "CANCELLED") return new HistoryError("CANCELLED")
  const reason = error instanceof Error && error.message ? error.message.split("\n", 1)[0]!.slice(0, 300) : "refused"
  return new HistoryError("PERMISSION_DENIED", { message: `${request.action} was refused for this session's agent: ${reason.replace(/[.\s]+$/, "")}.` })
}

/** The tool definitions the RPC serves: all but the excluded ones. */
const scriptTools = (): readonly ToolDefinition[] => TOOL_DEFINITIONS.filter(tool => !EXCLUDED.has(tool.name))

/** What a script author needs: each method's permission action and its input and output as JSON Schema. */
function describe(tools: readonly ToolDefinition[]): Description {
  return {
    id: TOOLS_RPC_ID,
    call: `POST /api/rpc/${TOOLS_RPC_ID}/<method> with {"input":{"sessionID":"<session>","input":<the tool's input>}}`,
    methods: tools.map(tool => ({
      name: tool.name,
      action: tool.action,
      description: tool.description,
      input: z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>,
      output: z.toJSONSchema(tool.output, { io: "output", unrepresentable: "any" }) as Record<string, unknown>,
    })),
  }
}

interface ScriptingContext {
  readonly rpc: Pick<Plugin.Context["rpc"], "register">
  readonly permission: Pick<Plugin.Context["permission"], "assert" | "hook">
  readonly session: Pick<Plugin.Context["session"], "get">
}

/** Registers the tools RPC and the hook that refuses a script's ask. Returns the cleanup. */
export async function registerScripting(ctx: ScriptingContext, sources: Omit<ToolSources, "assert">): Promise<() => Promise<void>> {
  // A refused assert becomes PERMISSION_DENIED, so a script reads one error shape.
  const assert: Assert = async request => {
    try {
      await ctx.permission.assert(request as never)
    } catch (error) {
      throw denied(request, error)
    }
  }
  const tools = scriptTools()
  const description = describe(tools)

  const session = async (sessionID: string): Promise<ScriptCall> => {
    let agent: string | undefined
    try {
      agent = (await ctx.session.get({ sessionID: sessionID as never })).agent
    } catch (error) {
      // Only OpenCode's "no such session" is SESSION_UNKNOWN; any other failure propagates as it is.
      if (sessionNotFound(error)) throw new HistoryError("SESSION_UNKNOWN")
      throw error
    }
    if (!agent) throw new HistoryError("SESSION_AGENT_REQUIRED")
    return { sessionID, agent, script: true }
  }

  const invoke = async (tool: ToolDefinition, raw: unknown, context: Context): Promise<unknown> => {
    try {
      if (context.signal.aborted) throw new HistoryError("CANCELLED")
      // OpenCode has checked the envelope with its validator, ENVELOPE's ~standard.
      const { sessionID, input } = raw as { sessionID: string; input: unknown }
      const call = await session(sessionID)
      const result = bounded(await runTool(tool, { ...sources, assert }, call, parse(tool.input, input ?? {}, "INPUT_INVALID"), context.signal))
      // RPC output must be a JSON value: drop undefined keys.
      return JSON.parse(JSON.stringify(result.output))
    } catch (error) {
      if (!isFailure(error)) throw error
      return context.error("failed", `${error.code}: ${error.message}${error.hint ? ` Next step: ${error.hint}` : ""}`, { code: error.code, next: error.hint ?? "" })
    }
  }

  const contract = Rpc.define({
    id: TOOLS_RPC_ID,
    methods: {
      describe: { input: DESCRIBE_INPUT, output: Description },
      ...Object.fromEntries(tools.map(tool => [tool.name, { input: ENVELOPE, output: tool.output, errors: { failed: Failure } }])),
    },
    events: {},
  })
  const handlers = {
    describe: async () => description,
    ...Object.fromEntries(tools.map(tool => [tool.name, (raw: unknown, context: Context) => invoke(tool, raw, context)])),
  }
  const registration = await ctx.rpc.register(contract, handlers as never)

  // A script's ask has no one to answer it: refuse it now instead of leaving a prompt that waits. Only this plugin's
  // own script calls carry the mark, so the hook never changes anything else.
  const hook = await ctx.permission.hook("evaluate", evaluation => {
    if (evaluation.effect !== "ask" || evaluation.metadata?.[SCRIPT_MARK] !== true || !evaluation.action.startsWith("history_")) return
    evaluation.effect = "deny"
    evaluation.message = UNATTENDED
  })

  return async () => {
    await hook.dispose().catch(() => undefined)
    await registration.dispose().catch(() => undefined)
  }
}
