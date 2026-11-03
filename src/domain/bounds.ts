// Defaults and ranges of the number inputs. The tool schemas declare them and the query layer clamps to them, so the
// two cannot disagree.

/** A number input's default and inclusive range. */
export interface Bound {
  readonly default: number
  readonly min: number
  readonly max: number
}

export const BOUNDS = {
  search: { limit: { default: 10, min: 1, max: 50 }, snippets: { default: 3, min: 0, max: 10 } },
  sessions: { limit: { default: 20, min: 1, max: 100 } },
  files: { limit: { default: 20, min: 1, max: 100 } },
  // Pins read message ranges with their own maxChars, so read's minimum is no higher than pin's.
  read: { before: { default: 2, min: 0, max: 200 }, after: { default: 10, min: 0, max: 500 }, maxChars: { default: 20_000, min: 500, max: 200_000 } },
  recall: { sessions: { default: 5, min: 1, max: 10 }, maxChars: { default: 16_000, min: 1000, max: 100_000 } },
  sql: { limit: { default: 100, min: 1, max: 200 } },
  pin: { maxChars: { default: 8000, min: 500, max: 50_000 } },
} as const satisfies Record<string, Record<string, Bound>>

/** Phrasings one search or recall takes. The schemas refuse more; the query layer ignores the rest. */
export const MAX_PHRASINGS = 6
