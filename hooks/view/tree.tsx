// The orchestrator and its workers: boxes while they fit, one row each beyond that, and a tiers summary.
import type { Worker } from '../../types'
import { contextLevel, tierColor } from '../model/config'
import { boxOrder, boxStats, drawOrder, timeBar, workersStart } from '../model/crew'
import { family, isFlagged, tierOf, tierStrip, tierTotals } from '../model/tiers'
import { fmtDuration, fmtTimer, kTokens, prettyModel, shorten } from '../model/util'
import type { Kit, PaneData } from './kit'
import type { nowNextRow } from './progress'

export const BOX_MIN = 18
export const boxesThatFit = (W: number, max: number) => Math.max(1, Math.min(max, Math.floor((W + 2) / (BOX_MIN + 2))))

const SOURCE_LABEL: Record<Worker['modelSource'], string> = {
  explicit: 'model passed',
  definition: 'from agent definition',
  inherited: '⚠ inherited (no model passed)',
  'definition-unpassed': '⚠ no model · from definition',
  'likely-inherited': '⚠ likely inherited (inferred)',
}

/** A press handler for one worker, built by the hooks module (the views never hold `$`). */
export type OnExpand = (id: string) => () => unknown

const clock = (k: Kit, key: string, w: Worker) => {
  const els = k.els
  const { Text } = els
  if (w.spawnedAt <= 0) return <Text dimColor>—</Text>
  if (w.endedAt !== null) return <Text dimColor>{fmtDuration(w.endedAt - w.spawnedAt)}</Text>
  // The surface that has a Client ticks the clock itself; the others show the time as of this draw.
  return 'Client' in els ? (
    <els.Client key={key} module="../elapsed.tsx" props={{ since: w.spawnedAt, now: k.now, endAt: null, color: k.C.dim }} />
  ) : (
    <Text dimColor>{fmtTimer(k.now - w.spawnedAt)}</Text>
  )
}

/** Cells the clock takes: its text when finished, up to `59:59` / `99h59` while it ticks. */
const clockCells = (w: Worker) => (w.spawnedAt <= 0 ? 1 : w.endedAt !== null ? fmtDuration(w.endedAt - w.spawnedAt).length : 5)

export const glyph = (w: Worker) => (w.status === 'running' ? '●' : w.status === 'done' ? '✓' : w.status === 'failed' ? '✗' : '■')
export const statusColor = (k: Kit, w: Worker) => (w.status === 'failed' ? k.C.warn : w.status === 'done' ? k.C.ok : k.C.run)

export const orchestratorBox = (k: Kit, d: PaneData, W: number, nowNext: ReturnType<typeof nowNextRow>) => {
  const { Box, Text } = k.els
  const tier = tierOf(d.main.model, k.cfg.tiers)
  const tc = tierColor(k.C, tier)
  const level = contextLevel(d.usage.pct, k.cfg)
  const ctxColor = level === 'red' ? k.C.warn : level === 'amber' ? k.C.amber : level === 'ok' ? k.C.ok : k.C.dim
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tc} paddingX={1} width={W}>
      <Box justifyContent="space-between">
        <Text bold color={tc} wrap="truncate">{`ORCHESTRATOR ${prettyModel(d.main.model)}${tier ? ` · ${tier}` : ''}`}</Text>
        <Box flexShrink={0}>
          <Text wrap="truncate">
            <Text dimColor>ctx </Text>
            <Text bold color={ctxColor}>
              {d.usage.pct !== null ? `${Math.round(d.usage.pct)}%` : '—'}
            </Text>
          </Text>
        </Box>
      </Box>
      {nowNext}
      {level === 'red' ? <Text bold color={k.C.warn} wrap="truncate">{`past ${k.cfg.contextRed}% context · checkpoint now`}</Text> : null}
      {level === 'amber' ? <Text color={k.C.amber} wrap="truncate">{`context ≥ ${k.cfg.contextAmber}% · plan a checkpoint`}</Text> : null}
    </Box>
  )
}

export const crewPanel = (k: Kit, d: PaneData, W: number, viewed: string | null, onExpand: OnExpand) => {
  const { Box, Text, Button } = k.els
  if (d.workers.length === 0) return null
  const fit = boxesThatFit(W, k.cfg.maxBoxes)
  const start = workersStart(d.workers, k.now)
  if (d.workers.length <= fit) {
    const ordered = boxOrder(d.workers)
    const boxW = Math.floor((W - 2 * (ordered.length - 1)) / ordered.length)
    const centres = ordered.map((_, i) => i * (boxW + 2) + Math.floor(boxW / 2))
    const drops = Array.from({ length: W }, (_, i) => (centres.includes(i) ? '│' : ' ')).join('')
    return (
      <Box flexDirection="column" width={W}>
        <Text color={k.C.faint} wrap="truncate">
          {drops}
        </Text>
        <Box columnGap={2}>
          {ordered.map((w, i) => {
            const tier = tierOf(w.model, k.cfg.tiers)
            const tc = tierColor(k.C, tier)
            const tb = timeBar(w, start, k.now, Math.max(4, boxW - 4))
            const isViewed = viewed === w.id || d.view.expanded === w.id
            return (
              <Box
                key={`box-${w.id}`}
                flexDirection="column"
                borderStyle={isViewed ? 'double' : 'round'}
                borderColor={tc}
                borderDimColor={w.status !== 'running' && !isViewed}
                width={boxW}
                paddingX={1}
              >
                <Text wrap="truncate">
                  <Text bold color={tc}>{`W${w.n} ${tier ?? '—'} ${family(w.model)}`}</Text>
                  {isFlagged(w.modelSource) ? <Text color={k.C.amber}>{' ⚠'}</Text> : null}
                </Text>
                <Button
                  key={`worker-${w.id}`}
                  plain
                  hotkey={i < 9 ? String(i + 1) : undefined}
                  // A plain Button with a hotkey draws `1: ` before its label, so the label gets 3 cells fewer than the box's inside width.
                  label={shorten(w.description || w.type, i < 9 ? boxW - 7 : boxW - 4)}
                  onPress={onExpand(w.id)}
                />
                <Box>
                  <Box flexShrink={0}>
                    <Text color={statusColor(k, w)}>{`${glyph(w)} `}</Text>
                  </Box>
                  <Box flexShrink={0}>{clock(k, `box-clock-${w.id}`, w)}</Box>
                  <Text dimColor wrap="truncate">
                    {boxStats(w, boxW - 4 - 2 - clockCells(w))}
                  </Text>
                </Box>
                <Text wrap="truncate">
                  <Text color={k.C.faint}>{'▁'.repeat(tb.before)}</Text>
                  <Text color={tc}>{'█'.repeat(tb.bar)}</Text>
                  <Text>{' '.repeat(tb.after)}</Text>
                </Text>
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  }
  // One row per worker: 14 (label) + title + 3 (status) + 7 (clock) + 2 (bar ends) + bar = W.
  const shown = drawOrder(d.workers).slice(0, 8)
  const barW = Math.max(6, Math.min(16, W - 42))
  const titleW = Math.max(8, W - 26 - barW)
  return (
    <Box flexDirection="column" width={W}>
      <Text
        bold
        wrap="truncate"
      >{`crew · ${d.workers.filter(w => w.status === 'running').length} running · ${d.workers.length} total`}</Text>
      {shown.map((w, i) => {
        const tier = tierOf(w.model, k.cfg.tiers)
        const tc = tierColor(k.C, tier)
        const tb = timeBar(w, start, k.now, barW)
        return (
          <Box key={`row-${w.id}`}>
            <Box width={14} flexShrink={0}>
              <Text
                color={tc}
                bold
                wrap="truncate"
              >{`W${w.n}${isFlagged(w.modelSource) ? '⚠' : ''} ${tier ?? '—'} ${family(w.model)}`}</Text>
            </Box>
            <Box width={titleW} flexShrink={0}>
              <Button
                key={`worker-${w.id}`}
                plain
                hotkey={i < 9 ? String(i + 1) : undefined}
                label={shorten(w.description || w.type, i < 9 ? titleW - 3 : titleW - 1)}
                onPress={onExpand(w.id)}
              />
            </Box>
            <Box width={3} flexShrink={0}>
              <Text color={statusColor(k, w)}>{` ${glyph(w)} `}</Text>
            </Box>
            <Box width={7} flexShrink={0}>
              {clock(k, `row-clock-${w.id}`, w)}
            </Box>
            <Box flexShrink={0}>
              <Text color={k.C.faint}>{`▕${'▁'.repeat(tb.before)}`}</Text>
              <Text color={tc}>{'█'.repeat(tb.bar)}</Text>
              <Text color={k.C.faint}>{`${' '.repeat(tb.after)}▏`}</Text>
            </Box>
          </Box>
        )
      })}
      {d.workers.length > shown.length ? <Text color={k.C.faint}>{`+${d.workers.length - shown.length} more`}</Text> : null}
    </Box>
  )
}

export const expandedWorker = (k: Kit, d: PaneData, W: number) => {
  const { Box, Text } = k.els
  const w = d.workers.find(x => x.id === d.view.expanded)
  if (!w) return null
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={tierColor(k.C, tierOf(w.model, k.cfg.tiers))} paddingX={1} width={W}>
      <Text bold wrap="wrap">
        {w.description || w.type}
      </Text>
      <Text
        dimColor
        wrap="truncate"
      >{`${SOURCE_LABEL[w.modelSource]} · ${w.type} · ${prettyModel(w.model)} · ${w.status} · ${w.steps} steps · ctx ${kTokens(w.ctx)}`}</Text>
      {w.tools.length === 0 ? <Text color={k.C.faint}>no tool calls yet</Text> : null}
      {w.tools.map((n, i) => (
        <Text
          key={`tool-${w.id}-${i}`}
          color={n.isError ? k.C.warn : k.C.text}
          wrap="truncate"
        >{`${n.isError ? '✗' : '·'} ${n.text}`}</Text>
      ))}
      {w.answer ? <Text dimColor wrap="wrap">{`» ${shorten(w.answer, 240)}`}</Text> : null}
    </Box>
  )
}

export const tiersRow = (k: Kit, d: PaneData, W: number) => {
  const { Text } = k.els
  const totals = tierTotals(d.workers, k.cfg.tiers, k.cfg.prices).filter(t => t.workers > 0)
  if (totals.length === 0) return null
  const strip = tierStrip(totals, W)
  return (
    <Text wrap="truncate">
      <Text dimColor>{strip.head}</Text>
      {strip.entries.map(e => (
        <Text key={`tier-${e.tier}`} color={tierColor(k.C, e.tier)}>
          {e.text}
        </Text>
      ))}
      {strip.more > 0 ? <Text dimColor>{`  +${strip.more}`}</Text> : null}
    </Text>
  )
}
