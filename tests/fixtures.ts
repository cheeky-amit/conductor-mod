import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { mock } from 'claude-code/testing'

/** Stubs the engine under the plugin's hooks: a mock clock, a status line, turns that start and complete. */
export const engine = (on: On) => {
  const clock = mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return clock
}

export const pane = (bodyColumns: number, placement: 'dock' | 'inline' = 'dock') => ({
  plugin: 'conductor',
  component: 'Pane' as const,
  requestId: 'conductor',
  props: { title: 'Conductor', isFocused: true, bodyColumns, placement, scroll: { offset: 0, bodyRows: 70 }, view: {} },
})

let n = 0
export const spawn = (subagentType: string, description: string, parentModel = 'claude-opus-5-5') => ({
  prompt: description,
  description,
  subagentType,
  tool_use_id: `tu${++n}`,
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel,
  background: true,
  fork: false,
})

/** Raises `tool.call` with a bare input. The typed call spells every tool's input out and is too deep for tsc to instantiate. */
export const callTool = ($: Engine, input: Record<string, unknown>) =>
  ($.tool as unknown as { call: (e: unknown) => Promise<unknown> }).call(input)

/**
 * Stubs `tool.call` so an Agent call can be held open, and returns a runner that makes one. The runner raises the Agent call
 * (passing `model` when given), then the spawn it causes while the call is still open, which is how the plugin links the two by
 * `tool_use_id`, then lets the call go. The harness cannot nest `$.agent.spawn` in a hook, so the call is held on a promise.
 */
export const agentCalls = (on: On) => {
  const held = new Map<string, { entered: () => void; hold: Promise<void> }>()
  on('tool.call', async (_$, e) => {
    const h = held.get(e.tool_use_id)
    if (h) {
      h.entered()
      await h.hold
    }
    return { result: {}, text: 'ok' }
  })
  return async ($: Engine, sp: ReturnType<typeof spawn>, model?: string) => {
    let entered = () => {}
    let release = () => {}
    const isOpen = new Promise<void>(r => {
      entered = r
    })
    const hold = new Promise<void>(r => {
      release = r
    })
    held.set(sp.tool_use_id, { entered, hold })
    const call = callTool($, {
      tool: 'Agent',
      description: sp.description,
      prompt: sp.prompt,
      subagent_type: sp.subagentType,
      ...(model ? { model } : {}),
      tool_use_id: sp.tool_use_id,
    })
    await isOpen
    const started = await $.agent.spawn(sp)
    release()
    await call
    return started
  }
}

/** A node of `ui.drawn()`: a string, or an element with its props and children. */
export type Drawn = string | { type: string; props?: Record<string, unknown>; children?: Drawn[] }
type El = Exclude<Drawn, string>

/** Everything a node shows, in order. */
export const textOf = (n: Drawn): string => (typeof n === 'string' ? n : (n.children ?? []).map(textOf).join(''))

/**
 * Cells a node takes along a row. A Box with a `width` takes that width; a plain Button with a hotkey draws
 * `x: label`, 3 more than its label; a Box with a `columnGap` adds it between its children.
 */
export const cellsOf = (n: Drawn): number => {
  if (typeof n === 'string') return n.length
  const p = n.props ?? {}
  if (n.type === 'Button') return String(p.label ?? '').length + (p.plain && p.hotkey ? 3 : 0)
  if (typeof p.width === 'number') return p.width
  const kids = n.children ?? []
  return kids.reduce((sum, c) => sum + cellsOf(c), 0) + Number(p.columnGap ?? 0) * Math.max(0, kids.length - 1)
}

/** Every element under `n` (and `n`), outermost first. */
export const elements = (n: Drawn): El[] => (typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(elements)])

/** The strip row beside the label cell that reads `label` (a Box whose first child is a 6-cell Box), or undefined. */
export const stripRow = (tree: unknown, label: string) =>
  elements(tree as Drawn).find(e => {
    const first = e.children?.[0]
    return e.type === 'Box' && typeof first === 'object' && first.props?.width === 6 && textOf(first) === label
  })

/** The servers strip's rows: Boxes whose first two children are the 6-cell label and the 8-cell port. */
export const serverRows = (tree: unknown) =>
  elements(tree as Drawn).filter(e => {
    const [a, b] = e.children ?? []
    return e.type === 'Box' && typeof a === 'object' && typeof b === 'object' && a.props?.width === 6 && b.props?.width === 8
  })

/** The log's rows: Boxes whose first child is the 9-cell clock cell. */
export const logRows = (tree: unknown) =>
  elements(tree as Drawn).filter(e => {
    const first = e.children?.[0]
    return e.type === 'Box' && typeof first === 'object' && first.props?.width === 9
  })

/**
 * The cells of a strip row that are one glyph each. A cell is a one-character Text, either a direct child of the row (the gate)
 * or inside the Text that wraps them (the plan).
 */
export const glyphs = (row: unknown, only: RegExp) =>
  elements(row as Drawn).filter(
    e => e.type === 'Text' && e.children?.length === 1 && typeof e.children[0] === 'string' && only.test(e.children[0]),
  )
