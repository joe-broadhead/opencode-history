import { formatFailure } from "../domain/common.js"

/** The tested OpenCode line. package.json `opencode.host` states the same range. */
export const HOST_RANGE = ">=2.2.3 <2.3.0"

type Version = readonly [number, number, number]
const parse = (value: string): Version | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}
const compare = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** Whether `version` is a release inside `>=low <high`. Prereleases, dev builds and "unknown" are untested. */
export function tested(version: string, range = HOST_RANGE) {
  const [, low, high] = /^>=(\S+) <(\S+)$/.exec(range) ?? []
  const found = parse(version), min = low && parse(low), max = high && parse(high)
  if (!found || !min || !max) return false
  return compare(found, min) >= 0 && compare(found, max) < 0
}

export interface HostCheck { readonly required: string; readonly found: string; readonly availability: "AVAILABLE" | "HOST_UNTESTED"; readonly next?: string }

/** Refuses an untested host unless `allowUntestedHost` is set; then the status keeps a warning and the next step. */
export function checkHost(found: string, allowUntestedHost: boolean): HostCheck {
  if (tested(found)) return { required: HOST_RANGE, found, availability: "AVAILABLE" }
  const next = "Use OpenCode 2.2.3 or a later 2.2.x release, or set the plugin option allowUntestedHost: true to run anyway."
  if (!allowUntestedHost) throw new Error(formatFailure({ code: "HOST_UNTESTED", message: `History is tested on OpenCode ${HOST_RANGE}, found ${found}.`, hint: next }))
  return { required: HOST_RANGE, found, availability: "HOST_UNTESTED", next: "This OpenCode version is untested and allowUntestedHost is set. If something fails, use OpenCode 2.2.3 or a later 2.2.x release." }
}
