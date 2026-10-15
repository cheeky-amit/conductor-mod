// Workers: the subagents the orchestrator dispatched. Pure reducers over the worker list.
import type { ToolNote, Worker, WorkerStatus } from '../../types'
import { kTokens, normalize, redact, shorten } from './util'

export const DEFAULT_WORKER: Worker = {
  id: '',
  n: 0,
  type: 'agent',
  description: '',
  model: '',
  modelSource: 'definition',
  status: 'running',
  spawnedAt: 0,
  endedAt: null,
  steps: 0,
  ctx: 0,
  out: 0,
  tokIn: 0,
  tokCacheRead: 0,
  tokCacheWrite: 0,
  lastStop: null,
  tools: [],
  answer: '',
}
export const MAX_WORKERS = 24

export const normalizeWorker = (stored: unknown): Worker => normalize(DEFAULT_WORKER, stored)
export const nextN = (list: Worker[]) => list.reduce((m, w) => Math.max(m, w.n), 0) + 1
/** Over the cap, drop the oldest worker that isn't running (or the oldest of all, when every one is): a running one keeps its steps and its completion. */
const cap = (list: Worker[]) => {
  if (list.length <= MAX_WORKERS) return list
  const drop = list.find(w => w.status !== 'running') ?? list[0]
  return list.filter(w => w !== drop)
}

export const addWorker = (list: Worker[], w: Worker) => cap([...list.filter(x => x.id !== w.id), w])
export const updateWorker = (list: Worker[], id: string, f: (w: Worker) => Worker) => list.map(w => (w.id === id ? f(w) : w))

type StepUsage =
  | { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number }
  | null
  | undefined

export const stepWorker = (w: Worker, s: { model: string; usage: StepUsage; stopReason: string | null }): Worker => {
  const u = s.usage ?? {}
  const tokIn = u.input_tokens ?? 0
  const read = u.cache_read_input_tokens ?? 0
  const write = u.cache_creation_input_tokens ?? 0
  const ctx = tokIn + read + write
  return {
    ...w,
    model: w.model || s.model,
    steps: w.steps + 1,
    ctx: ctx > 0 ? ctx : w.ctx,
    out: w.out + (u.output_tokens ?? 0),
    tokIn: w.tokIn + tokIn,
    tokCacheRead: w.tokCacheRead + read,
    tokCacheWrite: w.tokCacheWrite + write,
    lastStop: s.stopReason,
  }
}

export const noteWorkerTool = (w: Worker, n: ToolNote): Worker => ({ ...w, tools: [...w.tools, n].slice(-3) })

const statusOf = (reason: string): WorkerStatus => (reason === 'answer' ? 'done' : reason === 'aborted' ? 'stopped' : 'failed')

export const completeWorker = (w: Worker, o: { reason: string; at: number; answer: string }): Worker => ({
  ...w,
  status: statusOf(o.reason),
  endedAt: o.at,
  answer: shorten(redact(o.answer), 400),
})

/** A run on the axis from `start` to `now` in `width` cells: cells before it, its bar (≥1), cells after. */
export const timeBar = (w: Pick<Worker, 'spawnedAt' | 'endedAt'>, start: number, now: number, width: number) => {
  const cells = Math.max(1, width)
  const span = Math.max(1, now - start)
  const from = Math.min(cells - 1, Math.max(0, Math.floor(((Math.max(w.spawnedAt, start) - start) / span) * cells)))
  const to = Math.min(cells, Math.max(from + 1, Math.ceil((((w.endedAt ?? now) - start) / span) * cells)))
  return { before: from, bar: to - from, after: cells - to }
}

export const workersStart = (ws: Worker[], now: number) => Math.min(now, ...ws.map(w => w.spawnedAt).filter(n => n > 0))

/** Worker boxes read left to right in spawn order (W1 W2 W3), whatever their status. */
export const boxOrder = (ws: Worker[]) => [...ws].sort((a, b) => a.n - b.n)

/** Folded rows: running workers first, then finished ones, each newest first: a cut to the first rows keeps the newest. */
export const drawOrder = (ws: Worker[]) => [
  ...ws.filter(w => w.status === 'running').reverse(),
  ...ws.filter(w => w.status !== 'running').reverse(),
]

/** The tail of a worker box's status line that fits `room` cells: ` 18k · 7st`, else ` · 7st`, else ` 7st`. Steps always stay. */
export const boxStats = (o: Pick<Worker, 'out' | 'steps'>, room: number) => {
  const steps = `${o.steps}st`
  const both = ` ${kTokens(o.out)} · ${steps}`
  const stepsOnly = ` · ${steps}`
  return both.length <= room ? both : stepsOnly.length <= room ? stepsOnly : ` ${steps}`
}
