# Configuration

Plugin ID: `history.sessions`. Options live on the `plugins` entry in `opencode.json`. An invalid option fails setup with `OPTIONS_INVALID` and names every offending key. Values are not echoed.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "@joe-broadhead/opencode-history",
    "options": {
      "database": "<absolute path>",
      "indexPath": "<absolute path>",
      "defaultScope": "project",
      "index": { "reasoning": false, "toolResults": true, "maxDocChars": 8000 },
      "mask": ["<regular expression>"],
      "maskDefaults": true,
      "allowUntestedHost": false
    }
  }]
}
```

Every key is optional. There is no permission option. Permissions are OpenCode rules, described [below](#permissions).

## Options

| Key | Type | Default | Rule |
| --- | --- | --- | --- |
| `database` | absolute path | `$XDG_DATA_HOME/opencode/opencode.db`, or `~/.local/share/opencode/opencode.db` | OpenCode's database. Opened read-only. When it cannot be read, the plugin uses the partial [fallback source](#source). |
| `indexPath` | absolute path | `$XDG_DATA_HOME/opencode-history/index.db`, or `~/.local/share/opencode-history/index.db` | The plugin's own index. A missing folder is created with mode `0700`, and a file the plugin creates gets mode `0600`. See [Where the index may live](#where-the-index-may-live). |
| `defaultScope` | `project`, `directory` or `all` | `project` | The scope of search, sessions, files and recall when a call names none. |
| `index.reasoning` | boolean | `false` | Index model reasoning text. |
| `index.toolResults` | boolean | `true` | Index tool output, and the output of shell commands you run in a session, as its first 2,000 and last 1,000 characters. Output of the `read` tool is never indexed. |
| `index.maxDocChars` | integer, 500–100,000 | `8000` | Longest single text the index keeps. Longer text is cut. |
| `mask` | array of at most 64 regular expressions, each 1–1,024 characters | `[]` | Every match is replaced with `[masked]`, in addition to the built-in patterns. See [Masking](#masking). |
| `maskDefaults` | boolean | `true` | Mask common credential formats with the [built-in patterns](#built-in-patterns). `false` leaves only your `mask` patterns. |
| `allowUntestedHost` | boolean | `false` | When `true`, an untested OpenCode version loads, with a warning. See [Host check](#host-check). |

Unknown keys are rejected. A relative path is rejected. `XDG_DATA_HOME` is used only when it is an absolute path.

The plugin reads its options once, at setup. The `index` options, `mask` and `maskDefaults` change how text is stored from then on; text already in the index keeps the old form until `/history-reindex rebuild`. Masking also applies on the way out: every tool, `history_sql` included, masks what it returns with the current patterns, so a pattern you add takes effect at once. Until the rebuild, the index file itself still holds that text, and a search excerpt that the index cut through a match can show part of it, so status shows a `Masks:` row and asks for the rebuild.

### Where the index may live

The index holds a copy of every session, and the plugin rebuilds it by dropping its tables, so `indexPath` is checked before anything opens it. Setup fails with `INDEX_PATH_REFUSED`, and the file is left as it was, when `indexPath`:

- names OpenCode's database (the `database` option or its default), or its `-wal`, `-shm` or `-journal` file;
- is inside OpenCode's data folder, `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`;
- is set and inside the project's directory or its root folder, unless that folder is your home folder or `/`;
- names an existing file that is not a History index. The plugin marks its index with a SQLite application id (`0x48495354`) and changes only a file that carries it or a new, empty one.

A project's own `opencode.json` can re-declare the plugin with options, and the plugin cannot tell those options from yours. The rules above apply to every source, so a cloned repository cannot point the index at another database or make it write your history into the repository. Set `indexPath` in your user config, not in a project's.

Several plugin instances in one OpenCode process that name the same index file share one index. The first instance's source and index options serve all of them.

### Masking

Masking applies the built-in patterns, unless `maskDefaults` is `false`, then your `mask` patterns, in that order. Each `mask` entry is a JavaScript regular expression source, compiled with the `g` flag and no other, so matching is case-sensitive. Write `[Ss]ecret` to match both cases. A pattern that does not compile fails setup. A named group `keep` stays in the text and the rest of the match becomes `[masked]`: `(?<keep>PIN=)\d+` turns `PIN=1234` into `PIN=[masked]`.

#### Built-in patterns

| Matches | Example of what is masked |
| --- | --- |
| Private key blocks | `-----BEGIN … PRIVATE KEY-----` to `-----END … PRIVATE KEY-----` |
| API keys and tokens by their published prefixes | `sk-` (OpenAI, Anthropic and others), `xai-`, `gsk_`, `tvly-`, `lin_api_`, `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`, `glpat-`, `npm_`, `hf_`, `xoxb-`, `xoxp-` and the other `xox` tokens (Slack), `sk_live_`, `rk_test_` and the like (Stripe), `AIza` (Google), `AKIA` and `ASIA` (AWS access key IDs), each followed by the key's characters |
| JSON Web Tokens | `eyJ….eyJ….…` |
| Header credentials | the token after `Bearer`, and the credential after `Authorization: Basic`, `Token` or `Digest`; the header stays |
| Settings | the value after a name ending in `password`, `passwd`, `secret`, `token`, `api_key`, `apikey` or `access_key`, ignoring case: `DB_PASSWORD=hunter2`, `?token=abc`, `--password=x`, and quoted values such as `"apiKey": "abc"` or `password = 'x'`; the name stays |

They are written to leave ordinary code alone, such as `password: string`, `max_tokens=1000` or `const token = await getToken()`, so a key shape they do not know is not covered. Add your own formats with `mask`.

Masking happens before text is cut, so a cut cannot leave half a secret that no longer matches. It covers:

- everything the index stores from a message: user text and attached file names, assistant text, reasoning, tool calls, tool output, shell commands you ran and their output, synthetic messages and compaction summaries;
- the first prompt, the last reply, file paths and subagent descriptions kept for each session;
- session titles;
- what `history_read`, `history_brief` (its todos) and `history_recall` read from OpenCode's database at call time.

It does not cover directory and project paths, agent, model and tool names, IDs, or a session's outcome (`succeeded`, `failed` or `interrupted`). `history_sql` returns index text, masked when it was stored and again, with the current patterns, before its cells are cut.

## Host check

`package.json` states the supported range, `"opencode": { "host": ">=2.2.3 <2.3.0" }`. The checks run on the tested releases 2.2.3, 2.2.4 and 2.2.5. Setup compares `ctx.app.version` with both.

| Version | Result |
| --- | --- |
| 2.2.3, 2.2.4, 2.2.5 | Tested. Loads. |
| 2.2.6, 2.2.10 | Inside the range, untested. Loads normally, with a `HOST_UNTESTED` warning in the server log. Status works as usual: `host.tested` is `false` and the OpenCode row says untested, but the state and the next step are not changed by it. |
| 2.2.2, 2.3.0, 3.0.0 | Outside the range. Refused, unless `allowUntestedHost` is `true`. |
| Prerelease, dev build, `unknown` | Outside the range. Refused, unless `allowUntestedHost` is `true`. |

Do not write the range as `^2.2.3`. That would accept 2.3.

The refusal text is: `HOST_UNTESTED: History supports OpenCode >=2.2.3 <2.3.0, found <version>. Next step: Use OpenCode 2.2.3, 2.2.4 or 2.2.5, or another release inside >=2.2.3 <2.3.0, or set the plugin option allowUntestedHost: true to run anyway.`

With `allowUntestedHost: true`, a version outside the range loads too and works normally, with the same warning; its next step says to use a tested release if something fails. History has no status-only mode, so its state is never `host_untested`.

## Source

The index is built from one of two sources, chosen at setup.

| Source | When | What it has |
| --- | --- | --- |
| OpenCode database (`opencode-db`) | `database` opens read-only and has every table and column below. | Every session and every message, projects and todos. Complete. |
| Plugin session API (`context`) | Otherwise. | Sessions from `ctx.session.list`, and for each one only the messages after its latest compaction, from `ctx.session.context`. No todos, no project names. Message `seq`s are positions, so they change after a compaction. Never complete. |

When setup falls back, it writes one warning to the server log, and status gives the same reason and fix as its next step:

- `SOURCE_SCHEMA_UNKNOWN` when the database has some of the tables below but not every table and column: a layout this plugin version does not know. Update the plugin, or use a tested OpenCode release.
- `SOURCE_UNAVAILABLE` otherwise: the file cannot be opened, or it has none of the tables, so it is not OpenCode's database. Point `database` at OpenCode's `opencode.db`, then restart OpenCode.

A read from the source that fails later, for example in `history_read` or `/history-reindex`, is `SOURCE_UNAVAILABLE` too.

The database must have these tables and columns, as in OpenCode 2.2:

| Table | Columns |
| --- | --- |
| `session_v2` | `id`, `project_id`, `parent_id`, `directory`, `title`, `agent`, `model`, `cost`, `tokens_input`, `tokens_output`, `time_created`, `time_updated`, `time_archived` |
| `session_message` | `id`, `session_id`, `type`, `seq`, `time_created`, `time_updated`, `data` |
| `project` | `id`, `worktree`, `name` |
| `todo` (optional) | `session_id`, `content`, `status`, `position` |

The plugin reads no other table. The database is opened with SQLite's read-only flag and `query_only`, with a 5-second busy timeout.

## Tools

Effective name `history_<name>`. `options.permission` is that name, so a deny with resource `*` hides the tool. Pinned: `history_search`, `history_brief`, `history_read`. Every tool except `history_pin` is in Code Mode as `tools.history.<name>`.

| Tool | What it does | Effect |
| --- | --- | --- |
| `history_search` | Ranks sessions for one or more phrasings, with excerpts. | Reads the index. |
| `history_brief` | Summarises one session. | Reads the index, and the session's todos from the source. |
| `history_read` | Reads a window of one session's messages. | Reads the source. |
| `history_sessions` | Lists sessions without a query. | Reads the index. |
| `history_files` | Lists the sessions that touched a file or folder. | Reads the index. |
| `history_recall` | Searches, then quotes message windows around the best excerpts. | Reads the index and the source. |
| `history_sql` | Runs one read-only `SELECT` or `WITH` statement over the index views and full-text tables. | Reads the index, on its own read-only connection in a child process, for at most 10 seconds. |
| `history_pin` | Puts, removes or lists pins in the current session's instructions. | Writes the current session's instruction entries. Not in Code Mode. |

OpenCode checks tool input against each tool's schema before the call, and a result against its output schema after it. The text of a search, sessions, files, brief, read or recall result ends with the call to make next. The defaults and ranges below are the ones the schemas declare, and the query layer clamps to the same ones (`BOUNDS` in `src/domain/bounds.ts`).

`history_search`, `history_sessions` and `history_recall` first catch the index up with OpenCode's database: they index the sessions changed since the last pass, waiting for that at most about 200 ms, then answer. A longer catch-up finishes in the background. The other tools answer from the index as it is.

### Filters

`history_search`, `history_sessions`, `history_files` and `history_recall` take the same filters.

| Filter | Default | Meaning |
| --- | --- | --- |
| `scope` | the `defaultScope` option | `project`: sessions of the caller's project. `directory`: sessions started in the caller's directory or below it. `all`: every project. `session`: only the current session, for example to recover what was said before a compaction. |
| `since`, `until` | unset | An ISO date or date-time, or an age: `h`, `d`, `w`, `m` (30 days) or `y` (365 days), such as `36h` or `2m`. A bare date is a UTC day, and as `until` it covers the whole day; for a local day, pass a date-time with its offset, such as `2026-11-03T00:00+01:00`. Search and recall compare the time of each text, files the time of each touch, and sessions keep a session that was active in the window. |
| `kinds` | all indexed kinds | `title`, `user`, `assistant`, `summary` (compaction summaries), `reasoning`, `synthetic`, `tool_call`, `tool_result`. Sessions keeps sessions with such a text. Files takes no `kinds`. |
| `tool` | unset | Only calls and output of this tool, such as `bash`. `shell` also covers the commands you ran yourself. Files reads it as the tool that touched the file. Case-insensitive. |
| `agent` | unset | Only sessions run by this agent. Case-insensitive. |
| `path` | unset | Only sessions whose tree touched a matching file. A relative path matches the end of a recorded path on segment boundaries, so `src/auth.ts` finds that file in any checkout. An absolute path matches that file or anything under that folder. `..` is resolved against the caller's directory. `*`, `?` and `[` make a glob that matches whole recorded paths. |
| `sessionID` | unset | Only this session. It replaces `scope`. |
| `includeSubagents` | `false` | Also count subagent sessions. Search folds their text into the root session's result, and the excerpt names the subagent session. |
| `includeCurrent` | `false` | Also include the current session and its subagents. |
| `includeArchived` | `false` | Also include archived sessions. |

Scope is relative to the caller: the session that made the call, a script's session included, and the project and directory where the plugin runs.

Scope is a relevance filter, not access control. `history_read`, `history_brief` and `history_pin` take any indexed session ID, and `history_sql` sees every project.

### Search

| Input | Default | Rule |
| --- | --- | --- |
| `query` | required | One phrasing, or an array of one to six. Each is 1–512 characters. Duplicates are dropped. Sessions that match more phrasings rank higher. |
| `match` | `words` | `words`, `substring` or `regex`. |
| `recency` | `true` | Rank newer sessions a little higher. |
| `limit` | `10` | Sessions, 1–50. |
| `snippets` | `3` | Excerpts per session, 0–10. |
| `cursor` | unset | The `next` value of a previous result, for the next page of the same search. |

`words` matches stemmed words (SQLite FTS5, `porter unicode61`) and reads this syntax:

| Syntax | Meaning |
| --- | --- |
| `upload timeout` | Both words, in any order. Upper-case `AND` is ignored. |
| `"exact phrase"` | The words in that order. |
| `-flaky`, `NOT flaky` | No text with this term. `--flag` and a lone `-` are not exclusions. |
| `migrat*` | Prefix. |
| `redis OR memcached`, `redis \| memcached` | Either neighbour. |

A word whose letters and digits are joined by other characters with no space, such as `2.2.3`, `v1.4.0`, `192.0.2.10`, `foo.bar.baz` or `x-ray`, matches only as itself, ignoring case: not `2 2 3`, `2, 2, 3` or other text with the same parts, and not inside a longer word joined by `.` or `_`, such as `10.2.2.3`, `2.2.3.4` or `my_foo.bar.baz`. It still matches next to other punctuation, as in `opencode@2.2.3` or `2.2.3-beta`. A text with only some of a phrasing's terms is a near match, as below, and `-2.2.3` excludes only texts with the word itself.

`substring` matches exact text, ignoring case, with the same syntax; each term needs at least three characters. `regex` takes a JavaScript regular expression; a bare pattern ignores case, and `/pattern/flags` sets the flags.

Both read texts and check them: they ask the trigram index for the texts that contain every three-character piece of a term, or of the longest run of plain characters that every match of a regular expression must contain, then read the newest 20,000 of those that pass the filters, for at most 5 seconds, 500 at a time, letting OpenCode handle other work between batches. A regular expression with no such run, such as `\d{4}-\d{2}`, reads the newest 20,000 texts that pass the filters.

In words and substring mode, a phrasing with more than one term also finds near matches: texts with some of its terms but not all of them. They are looked for only when the full matches of every phrasing reach fewer sessions than `limit`, so a page that full matches fill has none, and every page with the same `limit` pages over the same list. A near match scores 0.4 of a full match, so it ranks below full matches of the same strength, and a session that only matches nearly has `queriesMatched: 0`. `relaxed: true` means some results on the page are such near matches.

`truncated: true` means a cap left full matches out, so `total` and the order are approximate: a phrasing matched more than 5,000 texts in words mode, or substring or regex mode stopped before it had read every candidate. In words mode a phrasing's near matches come from its 2,000 best texts with some of its terms, by `bm25` and before the filters, so a narrow scope can be left with few of them; in substring mode they are at most 5,000 per phrasing. Neither is looked for when a phrasing's full matches already fill a cap.

A result is one session tree: a top-level session with the matches of its subagents folded in when `includeSubagents` is on. Each has the session summary, `score`, `matches`, `queriesMatched`, `similar` and `snippets`. Sessions in the same directory that are runs of the same thing, such as the runs of one scheduled prompt, are folded into the best of them, and `similar` counts the others. They are the same when their titles are equal, ignoring case and punctuation; when their titles are near-identical, with at least three words in common, not counting words such as `the`, and at least two thirds of all their words, and no number in one title only; or when their first prompts are equal, ignoring case and punctuation, and at least three words long. A session joins the first better one it is the same as, also through a session folded before it. Sessions with no title or prompt in common are never folded, and `total` counts folded results. A snippet has the `seq`, `messageID`, `kind`, `tool`, `time` and `sessionID` of its text, and about 240 characters around the first match, with matches marked `«` `»` and cuts marked `…`. A session gives at most one snippet per message. Titles count towards the score but give no snippet.

When a search finds nothing, `hidden` counts the sessions that the default filters left out, by reason and the input that undoes it: `scope` (`scope: "all"`), `archived` (`includeArchived: true`), `subagents` (`includeSubagents: true`) and `current` (`includeCurrent: true`, the current session and its subagents). A session that several of them leave out counts under each, and shows with all of their inputs; a subagent of the current session, for one, counts under both `subagents` and `current`. The text names the input that shows the most, and both `includeSubagents` and `includeCurrent` when the sessions left out as subagents are no more than those left out as the current session's. `hidden` is `null` when there are results. `history_sessions` and `history_files` count it the same way.

### Read

| Input | Default | Rule |
| --- | --- | --- |
| `sessionID` | required | |
| `at` | the first message | A `seq`, or a message ID. |
| `before` | `2` | Messages before `at`, 0–200. Ignored without `at`. |
| `after` | `10` | Messages after `at`, 0–500. |
| `kinds` | everything but reasoning, which `full: true` shows | Only these kinds of text: every kind but `title`. |
| `full` | `false` | Whole messages: tool output and long inputs uncut, and reasoning shown. |
| `maxChars` | `20000` | Characters of message text, 500–200,000. |

The session must be in the index, but its messages come from the source, so `history_read` shows the full text, masked. Without `full`, each tool call is one line of at most 300 characters, and tool output and long inputs (an edit, written content, a patch, a subagent prompt) keep their first 400 and last 200 characters. A shell command you ran is shown the same way, as `▸ shell: <command>` with its output, and with its state when it did not exit or its exit code when that is not 0. When the window is longer than `maxChars`, the messages before `at` go first, earliest first, so `at` is shown whole whenever it fits on its own, and `previous` points at the last one left out. After that, when the next message would pass `maxChars`, reading stops before it, so the next page starts with it whole; a single message longer than `maxChars` is cut. When every message is before `at`, the last one stands for it. The result gives `previous` and `next` `seq`s for paging, and `truncated`.

With `kinds`, when no message in the window has those kinds, the window widens to the nearest messages that do: up to `before` of them before it and up to `after` after it, reading the session as far as it takes. When that finds none because a count is `0`, as in the `Earlier` and `Later` paging calls, the nearest one the other way is shown too. `widened` is then the window asked for, `{ from, to }`, and the text says it widened. When no message in the session has those kinds, `messages` is empty and the text says so, with a call to read without `kinds`. `widened` is `null` otherwise.

### Brief

`sessionID`, and `children` (default `false`) to cover every subagent session below it. A brief has the session summary with cost, outcome and models; the first prompt (500 characters); the latest 10 compaction summaries; the last reply (1,000 characters); up to 50 files edited, with counts; up to 30 distinct shell commands, from `bash` and `shell` calls and the commands you ran yourself, the most used first and then the most recent; up to 50 subagents; and the session's todos.

### Sessions and files

`history_sessions` takes `title` (text the title contains, at most 256 characters), `sort` (`updated` by default, `created`, `cost` or `messages`, largest first; `cost` is the session's own spend in USD, and a subagent session is its own row), `limit` (1–100, default 20) and `cursor`. When it lists nothing, `hidden` counts the sessions one more input would list, as in [Search](#search).

`history_files` takes `path` (required), `ops` (`read`, `edit`, `write`, `patch`, `search`; default all) and `limit` (paths, 1–100, default 20). Paths are listed most recently touched first, each with up to 20 sessions, their counts per operation, the last touch and the `seq` of the first. `truncated` is `true` when more paths matched than `limit`; the text then asks for the folder that makes the path unique, since a bare name such as `README.md` matches that file in every repository. Touches are recorded from completed `read`, `edit`, `write`, `apply_patch`, `grep` and `glob` calls (`grep` and `glob` as `search` on their folder). When no file matches, `hidden` counts the sessions whose touches one more input would show.

### Recall

| Input | Default | Rule |
| --- | --- | --- |
| `question` | required | 1–2,048 characters. |
| `queries` | from the question | One to six search phrasings. Without them, up to four from the question's key terms (its quoted phrases and its other words, without common words such as "how" and "we"): all of them, at most eight, joined with `OR`, then up to three pairs of neighbouring key terms, the longest first. |
| `sessions` | `5` | Sessions to draw evidence from, 1–10. |
| `maxChars` | `16000` | Characters of evidence, 1,000–100,000. |

Recall searches with the filters, takes up to three excerpts per session, best first across sessions, and quotes the message before and the two after each one from the source. When the source cannot give them, the excerpt itself is the evidence. The plugin makes no model call: the calling agent answers from the evidence.

### SQL

`sql` (at most 16,384 characters), `params` (at most 64 strings, numbers or nulls, for `?` placeholders) and `limit` (rows, 1–200, default 100).

The rule is one read-only `SELECT` or `WITH` statement over the index; anything else is `SQL_REJECTED`. Comments and a trailing semicolon are allowed. It runs in a child process of OpenCode's own runtime, on a fresh read-only connection to the index, with `query_only` and a 2-second busy timeout, wrapped as a subquery with the row limit, so it cannot write. A statement that runs longer than 10 seconds is stopped with `SQL_TIMEOUT`, so a recursive or expensive query cannot freeze OpenCode. The child process stops itself at that deadline, and also as soon as OpenCode exits, crashes or reloads the plugin, so a statement never keeps running without it. Rows stop at the limit and after 512 KB of data, and the result says `truncated`. Cells longer than 2,000 characters are cut, and blobs are shown as `[blob, <n> bytes]`. At most two statements run at once; more wait their turn.

Any table of the index can be read, but only the four views and the two full-text tables below are a stable interface. Query those: the tables behind them can change between versions, and the `history_sql` description names only these.

| View | Columns |
| --- | --- |
| `v_sessions` | `session_id`, `parent_id`, `root_id`, `project_id`, `project`, `directory`, `title`, `agent`, `model`, `cost`, `tokens_input`, `tokens_output`, `created`, `updated`, `archived`, `first_prompt`, `last_reply`, `outcome`, `messages`, `user_messages`, `compactions`, `tool_calls` |
| `v_docs` | `doc_id`, `session_id`, `root_id`, `message_id`, `seq`, `part`, `time`, `kind`, `tool`, `text` |
| `v_files` | `session_id`, `root_id`, `message_id`, `seq`, `time`, `path`, `op`, `tool` |
| `v_links` | `parent_id`, `child_id`, `message_id`, `description`, `agent` |

| Full-text table | Matches |
| --- | --- |
| `docs_words` | Stemmed words (FTS5, `porter unicode61`), as search's `words` mode, with `docs_words match ?`. |
| `docs_sub` | Substrings of three or more characters, with `text like '%substring%'`, which ignores case for ASCII letters. It keeps trigrams without their positions (FTS5, `trigram`, `detail=none`), so `docs_sub match ?` takes single trigrams joined with `AND`, `OR` and `NOT`, such as `"aut" AND "uth"`, and not phrases. |

Both index `v_docs.text`, and their `rowid` is `v_docs.doc_id`, for example `select d.session_id, count(*) from v_docs d join docs_words w on w.rowid = d.doc_id where docs_words match ? group by d.session_id`, or `select session_id from v_docs where doc_id in (select rowid from docs_sub where text like '%auth.ts%')`.

Times are UTC text such as `2026-10-12 09:30:00`. `project` is the project's worktree. `archived` is `0` or `1`. `root_id` is the top-level session of the tree. `tool_calls` counts the model's tool calls, not the shell commands you ran yourself. Title texts are in `v_docs` with `seq` `-1`.

### Pin

| Input | Default | Rule |
| --- | --- | --- |
| `action` | `put` | `put` pins, replacing an earlier pin of that session. `remove` unpins. `list` shows this session's pins. |
| `sessionID` | | The past session. Required for `put` and `remove`. |
| `from`, `to` | the brief | Pin messages `from` to `to`, inclusive, instead of the brief. `to` defaults to `from` and is at most `from + 200`. Only for `put`. |
| `maxChars` | `8000` | Characters of the whole pin, its header line included, 500–50,000. Text past it is cut, and the header says `trimmed`. |

A pin is an OpenCode instruction entry on the current session, keyed `history.<session ID>`. Entry keys are lower-case, so in the key an upper-case letter becomes `-` and the lower-case letter, and `-` becomes `--`. Its text starts by saying it is a record of earlier work, not instructions, and how to unpin it. OpenCode sends it with every request from the next one and keeps it through compaction. A pin larger than 256 KiB as JSON fails with `PIN_TOO_LARGE`.

## Permissions

Each tool's action is its effective name, `history_<name>`, on resource `*`. At setup the plugin inserts this block into every agent, directly after the agent's base `* * allow` rule:

```json
[
  { "action": "history_*", "resource": "*", "effect": "ask" },
  { "action": "history_search", "resource": "*", "effect": "allow" },
  { "action": "history_read", "resource": "*", "effect": "allow" },
  { "action": "history_brief", "resource": "*", "effect": "allow" },
  { "action": "history_sessions", "resource": "*", "effect": "allow" },
  { "action": "history_files", "resource": "*", "effect": "allow" },
  { "action": "history_recall", "resource": "*", "effect": "allow" },
  { "action": "history_sql", "resource": "*", "effect": "allow" }
]
```

| Tool | Default |
|---|---|
| `history_search`, `history_read`, `history_brief`, `history_sessions`, `history_files`, `history_recall`, `history_sql` | allow |
| `history_pin` | ask |
| any other `history_*` tool | ask |

Every tool asserts its action on each call, so an `ask` rule prompts; OpenCode itself only hides a plugin tool on a deny. "Always" allows that tool for the session. An agent without a base allow, such as Explore, gets no rules: there, unlisted tools are already not allowed, and an `ask` would loosen its default deny. Later rules still win, because the last matching rule wins, so your own rules decide. A deny hides the tool, for every agent at the top level or for one agent in its own `permissions`:

```jsonc
{
  "permissions": [
    { "action": "history_sql", "resource": "*", "effect": "deny" },
    { "action": "history_pin", "resource": "*", "effect": "allow" }
  ]
}
```

`history_*` matches every tool. Every rule needs `"resource"`. Without it, OpenCode skips the rule. For a Markdown agent, the same array goes in the `permissions` front matter.

Agents defined only in your config are created after plugins run, so they miss the block. Status names every agent that misses it and would run an unknown `history_*` tool without asking, under **Agents without default rules**, with the block. The next step reads: "Put the default rules shown by /history-status first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for History tools." Do not put it in the top-level `permissions`: top-level rules come after every agent's own, so they would loosen Explore.

## Commands and RPC

| Surface | What it does |
| --- | --- |
| `/history-status` | Posts the status into the session as text. On failure it posts the error, `STATUS_UNAVAILABLE` by default. |
| `/history-reindex` | Catches the index up: indexes the sessions changed since the last pass, then drops sessions OpenCode no longer has. `catch-up` as the argument does the same. Posts `Index caught up: <n> of <total> sessions.` |
| `/history-reindex rebuild` | Waits for running work, drops the index, and indexes everything again. Posts `Index rebuilt: ...` when done. Any other argument posts the usage. |
| `/history` (terminal UI) | Opens the status dialog; **History: Status** in the command palette does the same. It shows the `/history-status` text, read from RPC `status`, and posts nothing into the session. `r` refreshes it, and while it is open it also refreshes on `server.connected`, `agent.updated`, `session.created`, `session.deleted` and `session.idle`. A failed refresh keeps the last status and says why. It changes nothing. |
| RPC `history.sessions` `status` | The status object. |
| RPC `history.sessions.tools` | Every tool but `history_pin`, for scripts, run as a session and its agent, plus `describe`. See [scripting.md](scripting.md). |

The status RPC has the plugin ID, `history.sessions`, and no events. Its contract in `src/rpc.ts` is plain JSON Schema. Both RPCs fail the same way: error `failed`, with the message `CODE: what happened. Next step: What to do.` and data `{ code, next }`. An invalid tool input from a script is `INPUT_INVALID`, naming the fields, never the values.

### Status

| Field | Meaning |
| --- | --- |
| `version` | The plugin version. |
| `host` | `version`, the OpenCode version (`null` when OpenCode gives none); `range`, the supported range `>=2.2.3 <2.3.0`; and `tested`, true only for 2.2.3, 2.2.4 and 2.2.5. |
| `state` | `ready`; `connecting` while the first index builds; `failed` when the history is partial (`fallback`) or every query fails (`mismatch`). The Connection row shows the same states as `connected`, `connecting` and `failed`. An untested host does not change it; see `host.tested`. |
| `index.ready` | The first full pass has finished. Before that, results cover only the sessions indexed so far. |
| `index.sessionsIndexed`, `index.sessionsTotal` | Sessions in the index, and the source's count when it was last listed in full. |
| `index.lagSeconds` | How far the index may be behind OpenCode: seconds since the index was last known to be in step, which is the start of the last finished catch-up, full pass or session sync after a session event. Search, sessions and recall catch up first, so their results usually carry `0`. |
| `index.source` | `opencode-db` or `context`. |
| `index.complete` | Ready, from the database, and with no session waiting to be retried. |
| `fallback` | Present only on the `context` source: `SOURCE_UNAVAILABLE` or `SOURCE_SCHEMA_UNKNOWN`, the reason (above). |
| `tools` | `visible`, the `history_*` tools OpenCode lists, and `unknown`, the names of any this version does not know. |
| `database`, `indexPath`, `defaultScope` | The options in effect. |
| `indexBytes` | The size of the index file with its write-ahead log, in bytes, or `null` when it cannot be read. |
| `shadowedSkills` | Skills with the id `history-recall` that OpenCode loads instead of the plugin's own, such as one in your user skills folder, each as `{ id, path }`; empty when none. The `Skill:` row names them, and the next step says to rename or move them. |
| `masksChanged` | `true` when the mask options changed after text was indexed: results are masked with the current patterns, but the index file holds that text masked the old way until `/history-reindex rebuild`. |
| `unguardedAgents` | The agents that miss the default rules (see [Permissions](#permissions)), by name; empty when none. |
| `permissionsBlock` | Present when `unguardedAgents` is not empty: the block to put first in their own `permissions`. |
| `mismatch` | Present only when the index file's schema is not this build's, after another OpenCode process running another version of the plugin rebuilt it: `file`, its version, or `null` when it has none, and `build`, this build's. Every query then fails with `INDEX_MISMATCH`. |
| `nextStep` | One next step, exactly the Next step row: the first of a host outside the range that runs because of `allowUntestedHost`, an index file at another schema (`INDEX_MISMATCH`), the fallback source (`SOURCE_UNAVAILABLE` or `SOURCE_SCHEMA_UNKNOWN`), a shadowed skill, changed masks, unguarded agents, or an index still building; `Nothing to do.` when nothing is needed. |

`version`, `host`, `state`, `unguardedAgents` and `nextStep` are the fields every plugin's status RPC shares, with these names.

`/history-status` and the `/history` dialog render it as:

```text
History status
Connection: connected
Account: none; History needs no sign-in
Access: reads OpenCode's database read-only and writes only its own index; history_pin asks before it changes a session
Index: ready, 412 of 412 sessions, 35 s behind
Source: OpenCode database
Database: <database>
Index file: <indexPath> (511 MB)
Default scope: project
Skill: history-recall
Tools: 8 available
Agents without default rules: none
OpenCode: 2.2.3 (tested). History <version>
Next step: Nothing to do.
```

On a release inside the range that is not tested, the OpenCode row reads `2.2.6 (untested; supported range >=2.2.3 <2.3.0)`. When the mask options changed after text was indexed, a `Masks:` row follows `Index file:`, and the next step is `/history-reindex rebuild`.

With `mismatch`, a row follows `Index file:`, the connection is `failed`, and the next step is the fix:

```text
Index schema: version 2 in the file, but this build uses version 3, so every query fails (INDEX_MISMATCH)
Next step: Restart every OpenCode process, so they all run one version of the plugin.
```

With unguarded agents, the row lists their names, then the block follows, one rule a line, and the next step says where to put it.

Search, sessions, files, recall and SQL results carry the same `index` object, and their text warns when the index is still building or the source is partial. A model has no status tool: when results look incomplete, it reads that warning, and `/history-status` is for you.

## Bounds

| Limit | Value |
| --- | --- |
| Tool result | 1 MiB of text, and 1 MiB of structured output. Over that is `OUTPUT_LIMIT`. |
| IDs | `^[A-Za-z0-9_-]{1,128}$` |
| Search | 1–6 phrasings of 1–512 characters. 1–50 sessions, 0–10 snippets. 5,000 best texts per phrasing; near matches from the 2,000 best texts with some of its terms in words mode, and at most 5,000 in substring mode. Snippets of about 240 characters. Near matches score 0.4. |
| Substring and regex search | The newest 20,000 candidate texts per phrasing, 5 seconds. |
| Sessions, files | 1–100 results. 20 sessions per path. |
| Read | `before` 0–200, `after` 0–500, `maxChars` 500–200,000. Without `full`: call lines 300 characters, bodies 400 + 200. |
| Brief | 10 summaries, 50 files, 30 commands, 50 subagents. |
| Recall | 1–6 phrasings, 4 from a question (8 key terms), 1–10 sessions, 3 excerpts each, `maxChars` 1,000–100,000. |
| SQL | 16,384 characters, 64 params, 1–200 rows, 512 KB of row data, 2,000 characters a cell, 10 seconds, two at once, 2-second busy timeout. |
| Pin | `maxChars` 500–50,000, 201 messages, 256 KiB as JSON. |
| Index text | `index.maxDocChars` per text (500–100,000, default 8,000). Tool and shell output 2,000 + 1,000. First prompt 500, last reply 1,000. |
| Mask | 64 patterns of 1,024 characters, after the built-in ones. |
| Indexing | 200 messages a batch, 200 sessions a page. A session is synced 1.5 seconds after its last event, at most 6 seconds after its first. Search, sessions and recall wait at most 200 ms for the catch-up they start. |
| Event stream | Resubscribes after 1 second, doubling to 30 seconds. |

A cancelled call stops at once with `CANCELLED`. `history_pin` checks for cancellation just before it changes anything, so a cancelled call never pins or unpins late.

## Errors

A tool failure is `Tool.Error` with `message` set to `CODE: what happened. Next step: What to do.` and `metadata.code` plus `metadata.hint`. Errors from OpenCode itself, such as a schema check, propagate unchanged and have no plugin code. No message contains your input, session text or SQLite's own error text.

When an unexpected error is reported only by a code, `OPERATION_FAILED` or a command's or method's own fallback such as `STATUS_UNAVAILABLE` or `INDEX_FAILED`, the server log gets one warning line: `opencode-history: OPERATION_FAILED in search: Error, SQLite code 1, thrown in prepare < all < scan.` It names the operation, the error's class, SQLite's result code when there is one, and up to three functions it was thrown from, innermost first. It never has the error's message, your input or session text.

| Code | Next step |
| --- | --- |
| `OPTIONS_INVALID` | Fix the named option, then restart OpenCode. Fails setup. |
| `HOST_UNTESTED` | Use OpenCode 2.2.3, 2.2.4 or 2.2.5. Outside `>=2.2.3 <2.3.0` it fails setup unless `allowUntestedHost` is set; inside the range it is a warning. |
| `INDEX_UNAVAILABLE` | The index could not be opened. Check that `indexPath` is a writable file path, then restart. Fails setup. |
| `INDEX_PATH_REFUSED` | `indexPath` names OpenCode's database or a file in its data folder, a file inside the project, or an existing file that is not a History index (see [Where the index may live](#where-the-index-may-live)). The file is not changed. Set `indexPath` to a new file elsewhere, or remove it, then restart. Fails setup. |
| `SKILLS_INVALID` | A skill file is missing or malformed; setup skips it with this warning. Reinstall the plugin. |
| `EVENTS_UNAVAILABLE` | OpenCode's session events stopped. A warning; the plugin subscribes again by itself. Restart if it persists. |
| `SOURCE_SCHEMA_UNKNOWN` | OpenCode's database has a layout this plugin version does not know, so history comes from the plugin session API. A warning at setup, and the status's next step. Update the plugin, or use a tested OpenCode release. |
| `SOURCE_UNAVAILABLE` | OpenCode's session history could not be read: at setup, a warning that history comes from the plugin session API; later, the error of a call that reads from the source, such as `history_read` or `/history-reindex`. Check that `database` points at OpenCode's `opencode.db`, then restart. |
| `STATUS_UNAVAILABLE` | Run `/history-status` again, or check the OpenCode server log. |
| `INDEX_BUSY` | The index is locked by another writer, such as a second OpenCode process using the same `indexPath`. Retry in a moment. |
| `INDEX_FAILED` | `/history-reindex` failed. Run `/history-status`; if it persists, delete the index file and restart. |
| `INDEX_MISMATCH` | Another OpenCode process running another version of the plugin rebuilt the index for its own schema, so this version cannot query it. Restart every OpenCode process so they all run one version. Raised by search, sessions, files, read, brief, recall and SQL, and shown by status as its `Index schema:` row and next step. |
| `SESSION_NOT_FOUND` | No indexed session has that ID. Find it with `history_search` or `history_sessions`. |
| `MESSAGE_NOT_FOUND` | The session has no message at that `seq` or ID. Call `history_read` without `at` to see its range. |
| `CURSOR_INVALID` | Repeat the call without `cursor`. |
| `QUERY_INVALID` | The query, regular expression, date, path or other filter cannot be used; the message says which, and the next step fits it: for example "Use a substring of at least 3 characters, or search with match: \"words\".", or "Use an ISO date such as 2026-10-01 or an age such as 7d." |
| `SQL_REJECTED` | The SQL was not one read-only `SELECT` or `WITH` statement over the index. Rewrite it as one, best over the `v_*` views. |
| `SQL_TIMEOUT` | The statement ran longer than 10 seconds and was stopped. Narrow it: filter by time or session, and bound a recursive `WITH` with a `LIMIT` or a `WHERE` on its counter. |
| `SQL_FAILED` | Check the view and column names. The message names the kind of mistake: an unknown column, table or function, an ambiguous column, a syntax error, or too many params. |
| `PIN_TOO_LARGE` | Pin a shorter range, or set a lower `maxChars`. |
| `OUTPUT_LIMIT` | Narrow the request: a lower `limit`, a smaller `maxChars` or a shorter range. |
| `CANCELLED` | Call again if you still need the result. |
| `CLOSED` | The plugin is shutting down. Retry after OpenCode has reloaded it. |
| `INPUT_INVALID` | Scripts only. Correct the named fields. |
| `PERMISSION_DENIED` | Scripts only. The session's agent, or the session's own rules, deny the tool or ask for approval, which a script cannot answer. Add an allow rule, or call as another session. |
| `SESSION_UNKNOWN` | Scripts only. OpenCode has no session with that ID. |
| `SESSION_AGENT_REQUIRED` | Scripts only. The session names no agent. |
| `CONTRACT_MISMATCH` | A result could not be serialised. Reinstall; report it with the `/history-status` output if it persists. |
| `OPERATION_FAILED` | Anything else. Retry, then run `/history-status`. The server log gets one line for it, see below. |
