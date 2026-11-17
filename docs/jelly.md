# In Jelly

[Jelly](https://heyjelly.ai) runs OpenCode agents. It reads the `jelly` section of this
package's `package.json` as JSON, without loading the plugin, when a person reviews the exact
version, and uses it as follows.

Jelly names the plugin **History** (`jelly.title`), with the package name and version beneath. Under
that name it shows the one line in `jelly.summary`, and beside it the mark in `jelly.icon`
(`assets/icon.svg`, shipped in the package): Jelly reads that file once, when it records the
plugin, and keeps it only if it is a clean SVG of drawing elements, with no script, style, link
or outside reference. A Jelly whose declaration schema lacks `summary` or `icon` refuses this
declaration, because that schema accepts no unknown keys.

## Tools and permissions

9 tools are declared (8 read-only). Jelly's agents have no base "allow everything"
rule, so this plugin's own default rules, which it puts after that rule, never reach them. Jelly
writes each declared `ask` or `deny` as that tool's default instead (the person's own choice
replaces it), and denies a read-only helper every tool not marked `readOnly`. A declared `allow`
changes nothing in Jelly.

- Ask: none. Every declared tool is allowed, as the plugin's own default rules allow it at `access: "all"`.
- Off: none.

The declared tools are search, brief, read, sessions, files, recall, SQL and events_list, which only read the history index and
OpenCode's database, and `history.pin`, which pins a past session's brief or messages into the current session's
instructions. To make `pin` ask in Jelly too, set `access: "ask-changes"` in the plugin options; `"read-only"` denies
it there.

Keep `jelly.tools` in step with the plugin's tools and default rules; `test/**/jelly.test.ts`
checks each declared tool and effect against them.

Jelly's shared rules for every plugin of the family, word for word:

<!-- family-block:start -->
- At Allowed (`all`), the default, every tool runs without asking, declared or not, whatever its `effect`.
- At Ask before changes (`ask-changes`), a `readOnly` tool runs, and every other tool asks first, including a tool this plugin does not declare.
- At Read only (`read-only`), a `readOnly` tool runs, and every other tool is off, including a tool this plugin does not declare.
- A declared `effect` of `allow` changes nothing: the tool follows the access choice and its `readOnly`.
- A declared `effect` of `ask` makes the tool ask at Ask before changes, even when it is `readOnly`, and changes nothing at Allowed or Read only.
- A declared `effect` of `deny` turns the tool off at Ask before changes and at Read only, and changes nothing at Allowed.
- An action listed in `asks` asks first at Ask before changes and at Read only, and never at Allowed.
- A tool named with one `*`, such as another account's `plaud-*.get_file`, follows the same rules as a tool named in full.
- A choice the person makes for one tool wins over the access choice and the declared `effect`.
- jelly leaves out a key it does not know at the top level of the `jelly` block, and reads the rest.
- jelly refuses the plugin for a key it does not know inside anything it reads, such as a tool, a sign-in or a setting.
- jelly refuses the plugin, with one plain line, when `requires` names a field or a feature it does not read.
<!-- family-block:end -->

## Skills

Declared: `history-recall`. Jelly refuses an install whose skill ids collide with another
plugin's or the agent's own.

## Views

None.

## Signing in

None. History reads the OpenCode history on the machine it runs on and has no account, so it
declares no sign-ins.

## Versions

Jelly's curated catalogue pins an exact version. Publish each release under a new version, so
that a review in Jelly can tell two releases apart.

The declaration test runs the shared kit, `test/support/jelly-kit.ts`, which checks the declaration and this page against Jelly's plugin authors' standard. `scripts/check-copies.mjs` holds the kit equal to the copy every plugin carries. The events contract and the tools RPC come from the source contract package, `@we-the-rebel-alliance/source-contract` `v0.1.0`, pinned in `package-lock.json` and bundled; its `probe` is a tools RPC method, not a tool, so the declaration does not list it.
