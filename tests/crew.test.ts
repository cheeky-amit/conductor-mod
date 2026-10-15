import { expect, test } from 'claude-code/testing'

import {
  addWorker,
  boxOrder,
  boxStats,
  completeWorker,
  DEFAULT_WORKER,
  drawOrder,
  MAX_WORKERS,
  nextN,
  normalizeWorker,
  stepWorker,
  timeBar,
  updateWorker,
} from '../hooks/model/crew'

const mk = (id: string, n: number, over = {}) => ({ ...DEFAULT_WORKER, id, n, ...over })

test('a step updates context to the latest input and sums tokens by kind', () => {
  let x = mk('a', 1)
  x = stepWorker(x, {
    model: 'claude-sonnet-5-5',
    usage: { input_tokens: 10, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2_000, output_tokens: 500 },
    stopReason: 'tool_use',
  })
  x = stepWorker(x, {
    model: 'claude-sonnet-5-5',
    usage: { input_tokens: 5, cache_read_input_tokens: 40_000, output_tokens: 700 },
    stopReason: 'max_tokens',
  })
  expect([x.ctx, x.out, x.steps, x.tokIn, x.tokCacheRead, x.tokCacheWrite, x.lastStop, x.model]).toEqual([
    40_005,
    1200,
    2,
    15,
    70_000,
    2000,
    'max_tokens',
    'claude-sonnet-5-5',
  ])
  expect(stepWorker(x, { model: 'm', usage: null, stopReason: null }).ctx).toBe(40_005)
})

test('completion maps the reason to a status and keeps the start of the answer', () => {
  const x = mk('a', 1, { spawnedAt: 100 })
  expect(completeWorker(x, { reason: 'answer', at: 200, answer: 'ok' })).toEqual({ ...x, status: 'done', endedAt: 200, answer: 'ok' })
  expect(completeWorker(x, { reason: 'aborted', at: 200, answer: '' }).status).toBe('stopped')
  expect(completeWorker(x, { reason: 'error', at: 200, answer: '' }).status).toBe('failed')
})

test('completion masks a credential in the answer before it is kept', () => {
  const x = mk('a', 1, { spawnedAt: 100 })
  const done = completeWorker(x, { reason: 'answer', at: 200, answer: 'Set API_TOKEN=abcdefghijklmnop1234 then run the build' })
  expect(done.answer).toBe('Set API_TOKEN=••• then run the build')
  expect(done.answer).not.toContain('abcdefghijklmnop1234')
})

test('the list keeps the newest MAX_WORKERS, replaces by id, and numbers spawns', () => {
  let list = [] as ReturnType<typeof addWorker>
  for (let i = 0; i < MAX_WORKERS + 2; i += 1) list = addWorker(list, mk(`w${i}`, nextN(list)))
  expect(list.length).toBe(MAX_WORKERS)
  expect(list[list.length - 1]?.n).toBe(MAX_WORKERS + 2)
  list = updateWorker(list, 'w5', w => ({ ...w, status: 'done' }))
  expect(list.find(w => w.id === 'w5')?.status).toBe('done')
  expect(normalizeWorker({ id: 'z' }).tools).toEqual([])
})

test('at the cap, the oldest finished worker goes first; a running one only when all are running', () => {
  let list = [] as ReturnType<typeof addWorker>
  for (let i = 0; i < MAX_WORKERS; i += 1) list = addWorker(list, mk(`w${i}`, nextN(list)))
  list = updateWorker(list, 'w1', w => ({ ...w, status: 'done' }))
  list = updateWorker(list, 'w2', w => ({ ...w, status: 'failed' }))
  list = addWorker(list, mk('new1', nextN(list)))
  expect(list.length).toBe(MAX_WORKERS)
  expect(list.some(w => w.id === 'w0' && w.status === 'running')).toBe(true) // the oldest, still running, stays
  expect(list.some(w => w.id === 'w1')).toBe(false) // the oldest finished one is dropped
  expect(list.some(w => w.id === 'w2')).toBe(true)
  list = addWorker(list, mk('new2', nextN(list)))
  expect(list.some(w => w.id === 'w2')).toBe(false) // then the next finished one
  expect(list.some(w => w.id === 'w0')).toBe(true)
  // Every worker running: the oldest of them gives way.
  let running = [] as ReturnType<typeof addWorker>
  for (let i = 0; i < MAX_WORKERS + 1; i += 1) running = addWorker(running, mk(`r${i}`, nextN(running)))
  expect(running.map(w => w.id)).toEqual(Array.from({ length: MAX_WORKERS }, (_, i) => `r${i + 1}`))
})

test('time bar places a run on the shared axis and never overflows', () => {
  expect(timeBar({ spawnedAt: 0, endedAt: 50 }, 0, 100, 10)).toEqual({ before: 0, bar: 5, after: 5 })
  expect(timeBar({ spawnedAt: 50, endedAt: null }, 0, 100, 10)).toEqual({ before: 5, bar: 5, after: 0 })
  const tiny = timeBar({ spawnedAt: 99, endedAt: 100 }, 0, 100, 10)
  expect(tiny.before + tiny.bar + tiny.after).toBe(10)
  expect(tiny.bar).toBe(1)
})

test('draw order: running first, then finished, each newest first', () => {
  const ws = [mk('a', 1, { status: 'done' }), mk('b', 2), mk('c', 3, { status: 'failed' }), mk('d', 4)]
  expect(drawOrder(ws).map(w => w.id)).toEqual(['d', 'b', 'c', 'a'])
  // The newest eight survive a cut to eight rows.
  const many = Array.from({ length: 12 }, (_, i) => mk(`w${i + 1}`, i + 1))
  expect(
    drawOrder(many)
      .slice(0, 8)
      .map(w => w.n),
  ).toEqual([12, 11, 10, 9, 8, 7, 6, 5])
})

test('box order is spawn order, whatever the status', () => {
  const ws = [mk('c', 3), mk('a', 1, { status: 'done' }), mk('d', 4, { status: 'failed' }), mk('b', 2)]
  expect(boxOrder(ws).map(w => w.id)).toEqual(['a', 'b', 'c', 'd'])
  expect(ws.map(w => w.id)).toEqual(['c', 'a', 'd', 'b']) // the list itself is left alone
})

test('box stats: tokens then steps while they fit, steps alone when not, steps always', () => {
  expect(boxStats({ out: 18_000, steps: 7 }, 12)).toBe(' 18k · 7st')
  expect(boxStats({ out: 18_000, steps: 7 }, 9)).toBe(' · 7st')
  expect(boxStats({ out: 18_000, steps: 7 }, 6)).toBe(' · 7st')
  expect(boxStats({ out: 18_000, steps: 12 }, 6)).toBe(' 12st')
  expect(boxStats({ out: 0, steps: 0 }, 0)).toBe(' 0st')
})
