import { afterEach, describe, expect, it, vi } from "vitest"
import { acquire, REGISTRY } from "../../../src/index/shared.js"

class Thing {
  closed = 0
  constructor(readonly name: string) {}
  close(): void {
    this.closed++
  }
}

const registry = () => (globalThis as { [REGISTRY]?: Map<string, unknown> })[REGISTRY]

afterEach(() => {
  registry()?.clear()
})

describe("acquire", () => {
  it("shares one value per key and closes it when the last holder releases", () => {
    const factory = vi.fn(() => new Thing("a"))
    const first = acquire("/state/index.db", factory)
    const second = acquire("/state/index.db", factory)
    expect(second.value).toBe(first.value)
    expect(factory).toHaveBeenCalledTimes(1)

    first.release()
    expect(first.value.closed).toBe(0)
    second.release()
    expect(first.value.closed).toBe(1)
    expect(registry()?.has("/state/index.db")).toBe(false)

    const third = acquire("/state/index.db", factory)
    expect(third.value).not.toBe(first.value)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it("ignores a second release from the same holder", () => {
    const first = acquire("k", () => new Thing("a"))
    const second = acquire("k", () => new Thing("b"))
    first.release()
    first.release()
    expect(first.value.closed).toBe(0)
    second.release()
    expect(first.value.closed).toBe(1)
    second.release()
    expect(first.value.closed).toBe(1)
  })

  it("keeps keys apart", () => {
    const a = acquire("a", () => new Thing("a"))
    const b = acquire("b", () => new Thing("b"))
    expect(a.value.name).toBe("a")
    expect(b.value.name).toBe("b")
    a.release()
    expect(b.value.closed).toBe(0)
  })

  it("registers nothing when the factory throws", () => {
    expect(() =>
      acquire("k", () => {
        throw new Error("cannot open")
      }),
    ).toThrow("cannot open")
    expect(registry()?.has("k")).toBe(false)
    expect(acquire("k", () => new Thing("a")).value.name).toBe("a")
  })

  it("forgets the value even when closing it throws", () => {
    const lease = acquire("k", () => ({
      close() {
        throw new Error("close failed")
      },
    }))
    expect(() => lease.release()).toThrow("close failed")
    expect(registry()?.has("k")).toBe(false)
  })

  it("is shared by separately loaded copies of the module", async () => {
    const lease = acquire("k", () => new Thing("a"))
    vi.resetModules()
    const copy = await import("../../../src/index/shared.js")
    expect(copy.acquire).not.toBe(acquire)
    const other = copy.acquire("k", () => new Thing("b"))
    expect(other.value).toBe(lease.value)
    lease.release()
    other.release()
    expect(lease.value.closed).toBe(1)
  })
})
