// One-row strips: plan, workflow, architect, gate (with its drill-down). Each row is budgeted in cells, so none passes the pane's width.
import type { Bucket, Check } from '../../types'
import { archLine } from '../model/architect'
import { GATE_BUCKETS, gateLayout, gateSummary } from '../model/gate'
import { liveTasks } from '../model/plan'
import { fitSegments, shorten } from '../model/util'
import { activeRun, runProgress, runSegments, runTail } from '../model/workflow'
import type { Kit, PaneData } from './kit'

const LABEL_W = 6

/** A press handler for one gate bucket, built by the hooks module (the views never hold `$`). */
export type OnGate = (b: Bucket) => () => unknown

export const planStrip = (k: Kit, d: PaneData, W: number) => {
  const { Box, Text } = k.els
  const live = liveTasks(d.plan)
  if (live.length === 0) return null
  const tail = `  ${live.filter(t => t.status === 'completed').length}/${live.length}`
  const cells = live.slice(0, Math.max(0, W - LABEL_W - tail.length))
  return (
    <Box>
      <Box width={LABEL_W} flexShrink={0}>
        <Text dimColor>plan</Text>
      </Box>
      <Text>
        {cells.map(t => (
          <Text key={`plan-${t.id}`} color={t.status === 'completed' ? k.C.ok : t.status === 'in_progress' ? k.C.run : k.C.faint}>
            {t.status === 'completed' ? '▲' : t.status === 'in_progress' ? '◆' : '◇'}
          </Text>
        ))}
      </Text>
      <Text dimColor>{tail}</Text>
    </Box>
  )
}

export const workflowStrip = (k: Kit, d: PaneData, W: number) => {
  const { Box, Text } = k.els
  const run = activeRun(d.runs) ?? d.runs[d.runs.length - 1] ?? null
  if (!run) return null
  const p = runProgress(run)
  // The tail (agent count, or how long it took) is the part to keep, so it is taken out of the room first, then the name, then the phases.
  const tail = runTail(run, p)
  const room = W - LABEL_W - tail.length
  const name = shorten(run.name, Math.max(1, Math.min(Math.max(8, Math.floor(W / 3)), room)))
  const phases = fitSegments(runSegments(run, p), room - name.length)
  const colorOf = (state: (typeof phases)[number]['state']) => (state === 'done' ? k.C.ok : state === 'current' ? k.C.run : k.C.dim)
  return (
    <Box>
      <Box width={LABEL_W} flexShrink={0}>
        <Text dimColor>wf</Text>
      </Box>
      <Text wrap="truncate">
        <Text bold>{name}</Text>
        {phases.map((seg, i) => (
          <Text key={`phase-${i}`} color={colorOf(seg.state)}>
            {seg.text}
          </Text>
        ))}
        <Text dimColor>{tail}</Text>
      </Text>
    </Box>
  )
}

export const architectStrip = (k: Kit, d: PaneData, W: number) => {
  const { Box, Text } = k.els
  const a = d.architect
  if (a.consults.length === 0 && a.ids.length === 0) return null
  const line = archLine(a, k.now, W - LABEL_W)
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={LABEL_W} flexShrink={0}>
          <Text dimColor>arch</Text>
        </Box>
        <Text color={k.C.arch}>{line.timeline}</Text>
        <Text dimColor wrap="truncate">
          {line.tail}
        </Text>
      </Box>
      {a.lastAdvice ? <Text color={k.C.arch} wrap="truncate">{`      » ${shorten(a.lastAdvice, W - 8)}`}</Text> : null}
    </Box>
  )
}

const verdictColor = (k: Kit, c: Check) =>
  c.verdict === 'rule' ? k.C.gate : c.verdict === 'cleared' ? k.C.cleared : c.verdict === 'ask' ? k.C.amber : k.C.warn

const VERDICT_WORD: Record<Check['verdict'], string> = { rule: 'allowed', cleared: 'cleared', ask: 'pending', deny: 'denied' }

export const gateStrip = (k: Kit, d: PaneData, W: number, onGate: OnGate) => {
  const { Box, Text, Button } = k.els
  const g = d.gate
  const s = gateSummary(g)
  if (s.total === 0 && g.recent.length === 0) return null
  const open = d.view.gateOpen
  // Cells, totals and the gap are budgeted against the buttons' real width (each draws `f: file`, 3 cells more than its label).
  const layout = gateLayout({ width: W, labelW: LABEL_W, summary: s, recent: g.recent.length, open })
  const strip = layout.cells > 0 ? g.recent.slice(-layout.cells) : []
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={LABEL_W} flexShrink={0}>
          <Text dimColor wrap="truncate">
            {shorten(k.cfg.gateLabel.toLowerCase(), LABEL_W - 1)}
          </Text>
        </Box>
        {strip.map(c => (
          <Text key={`gate-cell-${c.id}-${c.at}`} color={verdictColor(k, c)} dimColor={c.inSubagent}>
            {c.verdict === 'deny' ? '✗' : '■'}
          </Text>
        ))}
        <Text dimColor>{layout.totals.count}</Text>
        {layout.totals.ask ? <Text color={k.C.amber}>{layout.totals.ask}</Text> : null}
        {layout.totals.deny ? <Text color={k.C.warn}>{layout.totals.deny}</Text> : null}
        <Text>{' '.repeat(layout.gap)}</Text>
        <Box columnGap={1} flexShrink={0}>
          {GATE_BUCKETS.map(b => (
            <Button
              key={`gate-${b}`}
              plain
              hotkey={b[0]}
              label={`${b}${open === b ? '▾' : ''}`}
              dimColor={g.totals[b].rule + g.totals[b].ask + g.totals[b].cleared + g.totals[b].deny === 0}
              onPress={onGate(b)}
            />
          ))}
        </Box>
      </Box>
      {open
        ? g.recent
            .filter(c => c.bucket === open)
            .slice(-5)
            .map(c => (
              <Text key={`gate-row-${c.id}-${c.at}`} wrap="truncate">
                <Text color={verdictColor(k, c)}>{`      ${c.verdict === 'deny' ? '✗' : '■'} `}</Text>
                <Text color={k.C.dim}>{`${VERDICT_WORD[c.verdict].padEnd(8)} `}</Text>
                <Text dimColor={c.inSubagent}>{shorten(c.detail, Math.max(10, W - 22))}</Text>
              </Text>
            ))
        : null}
    </Box>
  )
}
