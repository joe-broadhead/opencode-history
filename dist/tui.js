// src/tui.tsx
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createSignal, For, Show } from "solid-js";

// src/domain/contract.ts
var PLUGIN_ID = "history.sessions";

// src/host/format.ts
var lines = (...groups) => groups.flatMap((group) => group === void 0 || group === false ? [] : typeof group === "string" ? [group] : group).join("\n");
var SOURCE_TEXT = { "opencode-db": "OpenCode database", context: "plugin session API (partial)" };
var NOTHING_TO_DO = "Nothing to do.";
var MISMATCH_ROW = "Index schema:";
function blockLines(rules) {
  return rules.length ? ["[", ...rules.map((rule, at) => `  ${JSON.stringify(rule)}${at < rules.length - 1 ? "," : ""}`), "]"] : [];
}
var AGENTS_ROW = "Agents without default rules:";
function agentsRow(view) {
  const names = view.unguardedAgents;
  if (names.length === 0) return [`${AGENTS_ROW} none`];
  return [`${AGENTS_ROW} ${names.join(", ")}`, ...blockLines(view.permissionsBlock ?? []).map((line) => `  ${line}`)];
}
var ACCOUNT_TEXT = "none; History needs no sign-in";
var ACCESS_TEXT = {
  all: "reads OpenCode's database read-only and writes only its own index; every tool runs, so history_pin changes this session's instructions without asking",
  "ask-changes": "reads OpenCode's database read-only and writes only its own index; history_pin asks before it changes a session",
  "read-only": "reads OpenCode's database read-only and writes only its own index; history_pin is denied, so it never changes a session"
};
var FALLBACK_TEXT = { SOURCE_UNAVAILABLE: "OpenCode's database could not be read", SOURCE_SCHEMA_UNKNOWN: "OpenCode's database has an unknown layout" };
var CONNECTION_WORDS = { ready: "connected", connecting: "connecting", failed: "failed" };
var MASKS_ROW = "Masks:";
function size(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
function hostText({ host, version }) {
  const note = host.tested ? "tested" : `untested; supported range ${host.range}`;
  return `${host.version ?? "unknown version"} (${note}). History ${version}`;
}
function toolsText({ tools, access }) {
  const posture = access === "all" ? "new tools run too" : access === "read-only" ? "they are denied" : "they ask first";
  const unknown = tools.unknown.length ? `, ${tools.unknown.length} unknown (${posture}): ${tools.unknown.join(", ")}` : "";
  return `${tools.visible} available${unknown}`;
}
function formatStatus(view) {
  const { index, mismatch } = view;
  return lines(
    "History status",
    `Connection: ${CONNECTION_WORDS[view.state]}`,
    `Account: ${ACCOUNT_TEXT}`,
    `Access: ${ACCESS_TEXT[view.access]}`,
    `Index: ${index.ready ? "ready" : "building"}, ${index.sessionsIndexed} of ${index.sessionsTotal} sessions${index.lagSeconds ? `, ${Math.round(index.lagSeconds)} s behind` : ""}`,
    `Source: ${SOURCE_TEXT[index.source]}${index.complete ? "" : ", incomplete"}${view.fallback ? ` (${FALLBACK_TEXT[view.fallback]})` : ""}`,
    `Database: ${view.database}`,
    `Index file: ${view.indexPath}${view.indexBytes === null ? "" : ` (${size(view.indexBytes)})`}`,
    view.masksChanged ? `${MASKS_ROW} changed since text was indexed, so the index file holds that text masked the old way until /history-reindex rebuild` : void 0,
    mismatch ? `${MISMATCH_ROW} ${mismatch.file === null ? "none" : `version ${mismatch.file}`} in the file, but this build uses version ${mismatch.build}, so every query fails (INDEX_MISMATCH)` : void 0,
    `Default scope: ${view.defaultScope}`,
    `Skill: ${view.shadowedSkills.length ? view.shadowedSkills.map((skill) => `${skill.id} is hidden by ${skill.path}`).join("; ") : "history-recall"}`,
    `Tools: ${toolsText(view)}`,
    agentsRow(view),
    `OpenCode: ${hostText(view)}`,
    `Next step: ${view.nextStep}`
  );
}

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var string = { type: "string" };
var integer = { type: "integer" };
var number = { type: "number" };
var boolean = { type: "boolean" };
var choice = (values) => ({ type: "string", enum: values });
var list = (items) => ({ type: "array", items });
var nullable = (schema) => ({ type: [schema.type, "null"] });
var object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
var INDEX = object(
  { ready: boolean, sessionsIndexed: integer, sessionsTotal: integer, lagSeconds: number, source: choice(["opencode-db", "context"]), complete: boolean },
  ["ready", "sessionsIndexed", "sessionsTotal", "lagSeconds", "source", "complete"]
);
var STATUS_OUTPUT = object({
  version: string,
  access: choice(["all", "ask-changes", "read-only"]),
  host: object({ version: nullable(string), range: string, tested: boolean }, ["version", "range", "tested"]),
  state: choice(["ready", "connecting", "failed"]),
  index: INDEX,
  fallback: choice(["SOURCE_UNAVAILABLE", "SOURCE_SCHEMA_UNKNOWN"]),
  tools: object({ visible: integer, unknown: list(string) }, ["visible", "unknown"]),
  database: string,
  indexPath: string,
  indexBytes: nullable(integer),
  masksChanged: boolean,
  defaultScope: choice(["project", "directory", "all"]),
  shadowedSkills: list(object({ id: string, path: string }, ["id", "path"])),
  unguardedAgents: list(string),
  permissionsBlock: list(object({ action: string, resource: string, effect: choice(["allow", "deny", "ask"]) }, ["action", "resource", "effect"])),
  mismatch: object({ file: nullable(string), build: string }, ["file", "build"]),
  nextStep: string
}, ["version", "access", "host", "state", "index", "tools", "database", "indexPath", "indexBytes", "masksChanged", "defaultScope", "shadowedSkills", "unguardedAgents", "nextStep"]);
var errors = { failed: object({ code: string, next: string }, ["code", "next"]) };
var History = Rpc.define({
  id: PLUGIN_ID,
  methods: {
    status: { input: object({}, []), output: STATUS_OUTPUT, errors }
  },
  events: {}
});

// src/tui.tsx
var UNAVAILABLE = "STATUS_UNAVAILABLE: The History server part did not answer. Next step: Restart OpenCode.";
var UNEXPECTED = "STATUS_UNAVAILABLE: The History server answered with an unexpected status. Next step: Restart OpenCode.";
function statusLines(view) {
  try {
    return formatStatus(view).split("\n");
  } catch {
    throw new Error(UNEXPECTED);
  }
}
var EVENTS = ["server.connected", "agent.updated", "session.created", "session.deleted", "session.idle"];
var tui_default = {
  id: "history.sessions.tui",
  setup(context) {
    const [state, setState] = createSignal({
      loading: true
    });
    const [open, setOpen] = createSignal(false);
    let closed = false, generation = 0, controller;
    const refresh = async () => {
      if (closed) return;
      const current = ++generation;
      controller?.abort();
      const request = controller = new AbortController();
      setState((previous) => ({
        ...previous,
        loading: true
      }));
      try {
        const view = await context.client.rpc(History).status({}, {
          location: context.location ?? context.data.location.default(),
          signal: request.signal
        });
        if (closed || current !== generation) return;
        setState({
          lines: statusLines(view),
          loading: false
        });
      } catch (error) {
        if (!closed && current === generation) setState((previous) => ({
          ...previous,
          loading: false,
          error: error instanceof Error && error.message ? error.message : UNAVAILABLE
        }));
      }
    };
    const View = () => {
      const theme = context.theme;
      return (() => {
        var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$4 = _$createElement("text");
        _$insertNode(_el$, _el$2);
        _$insertNode(_el$, _el$4);
        _$setProp(_el$, "flexDirection", "column");
        _$setProp(_el$, "paddingLeft", 2);
        _$setProp(_el$, "paddingRight", 2);
        _$setProp(_el$, "paddingBottom", 1);
        _$setProp(_el$, "gap", 1);
        _$insert(_el$2, () => `${state().lines?.[0] ?? "History status"}${state().loading ? " \xB7 refreshing" : ""}`);
        _$insert(_el$, _$createComponent(Show, {
          get when() {
            return state().lines;
          },
          get fallback() {
            return (() => {
              var _el$6 = _$createElement("text");
              _$insert(_el$6, (() => {
                var _c$ = _$memo(() => !!state().loading);
                return () => _c$() ? "Loading status\u2026" : `${state().error}`;
              })());
              _$effect((_$p) => _$setProp(_el$6, "fg", theme.text.muted, _$p));
              return _el$6;
            })();
          },
          children: (lines2) => (() => {
            var _el$7 = _$createElement("scrollbox"), _el$8 = _$createElement("box");
            _$insertNode(_el$7, _el$8);
            _$setProp(_el$7, "maxHeight", 28);
            _$setProp(_el$8, "flexDirection", "column");
            _$insert(_el$8, _$createComponent(For, {
              get each() {
                return lines2().slice(1);
              },
              children: (line) => (() => {
                var _el$9 = _$createElement("text");
                _$insert(_el$9, line);
                _$effect((_$p) => _$setProp(_el$9, "fg", line.startsWith(MISMATCH_ROW) ? theme.text.feedback.error.base : line.startsWith("Next step:") && !line.endsWith(NOTHING_TO_DO) ? theme.text.feedback.warning.base : theme.text.base, _$p));
                return _el$9;
              })()
            }));
            return _el$7;
          })()
        }), _el$4);
        _$insert(_el$, _$createComponent(Show, {
          get when() {
            return _$memo(() => !!state().lines)() && state().error;
          },
          get children() {
            var _el$3 = _$createElement("text");
            _$insert(_el$3, () => `Refresh failed: ${state().error}`);
            _$effect((_$p) => _$setProp(_el$3, "fg", theme.text.feedback.error.base, _$p));
            return _el$3;
          }
        }), _el$4);
        _$insertNode(_el$4, _$createTextNode(`r refresh \xB7 esc close`));
        _$setProp(_el$4, "onMouseUp", () => void refresh());
        _$effect((_p$) => {
          var _v$ = theme.text.base, _v$2 = theme.text.muted;
          _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "fg", _v$, _p$.e));
          _v$2 !== _p$.t && (_p$.t = _$setProp(_el$4, "fg", _v$2, _p$.t));
          return _p$;
        }, {
          e: void 0,
          t: void 0
        });
        return _el$;
      })();
    };
    let stops = [];
    const unsubscribe = () => {
      for (const stop of stops.splice(0)) stop();
    };
    const show = () => {
      if (closed) return;
      setOpen(true);
      unsubscribe();
      stops = EVENTS.map((type) => context.data.on(type, () => void refresh()));
      context.ui.dialog.show(() => _$createComponent(View, {}), () => {
        unsubscribe();
        setOpen(false);
      });
      context.ui.dialog.set({
        size: "large"
      });
      void refresh();
    };
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "history.status",
        title: "History: Status",
        group: "History",
        palette: true,
        slash: {
          name: "history"
        },
        run: show
      }, {
        id: "history.refresh",
        title: "Refresh History status",
        group: "History",
        bind: "r",
        enabled: () => open(),
        run: () => void refresh()
      }]
    }));
    return () => {
      closed = true;
      generation++;
      controller?.abort();
      unsubscribe();
      if (open()) context.ui.dialog.clear();
    };
  }
};
export {
  tui_default as default
};
