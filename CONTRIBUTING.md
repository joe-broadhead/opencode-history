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

Each release is the GitHub tag `v<version>`, where `<version>` is the `version` in `package.json`, and users install from
that tag. The release is one commit on top of a `master` head that CI passed, and the tag points at it. The release
workflow makes both, in GitHub Actions: nobody builds, commits or tags a release on their own machine, and no personal
key signs it.

While changes land, their notes go under `## [Unreleased]` at the top of `CHANGELOG.md`. Each earlier GitHub release is
a `## [x.y.z] - YYYY-MM-DD` heading below it, newest first, and the npm history stays last, under
`## Earlier releases on npm`.

1. On `master`, set `version` in `package.json` to the new version, and change every install spec in the README,
   `CONTRIBUTING.md` and `docs/` to `#v<version>` (`test/docs.test.ts` fails until they match). Then run
   `node scripts/changelog.mjs release`: it turns `## [Unreleased]` into `## [<version>] - <today>`, above the earlier
   releases, and refuses a CHANGELOG it cannot shape. Run `npm run check`.
2. Push that commit to `master`, and wait for CI to pass on it.
3. Start the release with that commit's full sha:
   `gh workflow run release.yml --ref master -f sha=<full sha>`, or from Actions → release →
   Run workflow, on `master`.
4. Read the run's summary, then approve the `release` environment. The summary is on the run page, under the `stage`
   job: the tag, the parent and its CI run, the release commit and its tree, the sha256 of `SHA256SUMS` and the staged
   artifact's id, `SHA256SUMS` itself, and the notes. Open the release commit on `release/v<version>` and read them
   before approving: the approval releases exactly those bytes. Only the owner approves a release. Agents never approve
   one, never call the deployment-approval API, and never bypass a ruleset or the environment; the kit's scripts make
   only their own GitHub calls and refuse every other.
5. Check the published Release: not a draft, its notes, and every asset against `SHA256SUMS`.

Before the approval, the workflow:
- **plans:** refuses a run that is not on `master`, a sha that is not `master`'s head, a sha without a successful `ci.yml`
  push run, a version that is not `x.y.z`, a CHANGELOG whose newest release is not this version, a release that does not
  move forward from the last published Release, a leftover `release/v<version>` branch, a native run that did not build
  this sha on `master`, by hand, with success, and a missing `native_run` (or one given to a plugin that is not native);
- **builds** `dist/` with `npm ci --ignore-scripts` and `npm run build`, with a read-only token, and writes the release
  files: `dist/`, `package.json` without its lifecycle scripts, and the vetted native manifest;
- **commits** them on a temporary branch `release/v<version>` at the parent, through GitHub's API with the workflow's token,
  so GitHub signs the commit (author `github-actions[bot]`, committer GitHub). This job runs no npm. It refuses a commit
  that GitHub does not verify, or whose parent or tree is not the one the files give;
- **verifies** on a fresh runner: the commit's identity, one parent on `master`, `package.json` exactly the parent's
  without the lifecycle scripts, only regular files in the allowed paths, no `package.json` under `dist/`, and a second,
  independent build of the parent (its own job) equal to the committed `dist/` byte for byte;
- **installs** the release commit with `plugin add` on each stock OpenCode host (2.2.3 to 2.2.6);
- **packs** the commit before installing anything and keeps that tarball, then runs the pack stage against a copy;
- **stages** the Release: verifies the attested native files, writes `SHA256SUMS` and the notes (the version's CHANGELOG
  section), and shows them all in the run summary with the sha256 of `SHA256SUMS`.

A job either runs repository or dependency code (`npm ci`, the build, the pack stage, a host install) and has no write
token, or uses the API and runs only the kit's scripts on a fresh checkout, after checking that the release commit's
`scripts/` and `.github/` are the parent's. The first kind is not token-free: `actions/checkout` fetches with the job's
read-only (`contents: read`) token, and its post step and the artifact uploads run after repository code on the same
runner, so that code could reach a read-only token for this public repository and the runner's artifact token. Jobs
pass files as artifacts downloaded by the id the uploading job gave, and each is checked again on arrival.

After the approval, it downloads the staged artifact by the id the summary names, and refuses unless `SHA256SUMS` has
the sha256 the summary shows and every staged file matches it, and every native file is the one the release commit's
`manifest/native.json` pins, size and sha256, with each gzip holding the pinned executable. Then it checks everything again, creates the annotated tag
`v<version>` on the release commit (tagger `github-actions[bot]`, unsigned), checks the tag, creates the Release with the
notes, the tarball, the native files and `SHA256SUMS`, and deletes `release/v<version>`. The tag keeps the commit.

GitHub's signature and the bot identity show only that GitHub made the commit through its API for the workflow; anyone
with write access can make such a commit. What ties the release to `master` is its content: one parent CI passed, the
exact `package.json`, the allowed paths and the byte-for-byte rebuild. Never relax those because the commit is signed.

**A rejected, expired or failed run** leaves nothing behind: the `cleanup` job deletes `release/v<version>` when it points
at the parent or at that run's commit, and never touches another branch. No tag exists before the approval, so the
version is not burned: fix `master` and start again. If `cleanup` itself failed, the next run refuses until the branch
is deleted: `gh api -X DELETE repos/joe-broadhead/opencode-history/git/refs/heads/release/v<version>`.

**Resume.** If the run fails after creating the tag and before the Release is complete, start it again with the same `sha`. The plan finds the kit's tag on a release commit on that sha with no published Release, and resumes:
it makes no new commit, checks and installs the tagged commit, stages the files, and after a new approval reuses the tag
and adds what the Release lacks. Delete a draft Release a failed upload left first: the publish step refuses a draft.
Any other existing tag is refused: release the next version.

The repository's tag ruleset keeps a `v*` tag from being moved or deleted. A stray `v*` tag, one that never became a
Release, does not block later releases: only published Releases count, and drafts do not. Its version cannot be
released, so release the next one. To remove the tag anyway, an admin disables the `release tags` ruleset, deletes the
tag, and restores the ruleset exactly as it was.

**Known limit: a `v*` tag pushed by hand.** No ruleset limits who creates a `v*` tag, so anyone with write access can
push one by hand, pointing at any commit. Such a tag has no published Release, the forward-only check ignores it, and
Jelly installs only a published Release whose `SHA256SUMS` it verifies. But a user who installs
`github:joe-broadhead/opencode-history#v<x>` directly gets whatever that tag points at. Only the release workflow makes
release tags; never push one by hand.

The release kit is these files, the same in every plugin: `scripts/release-rules.mjs`, `scripts/release-commit.mjs`,
`scripts/release-github.mjs`, `scripts/check-release-shape.mjs`, `scripts/changelog.mjs`, `scripts/release-version.mjs`,
`scripts/release-pack.mjs`, `scripts/publish-release.mjs`, `scripts/attach-native.mjs`, `scripts/native-manifest.mjs`,
`scripts/tested-hosts.mjs`, `scripts/check-release-plugin-add.sh`, `scripts/release-kit.test.mjs` and
`.github/workflows/release.yml`. Do not re-run the older `apply-release-kit.mjs`: it writes back the kit that could
release only `v0.0.0`.

Each release has its own tag, and a Git install does not update by itself. To move to a newer release, remove the old entry with `opencode plugin remove github:joe-broadhead/opencode-history#v<old version>`, then add the new tag with `opencode plugin add github:joe-broadhead/opencode-history#v<version>`.

Or add the plugin to `opencode.json` instead, with the same spec:

```json
{ "plugins": [{ "package": "github:joe-broadhead/opencode-history#v0.0.2" }] }
```
## Commits

Commit messages use `type(scope): summary`. Keep the README, `docs/configuration.md`, `docs/architecture.md`, `SECURITY.md`, this file and `CHANGELOG.md` in step with the code. See [AGENTS.md](AGENTS.md) for the design rules.
