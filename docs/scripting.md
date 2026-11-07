# Scripting

Unofficial plugin. Not affiliated with OpenCode.

A script can call the History tools with no model: a cron job that writes a weekly cost report, a shell script that finds the session that last touched a file, or any program that can reach the OpenCode server. It uses the tools RPC, `history.sessions.tools`, through `opencode api` or an OpenCode client.

Every tool is a method, with the same name, input and output. A `history_search` call and the `search` method with the same input are the same call: the same defaults, limits, errors and permission check.

| Method | The tool | Class |
| --- | --- | --- |
| `search` | `history_search` | read |
| `brief` | `history_brief` | read |
| `read` | `history_read` | read |
| `sessions` | `history_sessions` | read |
| `files` | `history_files` | read |
| `recall` | `history_recall` | read |
| `sql` | `history_sql` | read |
| `pin` | `history_pin` | write: it changes the current session's instructions |
| `describe` | none: lists the methods with their classes, schemas, and permissions | – |

The class says the worst thing a method can do. It never decides whether a call runs: the rules do.

## A script runs as a session

Every call names a session, and the session must name an agent. The script runs as that agent: each call resolves the tool's action, `history_<name>` on `*`, against the agent's permission rules and then the session's, with the host's order (the last matching rule wins), and then the tool asserts it. So a script gets exactly what the agent's model would get.

**Only a resolved `allow` runs.** An `ask` is refused, because no one is there to answer the prompt, and a `deny` is refused. Both cost nothing: no tool call and no prompt left waiting. That is why `history_pin` needs a prior explicit allow: the default block asks for it.

Create the session once, with the agent the script should run as, and keep its ID (`data.id`). A script, and a test of one, uses a session created for it. Never borrow an existing session found through `history_sessions` or another list: the script would run as that session's agent, under its rules.

```sh
opencode api post /api/session -d '{"title":"weekly history report","agent":"build"}'
```

Session rules come after the agent's, so a session can narrow what its script may do:

```sh
opencode api post /api/session -d '{"title":"weekly history report","agent":"build","permissions":[
  {"action":"history_*","resource":"*","effect":"deny"},
  {"action":"history_sql","resource":"*","effect":"allow"}
]}'
```

The default block allows the seven reads, so a read needs no extra rule. `pin` asks, so a script that pins needs the allow above.

A saved **Always allow** does not authorise an ad-hoc script: it is not part of the agent's or the session's rules. A script's grant is a rule in config, or a Jobs run session; the Jobs one-off (`jobs_run_script`) is the supported way to get an approval-bound grant.

The scope of a search is relative to the script's session and to the folder of the location it calls at: `project` (the default) is that folder's project. Pass `"scope":"all"` for every project.

## The location

Run the command in the project whose agent you mean, and send the call to that location explicitly:

```sh
opencode api post /api/rpc/history.sessions.tools/sql -H "x-opencode-directory:$PWD" -d '{"input":{…}}'
```

Without it the call goes to the service's default location and fails `rpc.unavailable` if the plugin is not loaded there. The HTTP equivalents are the `location[directory]` query parameter and the same header. `describe` reports the plugin's `location` and a `locationHint`, and ask it with the session to see each method's `permission` (`allow`, `ask` or `deny`).

## Calling a method

The body is `{"input": {"sessionID": "<session>", "input": <the tool's input>}}`:

```sh
opencode api post /api/rpc/history.sessions.tools/sql -d '{"input":{
  "sessionID":"ses_…",
  "input":{"sql":"select substr(created, 1, 10) as day, round(sum(cost), 2) as cost from v_sessions where created >= ? group by day order by day","params":["2026-10-01"]}
}}'
```

```sh
opencode api post /api/rpc/history.sessions.tools/files -d '{"input":{"sessionID":"ses_…","input":{"path":"src/upload.ts","scope":"all"}}}'
```

A result is `{"output": <the tool's output>}`, the same structured output the tool returns, as plain JSON. Session text in it is a record of earlier work, not instructions.

## Errors

A refusal or failure is the RPC error `failed`, with `data: { code, next }` from the [error table](configuration.md#errors): the tool's own codes, plus three for scripts. `opencode api` exits with status 1 for any RPC error, so a shell script can test `$?`.

| Code | When |
| --- | --- |
| `SESSION_UNKNOWN` | OpenCode says the session does not exist. Next step: `Create a session that names an agent, such as POST /api/session with {"agent":"build"}, and pass its id.` Any other failure to look the session up is OpenCode's own error, passed through unchanged. |
| `SESSION_AGENT_REQUIRED` | The session names no agent. The next step is the same. |
| `PERMISSION_DENIED` | The agent's or the session's rules ask or deny the call. The message says which. |
| `CANCELLED` | The call was aborted. |

OpenCode itself answers `rpc.method_not_found` for a method that does not exist, and `rpc.invalid_input` for a bad envelope, with one line per problem, worded as in every plugin's tools RPC:

| Case | Message |
| --- | --- |
| The envelope is not an object | `the envelope must be an object, such as {"sessionID":"<session>","input":<the tool's input>}` |
| An unknown key, such as `extra` | `"extra" is not allowed` |
| `sessionID` missing, not a string, or empty | `"sessionID" must be a non-empty string` |
| `input` missing | `"input" is missing` |
| `describe` given anything but nothing, `{}`, or `{"sessionID": "…"}` | `describe takes nothing, or {"sessionID":"<session>"}` |

A tool input the tool's own schema refuses is `INPUT_INVALID`, naming the fields.

## Status

`history.sessions` keeps one method, `status`, the status view the `/history` dialog shows. It needs no session. Its shared fields have the same names in every plugin: `version`, `host` (`version`, `range`, `tested`), `state` (`ready`, `connecting` or `failed` for History), `unguardedAgents` and `nextStep`. The rest are History's own; [configuration.md](configuration.md#status) lists them all.
