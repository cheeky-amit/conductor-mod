// Composes the pane: mini inline above the prompt, hybrid or mini when docked as `layout` says. Panels with nothing to show take no rows.
import { nowNext, progressOf } from '../model/progress'
import { activeRun } from '../model/workflow'
import type { Kit, PaneData } from './kit'
import { logPanel, receiptLine } from './log'
import { drawMini, MINI_MIN } from './mini'
import { nowNextRow, progressRow } from './progress'
import { serversStrip } from './servers'
import type { OnGate } from './strips'
import { architectStrip, gateStrip, planStrip, workflowStrip } from './strips'
import type { OnExpand } from './tree'
import { crewPanel, expandedWorker, orchestratorBox, tiersRow } from './tree'

export type PaneProps = {
  columns: number
  isInline: boolean
  bodyRows: number
  viewedAgent: string | null
  onExpand: OnExpand
  onGate: OnGate
}

/** Rows the panels above the log take, so the log gets what is left (3–8). Server rows count only while the `servers` panel is on. */
const usedRows = (d: PaneData, W: number, maxBoxes: number, hasServers: boolean) => {
  const fit = Math.max(1, Math.min(maxBoxes, Math.floor((W + 2) / 20)))
  const crew = d.workers.length === 0 ? 0 : d.workers.length <= fit ? 7 : 2 + Math.min(8, d.workers.length)
  return (
    1 + 5 + crew + (d.view.expanded ? 7 : 0) + 1 + 4 + (hasServers ? Math.min(4, d.servers.length) : 0) + (d.view.gateOpen ? 5 : 0) + 3 + 2
  )
}

export const drawPane = (k: Kit, d: PaneData, p: PaneProps) => {
  const { Box } = k.els
  // Inline above the prompt the pane has 8 rows, so it is always mini there. Docked, `layout` decides (a docked pane under 40 columns is
  // mini unless `layout` is hybrid), and `mini` forces it everywhere.
  const layout = d.view.layout ?? k.cfg.layout
  const isMini = p.isInline || layout === 'mini' || (layout === 'auto' && p.columns < 40)
  const W = Math.max(isMini ? MINI_MIN : 40, p.columns)
  const run = activeRun(d.runs) ?? d.runs[d.runs.length - 1] ?? null
  const pr = progressOf({ tasks: d.plan, run, workers: d.workers, now: k.now })
  const nn = nowNext({ workers: d.workers, tasks: d.plan, main: d.main })
  if (isMini) return drawMini(k, d, W, pr, nn, !p.isInline && p.columns >= 40)
  const on = (panel: string) => (k.cfg.panels as string[]).includes(panel)
  return (
    <Box flexDirection="column" width={W}>
      {on('progress') ? progressRow(k, pr, W) : null}
      {orchestratorBox(k, d, W, nowNextRow(k, nn, W - 4))}
      {on('crew') ? crewPanel(k, d, W, p.viewedAgent, p.onExpand) : null}
      {on('crew') ? expandedWorker(k, d, W) : null}
      {on('crew') ? tiersRow(k, d, W) : null}
      {on('plan') ? planStrip(k, d, W) : null}
      {on('workflow') ? workflowStrip(k, d, W) : null}
      {on('servers') ? serversStrip(k, d, W) : null}
      {on('architect') ? architectStrip(k, d, W) : null}
      {on('gate') ? gateStrip(k, d, W, p.onGate) : null}
      {on('log') ? receiptLine(k, d, W) : null}
      {on('log')
        ? logPanel(k, d, W, Math.max(3, Math.min(8, p.bodyRows - usedRows(d, W, k.cfg.maxBoxes, on('servers')))), p.viewedAgent)
        : null}
    </Box>
  )
}
