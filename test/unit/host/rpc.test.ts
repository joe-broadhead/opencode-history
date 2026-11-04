import { describe, expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import * as z from "zod"
import { PLUGIN_ID } from "../../../src/domain/contract.js"
import { HOST_RANGE } from "../../../src/host/compat.js"
import { HistoryError } from "../../../src/domain/common.js"
import { rpcHandlers, type RpcSources } from "../../../src/host/rpc-handlers.js"
import * as S from "../../../src/host/schemas.js"
import { buildStatus } from "../../../src/host/status.js"
import { History, STATUS_OUTPUT } from "../../../src/rpc.js"
import { fakeRuntime } from "../../host/runtime.js"

/** The shape of a JSON Schema: types, properties, required keys, items, enums and unions. Bounds and text are left out. */
function shape(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(shape)
  if (typeof schema !== "object" || schema === null) return schema
  const s = schema as Record<string, unknown>, out: Record<string, unknown> = {}
  for (const key of ["type", "enum", "const", "additionalProperties"]) if (key in s) out[key] = s[key]
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties as object).map(([k, v]) => [k, shape(v)]))
  if ((s.required as string[] | undefined)?.length) out.required = [...(s.required as string[])].sort()
  if (s.items) out.items = shape(s.items)
  if (s.anyOf) {
    const options = shape(s.anyOf) as Record<string, unknown>[]
    // `{ anyOf: [{ type: "integer" }, { type: "null" }] }` and `{ type: ["integer", "null"] }` mean the same.
    if (options.every(o => Object.keys(o).length === 1 && typeof o.type === "string")) out.type = options.map(o => o.type)
    else out.anyOf = options
  }
  return out
}
const zodShape = (schema: z.ZodType, io: "input" | "output") => shape(z.toJSONSchema(schema, { target: "draft-2020-12", io }))

describe("RPC contract", () => {
  test("one method, status, under the plugin ID, with one failure shape", () => {
    expect(History.id).toBe(PLUGIN_ID)
    expect(Object.keys(History.methods)).toEqual(["status"])
    expect(History.methods.status.errors.failed).toMatchObject({ type: "object", required: ["code", "next"] })
  })

  test("the status JSON Schema has the shape of the zod schema the server parses with", () => {
    expect(shape(STATUS_OUTPUT)).toEqual(zodShape(S.StatusSchema, "output"))
  })

  test("the contract module imports no zod, so a TUI bundle stays small", () => {
    for (const file of ["src/rpc.ts", "src/domain/contract.ts"]) {
      const imports = [...readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8").matchAll(/^import .* from "([^"]+)"/gm)].map(m => m[1])
      expect(imports.filter(path => !["@opencode/plugin/rpc", "./domain/contract.js"].includes(path!)), file).toEqual([])
    }
  })
})

describe("RPC handlers", () => {
  const error = (type: string, message: string, data?: unknown) => ({ type, message, data })
  const context = { signal: new AbortController().signal, error } as never
  const setup = (overrides: Partial<RpcSources> = {}) => {
    const runtime = fakeRuntime()
    const sources: RpcSources = {
      status: () => buildStatus({ version: "1.0.0", host: { version: "2.2.3", range: HOST_RANGE, tested: true }, config: { database: "/d", indexPath: "/i", defaultScope: "directory", recall: { synthesize: false } }, runtime, agents: async () => [] }),
      ...overrides,
    }
    return { runtime, handlers: rpcHandlers(sources) }
  }

  test("status answers the one status view", async () => {
    const view = await setup().handlers.status({}, context)
    expect(S.StatusSchema.parse(view)).toMatchObject({ version: "1.0.0", defaultScope: "directory", state: "ready", nextStep: "Nothing to do." })
  })

  test("the status carries the shared fields with the shared names, and none of the old ones (S13)", async () => {
    const view = await setup().handlers.status({}, context) as Record<string, unknown>
    expect(view).toMatchObject({
      version: "1.0.0",
      host: { version: "2.2.3", range: ">=2.2.3 <2.3.0", tested: true },
      state: "ready",
      unguardedAgents: [],
      nextStep: "Nothing to do.",
    })
    expect(Object.keys(view.host as object).sort()).toEqual(["range", "tested", "version"])
    for (const old of ["connection", "next"]) expect(view).not.toHaveProperty(old)
    expect(STATUS_OUTPUT.required).toEqual(expect.arrayContaining(["version", "host", "state", "unguardedAgents", "nextStep"]))
    expect(STATUS_OUTPUT.properties.state.enum).toEqual(["ready", "connecting", "failed", "host_untested"])
  })

  test("a failure answers `failed` with the code, the text and the next step; an uncoded one is logged without its text", async () => {
    const coded = setup({ status: async () => { throw new HistoryError("INDEX_MISMATCH") } })
    expect(await coded.handlers.status({}, context)).toMatchObject({ type: "failed", message: expect.stringMatching(/^INDEX_MISMATCH: .* Next step: Restart every OpenCode process/), data: { code: "INDEX_MISMATCH", next: expect.stringMatching(/^Restart/) } })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const broken = setup({ status: async () => { throw new Error("boom at /private/path") } })
    const answer = await broken.handlers.status({}, context)
    expect(answer).toMatchObject({ type: "failed", data: { code: "STATUS_UNAVAILABLE" } })
    expect(JSON.stringify(answer)).not.toContain("private")
    expect(warn.mock.calls.map(([line]) => String(line).replace(/, thrown in .*\.$/, "."))).toEqual(["opencode-history: STATUS_UNAVAILABLE in rpc.status: Error."])
    warn.mockRestore()
  })
})
