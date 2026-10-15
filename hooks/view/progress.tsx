import type { Progress } from '../model/progress'
import { isComplete } from '../model/progress'
import { blocks, fitSegments, fmtDuration, fmtEta, shorten } from '../model/util'
import type { Kit } from './kit'

/**
 * The progress row: percent, bar, ETA, then the count and its source. One truncating Text budgeted in cells, so it takes one row at
 * any width: the percent and the bar always stay, the ETA only when it fits whole, the count is cut last.
 */
export const progressRow = (k: Kit, pr: Progress | null, W: number) => {
  const { Text } = k.els
  if (!pr)
    return (
      <Text color={k.C.faint} wrap="truncate">
        no plan yet · progress shows once tasks, a workflow or workers start
      </Text>
    )
  const head = `${String(pr.pct).padStart(3)}% `
  const barW = W >= 50 ? Math.min(24, W - 44) : Math.max(4, Math.min(6, W - 18))
  const g = blocks(pr.pct, barW)
  const eta = isComplete(pr) ? '  done' : pr.etaMs !== null ? `  ${fmtEta(pr.etaMs)} left` : '  ETA —'
  const count = `  ${pr.done}/${pr.total} ${pr.source}${pr.meanMs !== null ? ` · ${fmtDuration(pr.meanMs)} avg` : ''}`
  const room = W - head.length - barW
  const tail =
    eta.length <= room
      ? [{ key: 'eta', text: eta, bold: true }, ...fitSegments([{ key: 'count', text: count, bold: false }], room - eta.length)]
      : []
  return (
    <Text wrap="truncate">
      <Text bold>{head}</Text>
      <Text color={k.C.ok}>{g.on}</Text>
      <Text color={k.C.faint}>{g.off}</Text>
      {tail.map(t => (
        <Text key={`progress-${t.key}`} bold={t.bold} dimColor={!t.bold}>
          {t.text}
        </Text>
      ))}
    </Text>
  )
}

export const nowNextRow = (k: Kit, nn: { now: string | null; next: string | null }, W: number) => {
  const { Text } = k.els
  if (!nn.now && !nn.next) return null
  // Each half gets what is left after `▶ ` and `   → next `; under 32 cells the floor gives way so the row still fits.
  const half = Math.max(4, Math.floor((W - 12) / 2))
  return (
    <Text wrap="truncate">
      <Text color={k.C.run}>{nn.now ? '▶ ' : '○ '}</Text>
      <Text>{nn.now ? shorten(nn.now, half) : 'idle'}</Text>
      {nn.next ? <Text dimColor>{'   → next '}</Text> : null}
      {nn.next ? <Text>{shorten(nn.next, half)}</Text> : null}
    </Text>
  )
}
