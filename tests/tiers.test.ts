import { expect, test } from 'claude-code/testing'
import type { PriceRule, TierRule } from '../hooks/model/tiers'
import { estUsd, family, isFlagged, modelSourceOf, tierOf, tierStrip, tierTotals } from '../hooks/model/tiers'
import type { Worker } from '../types'

const TIERS: TierRule[] = [
  { tier: 'T0', re: /haiku/i },
  { tier: 'T1', re: /sonnet/i },
  { tier: 'T2', re: /opus/i },
  { tier: 'T3', re: /fable|mythos/i },
]
const PRICES: PriceRule[] = [
  { re: /opus/i, price: { in: 4, out: 20, cacheRead: 0.2 } },
  { re: /sonnet/i, price: { in: 2, out: 10, cacheRead: 0.2 } },
]
const w = (over: Partial<Worker>): Worker => ({
  id: 'x',
  n: 1,
  type: 'general-purpose',
  description: '',
  model: 'claude-sonnet-5-5',
  modelSource: 'explicit',
  status: 'done',
  spawnedAt: 0,
  endedAt: 1,
  steps: 1,
  ctx: 0,
  out: 0,
  tokIn: 0,
  tokCacheRead: 0,
  tokCacheWrite: 0,
  lastStop: null,
  tools: [],
  answer: '',
  ...over,
})

test('models map to tiers by the first matching rule; unknown models have none', () => {
  expect(['claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-opus-5-5[1m]', 'claude-fable-5-1', 'gpt-x'].map(m => tierOf(m, TIERS))).toEqual([
    'T0',
    'T1',
    'T2',
    'T3',
    null,
  ])
})

test('model source: passed, from the definition (linked or not), inherited, or likely inherited', () => {
  const parent = 'claude-opus-5-5'
  expect(modelSourceOf({ requested: 'sonnet', resolved: 'claude-sonnet-5-5', parent })).toBe('explicit')
  // Linked, none passed: the parent's model is inherited, any other came from the agent's definition.
  expect(modelSourceOf({ requested: null, resolved: parent, parent })).toBe('inherited')
  expect(modelSourceOf({ requested: null, resolved: 'claude-sonnet-5-5', parent })).toBe('definition-unpassed')
  // Not linked: whether a model was passed is unknown.
  expect(modelSourceOf({ requested: undefined, resolved: parent, parent })).toBe('likely-inherited')
  expect(modelSourceOf({ requested: undefined, resolved: 'claude-haiku-4-5', parent })).toBe('definition')
})

test('every worker launched without an explicit model is flagged, except one whose call could not be linked and ran another model', () => {
  expect((['inherited', 'likely-inherited', 'definition-unpassed', 'explicit', 'definition'] as const).map(isFlagged)).toEqual([
    true,
    true,
    true,
    false,
    false,
  ])
})

test('estimated cost prices input, cache writes (1.25x), cache reads and output', () => {
  const usd = estUsd(w({ tokIn: 1_000_000, tokCacheWrite: 1_000_000, tokCacheRead: 1_000_000, out: 1_000_000 }), PRICES)
  expect(Math.abs((usd ?? Number.NaN) - (2 + 2.5 + 0.2 + 10))).toBeLessThan(1e-6)
  expect(estUsd(w({ model: 'claude-haiku-4-5' }), PRICES)).toBe(null)
})

test('tier totals add tokens per tier; $ only when every worker in the tier is priced', () => {
  const totals = tierTotals(
    [w({ id: 'a', out: 1000, tokIn: 500 }), w({ id: 'b', out: 2000 }), w({ id: 'c', model: 'claude-haiku-4-5', out: 10 })],
    TIERS,
    PRICES,
  )
  const t1 = totals.find(t => t.tier === 'T1')
  const t0 = totals.find(t => t.tier === 'T0')
  expect([t1?.workers, t1?.tokens]).toEqual([2, 3500])
  expect(Math.abs((t1?.usd ?? Number.NaN) - (500 * 2 + 3000 * 10) / 1_000_000)).toBeLessThan(1e-9)
  expect([t0?.workers, t0?.usd]).toEqual([1, null])
  expect(totals.find(t => t.tier === 'T3')?.workers).toBe(0)
})

test('family is the model line in lower case', () => {
  expect([family('claude-sonnet-5-5'), family('claude-opus-5-5[1m]'), family('')]).toEqual(['sonnet', 'opus', '—'])
})

test('the tiers strip leads with its `est` label and drops $ before it drops a tier', () => {
  const totals = tierTotals(
    [w({ id: 'a', out: 41_000 }), w({ id: 'b', out: 100 }), w({ id: 'c', model: 'claude-opus-5-5', out: 12_000 })],
    TIERS,
    PRICES,
  ).filter(t => t.workers > 0)
  const line = (width: number) => {
    const s = tierStrip(totals, width)
    return `${s.head}${s.entries.map(e => e.text).join('')}${s.more > 0 ? `  +${s.more}` : ''}`
  }
  expect(line(120)).toBe('tiers est  T1 ▮▮ 41k ~$0.41  T2 ▮ 12k ~$0.24')
  expect(line(40)).toBe('tiers est  T1 ▮▮ 41k  T2 ▮ 12k')
  expect(line(25)).toBe('tiers est  T1 ▮▮ 41k  +1')
  expect(line(5)).toBe('tiers est  T1 ▮▮ 41k  +1')
  for (const width of [120, 60, 40, 30, 25]) expect(line(width).startsWith('tiers est')).toBe(true)
  for (const width of [120, 60, 40, 30, 25]) expect(line(width).length).toBeLessThanOrEqual(width)
})
