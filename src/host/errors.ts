import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { formatFailure, type HistoryFailure } from "../domain/common.js"

/** A History failure is an Error with an upper-case code. Host permission errors are tagged instead, and pass through. */
export function isFailure(error: unknown): error is Error & HistoryFailure {
  if (!(error instanceof Error) || "_tag" in error) return false
  const code = (error as { code?: unknown }).code
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)
}

/**
 * The host's answers to a text generation that mean there is no model to ask: none is configured or available, or the
 * named model or its provider is missing, cannot write text, or cannot be set up (an invalid request about `model`).
 * A plugin in the server process gets the `Generate.*` tags; the HTTP API gives the others.
 */
const NO_MODEL = new Set([
  "Generate.UnavailableError", "Generate.ModelNotFoundError", "Generate.UnsupportedModelError",
  "ServiceUnavailableError", "ModelNotFoundError", "ProviderNotFoundError", "UnsupportedModelError",
])
const INVALID_REQUEST = new Set(["Generate.InvalidRequestError", "InvalidRequestError"])
export function noModel(error: unknown) {
  if (typeof error !== "object" || error === null) return false
  const { _tag: tag, field } = error as { _tag?: unknown; field?: unknown }
  if (typeof tag !== "string") return false
  return NO_MODEL.has(tag) || (INVALID_REQUEST.has(tag) && typeof field === "string" && /^model(?:\.|$)/.test(field))
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
