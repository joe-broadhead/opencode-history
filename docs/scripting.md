# Scripting

Unofficial plugin. Not affiliated with OpenCode.

A script can call the History tools with no model: a cron job that writes a weekly cost report, a shell script that finds the session that last touched a file, or any program that can reach the OpenCode server. It uses the tools RPC, `history.sessions.tools`, through `opencode api` or an OpenCode client.

Each method is a tool with the same name, input and output: every tool except `history_pin`. A `history_search` call and the `search` method with the same input are the same call: the same defaults, limits, errors and permission check.

| Method | The tool |
| --- | --- |
| `search` | `history_search` |
| `brief` | `history_brief` |
| `read` | `history_read` |
| `sessions` | `history_sessions` |
| `files` | `history_files` |
| `recall` | `history_recall` |
| `sql` | `history_sql` |
| `status` | `history_status` |
| `describe` | none: lists the methods, their permission actions, and their input and output as JSON Schema |

`history_pin` is not a method. It changes a session's instructions, so a script can read history but never pin it.

## A script runs as a session

Every call names a session, and the session must name an agent. The script runs as that agent: each call asserts the tool's action, `history_<name>` on `*`, against the agent's permission rules and the session's own. So a script gets exactly what the agent's model would get, and a deny that hides a tool from the model refuses the method too.

Create the session once, with the agent the script should run as, and keep its ID:

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

No one answers a prompt for a script, so an `ask` on a script's call is denied with `PERMISSION_DENIED` instead of waiting. A script needs an allow rule, or the default block, for what it does. The default block allows every method.

The scope of a search is relative to the script's session and to the folder of the location it calls at: `project` (the default) is that folder's project. Pass `"scope":"all"` for every project.

`opencode api` calls run in the service's default location, your home directory, not the directory you run it in. To target a project, call the HTTP API with `?location[directory]=<dir>`, or create the session with `"location":{"directory":"<dir>"}`.

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
| `PERMISSION_DENIED` | The agent's or the session's rules deny the call, or ask for an approval. |

OpenCode itself answers `rpc.method_not_found` for a method that does not exist, such as `pin`, and `rpc.invalid_input` for a bad envelope, with one line per problem, worded as in every plugin's tools RPC:

| Case | Message |
| --- | --- |
| The envelope is not an object | `the envelope must be an object, such as {"sessionID":"<session>","input":<the tool's input>}` |
| An unknown key, such as `extra` | `"extra" is not allowed` |
| `sessionID` missing, not a string, or empty | `"sessionID" must be a non-empty string` |
| `input` missing | `"input" is missing` |
| `describe` given anything but nothing or `{}` | `describe takes no input` |

A tool input the tool's own schema refuses is `INPUT_INVALID`, naming the fields.

## Status

`history.sessions` keeps one method, `status`, the status view the `/history` dialog shows. It needs no session. Its shared fields have the same names in every plugin: `version`, `host` (`version`, `range`, `tested`), `state` (`ready`, `connecting` or `failed` for History), `unguardedAgents` and `nextStep`. The rest are History's own; [configuration.md](configuration.md#status) lists them all.
