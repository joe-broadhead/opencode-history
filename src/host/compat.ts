import { formatFailure, HistoryError } from "../domain/common.js"
import { HOST_RANGE, TESTED_HOSTS, testedWords } from "../domain/hosts.js"

type Version = readonly [number, number, number]
const parse = (value: string): Version | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}
const compare = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** Whether `version` is a release inside `>=low <high`. Prereleases, dev builds and "unknown" are outside. */
export function inRange(version: string, range = HOST_RANGE) {
  const [, low, high] = /^>=(\S+) <(\S+)$/.exec(range) ?? []
  const found = parse(version), min = low && parse(low), max = high && parse(high)
  if (!found || !min || !max) return false
  return compare(found, min) >= 0 && compare(found, max) < 0
}


/**
 * The host check, as the status shows it: the version found (null when the host gives none), the supported range, and
 * whether the version is one the checks run on. `next` is the host's next step, present only for a version outside the
 * range that runs because allowUntestedHost is set.
 */
export interface HostCheck { readonly version: string | null; readonly range: string; readonly tested: boolean; readonly next?: string }

/**
 * A version outside the range is refused unless `allowUntestedHost` is set; with it, it runs and keeps a next step. A
 * version inside the range that the checks do not run on sets up normally, with `tested` false.
 */
export function checkHost(found: string, allowUntestedHost: boolean): HostCheck {
  const version = found.trim() === "" ? null : found
  if (version !== null && TESTED_HOSTS.includes(version)) return { version, range: HOST_RANGE, tested: true }
  // Inside the range but untested: it sets up normally, and only `tested` and the OpenCode row say so (S13).
  if (version !== null && inRange(version)) return { version, range: HOST_RANGE, tested: false }
  if (!allowUntestedHost) throw new Error(formatFailure(new HistoryError("HOST_UNTESTED", { message: `History supports OpenCode ${HOST_RANGE}, found ${version ?? "no version"}.` })))
  return { version, range: HOST_RANGE, tested: false, next: `OpenCode ${version ?? "of no known version"} is outside the supported range and allowUntestedHost is set. If something fails, use OpenCode ${testedWords()}.` }
}
