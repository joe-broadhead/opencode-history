// Builds dist/ with esbuild: exactly two self-contained files, dist/index.js (the server part) and dist/tui.js (the TUI
// part). Each inlines all of its first-party code, the RPC contract and zod, with no chunks and no relative imports, so
// an in-place update can never mix a new entry with a cached old sibling module. No declarations ship.
// Run it with `node scripts/build.mjs` (npm run build).
// Sources import zod as `import * as z`. A named `import { z }` makes the bundler keep every locale.
import { transformAsync } from "@babel/core"
import { build } from "esbuild"
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const dist = join(root, "dist")
// The host provides these modules to plugins at run time, so they stay imports, as do node: built-ins (node:sqlite
// among them). Nothing else may stay external.
const HOST = ["@opencode/plugin", "@opencode/plugin/*", "@opentui/*", "solid-js", "solid-js/*"]
const allowed = path => path.startsWith("node:") || HOST.some(name => name.endsWith("/*") ? path.startsWith(name.slice(0, -1)) : path === name)

// The TUI view is Solid JSX for OpenTUI's universal renderer. It is compiled here, so no .tsx runs from node_modules.
const solid = {
  name: "solid-universal",
  setup(context) {
    context.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const result = await transformAsync(readFileSync(path, "utf8"), {
        filename: path, configFile: false, babelrc: false,
        presets: [["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }], ["@babel/preset-typescript", { onlyRemoveTypeImports: false }]],
      })
      if (!result?.code) throw new Error(`TUI_COMPILE_FAILED: ${path}`)
      return { contents: result.code, loader: "js" }
    })
  },
}

// The version is written in at build time, so the shipped code never reads package.json for it.
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
rmSync(dist, { recursive: true, force: true })
const result = await build({
  absWorkingDir: root,
  entryPoints: { index: "src/index.ts", tui: "src/tui.tsx" },
  outdir: "dist",
  bundle: true,
  splitting: false,
  format: "esm",
  platform: "node",
  target: "es2022",
  external: HOST,
  plugins: [solid],
  define: { __HISTORY_VERSION__: JSON.stringify(version) },
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
})

const outputs = Object.keys(result.metafile.outputs).sort()
if (JSON.stringify(outputs) !== JSON.stringify(["dist/index.js", "dist/tui.js"])) {
  console.error(`BUILD_OUTPUTS: the build wrote ${outputs.join(", ")}. Next step: Keep exactly dist/index.js and dist/tui.js, with splitting off.`)
  process.exit(1)
}
const unexpected = Object.entries(result.metafile.outputs).flatMap(([file, output]) => output.imports.filter(entry => entry.external && !allowed(entry.path)).map(entry => `${file}: ${entry.path}`))
if (unexpected.length) {
  console.error(`BUILD_EXTERNAL: ${unexpected.join(", ")} would be imported at run time but is neither bundled nor provided by the host. Next step: Bundle it, or remove the import.`)
  process.exit(1)
}

// NOTICE carries the licence of every package inlined into dist/, and names the bundles that contain it, from each
// output's own inputs. The build fails when the checked-in NOTICE no longer matches; `node scripts/build.mjs --notice`
// rewrites it.
const inlined = new Map()
for (const [file, output] of Object.entries(result.metafile.outputs)) for (const input of Object.keys(output.inputs)) {
  const name = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1]
  if (name) inlined.set(name, new Set([...inlined.get(name) ?? [], file]))
}
const notices = [...inlined.keys()].sort().map(name => {
  const dir = join(root, "node_modules", name), { version, license } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
  const file = readdirSync(dir).find(file => /^licen[cs]e(?:\.md|\.txt)?$/i.test(file))
  if (!file) throw new Error(`NOTICE_MISSING: ${name} ships no licence file`)
  return `## ${name} ${version} (${license}), in ${[...inlined.get(name)].sort().join(" and ")}\n\n${readFileSync(join(dir, file), "utf8").trim()}\n`
})
const notice = `@joe-broadhead/opencode-history bundles this third-party code into dist/.\n\n${notices.join("\n")}`
const noticePath = join(root, "NOTICE")
if (process.argv.includes("--notice")) writeFileSync(noticePath, notice)
else if (!existsSync(noticePath) || readFileSync(noticePath, "utf8") !== notice) {
  console.error("NOTICE_MISMATCH: NOTICE does not match the packages bundled into dist/. Next step: Run node scripts/build.mjs --notice, then commit NOTICE.")
  process.exit(1)
}
