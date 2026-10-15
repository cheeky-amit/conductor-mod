import { expect, test } from 'claude-code/testing'
import { archLine, archTails } from '../hooks/model/architect'
import { gateButtonCells, gateLayout, gateTotalsVariants, totalsCells } from '../hooks/model/gate'
import { receiptFit } from '../hooks/model/log'
import { fitSegments } from '../hooks/model/util'
import { runProgress, runSegments, runTail } from '../hooks/model/workflow'
import type { Architect, Bucket, Receipt, WorkflowRun } from '../types'

const WIDTHS = [40, 60, 80, 120]
const summary = (total: number, ask: number, deny: number) => ({ total, ask, deny })
const SUMMARIES = [summary(1, 0, 0), summary(31, 0, 0), summary(30, 6, 3), summary(30, 6, 0), summary(30, 0, 3), summary(1234, 12, 34)]

test('fitSegments keeps whole segments, cuts the first that does not fit, and drops the rest', () => {
  const segs = [{ text: '  Review' }, { text: ' › Verify' }, { text: ' › Ship' }]
  expect(fitSegments(segs, 40)).toEqual(segs)
  expect(fitSegments(segs, 17).map(s => s.text)).toEqual(['  Review', ' › Verify'])
  expect(fitSegments(segs, 15).map(s => s.text)).toEqual(['  Review', ' › Ver…'])
  expect(fitSegments(segs, 13).map(s => s.text)).toEqual(['  Review', ' › V…'])
  // Fewer than 5 cells left: the cut segment is dropped rather than shown as a stump.
  expect(fitSegments(segs, 11).map(s => s.text)).toEqual(['  Review'])
  expect(fitSegments(segs, 0)).toEqual([])
  expect(fitSegments([{ text: '  Review the plan' }], 8).map(s => s.text)).toEqual(['  Revie…'])
})

test('the gate buttons take label + 3 each, one cell between, and one more for the open bucket', () => {
  expect(gateButtonCells(null)).toBe(7 + 8 + 8 + 2)
  expect(gateButtonCells('shell')).toBe(26)
})

test('gate totals go from the full wording to the count alone', () => {
  const [full, short, flag, bare] = gateTotalsVariants(summary(30, 6, 3)).map(t => `${t.count}${t.ask}${t.deny}`)
  expect([full, short, flag, bare]).toEqual([' 30 checks · 6 pending · 3✗', ' 30·6?·3✗', ' 30·6?', ' 30'])
  // With nothing pending the single flag is the denial.
  expect(gateTotalsVariants(summary(30, 0, 3)).map(t => `${t.count}${t.ask}${t.deny}`)[2]).toBe(' 30·3✗')
})

test('gate layout: the totals take their room first, then 6 or more cells, else none', () => {
  const at = (width: number, s: ReturnType<typeof summary>, recent: number, open: Bucket | null = null) =>
    gateLayout({ width, labelW: 6, summary: s, recent, open })
  // 120: 6 + 2 + 25 + 27 (` 30 checks · 6 pending · 3✗`) leave 60 cells; only 30 checks are held.
  expect(at(120, summary(30, 6, 3), 30)).toMatchObject({ cells: 30, gap: 2 })
  expect(at(120, summary(30, 6, 3), 80).cells).toBe(60)
  // 60: 6 + 2 + 25 + 10 (` 31 checks`) leave 17.
  expect(at(60, summary(31, 0, 0), 80).cells).toBe(17)
  // 40: the fullest wording that fits is the one flag (6), leaving 2: under 6, so no cells.
  expect(at(40, summary(30, 6, 3), 30)).toMatchObject({ cells: 0, gap: 1, totals: { count: ' 30', ask: '·6?', deny: '' } })
  // 40 with one check: ` 1 checks` (9) would need 41; the bare count leaves exactly 6 cells.
  expect(at(40, summary(1, 0, 0), 80)).toMatchObject({ cells: 6, totals: { count: ' 1', ask: '', deny: '' } })
})

test('gate layout never passes the width, at 40, 60, 80 and 120, open or closed', () => {
  for (const width of WIDTHS)
    for (const s of SUMMARIES)
      for (const open of [null, 'file', 'shell', 'other'] as const) {
        const l = gateLayout({ width, labelW: 6, summary: s, recent: 80, open })
        expect(6 + l.cells + totalsCells(l.totals) + l.gap + gateButtonCells(open)).toBeLessThanOrEqual(width)
        expect(l.cells === 0 || l.cells >= 6).toBe(true)
      }
})

const arch = (n: number, over: Partial<Architect> = {}): Architect => ({
  consults: Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    at: 1000 * i,
    endAt: 1000 * i + 500,
    moment: 'before done' as const,
    via: 'architect',
  })),
  ids: [],
  seen: [],
  lastAdvice: '',
  ...over,
})

test('architect tails say less as the room shrinks, and advising replaces the last consult', () => {
  expect(archTails(arch(2), 70_000)).toEqual([
    '  2 consults · last 1m09s ago · before done',
    '  2 consults · last 1m09s ago',
    '  2 consults',
  ])
  const open = arch(2, { consults: [{ id: 'c', at: 0, endAt: null, moment: 'before a plan', via: 'x' }] })
  expect(archTails(open, 5000)).toEqual(['  1 consult · advising', '  1 consult'])
})

test('the architect line keeps a timeline of 8 cells or more and never passes its room', () => {
  for (const room of [34, 54, 74, 114])
    for (const n of [1, 2, 12, 40]) {
      const l = archLine(arch(n), 3_600_000, room)
      expect(l.timeline.length + l.tail.length).toBeLessThanOrEqual(room)
      expect(l.timeline.length).toBeGreaterThanOrEqual(8)
      expect(l.timeline.length).toBeLessThanOrEqual(24)
    }
  // 34 cells: the moment and the age do not fit beside an 8-cell timeline, the count does.
  expect(archLine(arch(12), 11_500 + 3_600_000, 34).tail).toBe('  12 consults')
  expect(archLine(arch(12), 11_500 + 3_600_000, 114).tail).toBe('  12 consults · last 1h00m ago · before done')
})

test('receipt wording gives up the cost, then `last turn`, then the long words, in that order', () => {
  const r: Receipt = { durationMs: 4000, agents: 3, edits: 12, errors: 0, costDelta: 0.25, reason: 'answer' }
  const wording = (room: number) => {
    const v = receiptFit(r, room)
    return `${v.body}${v.cost}`
  }
  expect(wording(80)).toBe('last turn 4s · 3 workers · 12 edits · 0 errors · +$0.25')
  expect(wording(50)).toBe('last turn 4s · 3 workers · 12 edits · 0 errors')
  expect(wording(40)).toBe('4s · 3 workers · 12 edits · 0 errors')
  expect(wording(30)).toBe('4s · 3w · 12e · 0err')
  // Even then the errors count is kept.
  expect(wording(5)).toBe('4s · 3w · 12e · 0err')
})

const run = (over: Partial<WorkflowRun>): WorkflowRun => ({
  id: 'r',
  ref: null,
  name: 'sweep',
  phases: ['Review', 'Verify'],
  startedAt: 0,
  endedAt: null,
  agents: [],
  ...over,
})

test('run segments: one plain list without phase data, one state per phase with it', () => {
  const plain = run({ agents: [{ id: 'a', phase: null, isDone: false, firstAt: 0, lastAt: 0 }] })
  expect(runSegments(plain, runProgress(plain))).toEqual([{ text: '  Review › Verify', state: 'plain' }])
  const phased = run({
    agents: [
      { id: 'a', phase: 'Review', isDone: true, firstAt: 0, lastAt: 0 },
      { id: 'b', phase: 'Verify', isDone: false, firstAt: 0, lastAt: 0 },
    ],
  })
  expect(runSegments(phased, runProgress(phased))).toEqual([
    { text: '  Review ✓', state: 'done' },
    { text: ' › Verify 0/1', state: 'current' },
  ])
  expect(runSegments(run({ phases: [] }), runProgress(run({ phases: [] })))).toEqual([])
})

test('run tail: the agent count while running, how long it took once ended', () => {
  const r = run({ agents: [{ id: 'a', phase: null, isDone: true, firstAt: 0, lastAt: 0 }] })
  expect(runTail(r, runProgress(r))).toBe('  1/1 agents')
  const ended = { ...r, endedAt: 258_000 }
  expect(runTail(ended, runProgress(ended))).toBe('  ✓ done in 4m18s')
})
