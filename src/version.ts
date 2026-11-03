import { readFileSync } from "node:fs"

declare const __HISTORY_VERSION__: string | undefined

/**
 * The package version. The build writes it in from package.json (scripts/build.mjs), so the shipped code never reads a
 * file for it; the unbuilt source, as the tests run it, reads package.json.
 */
export const VERSION: string = typeof __HISTORY_VERSION__ === "string"
  ? __HISTORY_VERSION__
  : (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version
