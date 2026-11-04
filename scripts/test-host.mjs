// Runs the host tests (vitest.host.config.ts) once per tested OpenCode release, as the host version the embedded
// @opencode/sdk reports to plugins. The releases come from src/host/tested-hosts.json, the one list the status, the
// pack test and CI read too. Run it with `node scripts/test-host.mjs` (npm run test:host).
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const versions = JSON.parse(readFileSync(join(root, "src/host/tested-hosts.json"), "utf8"))
const vitest = join(root, "node_modules", ".bin", "vitest")
for (const version of versions) {
  console.log(`\nhost tests as OpenCode ${version}`)
  const run = spawnSync(vitest, ["run", "-c", "vitest.host.config.ts"], { cwd: root, stdio: "inherit", env: { ...process.env, OPENCODE_HOST_VERSION: version } })
  if (run.status !== 0) process.exit(run.status ?? 1)
}
