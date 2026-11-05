// The query layer's inputs and outputs, as the tool schemas in schemas.ts define them: one description of each shape.
// Inputs are what a caller may pass, with defaults still optional; outputs are what the tools return. Type-only, so the
// TUI, which imports these, carries no zod.
import type * as z from "zod"
import type * as S from "./schemas.js"

/** Where the caller is. Scope filters and boosts are relative to it. */
export interface Caller {
  readonly sessionID: string
  readonly projectID: string
  readonly directory: string
}

export type Scope = typeof S.SCOPE_INPUTS[number]
export type Filters = z.input<typeof S.FiltersSchema>

export type SearchInput = z.input<typeof S.SearchInputSchema>
export type MatchMode = NonNullable<SearchInput["match"]>
export type SessionsInput = z.input<typeof S.SessionsInputSchema>
export type FilesInput = z.input<typeof S.FilesInputSchema>
export type ReadInput = z.input<typeof S.ReadInputSchema>
export type BriefInput = z.input<typeof S.BriefInputSchema>
export type SqlInput = z.input<typeof S.SqlInputSchema>
export type RecallInput = z.input<typeof S.RecallInputSchema>

export type IndexState = z.output<typeof S.IndexStateSchema>
export type SessionSummary = z.output<typeof S.SessionSummarySchema>
export type Snippet = z.output<typeof S.SnippetSchema>
export type SearchHit = z.output<typeof S.SearchHitSchema>
export type Hidden = z.output<typeof S.HiddenSchema>
export type ReadMessage = z.output<typeof S.ReadMessageSchema>
export type Evidence = z.output<typeof S.EvidenceSchema>
export type SearchOutput = z.output<typeof S.SearchOutputSchema>
export type SessionsOutput = z.output<typeof S.SessionsOutputSchema>
export type FilesOutput = z.output<typeof S.FilesOutputSchema>
export type ReadOutput = z.output<typeof S.ReadOutputSchema>
export type BriefOutput = z.output<typeof S.BriefOutputSchema>
export type SqlOutput = z.output<typeof S.SqlOutputSchema>
export type RecallOutput = z.output<typeof S.RecallOutputSchema>

/** Why a filter left sessions out by default: each reason is undone by one input. */
export type HiddenReason = keyof Hidden
export const HIDDEN_REASONS: readonly HiddenReason[] = ["scope", "archived", "subagents", "current"]
