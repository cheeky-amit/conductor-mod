// Event wiring only: each hook passes its event on, then applies a pure reducer to state.

import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { Bucket, Check, Consult, Layout, LogLine, PlanTask, Server, WorkflowRun } from '../types'
import {
  adviceOf,
  afterCall,
  DEFAULT_ARCHITECT,
  DEFAULT_TURN,
  endConsult,
  handbackOf,
  momentOf,
  receiptOf,
  startConsult,
} from './model/architect'
import type { Config } from './model/config'
import { contextLevel, PALETTES, parseConfig } from './model/config'
import { addWorker, completeWorker, nextN, normalizeWorker, noteWorkerTool, stepWorker, updateWorker } from './model/crew'
import { DEFAULT_GATE, normalizeGate, recordCheck, settleCheck } from './model/gate'
import { failureLine, normalizeLog, promptLine, pushLog, renderFailure } from './model/log'
import type { TaskEvent } from './model/plan'
import { applyTaskEvent, taskFromCreate, taskFromTodoWrite, taskFromUpdate } from './model/plan'
import { progressOf, statusText } from './model/progress'
import { liveServers, mayAffectServers, serversAfterCall, serversAfterNotice } from './model/servers'
import { isFlagged, modelSourceOf } from './model/tiers'
import { bucketOf, describeInput, EDIT_TOOLS, listOf, normalize, prettyModel, redact, shorten } from './model/util'
import { activeRun, endRunByText, finishRunAgent, loopPhase, runRefOf, startRun, stepRunAgent, workflowMetaOf } from './model/workflow'
import { DEFAULT_MAIN, DEFAULT_ROSTER, DEFAULT_USAGE, DEFAULT_VIEW, SCHEMA_VERSION } from './store'
import { drawPane } from './view/pane'

const PANE = 'conductor'
const TITLE = 'Conductor'
const PANE_COLUMNS = 66
const metaState = atom({ plugin: 'conductor', key: 'meta' } as const, { schemaVersion: SCHEMA_VERSION })
const mainState = atom({ plugin: 'conductor', key: 'main' } as const, DEFAULT_MAIN)
const usageState = atom({ plugin: 'conductor', key: 'usage' } as const, DEFAULT_USAGE)
const architectState = atom({ plugin: 'conductor', key: 'architect' } as const, DEFAULT_ARCHITECT)
const gateState = atom({ plugin: 'conductor', key: 'gate' } as const, DEFAULT_GATE)
const workersState = atom({ plugin: 'conductor', key: 'workers' } as const, [])
const planState = atom({ plugin: 'conductor', key: 'plan' } as const, [])
const runsState = atom({ plugin: 'conductor', key: 'runs' } as const, [])
const logState = atom({ plugin: 'conductor', key: 'log' } as const, [])
const turnState = atom({ plugin: 'conductor', key: 'turn' } as const, DEFAULT_TURN)
const receiptState = atom({ plugin: 'conductor', key: 'receipt' } as const, null)
const viewState = atom({ plugin: 'conductor', key: 'view' } as const, DEFAULT_VIEW)
const rosterState = atom({ plugin: 'conductor', key: 'roster' } as const, DEFAULT_ROSTER)
const serversState = atom({ plugin: 'conductor', key: 'servers' } as const, [])

type $ = EngineInterface
type ServerBlock = { type: string; id?: string; name?: string; tool_use_id?: string }

// Every read goes through these, so a value saved under an older shape still reads.
async function getMain($: $) {
  return normalize(DEFAULT_MAIN, await read($, mainState))
}
async function getUsage($: $) {
  return normalize(DEFAULT_USAGE, await read($, usageState))
}
async function getArchitect($: $) {
  const a = normalize(DEFAULT_ARCHITECT, await read($, architectState))
  return { ...a, consults: listOf<Consult>(a.consults), ids: listOf<string>(a.ids), seen: listOf<string>(a.seen) }
}
async function getGate($: $) {
  return normalizeGate(await read($, gateState))
}
async function getWorkers($: $) {
  return listOf<unknown>(await read($, workersState)).map(normalizeWorker)
}
async function getPlan($: $) {
  return listOf<PlanTask>(await read($, planState))
}
async function getRuns($: $) {
  return listOf<WorkflowRun>(await read($, runsState))
}
async function getLog($: $) {
  return normalizeLog(await read($, logState))
}
async function getTurn($: $) {
  return normalize(DEFAULT_TURN, await read($, turnState))
}
async function getReceipt($: $) {
  return (await read($, receiptState)) ?? null
}
async function getView($: $) {
  return normalize(DEFAULT_VIEW, await read($, viewState))
}
async function getRoster($: $) {
  return { architectTypes: listOf<string>(normalize(DEFAULT_ROSTER, await read($, rosterState)).architectTypes) }
}
async function getServers($: $) {
  return listOf<Server>(await read($, serversState))
}

async function say($: $, who: string, text: string, kind: LogLine['kind'] = 'info', agentId: string | null = null) {
  const line: LogLine = { at: await $.clock.now(), who, text, kind, agentId }
  await update($, logState, list => pushLog(normalizeLog(list), line))
}

/** Runs a hook's bookkeeping; a failure becomes one error row in the log, and the event has already passed on. */
async function safely($: $, hook: string, f: () => Promise<void>) {
  try {
    await f()
  } catch (err) {
    await say($, 'conductor', failureLine(hook, err), 'error').catch(() => undefined)
  }
}

async function resetAll($: $) {
  await update($, mainState, m => ({ ...DEFAULT_MAIN, model: normalize(DEFAULT_MAIN, m).model }))
  await update($, usageState, () => DEFAULT_USAGE)
  await update($, architectState, () => DEFAULT_ARCHITECT)
  await update($, gateState, () => DEFAULT_GATE)
  await update($, workersState, () => [])
  await update($, planState, () => [])
  await update($, runsState, () => [])
  await update($, logState, () => [])
  await update($, turnState, () => DEFAULT_TURN)
  await update($, receiptState, () => null)
  await update($, viewState, () => DEFAULT_VIEW)
  await update($, serversState, () => [])
}

/** A stored shape older than this build's starts fresh: the pane is session-only. */
async function migrate($: $) {
  const m = await read($, metaState)
  if ((m?.schemaVersion ?? 0) >= SCHEMA_VERSION) return
  await resetAll($)
  await update($, metaState, () => ({ schemaVersion: SCHEMA_VERSION }))
}

const textOf = (ran: unknown) => {
  const r = ran as { text?: unknown; result?: unknown }
  return typeof r.text === 'string' ? r.text : JSON.stringify(r.result ?? '')
}

async function refreshStatus($: $, cfg: Config) {
  if (!cfg.statusLine) return $.ui.status(undefined)
  const [workers, plan, runs, usage, servers, now] = await Promise.all([
    getWorkers($),
    getPlan($),
    getRuns($),
    getUsage($),
    getServers($),
    $.clock.now(),
  ])
  const progress = progressOf({ tasks: plan, run: activeRun(runs) ?? runs[runs.length - 1] ?? null, workers, now })
  $.ui.status(
    statusText({
      progress,
      ctxPct: usage.pct,
      running: workers.filter(w => w.status === 'running').length,
      flagged: workers.filter(w => isFlagged(w.modelSource)).length,
      servers: liveServers(servers).length,
    }),
  )
}

async function consultStarted($: $, cfg: Config, id: string, rawVia: string) {
  // `via` can be an agent type from the Agent call's input, so it is masked before it is stored or logged.
  const via = redact(rawVia)
  const t = await getTurn($)
  const moment = momentOf(t)
  const at = await $.clock.now()
  await update($, architectState, a => startConsult(normalize(DEFAULT_ARCHITECT, a), { id, at, moment, via }))
  if (moment === 'before done') await update($, turnState, x => ({ ...normalize(DEFAULT_TURN, x), isReviewing: true }))
  await say($, cfg.architectLabel.toLowerCase(), `${moment} · ${via} (inferred)`, 'consult')
}

async function consultEnded($: $, cfg: Config, advice: string | null, id?: string) {
  const at = await $.clock.now()
  const text = advice ? adviceOf(advice) : null
  await update($, architectState, a => endConsult(normalize(DEFAULT_ARCHITECT, a), at, text || null, id))
  await update($, turnState, t => ({ ...normalize(DEFAULT_TURN, t), isReviewing: false }))
  await say($, cfg.architectLabel.toLowerCase(), text ? `advice: ${shorten(text, 60)}` : 'advice returned', 'consult')
}

async function whoIs($: $, agentId: string | undefined) {
  if (!agentId) return 'main'
  const w = (await getWorkers($)).find(x => x.id === agentId)
  return w ? `W${w.n}` : 'agent'
}

/** The press handler for one worker's button: opens that worker, or closes it when it is already open. Built here, since it holds `$`. */
const expandOnPress = ($: $, id: string) => () =>
  update($, viewState, x => ({ ...normalize(DEFAULT_VIEW, x), expanded: normalize(DEFAULT_VIEW, x).expanded === id ? null : id }))

/** The press handler for one gate bucket (`f`, `s`, `o`): opens its drill-down, or closes it when it is already open. Built here, since it holds `$`. */
const gateOnPress = ($: $, b: Bucket) => () =>
  update($, viewState, x => ({ ...normalize(DEFAULT_VIEW, x), gateOpen: normalize(DEFAULT_VIEW, x).gateOpen === b ? null : b }))

async function openPane($: $) {
  return $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS, rows: 8 })
}

export const register: Register = (on, options) => {
  const cfg = parseConfig(options)
  const C = PALETTES[cfg.palette]
  // tool.check carries no loop id; the tool.call around it does. An Agent call's model, by its call id.
  const callLoop = new Map<string, string | null>()
  const requested = new Map<string, string | null>()

  on('session.start', async ($, e, next) => {
    await safely($, 'session.start', async () => {
      await $.command.register({
        name: 'conductor',
        description: 'Conductor pane: open, close, reset, or set the layout',
        argumentHint: '[open|close|reset|layout auto|hybrid|mini]',
      })
      await migrate($)
      const u = await $.session.usage().catch(() => null)
      if (u)
        await update($, usageState, () => ({ pct: u.context.percent ?? null, tokens: u.context.tokens ?? null, window: u.context.window }))
      if (cfg.openOnStart) void openPane($).catch(() => undefined)
      await refreshStatus($, cfg)
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear')
      await safely($, 'session.end', async () => {
        await resetAll($)
        await refreshStatus($, cfg)
      })
    return next(e)
  })

  on('command.run', { command: 'conductor' }, async ($, e) => {
    try {
      const [verb = 'open', arg = ''] = e.args.trim().split(/\s+/)
      if (verb === 'close') {
        await $.ui.close({ id: PANE })
        return { text: 'Conductor closed.' }
      }
      if (verb === 'reset') {
        await resetAll($)
        await refreshStatus($, cfg)
        return { text: 'Conductor reset.' }
      }
      if (verb === 'layout') {
        const layout: Layout | null = arg === 'auto' || arg === 'hybrid' || arg === 'mini' ? arg : null
        if (!layout) return { text: 'Usage: /conductor layout auto|hybrid|mini' }
        await update($, viewState, v => ({ ...normalize(DEFAULT_VIEW, v), layout }))
      }
      const opened = await openPane($)
      return {
        text: opened.isPlaced
          ? 'Conductor open. In the hybrid layout, focus it with ctrl+x tab; 1-8 expand workers, f/s/o open the file/shell/other permission rows.'
          : `Conductor is not shown yet: ${opened.reason}`,
      }
    } catch (err) {
      return { text: `Conductor failed: ${shorten(err instanceof Error ? err.message : String(err), 80)}` }
    }
  })

  on('agent.offer', async ($, e, next) => {
    const offered = await next(e)
    if (cfg.architect.test(e.agent))
      await safely($, 'agent.offer', async () => {
        await update($, rosterState, r => {
          const x = listOf<string>(normalize(DEFAULT_ROSTER, r).architectTypes)
          return x.includes(e.agent) ? { architectTypes: x } : { architectTypes: [...x, e.agent].slice(-20) }
        })
      })
    return offered
  })

  on('turn.start', async ($, e, next) => {
    await safely($, 'turn.start', async () => {
      const now = await $.clock.now()
      const cost = (await $.session.usage().catch(() => null))?.cost?.usd ?? null
      await update($, turnState, () => ({ ...DEFAULT_TURN, startedAt: now, costAtStart: cost }))
      await update($, mainState, m => ({ ...normalize(DEFAULT_MAIN, m), isRunning: true }))
      const text = e.text ?? ''
      const back = text ? handbackOf(text) : null
      const a = back ? await getArchitect($) : null
      if (back && a && a.ids.includes(back.from)) {
        const advice = adviceOf(back.body)
        if (advice && advice !== a.lastAdvice) {
          await update($, architectState, x => ({ ...normalize(DEFAULT_ARCHITECT, x), lastAdvice: advice }))
          await say($, cfg.architectLabel.toLowerCase(), `advice: ${shorten(advice, 60)}`, 'consult')
        }
      } else if (text) {
        if (/^\s*<task-notification/i.test(text)) {
          await update($, runsState, r => endRunByText(listOf<WorkflowRun>(r), text, now))
          await update($, serversState, l => serversAfterNotice(listOf<Server>(l), text, now))
        }
        const p = promptLine(text)
        await say($, p.who, p.text)
      }
      // A background server's stop notice changes the live count the status line shows.
      await refreshStatus($, cfg)
    })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    await safely($, 'turn.step', async () => {
      if (!e.agentId) {
        await update($, mainState, m => {
          const x = normalize(DEFAULT_MAIN, m)
          return { ...x, model: e.model, effort: String(e.effort ?? x.effort), steps: x.steps + 1 }
        })
        return
      }
      const id = e.agentId
      const [workers, a] = await Promise.all([getWorkers($), getArchitect($)])
      if (workers.some(w => w.id === id)) {
        await update($, workersState, list =>
          updateWorker(listOf<unknown>(list).map(normalizeWorker), id, w =>
            stepWorker(w, { model: e.model, usage: result.usage, stopReason: result.stopReason }),
          ),
        )
        if (result.stopReason === 'max_tokens') await say($, await whoIs($, id), 'hit max_tokens', 'error', id)
      } else if (!a.ids.includes(id)) {
        const at = await $.clock.now()
        await update($, runsState, r => stepRunAgent(listOf<WorkflowRun>(r), { agentId: id, phase: loopPhase(e), at }))
      }
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    await safely($, 'session.measure', async () => {
      const before = contextLevel((await getUsage($)).pct, cfg)
      const pct = e.context.percent ?? null
      await update($, usageState, () => ({ pct, tokens: e.context.tokens ?? null, window: e.context.window }))
      if (before !== 'red' && contextLevel(pct, cfg) === 'red') await say($, 'context', `past ${cfg.contextRed}% · checkpoint now`, 'error')
      if (e.changed.includes('context')) await refreshStatus($, cfg)
    })
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId && e.trigger !== 'precompute')
      await safely($, 'session.compact', () => say($, 'main', `context compacted (${e.trigger})`))
    return done
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (e.tool_use_id)
      await safely($, 'tool.check', async () => {
        const check: Check = {
          id: e.tool_use_id as string,
          tool: e.tool,
          bucket: bucketOf(e.tool),
          verdict: verdict.decision === 'allow' ? 'rule' : verdict.decision,
          inSubagent: Boolean(callLoop.get(e.tool_use_id as string)),
          detail: shorten(describeInput(e.tool, e.input), 90),
          at: await $.clock.now(),
        }
        await update($, gateState, g => recordCheck(normalizeGate(g), check))
        if (verdict.decision === 'deny') await say($, 'gate', `denied by rule · ${check.detail}`, 'error')
      })
    return verdict
  })

  on('tool.call', async ($, e, next) => {
    callLoop.set(e.tool_use_id, e.agentId ?? null)
    const input = e as unknown as Record<string, unknown>
    if (e.tool === 'Agent') requested.set(e.tool_use_id, typeof input.model === 'string' && input.model ? input.model : null)
    const ran = await next(e).finally(() => {
      callLoop.delete(e.tool_use_id)
      requested.delete(e.tool_use_id)
    })
    await safely($, 'tool.call', async () => {
      const didRun = ran.deny === undefined
      const now = await $.clock.now()
      await update($, gateState, g => settleCheck(normalizeGate(g), e.tool_use_id, didRun))
      const tool = String(e.tool)
      // Every tool can start, stop or use a local server, so this runs before any branch below returns; the cheap check skips the rest.
      if (didRun && mayAffectServers(tool, input)) {
        let liveBefore = 0
        const servers = await update($, serversState, l => {
          const list = listOf<Server>(l)
          liveBefore = liveServers(list).length
          return serversAfterCall(list, {
            tool,
            input,
            resultText: textOf(ran),
            didRun,
            at: now,
            by: e.agentId ? 'agent' : 'main',
            callId: e.tool_use_id,
          })
        })
        if (liveServers(listOf<Server>(servers)).length !== liveBefore) await refreshStatus($, cfg)
      }
      if (tool === 'SubagentHandback') {
        const message = input.message
        const a = e.agentId ? await getArchitect($) : null
        if (a && e.agentId && a.ids.includes(e.agentId) && typeof message === 'string') {
          const advice = adviceOf(message)
          if (advice && advice !== a.lastAdvice) {
            await update($, architectState, x => ({ ...normalize(DEFAULT_ARCHITECT, x), lastAdvice: advice }))
            await say($, cfg.architectLabel.toLowerCase(), `advice: ${shorten(advice, 60)}`, 'consult')
          }
        }
        return
      }
      if (tool === 'Agent') return
      if (didRun && (tool === 'TaskCreate' || tool === 'TaskUpdate' || tool === 'TodoWrite')) {
        const evs: TaskEvent[] =
          tool === 'TaskCreate'
            ? [taskFromCreate(input, textOf(ran), now)].filter((x): x is TaskEvent => x !== null)
            : tool === 'TaskUpdate'
              ? taskFromUpdate(input, now)
              : [taskFromTodoWrite(input, now)].filter((x): x is TaskEvent => x !== null)
        if (evs.length > 0) {
          await update($, planState, p => evs.reduce(applyTaskEvent, listOf<PlanTask>(p)))
          await refreshStatus($, cfg)
        }
        return
      }
      if (didRun && tool === 'Workflow') {
        const meta = workflowMetaOf(input)
        await update($, runsState, r =>
          startRun(listOf<WorkflowRun>(r), { id: e.tool_use_id, ref: runRefOf(textOf(ran)), ...meta, at: now }),
        )
        await say($, 'workflow', `started · ${meta.name}${meta.phases.length > 0 ? ` · ${meta.phases.join(' › ')}` : ''}`)
        return
      }
      const hasFailed = didRun && ran.isError === true
      const isEdit = !hasFailed && didRun && EDIT_TOOLS.has(tool)
      await update($, turnState, t => afterCall(normalize(DEFAULT_TURN, t), { inSubagent: Boolean(e.agentId), hasFailed, isEdit }))
      const text = shorten(describeInput(tool, e), 64)
      if (e.agentId) {
        const id = e.agentId
        await update($, workersState, list =>
          updateWorker(listOf<unknown>(list).map(normalizeWorker), id, w =>
            noteWorkerTool(w, { tool, text, isError: hasFailed || !didRun }),
          ),
        )
      } else {
        await update($, mainState, m => ({ ...normalize(DEFAULT_MAIN, m), activity: text }))
      }
      if (!didRun) await say($, await whoIs($, e.agentId), `${text}  denied`, 'error', e.agentId ?? null)
      else if (hasFailed) await say($, await whoIs($, e.agentId), `${text}  ✗`, 'error', e.agentId ?? null)
      else if (isEdit) await say($, await whoIs($, e.agentId), text, 'info', e.agentId ?? null)
    })
    return ran
  })

  // A server-side review tool never reaches tool.call: it shows only in the assistant's rows.
  on('session.append', async ($, e, next) => {
    if (!e.agentId && e.message.type === 'assistant')
      await safely($, 'session.append', async () => {
        const a = await getArchitect($)
        const opened = new Set<string>()
        for (const block of e.message.content as unknown as readonly ServerBlock[]) {
          if (block.type === 'server_tool_use' && block.name && block.id && cfg.architect.test(block.name)) {
            if (a.seen.includes(block.id)) continue
            const id = block.id
            await update($, architectState, x => {
              const y = normalize(DEFAULT_ARCHITECT, x)
              return { ...y, seen: [...listOf<string>(y.seen), id].slice(-60) }
            })
            opened.add(id)
            await consultStarted($, cfg, id, `${block.name} tool`)
          } else if (block.type.endsWith('_tool_result') && block.tool_use_id) {
            const id = block.tool_use_id
            const isOpen = opened.has(id) || (await getArchitect($)).consults.some(c => c.id === id && c.endAt === null)
            if (isOpen) await consultEnded($, cfg, null, id)
          }
        }
      })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || !started.agentId) return started
    const id = started.agentId
    await safely($, 'agent.spawn', async () => {
      const roster = await getRoster($)
      if (cfg.architect.test(e.subagentType) || roster.architectTypes.includes(e.subagentType)) {
        await update($, architectState, a => {
          const x = normalize(DEFAULT_ARCHITECT, a)
          return { ...x, ids: [...listOf<string>(x.ids), id].slice(-40) }
        })
        await consultStarted($, cfg, id, e.subagentType.split(':').pop() ?? 'agent')
        return
      }
      const callId = (e as unknown as { tool_use_id?: unknown }).tool_use_id
      const req = typeof callId === 'string' && requested.has(callId) ? (requested.get(callId) ?? null) : undefined
      const parent = String((e as unknown as { parentModel?: unknown }).parentModel ?? (await getMain($)).model)
      const workers = await getWorkers($)
      const model = started.model ?? ''
      const worker = {
        ...normalizeWorker({}),
        id,
        n: nextN(workers),
        type: redact(e.name ?? e.subagentType),
        description: shorten(redact(e.description ?? ''), 120),
        model,
        modelSource: modelSourceOf({ requested: req, resolved: model, parent }),
        spawnedAt: await $.clock.now(),
      }
      await update($, workersState, list => addWorker(listOf<unknown>(list).map(normalizeWorker), worker))
      await say($, `W${worker.n}`, `spawned · ${worker.type} · ${prettyModel(worker.model)}`, 'info', id)
      if (worker.modelSource === 'inherited')
        await say($, `W${worker.n}`, `⚠ inherited ${prettyModel(worker.model)} (no model passed)`, 'error', id)
      if (worker.modelSource === 'likely-inherited')
        await say($, `W${worker.n}`, `⚠ likely inherited ${prettyModel(worker.model)}`, 'error', id)
      // Softer than an inherited model: the agent's own definition chose it, so it is a note and not a warning colour.
      if (worker.modelSource === 'definition-unpassed')
        await say($, `W${worker.n}`, `⚠ no model · from definition ${prettyModel(worker.model)}`, 'info', id)
      await refreshStatus($, cfg)
    })
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await safely($, 'turn.complete', async () => {
      const id = e.agentId
      const now = await $.clock.now()
      if (!id) {
        const [t, workers] = await Promise.all([getTurn($), getWorkers($)])
        const cost = (await $.session.usage().catch(() => null))?.cost?.usd ?? null
        await update($, receiptState, () =>
          receiptOf(t, {
            durationMs: e.durationMs,
            agentsSince: workers.filter(w => w.spawnedAt >= t.startedAt).length,
            costNow: cost,
            reason: e.reason,
          }),
        )
        await update($, mainState, m => ({ ...normalize(DEFAULT_MAIN, m), isRunning: false }))
      } else if ((await getArchitect($)).ids.includes(id)) {
        await consultEnded($, cfg, e.answer, id)
      } else if ((await getWorkers($)).some(w => w.id === id)) {
        await update($, workersState, list =>
          updateWorker(listOf<unknown>(list).map(normalizeWorker), id, w =>
            completeWorker(w, { reason: e.reason, at: now, answer: e.answer }),
          ),
        )
        const w = (await getWorkers($)).find(x => x.id === id)
        if (w)
          await say(
            $,
            `W${w.n}`,
            w.status === 'done' ? `done · ${shorten(w.description, 40)}` : w.status,
            w.status === 'done' ? 'done' : 'error',
            id,
          )
      } else {
        await update($, runsState, r => finishRunAgent(listOf<WorkflowRun>(r), id, now))
      }
      await refreshStatus($, cfg)
    })
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    try {
      const [main, usage, workers, plan, runs, architect, gate, log, turn, receipt, view, servers, now] = await Promise.all([
        getMain($),
        getUsage($),
        getWorkers($),
        getPlan($),
        getRuns($),
        getArchitect($),
        getGate($),
        getLog($),
        getTurn($),
        getReceipt($),
        getView($),
        getServers($),
        $.clock.now(),
      ])
      return drawPane(
        { els, C, now, hasClient: 'Client' in els, cfg },
        { main, usage, workers, plan, runs, architect, gate, log, turn, receipt, view, servers },
        {
          columns: e.props.bodyColumns,
          isInline: e.props.placement === 'inline',
          bodyRows: e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40,
          viewedAgent: e.props.view?.agentId ?? null,
          onExpand: (id: string) => expandOnPress($, id),
          onGate: (b: Bucket) => gateOnPress($, b),
        },
      )
    } catch (err) {
      // A drawing that fails still answers: one row saying so, cut to the pane's width.
      return (
        <els.Text color={C.warn} wrap="truncate">
          {renderFailure(err, e.props.bodyColumns)}
        </els.Text>
      )
    }
  })
}
