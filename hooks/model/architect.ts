// Ported from Flightdeck v0.4.0 (MIT, Stephen Casella), hooks/core.ts.
// Pure: nothing here touches `$`.
import type { Architect, Moment, Receipt, Turn } from '../../types'
import { fmtDuration, redact, shorten } from './util'

export const DEFAULT_ARCHITECT: Architect = { consults: [], ids: [], seen: [], lastAdvice: '' }
export const DEFAULT_TURN: Turn = { edits: 0, errorStreak: 0, errors: 0, isReviewing: false, startedAt: 0, costAtStart: null }

/**
 * The turn after one tool call. Errors count in the main loop only (a subagent's failure is its
 * own); edits count from every loop, so delegated work still reaches "before done".
 */
export const afterCall = (t: Turn, c: { inSubagent: boolean; hasFailed: boolean; isEdit: boolean }): Turn => ({
  ...t,
  errorStreak: c.inSubagent ? t.errorStreak : c.hasFailed ? t.errorStreak + 1 : 0,
  errors: t.errors + (!c.inSubagent && c.hasFailed ? 1 : 0),
  edits: t.edits + (c.isEdit ? 1 : 0),
})

/** Which of the architect's three moments a consult falls at: an inference over this turn so far. */
export const momentOf = (t: Pick<Turn, 'edits' | 'errorStreak'>): Moment =>
  t.errorStreak >= 2 ? 'error repeats' : t.edits === 0 ? 'before a plan' : 'before done'

export const startConsult = (a: Architect, c: { id: string; at: number; moment: Moment; via: string }): Architect =>
  a.consults.some(x => x.id === c.id) ? a : { ...a, consults: [...a.consults, { ...c, endAt: null }].slice(-40) }

/** Ends the open consult (the latest without an end), or the one named. */
export const endConsult = (a: Architect, at: number, advice: string | null, id?: string): Architect => {
  const open = [...a.consults].reverse().find(c => c.endAt === null && (id === undefined || c.id === id))
  return {
    ...a,
    consults: a.consults.map(c => (c === open ? { ...c, endAt: at } : c)),
    lastAdvice: advice ?? a.lastAdvice,
  }
}

export const isAdvising = (a: Architect) => a.consults.some(c => c.endAt === null)

/** A one-row timeline of consults across `width` cells: ◆ a consult, ━ while it ran. */
export const consultTimeline = (a: Architect, now: number, width: number) => {
  if (a.consults.length === 0 || width < 4) return '─'.repeat(Math.max(0, width))
  const first = a.consults[0]?.at ?? now
  const span = Math.max(1, now - first)
  const cells = Array.from({ length: width }, () => '─')
  for (const c of a.consults) {
    const from = Math.min(width - 1, Math.floor(((c.at - first) / span) * (width - 1)))
    const to = Math.min(width - 1, Math.floor((((c.endAt ?? now) - first) / span) * (width - 1)))
    for (let i = from + 1; i <= to; i += 1) cells[i] = '━'
    cells[from] = '◆'
  }
  return cells.join('')
}

/** The words after the timeline, fullest first: count, then how long ago and at what moment, or `advising`. */
export const archTails = (a: Architect, now: number): string[] => {
  const count = `  ${a.consults.length} consult${a.consults.length === 1 ? '' : 's'}`
  if (isAdvising(a)) return [`${count} · advising`, count]
  const last = a.consults[a.consults.length - 1]
  if (!last) return [count]
  const ago = `${count} · last ${fmtDuration(now - (last.endAt ?? last.at))} ago`
  return [`${ago} · ${last.moment}`, ago, count]
}

/** The architect row beside its label: the fullest tail that leaves the timeline 8 cells, the timeline taking what remains (up to 24). */
export const archLine = (a: Architect, now: number, room: number): { timeline: string; tail: string } => {
  const tails = archTails(a, now)
  const tail = tails.find(t => room - t.length >= 8) ?? (tails[tails.length - 1] as string)
  return { timeline: consultTimeline(a, now, Math.max(0, Math.min(24, room - tail.length))), tail }
}

export const receiptOf = (t: Turn, o: { durationMs: number; agentsSince: number; costNow: number | null; reason: string }): Receipt => ({
  durationMs: o.durationMs,
  agents: o.agentsSince,
  edits: t.edits,
  errors: t.errors,
  costDelta: o.costNow !== null && t.costAtStart !== null && o.costNow - t.costAtStart >= 0.005 ? o.costNow - t.costAtStart : null,
  reason: o.reason,
})

/**
 * A subagent's hand-back message: who sent it and the first line of what it said. The report
 * follows a framing header in the message; without one, the first line after the opening tag.
 */
export const handbackOf = (text: string): { from: string; body: string } | null => {
  const from = /^\s*<agent-message\s+from="([^"]+)"/.exec(text)?.[1]
  if (!from) return null
  const afterHeader = text.split(/The report follows:\s*\n/)[1]
  const rest = afterHeader ?? text.replace(/^\s*<agent-message[^>]*>/, '')
  const body =
    rest
      .split('\n')
      .map(l => l.trim())
      .find(l => l && !l.startsWith('[') && !l.startsWith('<') && !l.startsWith('</')) ?? ''
  return body ? { from, body } : null
}

/** The advice line a pane shows for a report: its first real line, markdown markers stripped, cut to 160. */
export const adviceLine = (report: string) => {
  const first =
    report
      .split('\n')
      .map(l => l.trim())
      .find(l => l && !l.startsWith('[') && !l.startsWith('<')) ?? ''
  return shorten(first.replace(/\*\*|__/g, '').replace(/^[#>*\s-]+/, ''), 160)
}

/** What a pane stores and logs for advice: the report's advice line with credentials masked. Every advice path uses this. */
export const adviceOf = (report: string) => adviceLine(redact(report))
