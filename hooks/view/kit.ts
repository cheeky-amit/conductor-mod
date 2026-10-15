import type { EngineInterface } from 'claude-code'

import type { Architect, Gate, LogLine, Main, PlanTask, Receipt, Server, Turn, Usage, View, Worker, WorkflowRun } from '../../types'
import type { Colors, Config } from '../model/config'

export type Els = ReturnType<EngineInterface['ui']['resolve']>
export type Kit = { els: Els; C: Colors; now: number; hasClient: boolean; cfg: Config }
export type PaneData = {
  main: Main
  usage: Usage
  workers: Worker[]
  plan: PlanTask[]
  runs: WorkflowRun[]
  architect: Architect
  gate: Gate
  log: LogLine[]
  turn: Turn
  receipt: Receipt | null
  view: View
  servers: Server[]
}
