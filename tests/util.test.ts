import { expect, test } from 'claude-code/testing'
import { failureLine, LOG_MAX, promptLine, pushLog, renderFailure } from '../hooks/model/log'
import { blocks, fmtEta, normalize } from '../hooks/model/util'

test('fmtEta says remaining time the way people do', () => {
  expect([fmtEta(null), fmtEta(20_000), fmtEta(12 * 60_000), fmtEta(65 * 60_000)]).toEqual(['', '<1m', '~12m', '~1h05m'])
})

test('blocks fills a bar by percent, clamped', () => {
  expect(blocks(50, 10)).toEqual({ on: '█████', off: '░░░░░' })
  expect(blocks(140, 4)).toEqual({ on: '████', off: '' })
  expect(blocks(-5, 3)).toEqual({ on: '', off: '░░░' })
})

test('pushLog keeps the newest LOG_MAX lines', () => {
  let list = [] as ReturnType<typeof pushLog>
  for (let i = 0; i < LOG_MAX + 5; i += 1) list = pushLog(list, { at: i, who: 'x', text: String(i), agentId: null, kind: 'info' })
  expect(list.length).toBe(LOG_MAX)
  expect(list[0]?.text).toBe('5')
})

test('normalize merges a stored object over defaults and ignores non-objects', () => {
  expect(normalize({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 })
  expect(normalize({ a: 1 }, 'junk')).toEqual({ a: 1 })
})

test('a prompt is logged with credentials masked; a tagged message names only its kind', () => {
  const p = promptLine('deploy with API_TOKEN=abcdefghijklmnop1234 now')
  expect(p.who).toBe('you')
  expect(p.text).not.toContain('abcdefghijklmnop1234')
  expect(p.text).toContain('deploy with')
  expect(promptLine('<task-notification>x</task-notification>')).toEqual({ who: 'engine', text: 'task notification' })
})

test('a failed hook leaves one log row with credentials masked and the reason cut to 80', () => {
  const row = failureLine('turn.start', new Error('boom API_TOKEN=abcdefghijklmnop1234 while reading'))
  expect(row).toBe('turn.start failed: boom API_TOKEN=••• while reading')
  expect(failureLine('tool.call', 'plain text')).toBe('tool.call failed: plain text')
  expect(failureLine('tool.call', new Error('x'.repeat(200))).length).toBe('tool.call failed: '.length + 80)
})

test('the render failure row masks credentials and fits the pane, 33 cells at least', () => {
  const err = new Error('boom API_TOKEN=abcdefghijklmnop1234 '.repeat(4))
  expect(renderFailure(err, 120)).toMatch(/^conductor render failed: boom API_TOKEN=••• boom API_TOKEN=•••/)
  expect(renderFailure(err, 120)).not.toMatch(/abcdefghijklmnop1234/)
  for (const cols of [10, 40, 60, 80, 120]) expect(renderFailure(err, cols).length).toBeLessThanOrEqual(Math.max(33, cols))
})
