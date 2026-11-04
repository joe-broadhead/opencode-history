# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.2] - 2026-11-04

### Added

- Jelly shows the plugin's one-line summary ("Search, read and recall your past OpenCode sessions.") and its icon, a neutral clock with a back arrow (`assets/icon.svg`, now in the package). A Jelly release that does not know these two fields refuses the declaration, so this version needs a Jelly that accepts them.

## [0.0.1] - 2026-11-04

### Added

- OpenCode 2.2.5 is a tested host, next to 2.2.3 and 2.2.4.
- Status shows the index file's size, as `Index file: <path> (511 MB)` and `indexBytes`, and the README says how large the index grows and how to make it smaller.
- A mask pattern you add now applies at once to everything the tools return, `history_sql` included, not only to text indexed after it. Status shows a `Masks:` row and asks for `/history-reindex rebuild` until the index file is rewritten with the new patterns.
- README sections on updating the plugin, and on what to run after installing it.

### Changed

- The status RPC (`history.sessions` `status`) uses the field names every plugin's status RPC shares:
  - `connection` is now `state`, in machine words: `ready` (was `connected`), `connecting` and `failed`. The old `host untested` is gone: an untested host no longer changes the state, and shows in `host.tested` instead. The `/history-status` rows keep their words.
  - `next` is now `nextStep`, always present, and `Nothing to do.` when nothing is needed.
  - `host` is now `{ version, range, tested }`; it was `{ required, found, availability, next }`. `tested` is true only for 2.2.3, 2.2.4 and 2.2.5.
- An OpenCode release inside `>=2.2.3 <2.3.0` that is not tested, such as 2.2.6, works as before, but status now says it is untested: `host.tested` is `false` and its OpenCode row reads `2.2.6 (untested; supported range >=2.2.3 <2.3.0)`. Before, every release in the range was called tested.
- The tools RPC words a bad envelope as every plugin's tools RPC does, such as `"extra" is not allowed`, `"sessionID" must be a non-empty string`, `"input" is missing` and `describe takes no input`, instead of zod's messages. A call without `input` is now refused; before, it ran with `{}`.
- `SESSION_UNKNOWN` and `SESSION_AGENT_REQUIRED` have the next step every plugin uses: create a session that names an agent and pass its id.
- The Uninstall steps run in the same order as every plugin's: pins first, while the plugin can still remove them, then the plugin, its index, and copied rules.
- The scripting docs say that `opencode api` runs in the service's default location, your home directory, and how to target a project, and that it exits with status 1 on an RPC error.

### Fixed

- A `history_sql` statement no longer keeps running after OpenCode stops. Before, a statement that never ended went on using a CPU core after OpenCode crashed or was killed. Now its process stops by itself at the 10-second limit, and as soon as OpenCode exits, crashes or reloads the plugin.
- `QUERY_INVALID` now gives a next step that fits its cause. A short substring, a bad date or an empty path no longer gets advice about regular expressions.
- `/history-reindex` with an unknown argument answers in the usual error format: `INPUT_INVALID: /history-reindex takes no argument or rebuild. Next step: …`.
- `/history-reindex rebuild` now overwrites the text it drops and empties the write-ahead log, so text that only a newer mask pattern covers no longer stays in the index file's free space.
- `history_pin` keeps the whole pin within `maxChars`. Before, its header line came on top, so `maxChars: 500` pinned about 730 characters.

## [0.0.0] - 2026-11-03

### Added

- Nine tools under `history_<name>`: `search`, `brief`, `read`, `sessions`, `files`, `recall`, `sql`, `pin` and `status`. Every tool but `pin` is in Code Mode as `tools.history.<name>`, with search, brief and read pinned.
- A local SQLite full-text index of every OpenCode session, built from OpenCode's own database opened read-only, kept fresh from session events, with a partial fallback to the plugin session API.
- Search in three modes (stemmed words, exact substrings, regular expressions), with several phrasings per search, near matches, folded repeats, filters by scope, time, kind, tool, agent and path, and excerpts with a `seq` to read from.
- `history_recall`, which quotes evidence from the best sessions and can ask a model to answer from it; `history_sql`, one read-only statement over stable views, run in a child process with a 10-second limit; `history_pin`, which keeps a past session's brief or messages in the current session's instructions.
- Default permission rules after each agent's base allow: the reads are allowed, and `history_pin` and any unknown `history_*` tool ask. Status names agents without the rules.
- An index that changes only its own file, and refuses OpenCode's database and data folder, a path inside the project, and any other existing file.
- Built-in masks for common credentials, and a `mask` option, applied before text is indexed or shown.
- `/history-status`, `/history-reindex`, the `history_status` tool, and a status dialog in the terminal UI: `/history`, or **History: Status** in the command palette.
- A tools RPC for scripts, `history.sessions.tools`: every tool but `history_pin` as a method, run as a named session and its agent under their permission rules, with no model.
- The `history-recall` skill, and a Jelly declaration in `package.json`.
- A startup check for OpenCode `>=2.2.3 <2.3.0`, with `allowUntestedHost` to override it.
