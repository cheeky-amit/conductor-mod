// The last turn's receipt and the session log (ported shapes from Flightdeck v0.4.0, MIT).
import type { LogLine } from '../../types'
import { receiptFit } from '../model/log'
import { fmtClock, shorten } from '../model/util'
import type { Kit, PaneData } from './kit'

export const receiptLine = (k: Kit, d: PaneData, W: number) => {
  const { Text } = k.els
  const r = d.receipt
  if (d.main.isRunning || !r) return null
  const v = receiptFit(r, W)
  return (
    <Text wrap="truncate">
      <Text color={r.reason === 'answer' ? k.C.ok : k.C.warn}>{r.reason === 'answer' ? '✓ ' : '✗ '}</Text>
      <Text>{v.body}</Text>
      {v.cost ? <Text color={k.C.main}>{v.cost}</Text> : null}
    </Text>
  )
}

const TIME_W = 9
const WHO_W = 15

export const logPanel = (k: Kit, d: PaneData, W: number, rows: number, viewed: string | null) => {
  const { Box, Text } = k.els
  const all = viewed ? d.log.filter(l => l.agentId === viewed) : d.log
  const lines = all.slice(-rows)
  // A panel with nothing to show takes no rows. A worker with no lines is worth naming, so that view keeps its panel.
  if (all.length === 0 && !viewed) return null
  // Inside the border (2) and the padding (2): the clock, who, then the text takes the rest.
  const textW = Math.max(8, W - 4 - TIME_W - WHO_W)
  const colorOf = (l: LogLine) =>
    l.kind === 'error'
      ? k.C.warn
      : l.kind === 'consult'
        ? k.C.arch
        : l.kind === 'done'
          ? k.C.ok
          : l.who === 'main'
            ? k.C.main
            : l.who === 'gate'
              ? k.C.gate
              : k.C.text
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={k.C.faint} paddingX={1} marginTop={1} width={W}>
      <Text dimColor wrap="truncate">
        {viewed ? 'session log · this worker' : 'session log'}
      </Text>
      {lines.length === 0 ? <Text color={k.C.faint}>nothing yet</Text> : null}
      {lines.map((l, i) => (
        <Box key={`log-${all.length - lines.length + i}-${l.at}`}>
          <Box width={TIME_W} flexShrink={0}>
            <Text color={k.C.faint}>{fmtClock(l.at)}</Text>
          </Box>
          <Box width={WHO_W} flexShrink={0}>
            <Text color={colorOf(l)} bold wrap="truncate">
              {l.who}
            </Text>
          </Box>
          <Text color={l.kind === 'error' ? k.C.warn : k.C.text} wrap="truncate">
            {shorten(l.text, textW)}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
