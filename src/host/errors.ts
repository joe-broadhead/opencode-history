import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { formatFailure, type HistoryFailure } from "../domain/common.js"

/** A History failure is an Error with an upper-case code. Host permission errors are tagged instead, and pass through. */
export function isFailure(error: unknown): error is Error & HistoryFailure {
  if (!(error instanceof Error) || "_tag" in error) return false
  const code = (error as { code?: unknown }).code
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)
}

/** What the model sees: the code, what happened and the next step. */
export function toToolError(failure: HistoryFailure) {
  const hint = failure.hint ? { hint: failure.hint } : {}
  return new ToolError({ message: formatFailure(failure), metadata: { code: failure.code, ...hint } })
}

/** Runs a tool body and turns History failures into tool errors; anything else, including permission errors, is rethrown. */
export async function mapFailures<T>(work: () => Promise<T>) {
  try { return await work() } catch (error) { throw isFailure(error) ? toToolError(error) : error }
}
