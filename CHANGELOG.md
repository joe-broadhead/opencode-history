# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A `history_sql` statement no longer keeps running after OpenCode stops. Before, a statement that never ended went on using a CPU core after OpenCode crashed or was killed. Now its process stops by itself at the 10-second limit, and as soon as OpenCode exits, crashes or reloads the plugin.
- `QUERY_INVALID` now gives a next step that fits its cause. A short substring, a bad date or an empty path no longer gets advice about regular expressions.
- `/history-reindex` with an unknown argument answers in the usual error format: `INPUT_INVALID: /history-reindex takes no argument or rebuild. Next step: …`.

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
