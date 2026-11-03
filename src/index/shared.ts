// One value per key for the whole process, so plugin instances for different project locations share one store and
// one indexer. The registry lives on globalThis so separately loaded copies of this module find the same one.

/** Registry slot. Bump the version if `Entry` changes shape. */
export const REGISTRY = Symbol.for("opencode-history.index.v1")

interface Entry {
  readonly value: { close(): void }
  refs: number
}

export interface Lease<T> {
  readonly value: T
  /** Give the value back; the last release closes it. Releasing twice does nothing. */
  release(): void
}

function registry(): Map<string, Entry> {
  const slot = globalThis as { [REGISTRY]?: Map<string, Entry> }
  return (slot[REGISTRY] ??= new Map())
}

/**
 * Hold the value for `key`, creating it with `factory` when nobody holds one. Callers sharing a key must build the same
 * kind of value; pass a resolved index path as the key so different spellings of one file meet.
 */
export function acquire<T extends { close(): void }>(key: string, factory: () => T): Lease<T> {
  const entries = registry()
  let entry = entries.get(key)
  if (!entry) {
    entry = { value: factory(), refs: 0 }
    entries.set(key, entry)
  }
  entry.refs++
  const held = entry
  let released = false
  return {
    value: held.value as T,
    release() {
      if (released) return
      released = true
      held.refs--
      if (held.refs > 0) return
      if (entries.get(key) === held) entries.delete(key)
      held.value.close()
    },
  }
}
