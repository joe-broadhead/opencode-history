import { formatFailure } from "../domain/common.js"
import TESTED from "./tested-hosts.json" with { type: "json" }

/** The supported OpenCode line. package.json `opencode.host` states the same range. */
export const HOST_RANGE = ">=2.2.3 <2.3.0"

/**
 * The OpenCode releases the checks run on: the host and pack tests, CI and the status's `tested` flag all read this one
 * list (`tested-hosts.json`).
 */
export const TESTED_HOSTS: readonly string[] = TESTED

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

/** The tested releases in words: "2.2.3, 2.2.4 or 2.2.5". */
const testedWords = () => TESTED_HOSTS.length > 1 ? `${TESTED_HOSTS.slice(0, -1).join(", ")} or ${TESTED_HOSTS.at(-1)}` : TESTED_HOSTS.join("")

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
  const next = `Use OpenCode ${testedWords()}, or another release inside ${HOST_RANGE}, or set the plugin option allowUntestedHost: true to run anyway.`
  if (!allowUntestedHost) throw new Error(formatFailure({ code: "HOST_UNTESTED", message: `History supports OpenCode ${HOST_RANGE}, found ${version ?? "no version"}.`, hint: next }))
  return { version, range: HOST_RANGE, tested: false, next: `OpenCode ${version ?? "of no known version"} is outside the supported range and allowUntestedHost is set. If something fails, use OpenCode ${testedWords()}.` }
}
