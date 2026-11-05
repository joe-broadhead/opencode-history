import TESTED from "../host/tested-hosts.json" with { type: "json" }

/** The supported OpenCode line. package.json `opencode.host` states the same range. */
export const HOST_RANGE = ">=2.2.3 <2.3.0"

/**
 * The OpenCode releases the checks run on: the host and pack tests, CI and the status's `tested` flag all read this one
 * list (`src/host/tested-hosts.json`).
 */
export const TESTED_HOSTS: readonly string[] = TESTED

/** The tested releases in words: "2.2.3, 2.2.4 or 2.2.5". */
export const testedWords = () => TESTED_HOSTS.length > 1 ? `${TESTED_HOSTS.slice(0, -1).join(", ")} or ${TESTED_HOSTS.at(-1)}` : TESTED_HOSTS.join("")
