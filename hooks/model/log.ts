// Ported from Flightdeck v0.4.0 (MIT, Stephen Casella), hooks/core.ts.
// Pure: nothing here touches `$`.
import type { LogLine, Receipt } from '../../types'
import { fmtDuration, fmtUsd, listOf, plural, redact, shorten } from './util'

export const LOG_MAX = 200
export const pushLog = (list: LogLine[], line: LogLine): LogLine[] => [...list, line].slice(-LOG_MAX)

export const normalizeLog = (stored: unknown): LogLine[] =>
  listOf<Record<string, unknown>>(stored).map(l => ({
    at: typeof l.at === 'number' ? l.at : 0,
    who: String(l.who ?? ''),
    text: String(l.text ?? ''),
    agentId: typeof l.agentId === 'string' ? l.agentId : null,
    kind: l.kind === 'error' || l.kind === 'consult' || l.kind === 'done' ? l.kind : 'info',
  }))

/**
 * What a turn's opening text was, for the log: the person's words, or for a turn the engine
 * opened with a tagged message (a subagent's hand-back, a task notification), that message's kind.
 */
export const promptLine = (text: string): { who: string; text: string } => {
  const tag = /^\s*<([a-z][\w-]*)/i.exec(text)?.[1]
  if (!tag) return { who: 'you', text: shorten(redact(text), 70) }
  const from = /\bfrom="([^"]+)"/.exec(text)?.[1]
  return { who: 'engine', text: shorten(`${tag.replace(/[-_]/g, ' ')}${from ? ` from ${from.slice(0, 8)}` : ''}`, 70) }
}

/**
 * The receipt's wording, fullest first, as `body` and `cost`. Narrower wordings drop the cost, then the
 * words `last turn`, then spell the counts short, so the errors count is never the part that is cut.
 */
export const receiptVariants = (r: Receipt): { body: string; cost: string }[] => {
  const dur = fmtDuration(r.durationMs)
  const cost = r.costDelta !== null ? ` · +${fmtUsd(r.costDelta)}` : ''
  const counts = `${plural(r.agents, 'worker')} · ${plural(r.edits, 'edit')} · ${plural(r.errors, 'error')}`
  return [
    { body: `last turn ${dur} · ${counts}`, cost },
    { body: `last turn ${dur} · ${counts}`, cost: '' },
    { body: `${dur} · ${counts}`, cost: '' },
    { body: `${dur} · ${r.agents}w · ${r.edits}e · ${r.errors}err`, cost: '' },
  ]
}

/** The first wording that fits `room` cells (the mark `✓ ` takes 2 of them); the shortest when none does. */
export const receiptFit = (r: Receipt, room: number) => {
  const all = receiptVariants(r)
  return all.find(v => v.body.length + v.cost.length <= room - 2) ?? (all[all.length - 1] as { body: string; cost: string })
}

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** The log row a failed hook leaves: which hook and why, with credentials masked and the reason cut to 80. */
export const failureLine = (hook: string, err: unknown) => `${hook} failed: ${shorten(redact(reasonOf(err)), 80)}`

/** The one row a pane that cannot be drawn shows: the reason masked and cut so the row fits the pane (37 cells at least). */
export const renderFailure = (err: unknown, columns: number) => {
  const lead = 'conductor-mod render failed: '
  return `${lead}${shorten(redact(reasonOf(err)), Math.max(lead.length + 8, columns) - lead.length)}`
}
