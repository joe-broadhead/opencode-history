// Fails when the repository or the built dist/ uses something this plugin must never use: fork-only or legacy
// host APIs, the removed permission policy layer, install scripts, host peers, absolute local paths, or
// host-provided or build-time code bundled into dist/. Run it after the build; `npm run check` does.
//
// Two rules have one documented exception each, the only file allowed to do what the rule forbids:
//   - the permission evaluate hook, only in src/host/tools-rpc.ts, the shared tools RPC module. It turns an ask on
//     that RPC's own call in flight into a deny, because no one is there to answer the prompt. It only tightens: a
//     further rule allows that file to set an effect to "deny" and nothing else.
//   - OpenCode's database file, only in src/source/opencode-db.ts. It names the file, opens it read-only and knows its
//     tables; everything else gets sessions through the Source it returns. Tests are out of scope: their fixtures
//     build a synthetic database with the same layout.
// In dist/, an exception covers the bundled section of that same source file.
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const self = relative(root, fileURLToPath(import.meta.url))
const problems = []
const report = (file, line, message) => problems.push(`${file}${line ? `:${line}` : ""}: ${message}`)

const walk = dir => existsSync(join(root, dir))
  ? readdirSync(join(root, dir), { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => relative(root, join(e.parentPath, e.name)))
  : []
// Tracked files plus new files that are not ignored, so the scan sees work before it is committed.
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
  .split("\n").filter(file => file && file !== self && existsSync(join(root, file)))
const text = file => {
  const bytes = readFileSync(join(root, file))
  return bytes.subarray(0, 8192).includes(0) ? undefined : bytes.toString("utf8")
}
const code = /\.(?:[cm]?[jt]s|tsx)$/
const source = tracked.filter(file => code.test(file) && /^(?:src|test|scripts)\//.test(file))
const dist = walk("dist")
const built = dist.filter(file => /\.js$/.test(file))

/**
 * Line rules for first-party code. `scope` limits a rule to paths that start with one of its prefixes; `except` names
 * the source files where it does not apply.
 */
const RULES = [
  { pattern: /\bsupports[A-Z]\w*/, message: "fork-only host capability marker (supports*)" },
  { pattern: /\bPlugin\.image\b|\bPROFILE_IMAGE\b/, message: "Plugin.image and profile images are removed" },
  { pattern: /(?:^|[\s{,])image\s*:/, scope: ["src/", "dist/"], message: "the plugin definition has no image field" },
  { pattern: /(?<!\bexperimental\s*\??\.\s*)\bgenerate\.text\b/, message: "ctx.generate.text is deprecated" },
  {
    pattern: /\bexperimental\s*\??\.\s*generate\b|\bexperimental["'`]?\s*\]?\s*\??\.?\s*\[\s*["'`]generate["'`]\s*\]|\{[^}]*\bgenerate\b[^}]*\}\s*=\s*[\w$.?]*\bexperimental\b/,
    message: "ctx.experimental.generate: the plugin makes no model calls of its own",
  },
  {
    pattern: /["'`](?:[^"'`\s]*[\\/])?opencode\.db["'`]|\b(?:session_v2|session_message|session_part|session_inbox)\b/,
    scope: ["src/", "dist/"],
    except: ["src/source/opencode-db.ts"],
    message: "OpenCode's database is named, opened and queried only in src/source/opencode-db.ts; use defaultDatabasePath or the Source from openOpencodeSource",
  },
  { pattern: /["']@opencode-ai\//, message: "V1 @opencode-ai packages" },
  { pattern: /["'`]@opencode\/ai(?:\/[^"'`]*)?["'`]/, message: "@opencode/ai changes incompatibly between patches; do not import it" },
  { pattern: /\bpackages\/(?:ai|client|core|opencode|plugin|protocol|schema|sdk|server|util)\/src\b/, message: "private host source import" },
  { pattern: /opencode-(?:plugin-consumer|plugin-images|granola)-host/, message: "pinned host checkout reference" },
  { pattern: /\bui\s*\??\.\s*slot\b/, message: "ctx.ui.slot: nothing is always visible; status lives in the /history dialog" },
  { pattern: /\bhook\(\s*["']evaluate["']/, except: ["src/host/tools-rpc.ts"], message: "permission evaluate hook; only src/host/tools-rpc.ts registers one, to refuse a script's ask" },
  { pattern: /\.effect\s*=(?!=)/, except: ["src/host/tools-rpc.ts"], message: "a hook that changes a permission effect" },
  { pattern: /\.effect\s*=(?!=)(?!\s*["']deny["'])/, scope: ["src/host/tools-rpc.ts"], message: "the tools RPC hook may only turn an ask into a deny" },
  { pattern: /\b(?:config|options)\.policy\b|(?:^|[\s{,])policy\s*\??\s*:/, scope: ["src/", "dist/"], message: "plugin permission policy option" },
  { pattern: /\bexperimental\.policies\b|\bresponsePolicy\b/, message: "fork-only policy API" },
  { pattern: /\bmcp\.(?:catalog|attest)\b/, message: "fork-only MCP API" },
  { pattern: /\bexperimental\s*\??\.\s*artifact\b|\bexperimental\s*\??\.?\[\s*["'`]artifact["'`]\s*\]|\{[^}]*\bartifact\b[^}]*\}\s*=\s*[\w$.?]*\bexperimental\b/, message: "ctx.experimental.artifact is experimental (new in 2.2.4); do not use it" },
  { pattern: /^import\s+\{[^}]*\bz\b[^}]*\}\s+from\s+["']zod["']/, scope: ["src/"], message: "import zod as `import * as z from \"zod\"`; a named import bundles every locale" },
]
const vendored = file => file.startsWith("dist/")
for (const file of [...source, ...built]) {
  const content = readFileSync(join(root, file), "utf8")
  // In dist/, only first-party sections are checked; esbuild marks each bundled module with a `// <path>` comment,
  // which is also the source file an exception names.
  let firstParty = true, module = file
  content.split("\n").forEach((line, index) => {
    if (vendored(file) && /^\/\/ (?:src|node_modules)\//.test(line)) {
      firstParty = line.startsWith("// src/")
      module = line.slice(3).trim()
    }
    if (!firstParty) return
    for (const rule of RULES) {
      if (rule.scope && !rule.scope.some(prefix => file.startsWith(prefix))) continue
      if (rule.except?.includes(module)) continue
      if (rule.pattern.test(line)) report(file, index + 1, vendored(file) ? `${rule.message} (from ${module})` : rule.message)
    }
  })
  for (const call of assertCalls(content)) if (call.args > 1) report(file, call.line, "permission.assert takes one argument; the signal option is fork-only")
}

/** `.assert(` calls with their top-level argument count, skipping strings and comments. */
function assertCalls(content) {
  const calls = []
  for (const match of content.matchAll(/\.assert\s*\(/g)) {
    let depth = 0, args = 0, seen = false, quote = ""
    for (let i = match.index + match[0].length - 1; i < content.length; i++) {
      const c = content[i]
      if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue }
      if (c === "\"" || c === "'" || c === "`") { quote = c; seen = true; continue }
      if (c === "/" && content[i + 1] === "/") { i = content.indexOf("\n", i); if (i < 0) break; continue }
      if (c === "/" && content[i + 1] === "*") { i = content.indexOf("*/", i + 2) + 1; if (i <= 0) break; continue }
      if ("([{".includes(c)) { depth++; if (depth > 1) seen = true; continue }
      if (")]}".includes(c)) { if (--depth === 0) break; continue }
      if (depth === 1 && c === ",") { args++; seen = false; continue }
      if (depth === 1 && !/\s/.test(c)) seen = true
    }
    calls.push({ line: content.slice(0, match.index).split("\n").length, args: args + (seen ? 1 : 0) })
  }
  return calls
}

// Package manifests: no install-time or pack-time scripts, and no peers or bundled dependencies.
const LIFECYCLE = ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare", "prepublish", "prepack", "postpack"]
for (const file of tracked.filter(file => file === "package.json" || /^npm\/[^/]+\/package\.json$/.test(file))) {
  const manifest = JSON.parse(readFileSync(join(root, file), "utf8"))
  for (const name of LIFECYCLE) if (manifest.scripts?.[name] !== undefined) report(file, 0, `"${name}" script runs on install or pack; OpenCode installs with scripts disabled`)
  for (const field of ["peerDependencies", "peerDependenciesMeta", "bundleDependencies", "bundledDependencies"]) if (manifest[field] !== undefined) report(file, 0, `"${field}": the host provides @opencode/plugin, OpenTUI and Solid, so packages declare no peers and bundle nothing`)
}

// Absolute local paths in anything tracked, and in dist/.
const ABSOLUTE = /\/Users\/[A-Za-z]|\/home\/[a-z][\w.-]*\/|\/private\/var\/folders\/|\/var\/folders\/[a-z0-9_]{2}\/|[A-Z]:\\Users\\/
for (const file of [...tracked, ...dist]) {
  const content = text(file)
  if (content === undefined) continue
  content.split("\n").forEach((line, index) => { if (ABSOLUTE.test(line)) report(file, index + 1, "absolute local path") })
}

// dist/ ships prebuilt JavaScript only, and inlines no host-provided or build-time package.
const INLINED = new Set(["zod"])
if (built.length === 0) report("dist", 0, "missing; run npm run build first")
for (const file of dist) if (!file.endsWith(".js")) report(file, 0, "dist/ ships only .js; the licences of inlined packages are in the root NOTICE")
for (const file of built) {
  const packages = new Set([...readFileSync(join(root, file), "utf8").matchAll(/^\/\/ node_modules\/((?:@[^/\n]+\/)?[^/\n]+)\//gm)].map(m => m[1]))
  for (const name of packages) if (!INLINED.has(name)) report(file, 0, `bundles ${name}; host-provided and build-time packages stay external or out of dist/`)
}

if (problems.length) {
  console.error(`check-forbidden: ${problems.length} problem${problems.length === 1 ? "" : "s"}\n${problems.map(p => `  ${p}`).join("\n")}`)
  process.exit(1)
}
console.log(`check-forbidden: clean (${source.length} source files, ${built.length} built files, ${tracked.length} tracked files)`)
