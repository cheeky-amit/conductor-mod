export type Tier = 'T0' | 'T1' | 'T2' | 'T3'
/** explicit: a model was passed. inherited: none passed, it runs the parent's model.
 *  definition-unpassed: none passed, and the agent's own definition set another.
 *  likely-inherited: its Agent call could not be linked, and it runs the parent's model.
 *  definition: its Agent call could not be linked, and it runs another model: whether one was passed is unknown. */
export type ModelSource = 'explicit' | 'inherited' | 'definition-unpassed' | 'likely-inherited' | 'definition'
export type Moment = 'before a plan' | 'error repeats' | 'before done'
export type Bucket = 'file' | 'shell' | 'other'
/** rule: settings allowed it. ask: put to the decider, outcome pending. cleared: asked, then ran. deny: refused. */
export type Verdict = 'rule' | 'ask' | 'cleared' | 'deny'
export type Layout = 'auto' | 'hybrid' | 'mini'

export type Main = { model: string; effort: string; steps: number; isRunning: boolean; activity: string }
export type Usage = { pct: number | null; tokens: number | null; window: number }

export type Consult = { id: string; at: number; endAt: number | null; moment: Moment; via: string }
export type Architect = { consults: Consult[]; ids: string[]; seen: string[]; lastAdvice: string }

export type Check = { id: string; tool: string; bucket: Bucket; verdict: Verdict; inSubagent: boolean; detail: string; at: number }
export type Tally = { rule: number; ask: number; cleared: number; deny: number }
export type Gate = { recent: Check[]; totals: Record<Bucket, Tally> }

export type ToolNote = { tool: string; text: string; isError: boolean }
export type WorkerStatus = 'running' | 'done' | 'failed' | 'stopped'
export type Worker = {
  id: string
  /** W1, W2…: spawn order in this session. */
  n: number
  type: string
  description: string
  model: string
  modelSource: ModelSource
  status: WorkerStatus
  spawnedAt: number
  endedAt: number | null
  steps: number
  /** Latest step's whole input (uncached + cache read + cache write). */
  ctx: number
  out: number
  tokIn: number
  tokCacheRead: number
  tokCacheWrite: number
  lastStop: string | null
  tools: ToolNote[]
  answer: string
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'
export type PlanTask = {
  id: string
  subject: string
  status: TaskStatus
  createdAt: number
  startedAt: number | null
  completedAt: number | null
}

export type WorkflowAgent = { id: string; phase: string | null; isDone: boolean; firstAt: number; lastAt: number }
export type WorkflowRun = {
  id: string
  /** The run id the Workflow tool reported (wf_…), used to match its completion notice. */
  ref: string | null
  name: string
  phases: string[]
  startedAt: number
  endedAt: number | null
  agents: WorkflowAgent[]
}

export type LogLine = { at: number; who: string; text: string; agentId: string | null; kind: 'info' | 'error' | 'consult' | 'done' }
export type Turn = {
  edits: number
  errorStreak: number
  errors: number
  isReviewing: boolean
  startedAt: number
  costAtStart: number | null
}
export type Receipt = { durationMs: number; agents: number; edits: number; errors: number; costDelta: number | null; reason: string }
export type View = { expanded: string | null; gateOpen: Bucket | null; layout: Layout | null }
export type Roster = { architectTypes: string[] }

/** live: started here, still running. seen: used here, started elsewhere. stopped/failed: started here, ended. */
export type ServerStatus = 'live' | 'seen' | 'stopped' | 'failed'
export type Server = {
  id: string
  /** The background job id from the Bash result (inferred), used to match its stop notice. */
  jobId: string | null
  port: number | null
  command: string
  status: ServerStatus
  startedAt: number
  endedAt: number | null
  lastUsedAt: number | null
  uses: number
  /** `main` or `agent`. */
  by: string
}

declare module 'claude-code' {
  interface PluginState {
    conductor: {
      meta: { schemaVersion: number }
      main: Main
      usage: Usage
      architect: Architect
      gate: Gate
      workers: Worker[]
      plan: PlanTask[]
      runs: WorkflowRun[]
      log: LogLine[]
      turn: Turn
      receipt: Receipt | null
      view: View
      roster: Roster
      servers: Server[]
    }
  }
}
