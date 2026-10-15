import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

import type { Drawn } from './fixtures'
import {
  agentCalls,
  engine as baseEngine,
  callTool,
  cellsOf,
  elements,
  glyphs,
  logRows,
  pane,
  serverRows,
  spawn,
  stripRow,
  textOf,
} from './fixtures'

/** The base engine plus subagent steps that report 1k output tokens each, and a context measurement that answers. */
const engine = (on: On) => {
  const clock = baseEngine(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  // biome-ignore lint/correctness/useYield: the bottom of the chain answers the step without streaming
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model: e.model, input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
  })
  return clock
}

const fanOut = async ($: Engine, on: On, models: string[]) => {
  let k = 0
  on('agent.spawn', () => ({ model: models[k] ?? 'claude-sonnet-5-5', agentId: `ag${++k}` }))
  await $.turn.start({ text: 'fan out', turnId: 'R1' })
  for (let i = 0; i < models.length; i += 1) await $.agent.spawn(spawn('general-purpose', `task ${i + 1}`))
}

test('orchestrator box names the main model, its tier and context', async ($, on) => {
  engine(on)
  const s = $.turn.step({ turnId: 'R0', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of s) void _
  await s.result
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /ORCHESTRATOR Opus 5\.5 · T2/ })).toBeDefined()
  expect(await ui.find({ text: /ctx —/ })).toBeDefined()
  await ui.unmount()
})

test('up to maxBoxes workers draw as tier boxes; a flagged one carries ⚠', async ($, on) => {
  engine(on)
  await fanOut($, on, ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /W1 T1 sonnet/ })).toBeDefined()
  expect(await ui.find({ text: /W3 T2 opus ⚠/ })).toBeDefined()
  expect(await ui.find({ text: /tiers/ })).toBeDefined()
  expect(await ui.find({ text: /T1 ▮▮/ })).toBeDefined()
  await ui.unmount()
})

test('more workers than fit fold into rows; a hotkey expands one', async ($, on) => {
  engine(on)
  await fanOut($, on, ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-sonnet-5-5'])
  for (const cols of [40, 60, 80, 120]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    expect(await ui.find({ text: /W4/ })).toBeDefined()
    expect(await ui.find({ text: /▕/ })).toBeDefined() // row time bars
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  await ui.press({ key: 'worker-ag1' })
  expect(await ui.find({ text: /from agent definition|model passed|inherited/ })).toBeDefined()
  await ui.unmount()
})

test('a fresh session draws on every surface and width', async ($, on) => {
  engine(on)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    for (const cols of [40, 60, 80, 120]) {
      const ui = await $.ui.mount({ ...pane(cols), surface })
      expect(await ui.find({ text: /ORCHESTRATOR/ })).toBeDefined()
      expect(await ui.find({ text: /^W\d/ })).toBeUndefined()
      await ui.unmount()
    }
  }
})

test('a fresh session mounts no log panel: an empty log takes no rows', async ($, on) => {
  engine(on)
  for (const cols of [40, 60, 80, 120]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    expect(await ui.find({ text: /session log/ })).toBeUndefined()
    expect(await ui.find({ text: /nothing yet/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a viewed worker with no log lines still names the empty log', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'v1' }))
  await $.turn.start({ text: 'go', turnId: 'V1' })
  await $.agent.spawn(spawn('Explore', 'scan repo'))
  const viewed = { ...pane(80), props: { ...pane(80).props, view: { agentId: 'zz-no-lines' } } }
  const ui = await $.ui.mount({ ...viewed, surface: 'terminal' })
  expect(await ui.find({ text: /session log · this worker/ })).toBeDefined()
  expect(await ui.find({ text: /nothing yet/ })).toBeDefined()
  await ui.unmount()
})

test('pressing an open worker again closes it', async ($, on) => {
  engine(on)
  await fanOut($, on, ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-sonnet-5-5'])
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /from agent definition/ })).toBeUndefined()
  await ui.press({ key: 'worker-ag1' })
  expect(await ui.find({ text: /from agent definition/ })).toBeDefined()
  await ui.press({ key: 'worker-ag1' })
  expect(await ui.find({ text: /from agent definition/ })).toBeUndefined()
  await ui.unmount()
})

test('a running worker ticks on a Client clock; a finished one shows how long it ran', async ($, on) => {
  const clock = engine(on)
  await clock.advance(5000)
  await fanOut($, on, ['claude-sonnet-5-5', 'claude-sonnet-5-5'])
  await clock.advance(125_000)
  await $.turn.complete({ agentId: 'ag1', turnId: 'R1', reason: 'answer', answer: 'ok', durationMs: 125_000, isAborted: false })
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.findAll({ type: 'Client' })).toHaveLength(1)
  expect(await ui.find({ text: /2m05s/ })).toBeDefined()
  await ui.unmount()
})

test('the expanded worker shows the start of its answer with credentials masked', async ($, on) => {
  const clock = engine(on)
  await clock.advance(5000)
  await fanOut($, on, ['claude-sonnet-5-5'])
  await $.turn.complete({
    agentId: 'ag1',
    turnId: 'R1',
    reason: 'answer',
    answer: 'Done. Set API_TOKEN=abcdefghijklmnop1234 before you run it.',
    durationMs: 1000,
    isAborted: false,
  })
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  await ui.press({ key: 'worker-ag1' })
  expect(await ui.find({ text: /» Done\. Set API_TOKEN=••• before you run it\./ })).toBeDefined()
  expect(await ui.find({ text: /abcdefghijklmnop1234/ })).toBeUndefined()
  await ui.unmount()
})

/** Runs `n` steps of subagent `agentId`; each reports 1k output tokens. */
const stepAgent = async ($: Engine, agentId: string, n: number) => {
  for (let i = 0; i < n; i += 1) {
    const s = $.turn.step({ turnId: 'R1', index: i, model: 'claude-sonnet-5-5', messageCount: 1, agentId })
    for await (const _ of s) void _
    await s.result
  }
}

const spawnWith = async ($: Engine, on: On, workers: { model: string; description: string }[]) => {
  let k = 0
  on('agent.spawn', () => ({ model: workers[k]?.model ?? 'claude-sonnet-5-5', agentId: `ag${++k}` }))
  await $.turn.start({ text: 'fan out', turnId: 'R1' })
  for (const w of workers) await $.agent.spawn(spawn('general-purpose', w.description))
}

test('boxes keep the label, the steps and the clock inside their width at 40 and 120 columns', async ($, on) => {
  const clock = engine(on)
  await clock.advance(5000)
  await spawnWith($, on, [
    { model: 'claude-sonnet-5-5', description: 'refactor the authentication middleware' },
    { model: 'claude-sonnet-5-5', description: 'write the migration guide for v2' },
  ])
  await stepAgent($, 'ag1', 7)
  await stepAgent($, 'ag2', 3)
  await clock.advance(258_000)
  await $.turn.complete({ agentId: 'ag1', turnId: 'R1', reason: 'answer', answer: 'ok', durationMs: 258_000, isAborted: false })
  // 40 columns, 2 boxes: 19 wide, 15 inside. A Button with a hotkey draws `1: ` before its label, so its label gets 12.
  const narrow = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  for (const b of await narrow.findAll({ type: 'Button' })) expect(b.text.length).toBeLessThanOrEqual(12)
  expect((await narrow.findAll({ type: 'Button' })).length).toBe(2)
  expect(await narrow.find({ text: /4m18s · 7st/ })).toBeDefined() // tokens dropped, steps and clock kept
  expect(await narrow.find({ text: /7k · 7st/ })).toBeUndefined()
  expect(await narrow.find({ text: /· 3st/ })).toBeDefined() // the running one shows its steps too
  await narrow.unmount()
  const wide = await $.ui.mount({ ...pane(120), surface: 'terminal' })
  expect(await wide.find({ text: /7k · 7st/ })).toBeDefined()
  expect((await wide.find({ text: /^refactor the authentication middleware$/ }))?.type).toBe('Button')
  await wide.unmount()
})

test('rows keep ⚠ in the label cell and fit their title beside the hotkey, newest first', async ($, on) => {
  engine(on)
  await spawnWith($, on, [
    { model: 'claude-sonnet-5-5', description: 'alpha task' },
    { model: 'claude-sonnet-5-5', description: 'bravo task' },
    { model: 'claude-sonnet-5-5', description: 'charlie task' },
    { model: 'claude-opus-5-5', description: 'delta task' }, // the parent's model, none passed: flagged
  ])
  const narrow = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  expect(await narrow.find({ text: /W4⚠ T2 opus/ })).toBeDefined()
  const buttons = await narrow.findAll({ type: 'Button' })
  // 40 columns: 14 + title 8 + 3 + 7 + 8. The title shares its 8 with `1: `.
  for (const b of buttons) expect(b.text.length).toBeLessThanOrEqual(5)
  await narrow.unmount()
  const wide = await $.ui.mount({ ...pane(120), surface: 'terminal' })
  expect((await wide.findAll({ type: 'Button' })).map(b => b.text)).toEqual(['delta task', 'charlie task', 'bravo task', 'alpha task'])
  await wide.unmount()
})

test('the tiers strip keeps its `est` label at 40 columns and drops the $ before a tier', async ($, on) => {
  engine(on)
  await spawnWith($, on, [
    { model: 'claude-sonnet-5-5', description: 'one' },
    { model: 'claude-opus-5-5', description: 'two' },
  ])
  await stepAgent($, 'ag1', 40)
  await stepAgent($, 'ag2', 10)
  const narrow = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  const row = await narrow.find({ text: /^tiers est/ })
  expect(row).toBeDefined()
  expect(row?.text).toMatch(/T1 ▮ 40k/)
  expect(row?.text).toMatch(/T2 ▮ 10k/)
  expect(row?.text).not.toMatch(/~\$/)
  expect(row?.text.length).toBeLessThanOrEqual(40)
  await narrow.unmount()
  const wide = await $.ui.mount({ ...pane(120), surface: 'terminal' })
  expect((await wide.find({ text: /^tiers est/ }))?.text).toMatch(/T1 ▮ 40k ~\$0\.\d\d {2}T2 ▮ 10k ~\$0\.\d\d/)
  await wide.unmount()
})

test('the expanded worker leads with where its model came from, so an inherited warning survives 40 columns', async ($, on) => {
  engine(on)
  await spawnWith($, on, [{ model: 'claude-opus-5-5', description: 'review panel' }])
  const ui = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  await ui.press({ key: 'worker-ag1' })
  expect(await ui.find({ text: /^⚠ likely inherited \(inferred\) · / })).toBeDefined()
  await ui.unmount()
})

/** Workers launched by Agent calls that pass no model, under an Opus parent: each call is linked to its spawn, so a Sonnet worker got its model from its agent definition. */
const spawnUnpassed = async ($: Engine, on: On, descriptions: string[]) => {
  let k = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `ag${++k}` }))
  const agentCall = agentCalls(on)
  await $.turn.start({ text: 'fan out', turnId: 'R1' })
  for (const d of descriptions) await agentCall($, spawn('general-purpose', d))
}

test('a worker with no model passed whose definition chose one carries ⚠ like an inherited one, with a softer label', async ($, on) => {
  engine(on)
  await spawnUnpassed($, on, ['review panel'])
  const narrow = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  expect(await narrow.find({ text: /W1 T1 sonnet ⚠/ })).toBeDefined()
  await narrow.press({ key: 'worker-ag1' })
  expect(await narrow.find({ text: /^⚠ no model · from definition · / })).toBeDefined()
  expect(await narrow.find({ text: /inherited/ })).toBeUndefined()
  await narrow.unmount()
  // The open worker stays open across a redraw at another width.
  const wide = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await wide.find({ text: /W1 T1 sonnet ⚠/ })).toBeDefined()
  expect(await wide.find({ text: /^⚠ no model · from definition · / })).toBeDefined()
  await wide.unmount()
})

test('folded rows and the mini layout flag it too, and the log says it softly', async ($, on) => {
  engine(on)
  await spawnUnpassed($, on, ['alpha task', 'bravo task', 'charlie task', 'delta task'])
  const rows = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await rows.find({ text: /^W4⚠ T1 sonnet/ })).toBeDefined()
  expect(await rows.find({ text: /^W1⚠ T1 sonnet/ })).toBeDefined()
  expect(await rows.find({ text: /⚠ no model · from definition Sonnet 5\.5/ })).toBeDefined()
  await rows.unmount()
  const mini = await $.ui.mount({ ...pane(80, 'inline'), surface: 'terminal' })
  expect(await mini.find({ text: /^W4⚠ T1 sonnet /, type: 'Text' })).toBeDefined()
  expect(await mini.find({ text: /^W4 ⚠ no model · from definition Sonnet 5\.5$/ })).toBeDefined()
  await mini.unmount()
})

test('worker boxes keep spawn order, W1 left of W3, even when W1 has finished', async ($, on) => {
  const clock = engine(on)
  await clock.advance(5000)
  await fanOut($, on, ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'])
  await $.turn.complete({ agentId: 'ag1', turnId: 'R1', reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false })
  const ui = await $.ui.mount({ ...pane(120), surface: 'terminal' })
  expect((await ui.findAll({ type: 'Button' })).map(b => b.text)).toEqual(['task 1', 'task 2', 'task 3'])
  await ui.unmount()
})

const WIDTHS = [40, 60, 80, 120]

/** `n` tool checks: every 10th denied, every 5th (from 1) put to the decider, the rest allowed by a rule. */
const checks = async ($: Engine, on: On, n: number) => {
  on('tool.check', (_$, e) => {
    const i = Number(String(e.tool_use_id).slice(2))
    return { decision: i % 10 === 0 ? 'deny' : i % 5 === 1 ? 'ask' : 'allow' }
  })
  for (let i = 0; i < n; i += 1) {
    const tool = i % 3 === 0 ? 'Bash' : i % 3 === 1 ? 'Read' : 'WebFetch'
    await $.tool.check({
      tool,
      input: { command: `echo ${i}`, file_path: `/a/b${i}.ts`, url: `https://x.test/${i}` },
      tool_use_id: `ck${i}`,
    })
  }
}

test('plan strip marks done, current and pending tasks', async ($, on) => {
  engine(on)
  let id = 0
  on('tool.call', (_$, e) => ({ result: {}, text: String(e.tool) === 'TaskCreate' ? `Task #${++id} created successfully` : 'ok' }))
  await $.turn.start({ text: 'plan', turnId: 'L1' })
  for (const subject of ['a', 'b', 'c']) await callTool($, { tool: 'TaskCreate', subject, tool_use_id: `p-${subject}` })
  await callTool($, { tool: 'TaskUpdate', taskId: '1', status: 'completed', tool_use_id: 'p-u1' })
  await callTool($, { tool: 'TaskUpdate', taskId: '2', status: 'in_progress', tool_use_id: 'p-u2' })
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /▲◆◇/ })).toBeDefined()
  await ui.unmount()
})

test('workflow strip shows the run, its phases and agent count', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {}, text: 'Workflow started: wf_ab12cd34' }))
  await $.turn.start({ text: 'review', turnId: 'W1' })
  const script = "export const meta = { name: 'review-changes', description: 'x', phases: [{ title: 'Review' }, { title: 'Verify' }] }"
  await callTool($, { tool: 'Workflow', script, tool_use_id: 'wf-call' })
  const s = $.turn.step({ turnId: 'W1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'loopA' })
  for await (const _ of s) void _
  await s.result
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /review-changes/ })).toBeDefined()
  // The live case: the loop reports no phase, so the phases read as one plain list.
  expect(await ui.find({ text: /Review › Verify/ })).toBeDefined()
  expect(await ui.find({ text: /0\/1 agents/ })).toBeDefined()
  await ui.unmount()
})

test('workflow strip marks each phase when the agents report one', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {}, text: 'Workflow started: wf_ab12cd34' }))
  await $.turn.start({ text: 'review', turnId: 'W2' })
  const script = "export const meta = { name: 'review-changes', description: 'x', phases: [{ title: 'Review' }, { title: 'Verify' }] }"
  await callTool($, { tool: 'Workflow', script, tool_use_id: 'wf-call2' })
  const s = $.turn.step({ turnId: 'W2', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'loopB', phase: 'Review' } as never)
  for await (const _ of s) void _
  await s.result
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /review-changes {2}Review 0\/1 › Verify {2}0\/1 agents/ })).toBeDefined()
  await ui.unmount()
  await $.turn.complete({ agentId: 'loopB', turnId: 'W2', reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false })
  const done = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await done.find({ text: /Review ✓ › Verify {2}1\/1 agents/ })).toBeDefined()
  await done.unmount()
})

test('gate strip fills from checks and its drill-down is redacted', async ($, on) => {
  engine(on)
  on('tool.check', (_$, e) => ({ decision: e.tool === 'Read' ? 'allow' : 'ask' }))
  await $.tool.check({ tool: 'Read', input: { file_path: '/a/b.ts' }, tool_use_id: 'k1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'curl -H "Authorization: Bearer abcdefgh12345" api' }, tool_use_id: 'k2' })
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /2 checks/ })).toBeDefined()
  await ui.press({ key: 'gate-shell' })
  expect(await ui.find({ text: /Authorization: Bearer •••/ })).toBeDefined()
  expect(await ui.find({ text: /abcdefgh12345/ })).toBeUndefined()
  // Pressing the open bucket again closes it.
  await ui.press({ key: 'gate-shell' })
  expect(await ui.find({ text: /Authorization: Bearer/ })).toBeUndefined()
  await ui.unmount()
})

test('the session log shows spawns and the receipt after a turn', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'g1' }))
  await $.turn.start({ text: 'go', turnId: 'G1' })
  await $.agent.spawn(spawn('Explore', 'scan repo'))
  await $.turn.complete({ answer: 'done', durationMs: 4000, isAborted: false, turnId: 'G1', reason: 'answer' })
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /session log/ })).toBeDefined()
  expect(await ui.find({ text: /spawned · Explore/ })).toBeDefined()
  expect(await ui.find({ text: /last turn 4s/ })).toBeDefined()
  await ui.unmount()
})

test('the gate row, its totals and its three buttons fit 40, 60, 80 and 120 columns, closed and open', async ($, on) => {
  engine(on)
  await checks($, on, 30)
  for (const cols of WIDTHS) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    for (const open of [null, 'gate-shell', 'gate-file']) {
      if (open) await ui.press({ key: open })
      const row = stripRow(await ui.drawn(), 'gate')
      expect(row).toBeDefined()
      expect(cellsOf(row as never)).toBeLessThanOrEqual(cols)
      expect(textOf(row as never)).toMatch(/\b30\b/)
    }
    await ui.unmount()
  }
})

test('at 40 columns the gate row counts each button as its label plus 3, drops the cells, and says what is pending', async ($, on) => {
  engine(on)
  await checks($, on, 30)
  const ui = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  const buttons = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('gate-'))
  expect(buttons.map(b => b.text)).toEqual(['file', 'shell', 'other'])
  // `f: file`, `s: shell`, `o: other` and the two cells between them.
  const buttonCells = buttons.reduce((n, b) => n + b.text.length + 3, 0) + (buttons.length - 1)
  expect(buttonCells).toBe(25)
  const row = stripRow(await ui.drawn(), 'gate') as Exclude<Drawn, string>
  // Label cell (6) + the row's own text (cells, totals, gap) + the buttons, each label with its 3-cell prefix.
  const own = (row.children ?? []).filter((c): c is Exclude<Drawn, string> => typeof c !== 'string' && c.type === 'Text')
  expect(6 + own.map(textOf).join('').length + buttonCells).toBeLessThanOrEqual(40)
  expect(cellsOf(row)).toBeLessThanOrEqual(40)
  // 6 asks and 3 denials: no room for cells or both flags, so the cells go and the pending count stays.
  expect(glyphs(row, /^[■✗]$/)).toHaveLength(0)
  expect(textOf(row as never)).toMatch(/ 30·6\?/)
  await ui.unmount()
  const wide = await $.ui.mount({ ...pane(120), surface: 'terminal' })
  expect(textOf(stripRow(await wide.drawn(), 'gate') as never)).toMatch(/ 30 checks · 6 pending · 3✗/)
  // 120 - 6 (label) - 2 (gap) - 25 (buttons) - 27 (totals) = 60 cells, of the 30 checks held.
  expect(glyphs(stripRow(await wide.drawn(), 'gate'), /^[■✗]$/)).toHaveLength(30)
  await wide.unmount()
})

test('the plan strip fits 40, 60, 80 and 120 columns and keeps its done/total', async ($, on) => {
  engine(on)
  let id = 0
  on('tool.call', (_$, e) => ({ result: {}, text: String(e.tool) === 'TaskCreate' ? `Task #${++id} created successfully` : 'ok' }))
  await $.turn.start({ text: 'plan', turnId: 'L2' })
  for (let i = 0; i < 120; i += 1) await callTool($, { tool: 'TaskCreate', subject: `task ${i}`, tool_use_id: `pt${i}` })
  for (const cols of WIDTHS) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    const row = stripRow(await ui.drawn(), 'plan')
    expect(cellsOf(row as never)).toBeLessThanOrEqual(cols)
    expect(textOf(row as never)).toMatch(/ {2}0\/120$/)
    // 6 for the label, 7 for `  0/120`; the rest are cells.
    expect(glyphs(row, /^[◇▲◆]$/)).toHaveLength(cols - 6 - 7)
    await ui.unmount()
  }
})

const LONG_SCRIPT =
  "export const meta = { name: 'nightly-regression-sweep-of-the-whole-monorepo', description: 'x', phases: [{ title: 'Collect the changed files' }, { title: 'Review each change' }, { title: 'Verify the findings' }, { title: 'Write the report' }] }"

test('the workflow row keeps its agent count at 40, 60, 80 and 120 columns, with or without phase data', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {}, text: 'Workflow started: wf_ab12cd34' }))
  await $.turn.start({ text: 'sweep', turnId: 'W3' })
  await callTool($, { tool: 'Workflow', script: LONG_SCRIPT, tool_use_id: 'wf-long' })
  for (const [id, phase] of [
    ['la', undefined],
    ['lb', undefined],
  ] as const) {
    const s = $.turn.step({ turnId: 'W3', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: id, phase } as never)
    for await (const _ of s) void _
    await s.result
  }
  for (const cols of WIDTHS) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    const row = stripRow(await ui.drawn(), 'wf')
    expect(cellsOf(row as never)).toBeLessThanOrEqual(cols)
    expect(textOf(row as never)).toMatch(/ {2}0\/2 agents$/)
    await ui.unmount()
  }
  // The same run once its agents report phases.
  const phased = [
    ['pa', 'Collect the changed files'],
    ['pb', 'Review each change'],
  ] as const
  for (const [id, phase] of phased) {
    const s = $.turn.step({ turnId: 'W3', index: 1, model: 'claude-sonnet-5-5', messageCount: 1, agentId: id, phase } as never)
    for await (const _ of s) void _
    await s.result
  }
  await $.turn.complete({ agentId: 'pa', turnId: 'W3', reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false })
  for (const cols of WIDTHS) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    const row = stripRow(await ui.drawn(), 'wf')
    expect(cellsOf(row as never)).toBeLessThanOrEqual(cols)
    expect(textOf(row as never)).toMatch(/ {2}1\/4 agents$/)
    if (cols === 120) expect(textOf(row as never)).toMatch(/Collect the changed files ✓ › Review each change 0\/1/)
    await ui.unmount()
  }
})

test('the architect row keeps its timeline and its count at 40, 60, 80 and 120 columns, and cuts the advice to the width', async ($, on) => {
  const clock = engine(on)
  await clock.advance(5000)
  let k = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `ar${++k}` }))
  await $.turn.start({ text: 'plan it', turnId: 'A1' })
  for (let i = 0; i < 12; i += 1) {
    await $.agent.spawn(spawn('architect', `consult ${i}`))
    await clock.advance(61_000)
    await $.turn.complete({
      agentId: `ar${i + 1}`,
      turnId: 'A1',
      reason: 'answer',
      answer: 'Split the migration into two steps, and run the backfill before the cutover so that nothing reads a half-written column.',
      durationMs: 1000,
      isAborted: false,
    })
  }
  await clock.advance(61_000)
  for (const cols of WIDTHS) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    const row = stripRow(await ui.drawn(), 'arch')
    expect(cellsOf(row as never)).toBeLessThanOrEqual(cols)
    expect(textOf(row as never)).toMatch(/12 consults/)
    expect(textOf(row as never)).toMatch(/[─━◆]{8,}/)
    for (const advice of await ui.findAll({ type: 'Text', text: /^ {6}» / })) expect(advice.text.length).toBeLessThanOrEqual(cols)
    await ui.unmount()
  }
  const wide = await $.ui.mount({ ...pane(120), surface: 'terminal' })
  expect(textOf(stripRow(await wide.drawn(), 'arch') as never)).toMatch(/12 consults · last 1m01s ago · before a plan$/)
  await wide.unmount()
})

test('the receipt keeps its errors count at 40 columns; the session log rows fit inside their border', async ($, on) => {
  const clock = engine(on)
  await clock.advance(5000)
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  let k = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `rc${++k}` }))
  await $.turn.start({ text: 'a long turn with a rather long request that does not fit a narrow pane at all', turnId: 'X1' })
  for (let i = 0; i < 3; i += 1) await $.agent.spawn(spawn('Explore', `a worker with a rather long description ${i}`))
  for (let i = 0; i < 12; i += 1) await callTool($, { tool: 'Edit', file_path: `/a/b${i}.ts`, tool_use_id: `ed${i}` })
  await $.turn.complete({ answer: 'done', durationMs: 3_900_000, isAborted: false, turnId: 'X1', reason: 'answer' })
  for (const cols of WIDTHS) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    const receipt = (await ui.findAll({ type: 'Text', text: /^[✓✗] / })).find(t => /1h05m/.test(t.text))
    expect(receipt).toBeDefined()
    expect(String(receipt?.text).length).toBeLessThanOrEqual(cols)
    expect(receipt?.text).toMatch(/0 errors?|0err/)
    const rows = logRows(await ui.drawn())
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(cellsOf(r as never)).toBeLessThanOrEqual(cols - 4)
    await ui.unmount()
  }
  const narrow = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  expect((await narrow.find({ text: /^✓ 1h05m/ }))?.text).toBe('✓ 1h05m · 3w · 12e · 0err')
  await narrow.unmount()
  const wide = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect((await wide.find({ text: /^✓ last turn/ }))?.text).toBe('✓ last turn 1h05m · 3 workers · 12 edits · 0 errors')
  await wide.unmount()
})

// Mini layout: inline above the prompt, at most 8 rows, any pane under 40 columns.

/** The pane's rows: what the root Box drew, one entry per row. */
const paneRows = async (ui: { drawn: () => Promise<unknown> }) =>
  (((await ui.drawn()) as { children?: Drawn[] }).children ?? []).filter(Boolean)

const rowProps = (row: Drawn) => (typeof row === 'string' ? {} : (row.props ?? {}))

/** Opus 5.5 at the helm, five workers (W5 runs its parent's model with none passed, so it is flagged), three tasks with ETA, and the context at `pct`. */
const crowded = async ($: Engine, on: On, pct: number) => {
  const clock = engine(on)
  let id = 0
  on('tool.call', (_$, e) => ({ result: {}, text: String(e.tool) === 'TaskCreate' ? `Task #${++id} created successfully` : 'ok' }))
  const models = ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-opus-5-5']
  let k = 0
  on('agent.spawn', () => ({ model: models[k] ?? 'claude-sonnet-5-5', agentId: `cw${++k}` }))
  await $.turn.start({ text: 'go', turnId: 'CW' })
  const step = $.turn.step({ turnId: 'CW', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of step) void _
  await step.result
  for (const subject of ['write the migration', 'backfill the orders table', 'ship it behind a flag']) {
    await callTool($, { tool: 'TaskCreate', subject, tool_use_id: `c-${subject}` })
  }
  await callTool($, { tool: 'TaskUpdate', taskId: '1', status: 'in_progress', tool_use_id: 'cu1' })
  await clock.advance(3 * 60_000)
  await callTool($, { tool: 'TaskUpdate', taskId: '1', status: 'completed', tool_use_id: 'cu2' })
  await callTool($, { tool: 'TaskUpdate', taskId: '2', status: 'in_progress', tool_use_id: 'cu3' })
  for (const d of [
    'refactor the authentication middleware to use the new session store',
    'review the panel',
    'map every call site of the legacy client',
    'run the full regression suite and report',
    'draft the release notes for the next minor version',
  ]) {
    await $.agent.spawn(spawn('general-purpose', d))
  }
  await $.session.measure({ context: { window: 200_000, tokens: pct * 2000, percent: pct }, rateLimits: [], changed: ['context'] })
}

test('inline above the prompt, the pane is at most 8 rows and keeps the essentials', async ($, on) => {
  engine(on)
  let k = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `m${++k}` }))
  await $.turn.start({ text: 'go', turnId: 'M1' })
  for (const t of ['one', 'two', 'three', 'four', 'five']) await $.agent.spawn(spawn('general-purpose', `task ${t}`))
  for (const surface of ['terminal', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...pane(80, 'inline'), surface })
    expect((await paneRows(ui)).length <= 8).toBe(true)
    expect(await ui.find({ text: /\+2 more/ })).toBeDefined()
    expect(await ui.find({ text: /session log/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a fresh session inline draws the progress line and the orchestrator line', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...pane(80, 'inline'), surface: 'terminal' })
  expect(await ui.find({ text: /no plan yet/ })).toBeDefined()
  expect(await ui.find({ text: /ORCHESTRATOR/ })).toBeUndefined()
  expect((await paneRows(ui)).length).toBe(2)
  await ui.unmount()
})

test('/conductor-mod layout mini forces the mini layout when docked', async ($, on) => {
  engine(on)
  await $.command.run({ command: 'conductor-mod', args: 'layout mini' } as never)
  const ui = await $.ui.mount({ ...pane(120), surface: 'terminal' })
  expect(await ui.find({ text: /ORCHESTRATOR/ })).toBeUndefined()
  expect(await ui.find({ text: /no plan yet/ })).toBeDefined()
  await ui.unmount()
})

test('layout hybrid forces hybrid on a docked pane, even under 40 columns, but inline is always mini', async ($, on) => {
  engine(on)
  await fanOut($, on, ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5'])
  await $.command.run({ command: 'conductor-mod', args: 'layout hybrid' } as never)
  const narrow = await $.ui.mount({ ...pane(30), surface: 'terminal' })
  expect(await narrow.find({ text: /ORCHESTRATOR/ })).toBeDefined()
  await narrow.unmount()
  const inline = await $.ui.mount({ ...pane(80, 'inline'), surface: 'terminal' })
  expect((await paneRows(inline)).length <= 8).toBe(true)
  expect(await inline.find({ text: /ORCHESTRATOR/ })).toBeUndefined()
  expect(await inline.find({ text: /session log/ })).toBeUndefined()
  await inline.unmount()
  await $.command.run({ command: 'conductor-mod', args: 'layout auto' } as never)
  const auto = await $.ui.mount({ ...pane(30), surface: 'terminal' })
  expect(await auto.find({ text: /ORCHESTRATOR/ })).toBeUndefined()
  await auto.unmount()
})

test('a mini worker line leads with W<n>, ⚠ when flagged, its tier and its family', async ($, on) => {
  engine(on)
  await fanOut($, on, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'])
  const ui = await $.ui.mount({ ...pane(80, 'inline'), surface: 'terminal' })
  // W1 runs the parent's model (opus) with none passed: flagged. The others come from their definitions.
  expect(await ui.find({ text: /^W1⚠ T2 opus /, type: 'Text' })).toBeDefined()
  expect(await ui.find({ text: /^W2 T1 sonnet /, type: 'Text' })).toBeDefined()
  expect(await ui.find({ text: /^W3 T0 haiku /, type: 'Text' })).toBeDefined()
  expect(await ui.find({ text: /^W[23]⚠/, type: 'Text' })).toBeUndefined()
  // Running workers read newest first.
  expect((await paneRows(ui)).slice(3, 6).map(r => textOf(r).slice(0, 2))).toEqual(['W3', 'W2', 'W1'])
  await ui.unmount()
})

test('"+n more" points to /conductor-mod layout hybrid only where that brings hybrid back', async ($, on) => {
  engine(on)
  await fanOut($, on, ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5'])
  const inline = await $.ui.mount({ ...pane(80, 'inline'), surface: 'terminal' })
  expect(await inline.find({ text: /^\+1 more$/ })).toBeDefined()
  await inline.unmount()
  const narrow = await $.ui.mount({ ...pane(30), surface: 'terminal' })
  expect(await narrow.find({ text: /^\+1 more$/ })).toBeDefined()
  await narrow.unmount()
  await $.command.run({ command: 'conductor-mod', args: 'layout mini' } as never)
  const docked = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await docked.find({ text: /^\+1 more · \/conductor-mod layout hybrid$/ })).toBeDefined()
  await docked.unmount()
})

test('the context in mini: green below the amber line, amber at 70%, red at 80% with "checkpoint now"', async ($, on) => {
  engine(on)
  const seen: [number, string, boolean][] = []
  for (const pct of [50, 72, 85]) {
    await $.session.measure({ context: { window: 200_000, tokens: pct * 2000, percent: pct }, rateLimits: [], changed: ['context'] })
    const ui = await $.ui.mount({ ...pane(80, 'inline'), surface: 'terminal' })
    const rows = await paneRows(ui)
    const orchestrator = rows.find(r => /ctx/.test(textOf(r)))
    // The innermost Text that says it: the row itself says as much when the model is not yet known.
    const ctx = elements(orchestrator as Drawn)
      .filter(e => e.type === 'Text' && textOf(e) === `ctx ${pct}%`)
      .at(-1)
    seen.push([pct, String(ctx?.props?.color), /checkpoint now/.test(textOf(orchestrator as Drawn))])
    await ui.unmount()
  }
  expect(seen).toEqual([
    [50, 'success', false],
    [72, 'warning', false],
    [85, 'error', true],
  ])
})

test('the crowded mini pane is exactly 8 rows, each one line of at most the pane width, from 20 to 120 columns', async ($, on) => {
  await crowded($, on, 85)
  for (const cols of [20, 24, 30, 32, 40, 60, 80, 120]) {
    const ui = await $.ui.mount({ ...pane(cols, 'inline'), surface: 'terminal' })
    const rows = await paneRows(ui)
    expect(rows).toHaveLength(8)
    for (const r of rows) {
      expect(rowProps(r).wrap).toBe('truncate')
      expect(textOf(r).length).toBeLessThanOrEqual(cols)
    }
    const [progress, nowNext, orchestrator, ...rest] = rows.map(textOf)
    expect(progress).toMatch(/^ {0,2}\d+% /)
    expect(nowNext).toMatch(/^▶ /)
    // The context and the alarm are what a narrow pane keeps; the model name is what it gives up.
    expect(orchestrator).toMatch(/ctx 85%|85% /)
    expect(orchestrator).toMatch(/checkpoint now/)
    expect(/^Opus 5\.5 T2 · /.test(String(orchestrator))).toBe(cols >= 40)
    // The three newest running workers: W5 (flagged), W4, W3, each with its tier, and the rest folded into `+2 more`.
    expect(rest.slice(0, 3).map(l => l.slice(0, 2))).toEqual(['W5', 'W4', 'W3'])
    expect(rest[0]).toMatch(/^W5⚠ T2 opus ●/)
    expect(rest[1]).toMatch(/^W4 T1 sonnet ●/)
    expect(rest[2]).toMatch(/^W3 T0 haiku ●/)
    expect(rest[3]).toMatch(/^\+2 more/)
    await ui.unmount()
  }
})

test('a flagged worker keeps ⚠ and its tier at every mini width', async ($, on) => {
  engine(on)
  let k = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `fl${++k}` }))
  await $.turn.start({ text: 'go', turnId: 'FL' })
  await $.agent.spawn(spawn('general-purpose', 'a worker with a rather long description that cannot fit a narrow pane'))
  for (const cols of [20, 24, 30, 40, 80]) {
    const ui = await $.ui.mount({ ...pane(cols, 'inline'), surface: 'terminal' })
    const line = (await paneRows(ui)).map(textOf).find(t => /^W1/.test(t))
    expect(line).toMatch(/^W1⚠ T2 opus/)
    expect(String(line).length).toBeLessThanOrEqual(cols)
    await ui.unmount()
  }
})

test('a docked pane under 40 columns draws the mini layout: 30 columns, 8 rows, every row inside the width', async ($, on) => {
  await crowded($, on, 72)
  const ui = await $.ui.mount({ ...pane(30), surface: 'terminal' })
  expect(await ui.find({ text: /ORCHESTRATOR/ })).toBeUndefined()
  const rows = await paneRows(ui)
  expect(rows).toHaveLength(8)
  for (const r of rows) {
    expect(rowProps(r).wrap).toBe('truncate')
    expect(textOf(r).length).toBeLessThanOrEqual(30)
  }
  const root = (await ui.drawn()) as Exclude<Drawn, string>
  expect(root.props?.width).toBe(30)
  await ui.unmount()
})

// Servers strip: local servers this session started in the background, and the localhost ports it used.

/** A background Bash call answers with its job id as Claude Code words it (inferred); any other call answers `ok`. */
const answerJobs = (on: On, id?: string) =>
  on('tool.call', (_$, e) => ({
    result: {},
    text: (e as unknown as { run_in_background?: boolean }).run_in_background
      ? `Command running in background with ID: ${id ?? `job-${e.tool_use_id}`}`
      : 'ok',
  }))

test('a background dev server shows live with its port, then stopped after its notice', async ($, on) => {
  engine(on)
  answerJobs(on, 'b7k2x9')
  await $.turn.start({ text: 'serve it', turnId: 'V1' })
  await callTool($, { tool: 'Bash', command: 'pnpm dev --port 3300', run_in_background: true, tool_use_id: 'sv1' })
  await callTool($, { tool: 'Bash', command: 'curl -s http://localhost:3300/', tool_use_id: 'sv2' })
  let ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /:3300/ })).toBeDefined()
  expect(await ui.find({ text: /live/ })).toBeDefined()
  expect(await ui.find({ text: /·1×/ })).toBeDefined()
  await ui.unmount()
  await $.turn.start({ text: '<task-notification><task-id>b7k2x9</task-id><status>killed</status></task-notification>', turnId: 'V2' })
  ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /stopped/ })).toBeDefined()
  expect(await ui.find({ text: /live/ })).toBeUndefined()
  await ui.unmount()
})

test('a port used here but started elsewhere is listed as in use', async ($, on) => {
  engine(on)
  answerJobs(on)
  await callTool($, { tool: 'Bash', command: 'curl localhost:8080/health', tool_use_id: 'se1' })
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  const rows = serverRows(await ui.drawn())
  expect(rows.map(textOf)).toEqual(['srv:8080○ in use  used 0s ago ·1× · started elsewhere'])
  await ui.unmount()
})

test('with no servers the strip takes no rows', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(serverRows(await ui.drawn())).toHaveLength(0)
  await ui.unmount()
})

test('servers rows are keyed by server, newest first, so a row keeps its identity as the list changes', async ($, on) => {
  const clock = engine(on)
  answerJobs(on)
  await callTool($, { tool: 'Bash', command: 'pnpm dev --port 3300', run_in_background: true, tool_use_id: 'key1' })
  await clock.advance(1000)
  await callTool($, { tool: 'Bash', command: 'uvicorn app:app --port 8000', run_in_background: true, tool_use_id: 'key2' })
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  const keys = serverRows(await ui.drawn()).map(r => (r as unknown as { key?: unknown }).key ?? r.props?.key)
  expect(keys).toEqual(['srv-key2', 'srv-key1'])
  await ui.unmount()
})

test('a probe and the start of the same server are one live row, whichever came first', async ($, on) => {
  engine(on)
  answerJobs(on)
  // Probe first, then start with the port in the command.
  await callTool($, { tool: 'Bash', command: 'curl -s localhost:3300/', tool_use_id: 'one1' })
  await callTool($, { tool: 'Bash', command: 'pnpm dev --port 3300', run_in_background: true, tool_use_id: 'one2' })
  // Start with the port unknown, then the first local port it uses.
  await callTool($, { tool: 'Bash', command: 'npm run dev', run_in_background: true, tool_use_id: 'one3' })
  await callTool($, { tool: 'Bash', command: 'curl -s localhost:5173/', tool_use_id: 'one4' })
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  const rows = serverRows(await ui.drawn()).map(textOf)
  expect(rows).toHaveLength(2)
  expect(rows.filter(r => /^(srv)?:3300● live +used 0s ago ·1× · pnpm dev --port 3300$/.test(r))).toHaveLength(1)
  expect(rows.filter(r => /^(srv)?:5173● live +used 0s ago ·1× · npm run dev$/.test(r))).toHaveLength(1)
  expect(await ui.find({ text: /in use/ })).toBeUndefined()
  await ui.unmount()
})

/** Eight prompts in the log and three live servers, in a pane with 22 body rows; `panels` is the plugin's option. */
const logWithServers = async ($: Engine, on: On) => {
  engine(on)
  answerJobs(on)
  for (let i = 0; i < 8; i += 1) await $.turn.start({ text: `step ${i}`, turnId: `L${i}` })
  for (const [i, port] of [3300, 5173, 8000].entries()) {
    await callTool($, { tool: 'Bash', command: `pnpm dev --port ${port}`, run_in_background: true, tool_use_id: `lg${i}` })
  }
  const base = pane(80)
  const ui = await $.ui.mount({ ...base, props: { ...base.props, scroll: { offset: 0, bodyRows: 22 } }, surface: 'terminal' })
  const tree = await ui.drawn()
  await ui.unmount()
  return { servers: serverRows(tree).length, log: logRows(tree).length }
}

const WITHOUT_SERVERS = 'progress,crew,plan,workflow,architect,gate,log'

test('the three server rows take their share of the pane, so the log gets fewer rows', async ($, on) => {
  expect(await logWithServers($, on)).toEqual({ servers: 3, log: 3 })
})

test(
  'with the servers panel off, no server rows are drawn and none are counted against the log',
  { options: { panels: WITHOUT_SERVERS } },
  async ($, on) => {
    expect(await logWithServers($, on)).toEqual({ servers: 0, log: 6 })
  },
)

test('the servers rows keep their port, state and use time inside 40, 60, 80 and 120 columns', async ($, on) => {
  const clock = engine(on)
  answerJobs(on)
  await $.turn.start({ text: 'serve it', turnId: 'V3' })
  const commands = [
    'pnpm dev --port 3300 --host 0.0.0.0 --open --no-clear-screen',
    'npm run dev -- --port 5173 --strictPort --logLevel info',
    'uvicorn app.main:app --reload --port 8000 --log-level debug --workers 4',
    'python3 -m http.server 8080 --bind 127.0.0.1 --directory /tmp/some/long/path',
  ]
  for (const [i, command] of commands.entries()) {
    await callTool($, { tool: 'Bash', command, run_in_background: true, tool_use_id: `w${i}` })
  }
  await callTool($, { tool: 'Bash', command: 'curl localhost:9000', tool_use_id: 'w-seen' })
  // Twelve uses of the first one, an hour and five minutes ago: the widest `used … ago ·n×` the strip can show.
  for (let i = 0; i < 12; i += 1) await callTool($, { tool: 'Bash', command: 'curl localhost:3300/x', tool_use_id: `u${i}` })
  await clock.advance(65 * 60_000)
  for (const cols of WIDTHS) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    const tree = await ui.drawn()
    const rows = serverRows(tree)
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(cellsOf(r as never)).toBeLessThanOrEqual(cols)
      expect(textOf(r as never)).toMatch(/^(srv)?:\d+● live/)
    }
    expect(textOf(rows[0] as never)).toMatch(/^srv:3300● live +used 1h05m ago/)
    // 4 live and 1 in use: three rows and the rest folded into one line that fits too.
    const more = elements(tree as Drawn).find(e => e.type === 'Text' && /\+2 more/.test(textOf(e)))
    expect(textOf(more as never).trim()).toBe('+2 more')
    expect(textOf(more as never).length).toBeLessThanOrEqual(cols)
    // The width a row has after its label (6), port (8) and state (9) is what the tail gets: at 120 the command shows whole.
    if (cols === 120) expect(textOf(rows[0] as never)).toContain('pnpm dev --port 3300 --host 0.0.0.0 --open')
    if (cols === 40) expect(textOf(rows[0] as never)).not.toMatch(/pnpm/)
    await ui.unmount()
  }
})

test('a credential in a server command is masked before it is stored or drawn', async ($, on) => {
  engine(on)
  answerJobs(on)
  await callTool($, {
    tool: 'Bash',
    command: 'API_TOKEN=abcdefghijklmnop1234 pnpm dev --port 3300',
    run_in_background: true,
    tool_use_id: 'rd1',
  })
  const ui = await $.ui.mount({ ...pane(120), surface: 'terminal' })
  expect(await ui.find({ text: /API_TOKEN=•••/ })).toBeDefined()
  expect(await ui.find({ text: /abcdefghijklmnop1234/ })).toBeUndefined()
  await ui.unmount()
})

/** Opus at the helm, one live server on :3300, and the context at `pct`. */
const miniWithServer = async ($: Engine, on: On, pct: number) => {
  engine(on)
  answerJobs(on)
  const step = $.turn.step({ turnId: 'MS', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of step) void _
  await step.result
  await callTool($, { tool: 'Bash', command: 'pnpm dev --port 3300', run_in_background: true, tool_use_id: 'ms1' })
  await $.session.measure({ context: { window: 200_000, tokens: pct * 2000, percent: pct }, rateLimits: [], changed: ['context'] })
}

/** The orchestrator line: the row with a Text of its own that reads `ctx 85%` (or `85%` where `ctx` has given way). */
const orchestratorText = async (ui: { drawn: () => Promise<unknown> }) =>
  (await paneRows(ui))
    .filter(r => elements(r as Drawn).some(e => e.type === 'Text' && /^(ctx )?\d+%$/.test(textOf(e))))
    .map(textOf)[0] as string

test('in mini, the servers come after the context and the alarm and are the first thing cut', async ($, on) => {
  await miniWithServer($, on, 85)
  const seen: [number, string][] = []
  for (const cols of [20, 24, 30, 40, 60, 120]) {
    const ui = await $.ui.mount({ ...pane(cols, 'inline'), surface: 'terminal' })
    const line = await orchestratorText(ui)
    expect(line.length).toBeLessThanOrEqual(cols)
    expect(line).toMatch(/checkpoint now/)
    seen.push([cols, line])
    await ui.unmount()
  }
  expect(seen.find(([c]) => c === 30)?.[1]).toBe('ctx 85% · checkpoint now')
  expect(seen.find(([c]) => c === 40)?.[1]).toBe('Opus 5.5 T2 · ctx 85% · checkpoint now')
  expect(seen.find(([c]) => c === 60)?.[1]).toBe('Opus 5.5 T2 · ctx 85% · checkpoint now · srv :3300●')
  expect(seen.find(([c]) => c === 120)?.[1]).toBe('Opus 5.5 T2 · ctx 85% · checkpoint now · srv :3300●')
  // No wider pane loses anything a narrower one kept: the alarm is in every row above.
  expect(seen.filter(([, l]) => /srv/.test(l)).map(([c]) => c)).toEqual([60, 120])
})

test('in mini, below the alarm the server shows where it fits and never costs the context its room', async ($, on) => {
  await miniWithServer($, on, 72)
  const seen = new Map<number, string>()
  for (const cols of [20, 30, 40, 80]) {
    const ui = await $.ui.mount({ ...pane(cols, 'inline'), surface: 'terminal' })
    const line = await orchestratorText(ui)
    expect(line.length).toBeLessThanOrEqual(cols)
    expect(line).toMatch(/ctx 72%/)
    seen.set(cols, line)
    await ui.unmount()
  }
  expect(seen.get(30)).toBe('Opus 5.5 T2 · ctx 72%')
  expect(seen.get(40)).toBe('Opus 5.5 T2 · ctx 72% · srv :3300●')
  expect(seen.get(80)).toBe('Opus 5.5 T2 · ctx 72% · srv :3300●')
})

test('the crowded mini pane with a server stays 8 rows and keeps the alarm from 20 to 120 columns', async ($, on) => {
  await crowded($, on, 85)
  await callTool($, { tool: 'Bash', command: 'pnpm dev --port 3300', run_in_background: true, tool_use_id: 'cs1' })
  for (const cols of [20, 24, 30, 32, 40, 60, 80, 120]) {
    const ui = await $.ui.mount({ ...pane(cols, 'inline'), surface: 'terminal' })
    const rows = await paneRows(ui)
    expect(rows).toHaveLength(8)
    for (const r of rows) {
      expect(rowProps(r).wrap).toBe('truncate')
      expect(textOf(r).length).toBeLessThanOrEqual(cols)
    }
    const orchestrator = rows.map(textOf)[2] as string
    expect(orchestrator).toMatch(/checkpoint now/)
    expect(/srv :3300●$/.test(orchestrator)).toBe(cols >= 60)
    await ui.unmount()
  }
})
