import { expect, test } from 'claude-code/testing'

import { contextLevel, PALETTES, parseConfig, parsePrices, parseTiers, tierColor } from '../hooks/model/config'

test('defaults: tiers, prices, thresholds, panels, layout', () => {
  const c = parseConfig({})
  expect(c.tiers.map(t => t.tier)).toEqual(['T0', 'T1', 'T2', 'T3'])
  expect(c.tiers[3]?.re.test('claude-mythos-5-1')).toBe(true)
  expect(c.prices.find(p => p.re.test('claude-opus-5-5'))?.price).toEqual({ in: 4, out: 20, cacheRead: 0.2 })
  expect([c.contextAmber, c.contextRed, c.maxBoxes, c.layout, c.palette, c.openOnStart, c.statusLine]).toEqual([
    70,
    80,
    3,
    'auto',
    'theme',
    true,
    true,
  ])
  expect(c.panels).toEqual(['progress', 'crew', 'plan', 'workflow', 'servers', 'architect', 'gate', 'log'])
})

test('bad values fall back; amber must sit below red', () => {
  const c = parseConfig({
    contextAmber: 90,
    contextRed: 80,
    maxBoxes: 40,
    layout: 'diagonal',
    panels: 'log, gate ,nope,gate',
    architectPattern: '([',
  })
  expect([c.contextAmber, c.contextRed, c.maxBoxes, c.layout]).toEqual([70, 80, 6, 'auto'])
  expect(c.panels).toEqual(['log', 'gate'])
  expect(parseConfig({ panels: 'servers, log' }).panels).toEqual(['servers', 'log'])
  expect(c.architect.test('advisor')).toBe(true)
})

test('tier and price strings skip malformed parts', () => {
  expect(parseTiers('T1=sonnet, T9=x, T2=, T0=haiku').map(t => t.tier)).toEqual(['T1', 'T0'])
  expect(parsePrices('opus=4/20/0.2, bad=1/x/2, sonnet=2/10').map(p => p.price)).toEqual([{ in: 4, out: 20, cacheRead: 0.2 }])
})

test('parts without a key or with blank numbers are skipped', () => {
  const tiers = parseTiers('T10, T1=sonnet')
  expect(tiers.map(t => t.tier)).toEqual(['T1'])
  expect(tiers[0]?.re.test('sonnet')).toBe(true)
  expect(tiers[0]?.re.test('T10')).toBe(false)
  const prices = parsePrices('4/20/0.2, opus=4//0.2, opus= 4/ /0.2, haiku=1/5/0.1')
  expect(prices.length).toBe(1)
  expect(prices[0]?.re.test('haiku')).toBe(true)
  expect(prices[0]?.price).toEqual({ in: 1, out: 5, cacheRead: 0.1 })
})

test('context level by threshold; tier colours by tier', () => {
  const c = parseConfig({})
  expect([contextLevel(null, c), contextLevel(50, c), contextLevel(70, c), contextLevel(80, c)]).toEqual(['unknown', 'ok', 'amber', 'red'])
  expect([tierColor(PALETTES.theme, 'T1'), tierColor(PALETTES.theme, null)]).toEqual([PALETTES.theme.t1, PALETTES.theme.dim])
})
