# Contributing

## Setup

You need Node.js 24 or later and npm. Bun is not needed: the Bun-based checks run Bun 1.4.4 through `npx -y bun@1.4.4`, which downloads it on first use.

```sh
git clone https://github.com/joe-broadhead/opencode-history.git
cd opencode-history
npm ci --ignore-scripts
npm run check
```

To try a checkout in OpenCode, build it and point a plugin entry at the folder: `{ "plugins": ["/path/to/opencode-history"] }` in `opencode.json`, or `opencode plugin add /path/to/opencode-history`.

There are no native programs and no install scripts. SQLite is `node:sqlite`, which both Node (for the tests) and OpenCode's runtime provide, so the same driver code (`src/domain/sqlite.ts`) runs in both.

## Layout

| Path | Contents |
| --- | --- |
| `src/index.ts` | The server entry: `Plugin.define(createPlugin(...))`. Built to `dist/index.js`, the package's `.` export. |
| `src/tui.tsx` | The TUI entry: the `/history` status dialog. Built to `dist/tui.js`, the `./tui` export. |
| `src/domain/` | The shared contracts: IDs, doc kinds and weights, the `Source` interface (`contract.ts`), the tool input and output schemas (`schemas.ts`) and the types derived from them (`api.ts`), input defaults and ranges (`bounds.ts`), options (`config.ts`), failure codes and messages (`common.ts`) and the SQLite wrapper (`sqlite.ts`). |
| `src/source/` | The two sources: OpenCode's database, read-only (`opencode-db.ts`), and the partial plugin session API fallback (`context.ts`). |
| `src/extract/` | Turns one message into docs, file touches, subagent links and facts, and applies the built-in mask patterns and `mask`. |
| `src/index/` | The index schema, the store, sync (backfill, catch-up, reconcile), the event router and the process-wide registry. |
| `src/query/` | Search, sessions, files, read, brief, recall and SQL over the index, with the shared filters and query parser. |
| `src/host/` | Everything that talks to OpenCode: setup, tools, schemas, result text, pin, commands, RPC handlers, status, skills, events and errors. |
| `src/runtime.ts` | `createRuntime`: connects a source, the shared index and the query functions behind the `HistoryRuntime` interface in `src/host/runtime.ts`. |
| `src/rpc.ts` | The status RPC contract, in plain JSON Schema. The tools RPC for scripts is `src/host/scripting.ts`. |
| `skills/history-recall/SKILL.md` | The one skill. |
| `scripts/build.mjs` | The esbuild build of `dist/`, and the `NOTICE` check. |
| `scripts/check-forbidden.mjs` | The lint: uses this plugin must never make. |
| `test/unit/` | Unit tests, by module. |
| `test/fixtures/opencode-db.ts` | A synthetic OpenCode 2.2 database with the `session_v2`, `session_message`, `project` and `todo` tables, and builders for message data. |
| `test/host/` | The plugin on an embedded `@opencode/sdk` host: the tools, rules and pin (`history.test.ts`), the tools RPC for scripts (`scripting.test.ts`), the `indexPath` refusals (`index-path.test.ts`), the harness (`harness.ts`), and test doubles for the host side: a fake runtime, sample outputs and fake instruction entries with OpenCode's key and size rules. |
| `test/tui/` | The built status dialog, mounted with OpenTUI's test renderer. |
| `test/pack/` | The packed tarball, installed and loaded on stock OpenCode. |
| `test/bench/` | Index size and search speed on a synthetic index of about 200,000 docs (`npm run bench`). |
| `.github/workflows/` | CI (`ci.yml`) and the release (`release.yml`). |

## Build

`npm run build` runs `scripts/build.mjs`. It writes exactly two self-contained ES modules, `dist/index.js` (the server part) and `dist/tui.js` (the TUI part), with no chunks and no relative imports, so an in-place update can never mix a new entry with a cached old sibling. Modules the host provides stay imports: `@opencode/plugin`, `@opentui/*`, `solid-js` and `node:` built-ins. Everything else is inlined, which today is first-party code and zod, in the server part only. The TUI's Solid JSX is compiled for OpenTUI with `babel-preset-solid`. No declaration files ship.

The build fails when it writes other files, leaves another import external, or when `NOTICE`, the licences of the inlined packages and the bundles they are in, no longer matches. `node scripts/build.mjs --notice` rewrites `NOTICE`; commit it with the change that caused it.

## Checks

`npm run check` is the full gate, and what CI runs on Linux x64 and arm64 and macOS arm64 and x64. It runs, in order:

| Script | What it does |
| --- | --- |
| `npm run typecheck` | `tsc` over the TypeScript in `src` and `test`. It also fails when OpenCode has a `session.*` event type that `src/host/events.ts` does not list. |
| `npm test` | The unit tests in `test/unit` with Vitest, two workers at a time. |
| `npm run build` | Builds `dist/`, as above. |
| `npm run test:host` | The plugin from `src/`, with the real runtime, on an embedded `@opencode/sdk` host, once as each tested release in `src/host/tested-hosts.json` (2.2.3, 2.2.4, 2.2.5 and 2.2.6), through `OPENCODE_HOST_VERSION` (`scripts/test-host.mjs`). The host runs in-process with its home, data, config and working folder in a temporary folder, no models and no provider keys. |
| `npm run test:tui` | Bun mounts the built `dist/tui.js` with OpenTUI's test renderer and a narrow fake TUI context, and checks the dialog's commands, text, refresh and cleanup. Run `npm run build` first. |
| `npm run lint` | `scripts/check-forbidden.mjs` scans `src`, `test`, `scripts` and the built `dist/` for host APIs this plugin must not use, a named zod import, install or pack scripts, peers, bundled host packages and absolute local paths. `ctx.experimental.generate` is refused everywhere, since the plugin makes no model calls. Two rules have one allowed file each: the permission `evaluate` hook only in `src/host/tools-rpc.ts` (where it may only turn an ask into a deny), and OpenCode's database only in `src/source/opencode-db.ts`. Run it after the build. |
| `npm run test:pack` | Bun packs the package as npm would publish it, installs the tarball into an empty temporary project with scripts off, and checks the file list against `test/pack/__snapshots__/install.spec.ts.snap`, the manifest, the two self-contained bundles and the TUI bundle's size. Then it starts stock OpenCode 2.2.3, 2.2.4, 2.2.5 and 2.2.6 (`opencode serve`), each on its own port, with an isolated home and a proxy that refuses outside connections, and checks that the plugin loads, answers the status RPC, finds a new session through the tools RPC, stops an endless `history_sql` statement while the server keeps answering, runs `history_sql`'s child process inside that binary, checks that the child stops when that binary is killed mid-statement, and registers its skill. The status test reads the release from the binary's `--version`, so a newer binary can stand in for a slot. Run `npm run build` first. |

The unit and host tests build their databases in temporary folders, from the synthetic fixture or from `src/index/schema.ts`. Every test's temp folder is under `/tmp` (`/private/tmp` on macOS), never under your home folder, where OpenCode's upward search would find your own `.opencode/` folders and `opencode.json`; `test/temp.ts` refuses to run when OpenCode config sits above `/tmp`. They never open your OpenCode database or your index, and they make no network calls. `test:tui` and `test:pack` download Bun 1.4.4 through `npx` on first use. `test:pack` also installs `@opencode/cli` 2.2.3, 2.2.4, 2.2.5 and 2.2.6 from npm into its temp folder, once per release, unless `OPENCODE_BIN_2_2_3`, `OPENCODE_BIN_2_2_4`, `OPENCODE_BIN_2_2_5` and `OPENCODE_BIN_2_2_6` name those binaries, as CI does; to test another release, add it to `src/host/tested-hosts.json`, which the status's `tested` flag, the host and pack tests and CI all read; with `PACKED_DIR` it checks a tarball packed earlier instead of packing one.

`npm run bench` is not part of the gate. It builds a synthetic index of made-up coding sessions, about 200,000 docs (`BENCH_DOCS` sets the count), once into `/tmp` and reuses it while the generator and `INDEX_SCHEMA_VERSION` stay the same. It prints the index size by table and the median time of searches in each mode, and fails a search slower than 500 ms. Run it when you change the index layout or the search queries.

When the published file list changes on purpose, refresh the snapshot with `npm run build && npx -y bun@1.4.4 test test/pack --update-snapshots`, and commit it. Do not skip, weaken or delete a test to get green.

## Changing things

- **Contracts.** `src/domain/contract.ts` and `src/domain/api.ts` are shared by every module. Change them deliberately, and update every side in the same change.
- **Defaults and ranges.** Every number input's default, minimum and maximum is in `BOUNDS` in `src/domain/bounds.ts`, and the most phrasings in `MAX_PHRASINGS`. The tool schemas and their descriptions read them, and the query layer clamps to them, so change them there only.
- **Index layout.** When a table, trigger or view in `src/index/schema.ts` changes, or extraction changes the text it stores for the same messages, bump `INDEX_SCHEMA_VERSION` in `src/domain/contract.ts`. An index with another version is dropped and rebuilt on open, so every doc has the new form. The version is also part of the key under which a process shares an open index, and every query checks the file's version first, so a build never queries a layout another version of the plugin made, in this process or another (`INDEX_MISMATCH`). Keep the `v_*` view names and columns and the `docs_words` and `docs_sub` full-text tables stable: `history_sql` users depend on them, and the `history_sql` description lists them. Measure a change to the full-text tables with `npm run bench`.
- **Tool schemas and the RPC contracts.** The zod schemas in `src/domain/schemas.ts` are the one description of every tool input and output; `src/domain/api.ts` derives its types from them, and OpenCode validates every result against them. `src/rpc.ts` states the status shape in JSON Schema without zod; a unit test fails when the two differ. The tools RPC takes each method's input and output from the tool itself.
- **Tools and permissions.** A new tool is a read or a change. Add a read to `READ_TOOLS` in `src/host/permissions.ts`, and a change to `CHANGING_ACTIONS` there. Both follow the `access` option (`all` by default, so they run without asking; `ask-changes` and `read-only` restrict changes), and the tools RPC makes each one a method of its class. Keep the `jelly` section of `package.json` and `docs/jelly.md` in step; `test/unit/jelly.test.ts` checks them.
- **The TUI part.** Besides Solid, `src/tui.tsx` imports only the RPC contract, `formatStatus` with its row constants, and types, so `dist/tui.js` carries no zod and stays under 30 KB; the pack test checks both. It reads the status through the `status` RPC method and changes nothing.
- **Session events.** `src/host/events.ts` lists every `session.*` event type as either followed or streaming. A host type in neither list fails the typecheck.
- **OpenCode's database.** `REQUIRED_COLUMNS` in `src/source/opencode-db.ts` is every column the plugin reads. Add a column there before reading it, so an older layout falls back to the plugin session API instead of failing.
- **Errors.** Add a code to `FailureCode` and `FAILURES` in `src/domain/common.ts`, with what happened and one next step, and to the errors table in `docs/configuration.md`. Every code must be raised somewhere; remove one that nothing raises. Messages never contain input values, session text or SQLite's own message.

## Releasing

Every plugin releases as `v0.0.0`, and it installs from that GitHub tag. The release is one commit on top of a `master`
head that CI passed, and the tag points at it.

1. Set `version` to `0.0.0` in `package.json`, date the `## [0.0.0]` entry in `CHANGELOG.md`, then run `npm run check`.
2. Push that commit to `master`, and wait for CI to pass on it.
3. In a clean checkout of `master` at that commit, run `node scripts/release-commit.mjs --ci-sha <its full sha>`. It builds
   `dist/`, removes the lifecycle scripts, and creates the signed commit and the signed annotated tag `v0.0.0`. It never
   pushes; `--dry-run` shows the change first.
4. Push the tag only: `git push origin v0.0.0`.
5. Approve the run in the `release` environment. The release workflow checks the tag and its commit, installs the tag on
   each stock OpenCode host (2.2.3 to 2.2.6), packs it, and creates the GitHub Release with the notes, the tarball and
   `SHA256SUMS`.

A tag that already exists stops step 3. Delete the old tag and its Release first, then start again.
## Commits

Commit messages use `type(scope): summary`. Keep the README, `docs/configuration.md`, `docs/architecture.md`, `SECURITY.md`, this file and `CHANGELOG.md` in step with the code. See [AGENTS.md](AGENTS.md) for the design rules.
