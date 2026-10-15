// Inline above the prompt (and any pane under 40 columns): at most 8 rows, each one line cut to the width.
import type { Worker } from '../../types'
import { contextLevel, tierColor } from '../model/config'
import { drawOrder } from '../model/crew'
import type { Progress } from '../model/progress'
import { family, isFlagged, tierOf } from '../model/tiers'
import { prettyModel, shorten } from '../model/util'
import type { Kit, PaneData } from './kit'
import { nowNextRow, progressRow } from './progress'
import { serversInlineFit } from './servers'
import { glyph, statusColor } from './tree'

/** The narrowest pane the mini layout draws for; a narrower host clips it. */
export const MINI_MIN = 20
const MINI_WORKERS = 3

/**
 * The orchestrator line: `Opus 5.5 T2 · ctx 72%`, and past the red line `· checkpoint now`. The context and the alarm are what
 * stay: the model name takes whatever room is left and goes first. Too narrow for the full tail, the separator and then the word
 * `ctx` give way, so the alarm is never what gets cut. Live servers (` · srv :3300●`) come last on the line and are cut before
 * anything else: they get only the room left once the context, the alarm and the whole model name have theirs.
 */
const orchestratorLine = (k: Kit, d: PaneData, W: number) => {
  const { Text } = k.els
  const tier = tierOf(d.main.model, k.cfg.tiers)
  const level = contextLevel(d.usage.pct, k.cfg)
  const pct = d.usage.pct !== null ? `${Math.round(d.usage.pct)}%` : '—'
  const ctxColor = level === 'red' ? k.C.warn : level === 'amber' ? k.C.amber : level === 'ok' ? k.C.ok : k.C.dim
  const alarm = level === 'red' ? 'checkpoint now' : null
  const variants = alarm
    ? [
        { ctx: `ctx ${pct}`, sep: ' · ' },
        { ctx: `ctx ${pct}`, sep: ' ' },
        { ctx: pct, sep: ' ' },
      ]
    : [{ ctx: `ctx ${pct}`, sep: '' }]
  const cells = (v: (typeof variants)[number]) => v.ctx.length + (alarm ? v.sep.length + alarm.length : 0)
  const tail = variants.find(v => cells(v) <= W) ?? (variants[variants.length - 1] as (typeof variants)[number])
  // The model name and its ` · ` come first on the row, so they get what the tail leaves. Before the first step there is no model to name.
  const room = W - cells(tail) - 3
  const name = d.main.model !== '' ? `${prettyModel(d.main.model)}${tier ? ` ${tier}` : ''}` : ''
  // What the servers may take is what the whole name leaves; a name that had to be cut leaves them nothing.
  const spare = W - cells(tail) - (name !== '' ? name.length + 3 : 0)
  const srv = k.cfg.panels.includes('servers') && d.servers.length > 0 ? serversInlineFit(d, spare) : ''
  return (
    <Text wrap="truncate">
      {name !== '' && room >= 4 ? (
        <Text bold color={tierColor(k.C, tier)}>
          {`${shorten(name, room)} · `}
        </Text>
      ) : null}
      <Text color={ctxColor}>{tail.ctx}</Text>
      {alarm ? <Text dimColor>{tail.sep}</Text> : null}
      {alarm ? (
        <Text bold color={k.C.warn}>
          {alarm}
        </Text>
      ) : null}
      {srv !== '' ? <Text dimColor>{srv}</Text> : null}
    </Text>
  )
}

/**
 * One worker: `W4⚠ T1 sonnet ● title`. The label (number, ⚠, tier, family) and the status glyph always stay; the title takes what
 * is left and is dropped when fewer than 4 cells remain.
 */
const workerLine = (k: Kit, w: Worker, W: number) => {
  const { Text } = k.els
  const tier = tierOf(w.model, k.cfg.tiers)
  const flagged = isFlagged(w.modelSource)
  const head = `W${w.n}`
  const rest = ` ${tier ?? '—'} ${shorten(family(w.model), Math.max(4, Math.min(12, W - 12)))}`
  const title = shorten(w.description || w.type, W - head.length - (flagged ? 1 : 0) - rest.length - 3)
  return (
    <Text key={`mini-${w.id}`} wrap="truncate">
      <Text bold color={tierColor(k.C, tier)}>
        {head}
      </Text>
      {flagged ? <Text color={k.C.amber}>⚠</Text> : null}
      <Text bold color={tierColor(k.C, tier)}>
        {rest}
      </Text>
      <Text color={statusColor(k, w)}>{` ${glyph(w)}`}</Text>
      {title.length >= 4 ? <Text>{` ${title}`}</Text> : null}
    </Text>
  )
}

/**
 * Progress, now/next, the orchestrator, up to 3 workers, `+n more`, the last log line: 8 rows at most. A panel the person switched
 * off in `panels` is not drawn here either. `canSwitch` is whether `/conductor-mod layout hybrid` would bring the hybrid layout back.
 */
export const drawMini = (
  k: Kit,
  d: PaneData,
  W: number,
  pr: Progress | null,
  nn: { now: string | null; next: string | null },
  canSwitch: boolean,
) => {
  const { Box, Text } = k.els
  const on = (panel: string) => (k.cfg.panels as string[]).includes(panel)
  const live = on('crew') ? drawOrder(d.workers).slice(0, MINI_WORKERS) : []
  const more = on('crew') ? d.workers.length - live.length : 0
  const moreText = `+${more} more`
  const hint = `${moreText} · /conductor-mod layout hybrid`
  const last = on('log') ? d.log[d.log.length - 1] : undefined
  return (
    <Box flexDirection="column" width={W}>
      {on('progress') ? progressRow(k, pr, W) : null}
      {nowNextRow(k, nn, W)}
      {orchestratorLine(k, d, W)}
      {live.map(w => workerLine(k, w, W))}
      {more > 0 ? (
        <Text color={k.C.faint} wrap="truncate">
          {canSwitch && hint.length <= W ? hint : moreText}
        </Text>
      ) : null}
      {last ? (
        <Text dimColor wrap="truncate">
          {shorten(`${last.who} ${last.text}`, W)}
        </Text>
      ) : null}
    </Box>
  )
}
