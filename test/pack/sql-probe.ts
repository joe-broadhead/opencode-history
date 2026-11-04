// Runs history_sql's runner the way the OpenCode host does: inside a stock `opencode` binary acting as Bun
// (BUN_BE_BUN=1), so the child it starts is that binary again. Prints what an endless statement and a quick one did.
// With `orphan`, it starts an endless statement with the full deadline, prints its own PID and waits: the test kills
// it with SIGKILL, as a crashed OpenCode, and checks that the SQL child goes too.
// Usage: BUN_BE_BUN=1 opencode test/pack/sql-probe.ts <folder> [orphan]
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { sql } from "../../src/query/sql.js"

const [folder, mode] = process.argv.slice(2)
if (!folder) throw new Error("usage: sql-probe.ts <folder> [orphan]")
const path = join(folder, "probe.db")
const db = new DatabaseSync(path)
db.exec("create table t (x)")
db.exec("insert into t values (1), (2), (3)")
db.close()
const ENDLESS = "with recursive r(x) as (select 1 union all select x+1 from r) select count(*) from r"

if (mode === "orphan") {
  setInterval(() => {}, 1000)
  void sql(path, { sql: ENDLESS }).catch(() => {})
  console.log(JSON.stringify({ pid: process.pid }))
} else {
  let ticks = 0
  const timer = setInterval(() => ticks++, 20)
  const started = performance.now()
  const endless = await sql(path, { sql: ENDLESS }, { timeoutMs: 1500 })
    .then(() => "finished", (error: { reason?: string; code?: string }) => error.reason ?? error.code ?? "unknown")
  const took = Math.round(performance.now() - started)
  clearInterval(timer)
  const quick = await sql(path, { sql: "select sum(x) as total from t" })
  console.log(JSON.stringify({ bun: typeof process.versions.bun === "string", endless, took, ticks, quick }))
}
