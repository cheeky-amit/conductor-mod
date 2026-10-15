import { expect, test } from 'claude-code/testing'

import { DEFAULT_WORKER } from '../hooks/model/crew'
import { isComplete, nowNext, progressOf, statusText } from '../hooks/model/progress'
import type { PlanTask, WorkflowRun } from '../types'

const MIN = 60_000
const task = (id: string, status: PlanTask['status'], over: Partial<PlanTask> = {}): PlanTask => ({
  id,
  subject: `t${id}`,
  status,
  createdAt: 0,
  startedAt: null,
  completedAt: null,
  ...over,
})
const run: WorkflowRun = {
  id: 'r',
  ref: null,
  name: 'w',
  phases: [],
  startedAt: 0,
  endedAt: null,
  agents: [
    { id: 'a', phase: null, isDone: true, firstAt: 0, lastAt: 2 * MIN },
    { id: 'b', phase: null, isDone: false, firstAt: 2 * MIN, lastAt: 3 * MIN },
  ],
}

test('tasks win over workflow and workers as the progress source', () => {
  const p = progressOf({ tasks: [task('1', 'completed', { completedAt: 2 * MIN }), task('2', 'pending')], run, workers: [], now: 3 * MIN })
  expect(p).toEqual({ source: 'tasks', done: 1, total: 2, pct: 50, etaMs: 2 * MIN, meanMs: 2 * MIN })
})

test('without tasks: workflow agents, then workers; nothing at all is null', () => {
  // The count is agents seen so far, not phases, and an open run has no total to trust: no ETA.
  expect(progressOf({ tasks: [], run, workers: [], now: 3 * MIN })).toEqual({
    source: 'agents',
    done: 1,
    total: 2,
    pct: 50,
    etaMs: null,
    meanMs: 2 * MIN,
  })
  const workers = [
    { ...DEFAULT_WORKER, id: 'w1', status: 'done' as const, spawnedAt: 0, endedAt: 4 * MIN },
    { ...DEFAULT_WORKER, id: 'w2', spawnedAt: 1 * MIN },
  ]
  expect(progressOf({ tasks: [], run: null, workers, now: 2 * MIN })).toEqual({
    source: 'workers',
    done: 1,
    total: 2,
    pct: 50,
    etaMs: 3 * MIN,
    meanMs: 4 * MIN,
  })
  expect(progressOf({ tasks: [], run: null, workers: [], now: 0 })).toBe(null)
})

test('now: the running worker, else the task in progress, else main activity; next: first pending task', () => {
  const main = { model: '', effort: '', steps: 0, isRunning: true, activity: 'Bash → npm test' }
  const tasks = [task('1', 'in_progress'), task('2', 'pending')]
  const busy = [{ ...DEFAULT_WORKER, id: 'w', n: 2, description: 'run test suite' }]
  expect(nowNext({ workers: busy, tasks, main })).toEqual({ now: 'W2 run test suite', next: 't2' })
  expect(nowNext({ workers: [], tasks, main })).toEqual({ now: 't1', next: 't2' })
  expect(nowNext({ workers: [], tasks: [], main })).toEqual({ now: 'Bash → npm test', next: null })
  expect(nowNext({ workers: [], tasks: [], main: { ...main, isRunning: false } })).toEqual({ now: null, next: null })
})

test('status line shows only fields with something to say', () => {
  const progress = { source: 'tasks' as const, done: 4, total: 9, pct: 44, etaMs: 12 * MIN, meanMs: 3 * MIN }
  expect(statusText({ progress, ctxPct: 62, running: 2, flagged: 1 })).toBe('44% · ~12m · ctx 62% · 2 running · 1⚠')
  expect(statusText({ progress: null, ctxPct: null, running: 0, flagged: 0 })).toBe(undefined)
})

test('the status line ends with the number of live servers, and says nothing for none', () => {
  const progress = { source: 'tasks' as const, done: 4, total: 9, pct: 44, etaMs: 12 * MIN, meanMs: 3 * MIN }
  expect(statusText({ progress, ctxPct: 62, running: 2, flagged: 1, servers: 2 })).toBe('44% · ~12m · ctx 62% · 2 running · 1⚠ · 2 srv')
  expect(statusText({ progress: null, ctxPct: 50, running: 0, flagged: 0, servers: 1 })).toBe('ctx 50% · 1 srv')
  expect(statusText({ progress: null, ctxPct: null, running: 0, flagged: 0, servers: 0 })).toBe(undefined)
})

test('an open workflow run never reads 100% from the agents seen so far; an ended one can', () => {
  const oneDone: WorkflowRun = { ...run, agents: [{ id: 'a', phase: null, isDone: true, firstAt: 0, lastAt: 2 * MIN }] }
  const open = progressOf({ tasks: [], run: oneDone, workers: [], now: 3 * MIN })
  expect(open).toEqual({ source: 'agents', done: 1, total: 1, pct: 99, etaMs: null, meanMs: 2 * MIN })
  expect(open && isComplete(open)).toBe(false)
  const ended = progressOf({ tasks: [], run: { ...oneDone, endedAt: 4 * MIN }, workers: [], now: 5 * MIN })
  expect(ended).toEqual({ source: 'agents', done: 1, total: 1, pct: 100, etaMs: null, meanMs: 2 * MIN })
  expect(ended && isComplete(ended)).toBe(true)
})

test('complete means every counted item is done; the status line then has no ETA', () => {
  const finished = { source: 'tasks' as const, done: 3, total: 3, pct: 100, etaMs: 0, meanMs: 2 * MIN }
  const under = { source: 'tasks' as const, done: 2, total: 3, pct: 67, etaMs: 0, meanMs: 2 * MIN }
  expect([isComplete(finished), isComplete(under)]).toEqual([true, false])
  expect(statusText({ progress: finished, ctxPct: 62, running: 0, flagged: 0 })).toBe('100% · ctx 62%')
  expect(statusText({ progress: under, ctxPct: 62, running: 0, flagged: 0 })).toBe('67% · <1m · ctx 62%')
  const tasks = [task('1', 'completed', { completedAt: 2 * MIN }), task('2', 'completed', { completedAt: 3 * MIN })]
  const p = progressOf({ tasks, run: null, workers: [], now: 4 * MIN })
  expect(p && isComplete(p)).toBe(true)
  const w = [{ ...DEFAULT_WORKER, id: 'w1', status: 'done' as const, spawnedAt: 0, endedAt: MIN }]
  const q = progressOf({ tasks: [], run: null, workers: w, now: 2 * MIN })
  expect(q && isComplete(q)).toBe(true)
})
