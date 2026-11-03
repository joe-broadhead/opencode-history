import { describe, expect, test } from "vitest"
import type * as z from "zod"
import type {
  BriefInput, BriefOutput, FilesInput, FilesOutput, IndexState, ReadInput, ReadOutput, RecallInput, RecallOutput,
  SearchInput, SearchOutput, SessionsInput, SessionsOutput, SqlInput, SqlOutput,
} from "../../../src/domain/api.js"
import type * as S from "../../../src/host/schemas.js"
import type { StatusView } from "../../../src/host/status.js"

// Compile-time: each schema's type is its api.ts type, apart from readonly. `satisfies` in schemas.ts checks only one
// direction; these check both, so a field added to api.ts and not to a schema fails the typecheck.
type Writable<T> = T extends readonly (infer U)[] ? Writable<U>[] : T extends object ? { -readonly [K in keyof T]: Writable<T[K]> } : T
/** Flattens intersections and marks optional keys the same way on both sides, so only real differences remain. */
type Plain<T> = T extends readonly (infer U)[] ? Plain<U>[] : T extends object ? { [K in keyof T]: Plain<T[K]> } : T
type Same<A, B> = (<X>() => X extends Plain<Writable<A>> ? 1 : 2) extends (<X>() => X extends Plain<Writable<B>> ? 1 : 2) ? true : false
type Input<T extends z.ZodType> = z.input<T>
type Output<T extends z.ZodType> = z.output<T>

const inputs: [
  Same<Writable<SearchInput>, Input<typeof S.SearchInputSchema>>,
  Same<Writable<SessionsInput>, Input<typeof S.SessionsInputSchema>>,
  Same<Writable<FilesInput>, Input<typeof S.FilesInputSchema>>,
  Same<Writable<ReadInput>, Input<typeof S.ReadInputSchema>>,
  Same<Writable<BriefInput>, Input<typeof S.BriefInputSchema>>,
  Same<Writable<SqlInput>, Input<typeof S.SqlInputSchema>>,
  Same<Writable<RecallInput>, Input<typeof S.RecallInputSchema>>,
] = [true, true, true, true, true, true, true]
const outputs: [
  Same<Writable<IndexState>, Output<typeof S.IndexStateSchema>>,
  Same<Writable<SearchOutput>, Output<typeof S.SearchOutputSchema>>,
  Same<Writable<SessionsOutput>, Output<typeof S.SessionsOutputSchema>>,
  Same<Writable<FilesOutput>, Output<typeof S.FilesOutputSchema>>,
  Same<Writable<ReadOutput>, Output<typeof S.ReadOutputSchema>>,
  Same<Writable<BriefOutput>, Output<typeof S.BriefOutputSchema>>,
  Same<Writable<SqlOutput>, Output<typeof S.SqlOutputSchema>>,
  Same<Writable<RecallOutput>, Output<typeof S.RecallOutputSchema>>,
  Same<Writable<StatusView>, Output<typeof S.StatusSchema>>,
] = [true, true, true, true, true, true, true, true, true]

describe("schemas", () => {
  test("match the api.ts types (checked by tsc)", () => {
    expect([...inputs, ...outputs].every(Boolean)).toBe(true)
  })
})
