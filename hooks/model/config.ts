// The plugin's /config options, read leniently, and the colours they choose.
import type { Layout, Tier } from '../../types'
import type { PriceRule, TierRule } from './tiers'
import { TIERS } from './tiers'

export type Panel = 'progress' | 'crew' | 'plan' | 'workflow' | 'servers' | 'architect' | 'gate' | 'log'
export const PANELS: readonly Panel[] = ['progress', 'crew', 'plan', 'workflow', 'servers', 'architect', 'gate', 'log']

export const DEFAULT_TIERS = 'T0=haiku,T1=sonnet,T2=opus,T3=fable|mythos'
export const DEFAULT_PRICES = 'fable|mythos=10/50/0.25,opus=4/20/0.2,sonnet=2/10/0.2,haiku=1/5/0.1'

export type Palette = 'theme' | 'pastel'
export type Colors = Record<
  'main' | 'gate' | 'cleared' | 'arch' | 'amber' | 'warn' | 'dim' | 'faint' | 'text' | 'ok' | 'run' | 't0' | 't1' | 't2' | 't3',
  string
>

/** `theme` names the person's theme colours (light, dark, colour-blind all read); `pastel` is fixed hex for dark terminals. */
export const PALETTES: Record<Palette, Colors> = {
  theme: {
    main: 'claude',
    gate: 'success',
    cleared: 'permission',
    arch: 'merged',
    amber: 'warning',
    warn: 'error',
    dim: 'inactive',
    faint: 'subtle',
    text: 'text',
    ok: 'success',
    run: 'suggestion',
    t0: 'permission',
    t1: 'suggestion',
    t2: 'merged',
    t3: 'claude',
  },
  pastel: {
    main: '#7dd3fc',
    gate: '#86efac',
    cleared: '#5eead4',
    arch: '#c4b5fd',
    amber: '#fcd34d',
    warn: '#fca5a5',
    dim: '#6b7280',
    faint: '#3f4654',
    text: '#e5e7eb',
    ok: '#3fb950',
    run: '#58a6ff',
    t0: '#7ee0c3',
    t1: '#79c0ff',
    t2: '#d2a8ff',
    t3: '#f2cc60',
  },
}

export type Config = {
  tiers: TierRule[]
  prices: PriceRule[]
  contextAmber: number
  contextRed: number
  panels: Panel[]
  layout: Layout
  maxBoxes: number
  architect: RegExp
  architectLabel: string
  gateLabel: string
  palette: Palette
  openOnStart: boolean
  statusLine: boolean
}

const safeRegExp = (source: string, fallback: string) => {
  try {
    return new RegExp(source || fallback, 'i')
  } catch {
    return new RegExp(fallback, 'i')
  }
}

const pairs = (s: string) =>
  s
    .split(',')
    .map(p => p.trim())
    .filter(p => p.includes('='))
    .map(p => [p.slice(0, p.indexOf('=')).trim(), p.slice(p.indexOf('=') + 1).trim()] as const)
    .filter(([k, v]) => k !== '' && v !== '')

export const parseTiers = (s: string): TierRule[] =>
  pairs(s).flatMap(([t, re]) => ((TIERS as readonly string[]).includes(t) ? [{ tier: t as Tier, re: safeRegExp(re, '$^') }] : []))

export const parsePrices = (s: string): PriceRule[] =>
  pairs(s).flatMap(([re, nums]) => {
    const n = nums.split('/').map(x => (x.trim() === '' ? Number.NaN : Number(x)))
    const [i, o, r] = n
    return n.length === 3 && n.every(x => Number.isFinite(x) && x >= 0)
      ? [{ re: safeRegExp(re, '$^'), price: { in: i as number, out: o as number, cacheRead: r as number } }]
      : []
  })

export const parseConfig = (o: Readonly<Record<string, unknown>>): Config => {
  const str = (k: string, d: string) => (typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : d)
  const bool = (k: string, d: boolean) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : d)
  const num = (k: string, d: number) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : d)
  const panels = str('panels', PANELS.join(','))
    .split(',')
    .map(s => s.trim())
    .filter((p): p is Panel => (PANELS as readonly string[]).includes(p))
  const amber = num('contextAmber', 70)
  const red = num('contextRed', 80)
  const okThresholds = amber > 0 && amber < red && red <= 100
  const layout = str('layout', 'auto')
  const tiers = parseTiers(str('tiers', DEFAULT_TIERS))
  return {
    tiers: tiers.length > 0 ? tiers : parseTiers(DEFAULT_TIERS),
    prices: parsePrices(str('prices', DEFAULT_PRICES)),
    contextAmber: okThresholds ? amber : 70,
    contextRed: okThresholds ? red : 80,
    panels: panels.length > 0 ? [...new Set(panels)] : [...PANELS],
    layout: layout === 'hybrid' || layout === 'mini' ? layout : 'auto',
    maxBoxes: Math.min(6, Math.max(1, Math.round(num('maxBoxes', 3)))),
    architect: safeRegExp(str('architectPattern', ''), 'advisor|architect'),
    architectLabel: str('architectLabel', 'ARCHITECT'),
    gateLabel: str('gateLabel', 'GATE'),
    palette: str('palette', 'theme') === 'pastel' ? 'pastel' : 'theme',
    openOnStart: bool('openOnStart', true),
    statusLine: bool('statusLine', true),
  }
}

export type CtxLevel = 'unknown' | 'ok' | 'amber' | 'red'
export const contextLevel = (pct: number | null, cfg: Pick<Config, 'contextAmber' | 'contextRed'>): CtxLevel =>
  pct === null ? 'unknown' : pct >= cfg.contextRed ? 'red' : pct >= cfg.contextAmber ? 'amber' : 'ok'

export const tierColor = (C: Colors, tier: Tier | null) =>
  tier === 'T0' ? C.t0 : tier === 'T1' ? C.t1 : tier === 'T2' ? C.t2 : tier === 'T3' ? C.t3 : C.dim
