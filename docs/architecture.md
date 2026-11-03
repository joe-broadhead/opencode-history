# Architecture

`@joe-broadhead/opencode-history` reads OpenCode's own database read-only, keeps a SQLite full-text index of its own, and answers the `history_*` tools from that index and the database. It opens no network connection. It writes only its index and, when `history_pin` runs, the current session's instruction entries. The one process it starts is the short-lived child that runs a `history_sql` statement. The only call that leaves the machine is the optional recall answer, a model call made through OpenCode.

Options, limits and errors are in [configuration.md](configuration.md); this page is the design behind them.

## Setup

`src/index.ts` exports `Plugin.define(createPlugin(...))`. `src/host/plugin.ts`:

1. Validates the options (`src/domain/config.ts`, `OPTIONS_INVALID`) and the host version (`src/host/compat.ts`, `HOST_UNTESTED`).
2. Refuses a dangerous `indexPath` before anything opens it (`src/domain/paths.ts`, `INDEX_PATH_REFUSED`).
3. Creates the runtime (`src/runtime.ts`): opens the source, opens or joins the shared index, and starts indexing in the background. Setup does not wait for it.
4. Registers the default permission block (`ctx.agent.transform`), the nine tools, the status RPC, the tools RPC and its `evaluate` hook, two commands and the skill.
5. Follows session events.

A failed registration closes the runtime and rethrows. The cleanup stops the events, the tools RPC and the index. The TUI part, `src/tui.tsx`, is separate (see [Host parts](#host-parts)).

## Source

A `Source` (`src/domain/contract.ts`) lists changed sessions and session IDs, and reads sessions, messages, projects and todos.

- **OpenCode's database** (`src/source/opencode-db.ts`) is the complete source. The plugin API's `ctx.session.context` holds only the messages after the latest compaction, so search over it would miss everything a compaction summarised. The plugin opens `opencode.db` read-only with `query_only`, and reads only `session_v2`, `session_message`, `project` and the optional `todo` table, after checking every column it reads (`REQUIRED_COLUMNS`).
- **The plugin session API** (`src/source/context.ts`) is the partial fallback when that probe fails: only the messages after each compaction, no todos or project names. The probe's reason becomes `fallback`, `SOURCE_UNAVAILABLE` or `SOURCE_SCHEMA_UNKNOWN`; setup logs it and status gives the fix.

A failed read through either source is `SOURCE_UNAVAILABLE`, without the driver's message.

## Index

One SQLite file at `indexPath`, owned by the plugin and rebuildable from the source (`src/index/schema.ts`, `store.ts`).

- **Tables.** `sessions` (metadata, root, first prompt, last reply, outcome, counts), `docs` and `doc_texts` (each searchable text, its metadata apart from its text so joins read small rows), `files`, `links` (subagents), `batches` (the `seq` ranges written), `projects` and `meta`.
- **Full text.** `docs_words` (FTS5, `porter unicode61`) for words, and `docs_sub` (FTS5 `trigram`, `detail=none`) for substring candidates. Without positions `docs_sub` is about a fifth the size of a full trigram index, and search checks each candidate's text.
- **Stable interface.** The views `v_sessions`, `v_docs`, `v_files` and `v_links`, and the two full-text tables, are what `history_sql` documents; the rest may change.
- **Only its own file.** The store checks, with reads only, that the file carries the SQLite `application_id` `0x48495354` or holds no schema, and closes anything else unchanged. Setup has already refused OpenCode's database and its sidecars, OpenCode's data folder, and a custom path inside the project. A new file is created `0600` in a `0700` folder; an existing file keeps its mode.
- **Versions.** A different `meta.schema_version` drops and recreates every table of the file. One open index per file per process lives in a `globalThis` registry (`Symbol.for("opencode-history.index.v1")`), keyed by the resolved path and `INDEX_SCHEMA_VERSION`. Every query first checks the file's schema version and fails with `INDEX_MISMATCH` if another process's plugin version rebuilt it.

## Extraction

`src/extract/index.ts` turns a message into docs, file touches, subagent links and facts. Masks (the built-in patterns, then `mask`) apply before any cut. User text, assistant text, compaction summaries, synthetic text, tool calls (their essentials, with code and commands as written), tool results (head and tail, unless `index.toolResults` is off), reasoning (only with `index.reasoning`) and commands the user ran each become docs of their kind; the title is a doc at `seq` `-1`. File touches come from completed `read`, `edit`, `write`, `grep`, `glob` and `apply_patch` calls.

## Sync

`src/index/sync.ts`:

- **Backfill** on first start, newest sessions first; **catch-up** afterwards, by `time_updated` after a watermark, 200 sessions a page; **reconcile** drops sessions the source no longer lists, never on an empty listing.
- A session is written in batches of 200 messages, each replacing its `seq` range in one transaction, so a rewrite changes nothing and only the newest message is re-read next time. One job per session at a time; a failed session is retried on the next catch-up.
- Session events (`src/host/events.ts`) schedule a session sync 1.5 s after its last event; `session.deleted` deletes at once. A dropped stream resubscribes with backoff.
- **Freshness.** `lagSeconds` counts from the start of the last finished catch-up, backfill or event sync. Search, sessions and recall start a catch-up and wait at most 200 ms for it.

## Query

`src/query/` answers each tool. Every number input is clamped to `BOUNDS` (`src/domain/bounds.ts`), and the filters (`filters.ts`) are one SQL condition shared by every tool, relative to the caller's session, project and directory.

- **Search** (`search.ts`, `parse.ts`) quotes every term before FTS5. `words` ranks with `bm25` and adds near matches, texts with only some words, when full matches leave the page short; joined words such as `2.2.3` are checked whole against the text. `substring` and `regex` take candidates from the trigrams, read the newest 20,000 in batches of 500, yielding to the event loop between batches, for at most 5 s. Docs are weighted by kind, grouped by session tree, boosted for more phrasings, the caller's project and directory and, with `recency`, newer matches; runs of the same thing in one directory fold into one result with a `similar` count. An empty result counts what the default filters hid.
- **Read** (`read.ts`, `render.ts`) reads a window from the source, masks, then cuts; with `kinds` an empty window widens to the nearest matching messages. **Brief** is answered from the index, with todos from the source.
- **Recall** (`recall.ts`) searches, reads a window around each excerpt, and with `synthesize` asks the host's model to answer only from that evidence.
- **SQL** (`sql.ts`) accepts one `SELECT` or `WITH`, after a scanner strips comments outside strings. `node:sqlite` has no progress handler or interrupt, so the statement runs in a child process: OpenCode's own executable as Bun (`BUN_BE_BUN=1`), or Node in the tests, with the job on stdin and rows as JSON on stdout, on a read-only `query_only` connection. The child is killed after 10 s (`SQL_TIMEOUT`), on cancellation, or past 4 MB of output; rows stop at the limit and 512 KB. Two run at once. A failure names the kind of mistake, never SQLite's message.

## Host parts

`src/host/` connects the runtime to OpenCode.

- **Tools** (`tools.ts`, `schemas.ts`, `format.ts`). Zod input and output schemas (the output matching `src/domain/api.ts`), and text that ends with the next call to make. `runTool` asserts `history_<name>` on `*` as the caller's session and agent, then runs the tool; results over 1 MiB fail with `OUTPUT_LIMIT`. Search, brief and read are pinned; `history_pin` has `codemode: false`.
- **Permissions** (`permissions.ts`). The default block goes right after each agent's base `* * allow`: `history_*` asks, the eight reads allow. An agent counts as guarded when the block appears anywhere after its base allow; status names the others.
- **Pin** (`actions.ts`). Builds the pin text from a brief or a read, checks OpenCode's 256 KiB entry limit and cancellation, then puts or removes the instruction entry.
- **RPC** (`src/rpc.ts`, `rpc-handlers.ts`, `scripting.ts`). `history.sessions` has one method, `status`, in plain JSON Schema so the TUI carries no zod. `history.sessions.tools` serves every tool but the actions for scripts, in the pattern of the Google Workspace plugin: each method takes `{ sessionID, input }`, resolves the session and its agent (`SESSION_UNKNOWN`, `SESSION_AGENT_REQUIRED`), and runs `runTool` as them, so a deny is `PERMISSION_DENIED`. Script asserts carry a mark, and the `evaluate` hook turns an `ask` on a marked `history_*` call into a deny, so no prompt waits.
- **Status** (`status.ts`). One view for the tool, the command, the RPC and the dialog, in the shared rows: Connection, Account, Access, the History rows, Tools, Agents without default rules, OpenCode, and one Next step. The tool gives the unguarded agents as a count.
- **Commands** (`commands.ts`), **skill** (`skills.ts`; a bad file is skipped with `SKILLS_INVALID`) and **recall answers** (`plugin.ts`, the one use of `ctx.experimental.generate.text`; no model is `RECALL_MODEL_UNAVAILABLE`).
- **Errors** (`src/domain/common.ts`, `errors.ts`). Every failure is a `HistoryError` with a code and one next step. Anything unexpected becomes `OPERATION_FAILED` or the operation's fallback, with one server-log line naming the operation, error class, SQLite code and throwing functions, never the message. Host errors pass through unchanged.
- **TUI dialog** (`src/tui.tsx`). One global keymap layer: **History: Status** in the palette and as `/history`, and `r` to refresh while open. It renders the `status` RPC as the `/history-status` text, listens for `server.connected`, `agent.updated`, `session.created`, `session.deleted` and `session.idle` only while open, and changes nothing.

## OpenCode facts relied on

- `ctx.app.version` is the OpenCode release. OpenCode's database is `$XDG_DATA_HOME/opencode/opencode.db` or `~/.local/share/opencode/opencode.db`, with the tables in [configuration.md](configuration.md#source); `time_updated` advances on every change, and a session's earlier messages do not change once later ones exist.
- `ctx.session.context` returns only the messages after the latest compaction; `ctx.session.instructions.entry` stores per-session entries of at most 256 KiB that survive compaction.
- `ctx.tool.transform` is replayed on every rebuild. A deny on a tool's `permission` hides it; an `ask` takes effect only through `ctx.permission.assert`. `ctx.permission.hook("evaluate")` sees every evaluation and may change its effect.
- `ctx.agent.transform` edits agents defined before plugins run; config-only agents are created later and miss it.
- OpenCode's runtime is Bun, provides `node:sqlite` with FTS5 and `trigram`, and its executable acts as Bun with `BUN_BE_BUN=1`.
- The TUI loads the `./tui` export, and offers `keymap.layer`, `ui.dialog`, `data.on` and `client.rpc`.

## Build and checks

`scripts/build.mjs` bundles `dist/index.js` and `dist/tui.js` with esbuild, each self-contained, with host modules external, zod in the server part only, and the version written in from `package.json`. `NOTICE` must match what is inlined. Unit tests cover each module with a synthetic database; host tests run the plugin on an embedded `@opencode/sdk` host as 2.2.3 and 2.2.4; the TUI test mounts the built dialog; the lint scans source and `dist/` for forbidden APIs; the pack test installs the tarball and loads it on stock OpenCode 2.2.3 and 2.2.4. [CONTRIBUTING.md](../CONTRIBUTING.md) has the commands.
