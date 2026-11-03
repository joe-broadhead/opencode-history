// A fake HistoryRuntime: it records every call and answers with the samples, or with an injected failure.
import type { Caller, IndexState } from "../../src/domain/api.js"
import type { FailureCode } from "../../src/domain/common.js"
import { INDEX_SCHEMA_VERSION } from "../../src/domain/contract.js"
import type { HistoryRuntime, HostEvent, IndexSchema, QueryMethod, ReindexMode } from "../../src/host/runtime.js"
import { INDEX, SAMPLES } from "./samples.js"

export const failure = (code: FailureCode, message: string, hint?: string) => Object.assign(new Error(message), { code, ...(hint ? { hint } : {}) })

export interface FakeRuntime extends HistoryRuntime {
  readonly calls: { readonly method: QueryMethod; readonly caller: Caller; readonly input: unknown }[]
  readonly events: HostEvent[]
  readonly reindexed: ReindexMode[]
  /** Failures to throw, by method, instead of returning a sample. */
  readonly failures: Map<QueryMethod, Error>
  /** Answers to return instead of the samples, by method. */
  readonly answers: Map<QueryMethod, unknown>
  index: IndexState
  /** The index file's schema next to this build's; set `file` to another version for INDEX_MISMATCH. */
  indexSchema: IndexSchema
  closed: boolean
}

export function fakeRuntime(): FakeRuntime {
  const answer = (method: QueryMethod) => async (caller: Caller, input: unknown): Promise<never> => {
    if (runtime.closed) throw failure("CLOSED", "The History plugin is shutting down.")
    runtime.calls.push({ method, caller, input })
    const injected = runtime.failures.get(method)
    if (injected) throw injected
    return structuredClone(runtime.answers.has(method) ? runtime.answers.get(method) : SAMPLES[method]) as never
  }
  const runtime: FakeRuntime = {
    calls: [], events: [], reindexed: [], failures: new Map(), answers: new Map(), index: INDEX, closed: false,
    indexSchema: { file: String(INDEX_SCHEMA_VERSION), build: String(INDEX_SCHEMA_VERSION) },
    status: async () => runtime.index,
    schema: async () => runtime.indexSchema,
    search: answer("search"),
    sessions: answer("sessions"),
    files: answer("files"),
    read: answer("read"),
    brief: answer("brief"),
    sql: answer("sql"),
    recall: answer("recall"),
    async reindex(mode) { runtime.reindexed.push(mode); return runtime.index },
    onEvent(event) { runtime.events.push(event) },
    async close() { runtime.closed = true },
  }
  return runtime
}
