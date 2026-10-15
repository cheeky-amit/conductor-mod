# Conductor

A Claude Code mod: a live pane for orchestrated sessions. One main session dispatches tier-assigned
subagents and Workflow runs and tracks the work as a task list. Conductor shows how that is going.
It only watches session events: no network, no files, no processes, no model calls, and every event
passes through unchanged.

## What it shows

| Row | Source |
|---|---|
| Progress | % done, bar, ETA and average task time, from the task list (TaskCreate / TaskUpdate), else workflow agents, else workers done/total. Once everything counted is done the row says `done` |
| Orchestrator box | main model and tier, context % (amber and red thresholds), `▶` now and `→` next |
| Worker boxes | one per subagent, coloured by tier: task, status, output tokens, steps, time bar. Any Agent call without an explicit `model` is flagged `⚠`: `⚠ inherited` when the worker runs the parent's model, the softer `⚠ no model · from definition` when its agent definition chose one. Flagged workers count in `N⚠` on the status line |
| Tiers strip | tokens per tier, with an estimated $ labelled `est` |
| Plan strip | one glyph per task: `▲` done, `◆` in progress, `◇` pending |
| Workflow strip | workflow name and phases from the script's `meta`, with agent counts |
| Servers strip | local servers this session started in the background (port, live / stopped / failed, last use, command), plus `○ in use` for a localhost port it used but did not start. From background Bash calls, task notices, stop calls and `localhost:<port>` in later commands and URLs. Events only, no `lsof` |
| Architect strip | architect or advisor consults on a mini timeline |
| Gate strip | one cell per permission check, totals and denials |
| Log | spawns, completions, edits, errors, denials, and the turn receipt |

## Install

```
claude plugin marketplace add ~/Projects/conductor
claude plugin install conductor-mod@conductor-mod
/reload-plugins
/conductor-mod
```

Or add the marketplace from GitHub instead of the folder:

```
claude plugin marketplace add cheeky-amit/conductor-mod
```

## Commands and keys

- `/conductor-mod open | close | reset | layout auto|hybrid|mini`
- In the hybrid layout, focus the pane with `ctrl+x tab`. Then `1`-`8` expand a worker, and `f` / `s` / `o` open the gate's file / shell / other permission checks. The mini layout has no keys.

## Configure

Set these under `pluginConfigs["conductor-mod"].options`, or with `/config`.

| Key | Default | What it does |
|---|---|---|
| `tiers` | `T0=haiku,T1=sonnet,T2=opus,T3=fable\|mythos` | Comma-separated TIER=regex (case-insensitive) mapping models to T0-T3 |
| `prices` | `fable\|mythos=10/50/0.25,opus=4/20/0.2,sonnet=2/10/0.2,haiku=1/5/0.1` | Comma-separated regex=input/output/cacheRead in $ per 1M tokens, for estimates only |
| `contextAmber` | `70` | Context gauge turns amber at this percent |
| `contextRed` | `80` | Context gauge turns red and says 'checkpoint now' at this percent |
| `panels` | `progress,crew,plan,workflow,servers,architect,gate,log` | Comma-separated, in order: progress, crew, plan, workflow, servers, architect, gate, log. A panel left out is hidden |
| `layout` | `auto` | auto: mini inline above the prompt or under 40 columns, hybrid otherwise. hybrid: hybrid on every docked pane (inline above the prompt is always mini, 8 rows). mini: mini everywhere |
| `maxBoxes` | `3` | Worker boxes side by side before they fold into rows (1-6) |
| `architectPattern` | `advisor\|architect` | Case-insensitive regex for agent types and server tools that count as the architect |
| `architectLabel` | `ARCHITECT` | Name shown for the architect |
| `gateLabel` | `GATE` | Name shown for the permission strip |
| `palette` | `theme` | theme follows your Claude Code theme; pastel is fixed colours for dark terminals |
| `openOnStart` | `true` | Open the pane when a session starts |
| `statusLine` | `true` | Show progress, ETA, context, running workers, flags and live servers in the status line |

## What is inferred

Everything else is read from an event. These are guesses, and the pane labels them.

- `likely-inherited`: a worker whose model equals its parent's, when its Agent call could not be linked to the spawn. Flagged `⚠`. An unlinked spawn on another model is not flagged: whether a model was passed is unknown.
- `est` $: tokens times your `prices` table. Not a bill.
- ETA: mean duration of finished tasks times the tasks remaining. `—` until one task finishes.
- Architect moments (`before a plan`, `before done`, `error repeats`): guessed from the edits and error streak so far in the turn.
- Workflow progress: with no task list, the agents seen so far, so the total grows as they appear. It stops at 99% with `ETA —` until the run ends.
- Workflow phase attribution: workflow agents report no phase, so per-phase counts show only when an event carries one. Otherwise the strip lists the script's phases without state.
- Servers:
  - Job id shape: the `ID: <token>` in a background Bash result (4 to 32 letters, digits, `_`, `-`).
  - Stop tools: `KillShell`, `KillBash` and `TaskStop`, taking the job id as `bash_id`, `shell_id`, `task_id` or `id`.
  - Notice matching: a task notice ends the live server whose job id it names, as stopped or failed by its status or wording.
  - Port: the server's own flag, `PORT=` or `http.server N` (or a bare `host:port`, as in `php -S localhost:8000`), read from the part of a chained command that is the server. Another command in the chain (`curl localhost:8000 && npm run dev`) or a `NAME=value` URL does not set it.
  - Port adoption: with exactly one live server started without a port, the first local port the session then uses is taken to be its own.

## Credits

Flightdeck by Stephen Casella (MIT) is the reference. Conductor's gate, architect, receipt and log
logic is ported from it, marked "Ported from Flightdeck v0.4.0" in each file. See [NOTICE](NOTICE).
Conductor is MIT, see [LICENSE](LICENSE).
