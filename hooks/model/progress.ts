// Which progress to show (tasks, then workflow agents, then workers), now/next, and the status line.
import type { Main, PlanTask, Worker, WorkflowRun } from '../../types'
import { currentTask, meanTaskMs, nextTask, remainingMs, taskEta, taskProgress } from './plan'
import { fmtEta } from './util'
import { runProgress } from './workflow'

export type Progress = {
  source: 'tasks' | 'agents' | 'workers'
  done: number
  total: number
  pct: number
  etaMs: number | null
  meanMs: number | null
}

const pctOf = (done: number, total: number) => (total > 0 ? Math.round((done / total) * 100) : 0)
const mean = (ms: number[]) => (ms.length > 0 ? ms.reduce((s, x) => s + x, 0) / ms.length : null)

/** Everything counted is done, so there is nothing left to estimate: the row says `done` and the status line drops the ETA. */
export const isComplete = (p: Progress) => p.total > 0 && p.done >= p.total && p.pct >= 100

export const progressOf = (o: { tasks: PlanTask[]; run: WorkflowRun | null; workers: Worker[]; now: number }): Progress | null => {
  const tp = taskProgress(o.tasks)
  if (tp.total > 0)
    return { source: 'tasks', ...tp, pct: pctOf(tp.done, tp.total), etaMs: taskEta(o.tasks, o.now), meanMs: meanTaskMs(o.tasks) }
  if (o.run && o.run.agents.length > 0) {
    // Workflow agents report no phase, so what is counted is the agents seen so far: the total grows as they appear. While the run
    // is open that is no denominator to trust, so it never reads 100% and has no ETA; the run's own end makes it whole.
    const rp = runProgress(o.run)
    const pct = pctOf(rp.done, rp.total)
    return {
      source: 'agents',
      done: rp.done,
      total: rp.total,
      pct: o.run.endedAt === null ? Math.min(99, pct) : pct,
      etaMs: null,
      meanMs: mean(o.run.agents.filter(a => a.isDone).map(a => a.lastAt - a.firstAt)),
    }
  }
  if (o.workers.length > 0) {
    const finished = o.workers.filter(w => w.status !== 'running')
    const m = mean(finished.filter(w => w.endedAt !== null).map(w => (w.endedAt as number) - w.spawnedAt))
    const open = o.workers.filter(w => w.status === 'running').map(w => ({ startedAt: w.spawnedAt }))
    return {
      source: 'workers',
      done: finished.length,
      total: o.workers.length,
      pct: pctOf(finished.length, o.workers.length),
      etaMs: remainingMs(open, m, o.now),
      meanMs: m,
    }
  }
  return null
}

export const nowNext = (o: { workers: Worker[]; tasks: PlanTask[]; main: Main }) => {
  const busy = [...o.workers].reverse().find(w => w.status === 'running')
  const now = busy
    ? `W${busy.n} ${busy.description || busy.type}`
    : (currentTask(o.tasks) ?? (o.main.isRunning ? o.main.activity || 'thinking' : null))
  return { now, next: nextTask(o.tasks) }
}

export const statusText = (o: { progress: Progress | null; ctxPct: number | null; running: number; flagged: number; servers?: number }) => {
  const parts = [
    o.progress ? `${o.progress.pct}%` : null,
    o.progress?.etaMs != null && !isComplete(o.progress) ? fmtEta(o.progress.etaMs) : null,
    o.ctxPct !== null ? `ctx ${Math.round(o.ctxPct)}%` : null,
    o.running > 0 ? `${o.running} running` : null,
    o.flagged > 0 ? `${o.flagged}⚠` : null,
    o.servers ? `${o.servers} srv` : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : undefined
}
