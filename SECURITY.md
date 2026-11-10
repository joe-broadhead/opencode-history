# Security

## Supported versions

Fixes go into the newest release. Use the latest release from GitHub (`github:joe-broadhead/opencode-history#v<version>`) on OpenCode `>=2.2.3 <2.3.0`.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: on this repository, open **Security → Report a vulnerability**. Do not open a public issue. Include the plugin version, the OpenCode version and the steps to reproduce. Never include session text, prompts, tool output, file paths, API keys or a copy of your OpenCode database or index.

## Data handling

When OpenCode loads it, the plugin:

- opens OpenCode's database read-only and reads its sessions, messages, projects and todos;
- copies text from them into its own index file, and keeps it in step as sessions change;
- registers nine `history_*` tools, two commands, the status RPC, the tools RPC for scripts and one skill;
- in the terminal UI, adds one status dialog, `/history`, which only reads the `status` RPC method;
- inserts its default permission block after each agent's base `* * allow` (see [Permissions](#permissions)).

### What is read

The plugin API does not give a plugin a session's full message history, only the messages after its latest compaction. So the plugin reads OpenCode's database directly: `opencode.db` under `$XDG_DATA_HOME/opencode` (`~/.local/share/opencode` when unset), or the `database` option. It opens the file with SQLite's read-only flag and `query_only`, and reads only the `session_v2`, `session_message`, `project` and `todo` tables. It never writes that database, and it reads no other OpenCode file, credentials included.

When the database cannot be read, the plugin reads sessions through the plugin session API instead, which has only the messages after each session's latest compaction.

All sessions are read, from every project, including archived and subagent sessions. The tools' filters decide what a call returns, not what is indexed.

### Where the index lives

The index is `$XDG_DATA_HOME/opencode-history/index.db`, or `~/.local/share/opencode-history/index.db`, or the `indexPath` option, with SQLite's `-wal` and `-shm` files beside it. It holds a copy of your history: titles, prompts, replies, tool calls, tool output (unless `index.toolResults` is off), shell commands you ran in a session and their output (the output unless `index.toolResults` is off), compaction summaries, reasoning (only when `index.reasoning` is on), file paths, directories, agents, models and costs.

- A missing index folder is created with mode `0700`. An existing folder keeps its mode.
- A new index file is created with mode `0600` before SQLite opens it, so SQLite gives the `-wal` and `-shm` files the same mode. The plugin never changes the mode of a file it did not create.
- The plugin changes only its own index: a file marked with its SQLite application id, or a new, empty one. It refuses OpenCode's database and data folder, an `indexPath` inside the project, and any other existing file, and leaves them untouched (`INDEX_PATH_REFUSED`). Project configs are held to the same rules, so a cloned repository cannot point the index at another database or into the repository.
- The index is a cache. Deleting the three files removes it; the plugin builds it again on the next start. `opencode plugin remove` does not delete it.

### Masking

Built-in patterns for common credential formats, on unless `maskDefaults` is `false`, and your own `mask` patterns replace every match with `[masked]` before text is written to the index, and in what `history_read`, `history_brief` and `history_recall` read from OpenCode's database when they are called. [docs/configuration.md](docs/configuration.md#masking) lists the patterns and exactly what they cover. They leave ordinary code such as `password: string` alone, so a credential in a shape they do not know is not masked unless a `mask` pattern covers it.

Masking does not cover directory and project paths, agent, model and tool names, or IDs. It does not change OpenCode's database, which keeps the original text; OpenCode's own session views still show it. Text indexed before you add a pattern stays in the index file until you run `/history-reindex rebuild`, and status says so. Until then, every tool, `history_sql` included, masks what it returns with the current patterns, except that a search excerpt cut through a match can show part of it. A rebuild overwrites the dropped pages with zeros and empties the write-ahead log, so the old text does not stay in the file's free space.

Masking is a safety net for known formats, such as API key prefixes. It is not a guarantee that no secret reaches the index or the model.

### Where data goes

- **To your model provider:** tool descriptions, and every tool result the agent reads: excerpts, briefs, messages, query results and pins. Pinned text is sent with every request of the session that holds it.
- **To whatever calls `history_events_list`:** each changed session's title, first prompt and last reply, masked and cut to 4,096 characters, with the project folder's last segment and the agent's name. The result names this machine's OS user and host name as the source's owner and account. Memory's collector calls it to copy these events to your private memory space, after you turn History on as a source; the plugin itself sends them nowhere.
- **Into OpenCode's database, through OpenCode:** pins, as instruction entries on the current session, and the text `/history-status` and `/history-reindex` post into a session. OpenCode stores them like any other session data.
- **Over the network:** nothing from the plugin itself. It opens no connection. The one process it starts is the short-lived child that runs a `history_sql` statement, OpenCode's own executable, on the local index.
- **To the server log:** warnings with a code and no input or history text: `HOST_UNTESTED`, `SKILLS_INVALID`, `EVENTS_UNAVAILABLE`, and `SOURCE_UNAVAILABLE` or `SOURCE_SCHEMA_UNKNOWN` when the plugin falls back to the plugin session API. When a call fails unexpectedly and reports only a code, such as `OPERATION_FAILED`, one line with that code, the operation, the error's class, SQLite's result code and the names of the functions it was thrown from; never the error's message, which can repeat a query or text.

Tool errors, status and command text never contain your input, session text or SQLite's own messages, which can repeat a query.

## Permissions

- **Scope is not access control.** `scope` chooses what is relevant. Any agent that has the tools can read any indexed session in any project: `scope: "all"` searches everything, `history_read`, `history_brief` and `history_pin` accept any session ID, and `history_sql` always covers every project. To keep an agent, or every agent, out of your history, deny the tools for it, for example `{ "action": "history_*", "resource": "*", "effect": "deny" }`. A deny hides them.
- **Every tool is allowed by default.** The plugin inserts a block after each agent's base `* * allow` that allows every tool it registers and the `history_*` namespace, so an agent reads any indexed session and runs `history_pin` without asking. **`history_pin` changes the current session's instructions:** it pins a past session's brief, or a range of its messages, into every request from then on, through compaction, until it is removed. A tool a later version adds runs too. Every tool asserts its action on each call, so your own `ask` rules prompt.
- **Restrict it with `access`.** `"ask-changes"` makes `history_pin` and a new tool ask, and `"read-only"` denies them while the reads still run. Per-tool rules work as before, a deny hides the tool, and a later rule wins. Agents without a base allow get no rules. Agents defined only in your config miss the block; at `"all"` nothing is held back, and at a restricting value `/history-status` names them with the fix.
- **History is data, not instructions.** Past sessions contain web pages, tool output and text other people wrote, and any of it can carry instructions. Tool descriptions, the `history-recall` skill and every pin say so, but an agent can still be misled. Treat session text as a record, and check it against the current code before acting on it.
- **Pins persist.** A pin stays in the session's instructions, and is sent with every request, until it is removed with `history_pin` and `"action": "remove"`. Uninstalling the plugin does not remove pins.
- **SQL is read-only and bounded.** `history_sql` accepts one `SELECT` or `WITH` statement, runs it as a subquery on a separate read-only connection to the index with `query_only`, and never touches OpenCode's database. It runs in a child process that stops after 10 seconds, so a recursive or expensive statement cannot freeze OpenCode, and its rows stop at the limit and 512 KB. The child enforces the deadline and these caps itself, and exits as soon as OpenCode does, even when OpenCode is killed, so it never runs on alone. It can read any table of the index, which holds no history text the views do not; the views and full-text tables are the stable interface, not a boundary.

## Scripts

The tools RPC (`history.sessions.tools`, see [docs/scripting.md](https://github.com/joe-broadhead/opencode-history/blob/HEAD/docs/scripting.md)) runs the plugin's tools for a script, with no model. It adds no authority:

- A script names a session that names an agent, and runs as them. Every call asserts the tool's action against that agent's rules and the session's own, so a deny that hides a tool from the model refuses the method too.
- An ask on a script's call is denied, not prompted: no one is there to answer it. The one permission hook the plugin registers does only this, for its own marked script calls.
- `history_pin` is never a method, so a script cannot change a session.
- The RPC is reachable only by callers of the OpenCode server API, who already hold the server's full authority. The session is not a login: it scopes a script to what its agent may do.
