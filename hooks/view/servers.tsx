// One row per local server: port, live/seen/stopped, when this session last hit it, what started it.
import type { Server } from '../../types'
import { serverOrder, serverTail } from '../model/servers'
import type { Kit, PaneData } from './kit'

const LABEL_W = 6
const PORT_W = 8
/** Glyph, a space, and the state word padded to 7 (`stopped` is the longest). */
const STATE_W = 9
const ROWS = 3

const glyph = (s: Server) => (s.status === 'live' ? '●' : s.status === 'seen' ? '○' : s.status === 'failed' ? '✗' : '■')
const label = (s: Server) => (s.status === 'live' ? 'live' : s.status === 'seen' ? 'in use' : s.status)
const portText = (s: Server) => (s.port !== null ? `:${s.port}` : ':?')

/**
 * Up to 3 rows, live ones first: label (6), port (8), glyph and state (9), then the tail, which gets the rest of the width: when it was last
 * used and how often, then the command. `+n more` folds the rest into one line.
 */
export const serversStrip = (k: Kit, d: PaneData, W: number) => {
  const { Box, Text } = k.els
  if (d.servers.length === 0) return null
  const rows = serverOrder(d.servers).slice(0, ROWS)
  const room = W - LABEL_W - PORT_W - STATE_W
  const color = (s: Server) => (s.status === 'live' ? k.C.ok : s.status === 'seen' ? k.C.run : s.status === 'failed' ? k.C.warn : k.C.dim)
  return (
    <Box flexDirection="column">
      {rows.map((s, i) => (
        <Box key={`srv-${s.id}`}>
          <Box width={LABEL_W} flexShrink={0}>
            <Text dimColor>{i === 0 ? 'srv' : ''}</Text>
          </Box>
          <Box width={PORT_W} flexShrink={0}>
            <Text bold color={color(s)}>
              {portText(s)}
            </Text>
          </Box>
          <Text color={color(s)} wrap="truncate">{`${glyph(s)} ${label(s).padEnd(STATE_W - 2)}`}</Text>
          <Text dimColor wrap="truncate">
            {serverTail(s, k.now, room)}
          </Text>
        </Box>
      ))}
      {d.servers.length > rows.length ? (
        <Text color={k.C.faint} wrap="truncate">{`${' '.repeat(LABEL_W)}+${d.servers.length - rows.length} more`}</Text>
      ) : null}
    </Box>
  )
}

const inlineEntries = (d: PaneData) =>
  serverOrder(d.servers)
    .slice(0, ROWS)
    .map(s => `${portText(s)}${glyph(s)}`)

/** `:3300● :5173■` for the one-line layouts; empty when there are none. */
export const serversInline = (d: PaneData) => inlineEntries(d).join(' ')

/**
 * ` · srv :3300● :5173■` for the end of a one-line layout, in at most `room` cells: as many of the first three as fit, whole entries
 * only, and nothing when not even one does. The caller gives it only the room left after everything that has to stay.
 */
export const serversInlineFit = (d: PaneData, room: number) => {
  const entries = inlineEntries(d)
  for (let n = entries.length; n > 0; n -= 1) {
    const text = ` · srv ${entries.slice(0, n).join(' ')}`
    if (text.length <= room) return text
  }
  return ''
}
