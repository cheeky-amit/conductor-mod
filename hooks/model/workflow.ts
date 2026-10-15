// Workflow runs: phases from the script's meta literal, agents from model loops no worker claims.
import type { WorkflowAgent, WorkflowRun } from '../../types'
import { fmtDuration, isObject, redact } from './util'

const RUN_REF = /\bwf_[a-z0-9-]{6,}\b/i
const RUN_REFS = new RegExp(RUN_REF.source, 'gi')
const TOOL_USE_ID = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/gi
const SUMMARY = /<summary>([\s\S]*?)<\/summary>/i
export const MAX_RUNS = 5
const MAX_AGENTS = 100
/** A string literal in `'…'`, `"…"` or backticks, escaped quotes allowed: group 1 is the quote, group 2 what is inside it. */
const QUOTED = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/.source
const NAME = new RegExp(`\\bname\\s*:\\s*${QUOTED}`)
const TITLES = new RegExp(`\\btitle\\s*:\\s*${QUOTED}`, 'g')
const unquote = (s: string) => s.replace(/\\(.)/g, '$1')

/** The `export const meta = {…}` literal's name and phase titles; nothing outside it. */
export const parseWorkflowMeta = (script: string): { name: string; phases: string[] } => {
  const at = script.indexOf('export const meta')
  if (at < 0) return { name: 'workflow', phases: [] }
  const open = script.indexOf('{', at)
  let depth = 0
  let end = open
  for (let i = open; i >= 0 && i < script.length; i += 1) {
    if (script[i] === '{') depth += 1
    else if (script[i] === '}' && --depth === 0) {
      end = i
      break
    }
  }
  const meta = script.slice(open, end + 1)
  const block = /\bphases\s*:\s*\[([\s\S]*)\]/.exec(meta)?.[1] ?? ''
  const withoutPhases = meta.replace(block, '')
  const name = unquote(NAME.exec(withoutPhases)?.[2] ?? '') || 'workflow'
  const phases = [...block.matchAll(TITLES)].map(m => unquote(m[2] as string)).filter(title => title !== '')
  return { name, phases }
}

/** A Workflow call's run name and phases as stored: from the script's meta literal, else the call's `name`; credentials masked. */
export const workflowMetaOf = (input: Record<string, unknown>): { name: string; phases: string[] } => {
  const meta =
    typeof input.script === 'string'
      ? parseWorkflowMeta(input.script)
      : { name: typeof input.name === 'string' ? input.name : 'workflow', phases: [] as string[] }
  return { name: redact(meta.name), phases: meta.phases.map(p => redact(p)) }
}

export const runRefOf = (text: string) => RUN_REF.exec(text)?.[0] ?? null

export const startRun = (
  runs: WorkflowRun[],
  r: { id: string; ref: string | null; name: string; phases: string[]; at: number },
): WorkflowRun[] =>
  [
    ...runs.filter(x => x.id !== r.id),
    { id: r.id, ref: r.ref, name: r.name, phases: r.phases, startedAt: r.at, endedAt: null, agents: [] },
  ].slice(-MAX_RUNS)

export const activeRun = (runs: WorkflowRun[]) => [...runs].reverse().find(r => r.endedAt === null) ?? null

export const stepRunAgent = (runs: WorkflowRun[], o: { agentId: string; phase: string | null; at: number }): WorkflowRun[] => {
  const run = activeRun(runs)
  if (!run) return runs
  const found = run.agents.find(a => a.id === o.agentId)
  const agents: WorkflowAgent[] = found
    ? run.agents.map(a => (a === found ? { ...a, lastAt: o.at, phase: a.phase ?? o.phase } : a))
    : [...run.agents, { id: o.agentId, phase: o.phase, isDone: false, firstAt: o.at, lastAt: o.at }].slice(-MAX_AGENTS)
  return runs.map(r => (r === run ? { ...r, agents } : r))
}

export const finishRunAgent = (runs: WorkflowRun[], agentId: string, at: number): WorkflowRun[] =>
  runs.map(r =>
    r.agents.some(a => a.id === agentId)
      ? { ...r, agents: r.agents.map(a => (a.id === agentId ? { ...a, isDone: true, lastAt: at } : a)) }
      : r,
  )

/**
 * A completion notice: ends the open run it names, matching the notice's `<tool-use-id>` to the run's own id first,
 * then any `wf_` ref in the text to the run's ref. Only a notice with no `<tool-use-id>` at all, naming no known run,
 * open or ended, ends the only active run, and then only if its `<summary>` (or its whole text, without one) says
 * "workflow". A background Agent or Bash notice carries its own id and names its description in the summary, so it
 * never ends a run by a word.
 */
export const endRunByText = (runs: WorkflowRun[], text: string, at: number): WorkflowRun[] => {
  const ids = new Set([...text.matchAll(TOOL_USE_ID)].map(m => m[1]))
  const refs = new Set(text.match(RUN_REFS) ?? [])
  const isId = (r: WorkflowRun) => ids.has(r.id)
  const isRef = (r: WorkflowRun) => r.ref !== null && refs.has(r.ref)
  const isOpen = (r: WorkflowRun) => r.endedAt === null
  const open = runs.filter(isOpen)
  const names = runs.some(r => isId(r) || isRef(r))
  const about = SUMMARY.exec(text)?.[1] ?? text
  const isBare = ids.size === 0 && !names && open.length === 1 && /workflow/i.test(about)
  const target = open.find(isId) ?? open.find(isRef) ?? (isBare ? open[0] : undefined)
  return target ? runs.map(r => (r === target ? { ...r, endedAt: at } : r)) : runs
}

export type PhaseState = { title: string; done: number; total: number; state: 'done' | 'current' | 'waiting' }

export const runProgress = (run: WorkflowRun) => {
  const hasPhaseData = run.agents.some(a => a.phase !== null)
  const counts = run.phases.map(title => {
    const as = run.agents.filter(a => a.phase === title)
    return { title, done: as.filter(a => a.isDone).length, total: as.length }
  })
  const lastStarted = counts.reduce((last, p, i) => (p.total > 0 ? i : last), -1)
  const phases: PhaseState[] = counts.map((p, i) => ({
    ...p,
    state:
      !hasPhaseData || i > lastStarted
        ? 'waiting'
        : i < lastStarted || run.endedAt !== null
          ? 'done'
          : p.done === p.total && i < counts.length - 1
            ? 'done'
            : 'current',
  }))
  return { done: run.agents.filter(a => a.isDone).length, total: run.agents.length, phases, hasPhaseData }
}

/** What ends the workflow row: how long a finished run took, or how many of its agents are done. */
export const runTail = (run: WorkflowRun, p: Pick<ReturnType<typeof runProgress>, 'done' | 'total'>) =>
  run.endedAt !== null ? `  ✓ done in ${fmtDuration(run.endedAt - run.startedAt)}` : `  ${p.done}/${p.total} agents`

export type RunSegment = { text: string; state: PhaseState['state'] | 'plain' }

/**
 * The run's phases as row segments. With per-agent phase data (`hasPhaseData`) each phase carries its state:
 * `Review ✓`, `Verify 1/2`, a waiting one bare. Without it (the live case: workflow agents report no phase)
 * they are one plain segment, `Review › Verify`.
 */
export const runSegments = (run: WorkflowRun, p: ReturnType<typeof runProgress>): RunSegment[] =>
  run.phases.length === 0
    ? []
    : p.hasPhaseData
      ? p.phases.map((ph, i) => ({
          text: `${i === 0 ? '  ' : ' › '}${ph.title}${ph.state === 'done' ? ' ✓' : ph.state === 'current' ? ` ${ph.done}/${ph.total}` : ''}`,
          state: ph.state,
        }))
      : [{ text: `  ${run.phases.join(' › ')}`, state: 'plain' }]

export const loopPhase = (e: unknown): string | null => (isObject(e) && typeof e.phase === 'string' && e.phase ? e.phase : null)
