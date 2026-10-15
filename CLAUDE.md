# conductor-mod

Claude Code mod: live pane for orchestrated sessions (plan % + ETA, orchestrator + tiered workers,
workflow phases, local servers, context alarm, gate/architect/log). Spec + plan live in rea-lab:
`docs/superpowers/specs/2026-10-14-conductor-design.md`, `docs/superpowers/plans/2026-10-14-conductor.md`.

## Develop
- The plugin and its slash command are `conductor-mod` (install id `conductor-mod@conductor-mod`). The folder (`~/Projects/conductor`) and the display name "Conductor" keep the short name. The name appears as the `plugin` literal in every atom, the key in `types/index.d.ts` `PluginState`, the pane id (also the `ui.render` `requestId`), the command and `tests/fixtures.ts`; rename them together.
- `claude --plugin-dir ~/Projects/conductor` — load it; edits under hooks/ hot-reload at end of turn.
- `claude plugin validate .` · `claude plugin test .` · `npx -p typescript tsc -p .` (after first load writes .claude-plugin/types/) · `npx @biomejs/biome check .`

## Architecture
- `hooks/model/` pure reducers (no `$`), one test file each in `tests/`. `servers.ts` is the servers reducer: a background server-looking Bash call starts one, a task notice or a stop call ends it, a `localhost:<port>` in a later command or URL counts a use (a port the session did not start is `seen`; one server is one row, so a probe before its start joins the live row); `mayAffectServers` pre-checks every tool call so only a background Bash call, a stop, a job-id call or a call naming this machine reaches the reducer; adopting the first local port the session uses for a live server whose command named none is inferred; a command is a server when any part of a `&&`/`;`/`|` chain is; the port is read from that part only (not a `curl localhost:8000 &&` before it, not a `NAME=value` URL): its flag or `PORT=`, else `http.server N`, else a bare `host:port`, else none, and then adoption applies; it keeps only the redacted command (60 cells), ports and job ids. Job ids and the stop tools are inferred, not observed.
- `hooks/model/tiers.ts` and `progress.ts` carry two rules the views follow. ⚠: any Agent call without an explicit `model` is flagged (`isFlagged`): `inherited` (it runs the parent's model), `definition-unpassed` (its agent definition chose another; the softer `⚠ no model · from definition`) and `likely-inherited` (call not linked, parent's model); an unlinked spawn on another model (`definition`) is unknown and not flagged. Progress: tasks, else workflow `agents` (an open run stops at 99% and has no ETA), else `workers`; when `isComplete` the row says `done` and the status line drops the ETA.
- `hooks/store.ts` holds only `SCHEMA_VERSION` and the `DEFAULT_*` values.
- `hooks/register.tsx` is the one hooks module: the atoms (one literal const each, `mainState`, `workersState`, `serversState`, ...), the local `$` helpers (`getX($)`, `say`, `safely`, `resetAll`, `migrate`, `refreshStatus`) and every hook. It is long on purpose (see Engine rules).
- `hooks/view/` one panel per file, drawn from plain data and `els`; nothing there takes `$`. A press handler is built in register.tsx (`expandOnPress`, `gateOnPress`) and handed in as a callback (`PaneProps.onExpand`, `PaneProps.onGate`). Every strip row is budgeted in cells (`fitSegments`, `gateLayout`, `archLine`, `receiptFit`, `serverTail` in `hooks/model/`), so none passes the pane's width.
  - `kit.ts` the shared types (`Els`, `Kit`, `PaneData`) every panel is drawn from.
  - `pane.tsx` composes the panels and picks the layout: mini always inline above the prompt, on any docked pane under 40 columns unless `layout` is hybrid, and everywhere when `layout` is mini (`/conductor-mod layout auto|hybrid|mini`). Mini draws down to 20 columns; hybrid never under 40.
  - `progress.tsx` the progress row and the now/next row.
  - `tree.tsx` the orchestrator box, worker boxes/rows, the expanded worker and the tiers row.
  - `strips.tsx` the plan, workflow, architect and gate rows (the gate's drill-down too).
  - `log.tsx` the receipt line and the session log.
  - `mini.tsx` the 8-row layout: progress, now/next, orchestrator line, up to 3 worker lines, `+n more`, last log line.
  - `servers.tsx` the servers strip (up to 3 rows: port, state, last use, command; `+n more`) and the ` · srv :3300●` text `mini.tsx` puts last on its orchestrator line.
- `hooks/elapsed.tsx` a client module (ported): a running worker's ticking clock, loaded by `tree.tsx` through `els.Client`.

## Engine rules (found by running the code; they decide the layout above)
1. One hooks module per plugin. `hooks/hooks.json` names `["./register.tsx"]` only. A second entry fails `claude plugin validate .` with
   ``modules: hooks.json `modules` names one hooks module per plugin; a second entry is refused``, and the spike's separate probe module (since deleted), called from inside register.tsx, failed with
   `on("session.start") is registered twice without a matcher; the first is at .../hooks/probe.tsx:29`.
2. `$` is never passed across an import. Any function that takes `$` is declared in register.tsx. Otherwise the module fails to load with
   `$ is passed to "safely", imported from "./store": $ is followed only into a function declared in this same file, never across an import`.
3. Atoms are separate top-level consts in register.tsx with string-literal `plugin` and `key`. Not an object of atoms (`S.main`), not `plugin: P`, not imported from another file. Otherwise:
   `the state library's read takes a source the scan can read: a reference whose plugin and key are string literals, or what atom, memberOf or derive (imported from "claude-code") made of one, written there or in a const of this file`.
4. Tests: a test's own hooks cannot read plugin state (`$.state.get refused: its hooks module does not call it`), so hook tests assert through the mounted pane. `$.tool.call(... as never)` hits TS2589; use `callTool` in `tests/fixtures.ts`.

## Rules
- Observe-only. Every number from a session event; estimates labelled `est` / `(inferred)`.
- Redact tool inputs before storing. Check drawings at 40/60/80/120 columns.
