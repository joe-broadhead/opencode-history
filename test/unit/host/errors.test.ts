import { describe, expect, test } from "vitest"
import * as z from "zod"
import { FAILURES, fail, formatFailure, HistoryError, parse, type FailureCode } from "../../../src/domain/common.js"
import { isFailure, mapFailures, toToolError } from "../../../src/host/errors.js"
import { TOOL_NAMES } from "../../../src/host/tools.js"
import { failure } from "../../host/runtime.js"

describe("failures", () => {
  test("every code has a sentence and one next step, and names only real tools", () => {
    for (const [code, [message, hint]] of Object.entries(FAILURES)) {
      expect(code, code).toMatch(/^[A-Z][A-Z0-9_]*$/)
      expect(message, code).toMatch(/^[A-Z].*\.$/)
      expect(hint, code).toMatch(/^[A-Z].*\.$/)
      // Exactly one next step: one sentence.
      expect(hint!.slice(0, -1), code).not.toMatch(/[.!?] [A-Z]/)
      for (const tool of `${message} ${hint}`.match(/\bhistory_\w+/g) ?? []) expect(TOOL_NAMES.map(name => `history_${name}`), `${code}: ${tool}`).toContain(tool)
    }
  })

  test("the one error text is CODE: what happened. Next step: what to do.", () => {
    expect(formatFailure({ code: "SESSION_NOT_FOUND", message: "No indexed session has that ID.", hint: "Find it." })).toBe("SESSION_NOT_FOUND: No indexed session has that ID. Next step: Find it.")
    expect(formatFailure({ code: "OPERATION_FAILED", message: "It failed." })).toBe("OPERATION_FAILED: It failed.")
    const error = new HistoryError("CURSOR_INVALID")
    expect(error).toMatchObject({ name: "HistoryError", code: "CURSOR_INVALID", message: FAILURES.CURSOR_INVALID[0], hint: FAILURES.CURSOR_INVALID[1] })
    expect(new HistoryError("QUERY_INVALID", { message: "The regular expression does not compile." })).toMatchObject({ message: "The regular expression does not compile.", hint: FAILURES.QUERY_INVALID[1] })
    expect(() => fail("INDEX_BUSY")).toThrow(HistoryError)
  })

  test("parse names the zod paths and rules, never the values", () => {
    const schema = z.strictObject({ query: z.string().max(3), limit: z.number().int() })
    let message = ""
    try { parse(schema, { query: "secret-query", limit: 1.5 }, "INPUT_INVALID") } catch (error) { message = (error as Error).message }
    expect(message).toMatch(/^The tool input is invalid\. query: .*; limit: .*\.$/)
    expect(message).not.toContain("secret")
    expect(() => parse(schema, {})).toThrow(expect.objectContaining({ code: "CONTRACT_MISMATCH" }))
    expect(parse(schema, { query: "abc", limit: 2 })).toEqual({ query: "abc", limit: 2 })
  })
})

describe("tool errors", () => {
  test("a History failure becomes a Tool.Error with its code and hint", async () => {
    const error = await mapFailures(async () => { throw failure("SQL_REJECTED", "Only one SELECT is allowed.", "Rewrite it.") }).catch(e => e)
    expect(error).toMatchObject({ _tag: "Tool.Error", message: "SQL_REJECTED: Only one SELECT is allowed. Next step: Rewrite it.", metadata: { code: "SQL_REJECTED", hint: "Rewrite it." } })
    expect(toToolError({ code: "CANCELLED" as FailureCode, message: "The call was cancelled." })).toMatchObject({ metadata: { code: "CANCELLED" } })
  })

  test("permission errors and plain errors pass through unchanged", async () => {
    const declined = Object.assign(new Error(""), { _tag: "Permission.DeclinedError", code: "DECLINED" })
    const plain = new Error("boom")
    await expect(mapFailures(async () => { throw declined })).rejects.toBe(declined)
    await expect(mapFailures(async () => { throw plain })).rejects.toBe(plain)
    expect(isFailure(declined)).toBe(false)
    expect(isFailure(Object.assign(new Error("x"), { code: "lower_case" }))).toBe(false)
    expect(isFailure("SQL_FAILED")).toBe(false)
    await expect(mapFailures(async () => 7)).resolves.toBe(7)
  })
})
