// Which tier a model is, where a worker's model came from, and what its tokens cost (estimated).
import type { ModelSource, Tier, Worker } from '../../types'
import { fmtUsd, kTokens, prettyModel } from './util'

export type TierRule = { tier: Tier; re: RegExp }
export type Price = { in: number; out: number; cacheRead: number }
export type PriceRule = { re: RegExp; price: Price }

export const TIERS: readonly Tier[] = ['T0', 'T1', 'T2', 'T3']

export const tierOf = (model: string, rules: TierRule[]): Tier | null => (model ? (rules.find(r => r.re.test(model))?.tier ?? null) : null)

/**
 * `requested`: the model passed on the Agent call, `null` when the call is known to have passed
 * none, `undefined` when the call could not be linked to the spawn.
 */
export const modelSourceOf = (o: { requested: string | null | undefined; resolved: string; parent: string }): ModelSource => {
  if (typeof o.requested === 'string' && o.requested !== '') return 'explicit'
  const isParents = o.resolved !== '' && o.resolved === o.parent
  if (o.requested === null) return isParents ? 'inherited' : 'definition-unpassed'
  return isParents ? 'likely-inherited' : 'definition'
}

/** Every Agent call without an explicit `model` is flagged, whatever model it ran on; one whose call could not be linked and ran another model is not (unknown). */
export const isFlagged = (s: ModelSource) => s === 'inherited' || s === 'likely-inherited' || s === 'definition-unpassed'

const priceOf = (model: string, prices: PriceRule[]) => prices.find(p => p.re.test(model))?.price ?? null

/** Tokens × the configured price; cache writes at 1.25× input. Null when the model has no price. */
export const estUsd = (w: Pick<Worker, 'model' | 'tokIn' | 'tokCacheRead' | 'tokCacheWrite' | 'out'>, prices: PriceRule[]) => {
  const p = priceOf(w.model, prices)
  if (!p) return null
  return (w.tokIn * p.in + w.tokCacheWrite * p.in * 1.25 + w.tokCacheRead * p.cacheRead + w.out * p.out) / 1_000_000
}

export type TierTotal = { tier: Tier; workers: number; tokens: number; usd: number | null }

export const tierTotals = (workers: Worker[], tiers: TierRule[], prices: PriceRule[]): TierTotal[] =>
  TIERS.map(tier => {
    const ws = workers.filter(w => tierOf(w.model, tiers) === tier)
    const usds = ws.map(w => estUsd(w, prices))
    return {
      tier,
      workers: ws.length,
      tokens: ws.reduce((s, w) => s + w.tokIn + w.tokCacheRead + w.tokCacheWrite + w.out, 0),
      usd: ws.length === 0 || usds.some(u => u === null) ? null : usds.reduce<number>((s, u) => s + (u ?? 0), 0),
    }
  })

/** `claude-sonnet-5-5` → `sonnet`. */
export const family = (model: string) => (model ? (prettyModel(model).split(' ')[0] ?? model).toLowerCase() : '—')

export type TierEntry = { tier: Tier; text: string }

const STRIP_HEAD = 'tiers est'
const tierEntry = (t: TierTotal, withUsd: boolean): TierEntry => ({
  tier: t.tier,
  text: `  ${t.tier} ${'▮'.repeat(Math.min(5, t.workers))} ${kTokens(t.tokens)}${withUsd && t.usd !== null ? ` ~${fmtUsd(t.usd)}` : ''}`,
})
const moreText = (n: number) => `  +${n}`

/**
 * The tiers strip cut to `width` cells: the `tiers est` label first, so the estimate is never what gets cut,
 * then one entry per tier. Too wide: the estimated $ go first, then the last tiers (`more` counts them).
 * At least one entry always stays.
 */
export const tierStrip = (totals: TierTotal[], width: number): { head: string; entries: TierEntry[]; more: number } => {
  const cells = (es: TierEntry[], more: number) =>
    STRIP_HEAD.length + es.reduce((n, e) => n + e.text.length, 0) + (more > 0 ? moreText(more).length : 0)
  const full = totals.map(t => tierEntry(t, true))
  if (cells(full, 0) <= width) return { head: STRIP_HEAD, entries: full, more: 0 }
  let kept = totals.map(t => tierEntry(t, false))
  while (kept.length > 1 && cells(kept, totals.length - kept.length) > width) kept = kept.slice(0, -1)
  return { head: STRIP_HEAD, entries: kept, more: totals.length - kept.length }
}
