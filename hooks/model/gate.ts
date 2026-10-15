// Ported from Flightdeck v0.4.0 (MIT, Stephen Casella), hooks/core.ts.
// Pure: nothing here touches `$`.
import type { Bucket, Check, Gate, Tally } from '../../types'
import { listOf, normalize } from './util'

const ZERO: Tally = { rule: 0, ask: 0, cleared: 0, deny: 0 }
export const DEFAULT_GATE: Gate = { recent: [], totals: { file: ZERO, shell: ZERO, other: ZERO } }

export const normalizeGate = (stored: unknown): Gate => {
  const g = normalize(DEFAULT_GATE, stored)
  const totals = normalize(DEFAULT_GATE.totals, g.totals)
  return {
    recent: listOf<Check>(g.recent),
    totals: { file: normalize(ZERO, totals.file), shell: normalize(ZERO, totals.shell), other: normalize(ZERO, totals.other) },
  }
}

/** Keeps the last `max` checks, but never drops a pending ask: its settle must still find it. */
export const trimRecent = (list: Check[], max: number): Check[] => {
  let extra = list.length - max
  if (extra <= 0) return list
  const out: Check[] = []
  for (const c of list) {
    if (extra > 0 && c.verdict !== 'ask') {
      extra -= 1
      continue
    }
    out.push(c)
  }
  return out.slice(-max * 2)
}

export const recordCheck = (g: Gate, c: Check): Gate => {
  const t = g.totals[c.bucket]
  return {
    recent: trimRecent([...g.recent, c], 80),
    totals: { ...g.totals, [c.bucket]: { ...t, [c.verdict]: t[c.verdict] + 1 } },
  }
}

/** An `ask` settled by the call that followed it: it ran (cleared) or was refused (deny). */
export const settleCheck = (g: Gate, id: string, didRun: boolean): Gate => {
  const c = g.recent.find(r => r.id === id && r.verdict === 'ask')
  if (!c) return g
  const verdict = didRun ? 'cleared' : 'deny'
  const t = g.totals[c.bucket]
  return {
    recent: g.recent.map(r => (r === c ? { ...r, verdict } : r)),
    totals: { ...g.totals, [c.bucket]: { ...t, ask: Math.max(0, t.ask - 1), [verdict]: t[verdict] + 1 } },
  }
}

export const gateSummary = (g: Gate) => {
  const all = (['file', 'shell', 'other'] as const).reduce(
    (s, k) => ({
      rule: s.rule + g.totals[k].rule,
      ask: s.ask + g.totals[k].ask,
      cleared: s.cleared + g.totals[k].cleared,
      deny: s.deny + g.totals[k].deny,
    }),
    { ...ZERO },
  )
  return { ...all, total: all.rule + all.ask + all.cleared + all.deny }
}

export const GATE_BUCKETS: readonly Bucket[] = ['file', 'shell', 'other']

/** Cells the three drill-down buttons take. Each draws `f: file`, 3 more than its label; one cell between them; `▾` marks the open one. */
export const gateButtonCells = (open: Bucket | null) =>
  GATE_BUCKETS.reduce((n, b) => n + 3 + b.length + (open === b ? 1 : 0), GATE_BUCKETS.length - 1)

/** The totals as three parts, so the pane can colour pending and denied apart. */
export type GateTotals = { count: string; ask: string; deny: string }
export const totalsCells = (t: GateTotals) => t.count.length + t.ask.length + t.deny.length

/**
 * The totals from most said to least: `31 checks · 2 pending · 1✗`, then `31·2?·1✗`, then one flag
 * (pending before denied), then the count alone.
 */
export const gateTotalsVariants = (s: Pick<ReturnType<typeof gateSummary>, 'total' | 'ask' | 'deny'>): GateTotals[] => {
  const count = ` ${s.total}`
  const ask = s.ask > 0 ? `·${s.ask}?` : ''
  const deny = s.deny > 0 ? `·${s.deny}✗` : ''
  return [
    { count: `${count} checks`, ask: s.ask > 0 ? ` · ${s.ask} pending` : '', deny: s.deny > 0 ? ` · ${s.deny}✗` : '' },
    { count, ask, deny },
    { count, ask, deny: ask ? '' : deny },
    { count, ask: '', deny: '' },
  ]
}

/**
 * How the gate row spends its width: label, strip cells, totals, a gap, then the three buttons.
 * The totals take their room first: the fullest wording that fits with no cells at all. Whatever is
 * left becomes strip cells, but only from 6 up; below that the cells are dropped.
 */
export const gateLayout = (o: {
  width: number
  labelW: number
  summary: Pick<ReturnType<typeof gateSummary>, 'total' | 'ask' | 'deny'>
  recent: number
  open: Bucket | null
}): { cells: number; totals: GateTotals; gap: number } => {
  const gap = o.width < 60 ? 1 : 2
  const room = (t: GateTotals) => o.width - o.labelW - gap - gateButtonCells(o.open) - totalsCells(t)
  const variants = gateTotalsVariants(o.summary)
  const totals = variants.find(t => room(t) >= 0) ?? (variants[variants.length - 1] as GateTotals)
  const left = room(totals)
  return { cells: left >= 6 ? Math.min(left, o.recent) : 0, totals, gap }
}
