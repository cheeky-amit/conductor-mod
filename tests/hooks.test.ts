import { expect, mock, test } from 'claude-code/testing'

import { agentCalls, callTool, type Drawn, engine, logRows, pane, spawn, textOf } from './fixtures'

test('tasks drive the progress row: %, done/total and ETA after the first finish', async ($, on) => {
  const clock = engine(on)
  let id = 0
  on('tool.call', (_$, e) => ({ result: {}, text: String(e.tool) === 'TaskCreate' ? `Task #${++id} created successfully` : 'ok' }))
  await $.turn.start({ text: 'plan', turnId: 'P1' })
  for (const subject of ['one', 'two', 'three']) {
    await callTool($, { tool: 'TaskCreate', subject, tool_use_id: `c-${subject}` })
  }
  await callTool($, { tool: 'TaskUpdate', taskId: '1', status: 'in_progress', tool_use_id: 'u1' })
  await clock.advance(3 * 60_000)
  await callTool($, { tool: 'TaskUpdate', taskId: '1', status: 'completed', tool_use_id: 'u2' })
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /33%/ })).toBeDefined()
  expect(await ui.find({ text: /~6m left/ })).toBeDefined()
  expect(await ui.find({ text: /1\/3 tasks/ })).toBeDefined()
  expect(await ui.find({ text: /next/ })).toBeDefined()
  await ui.unmount()
})

test('every task done: the progress row says done instead of <1m left, and the status line drops the ETA', async ($, on) => {
  const clock = mock.clock(on)
  const statuses: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  let id = 0
  on('tool.call', (_$, e) => ({ result: {}, text: String(e.tool) === 'TaskCreate' ? `Task #${++id} created successfully` : 'ok' }))
  await $.turn.start({ text: 'plan', turnId: 'D1' })
  for (const subject of ['one', 'two']) await callTool($, { tool: 'TaskCreate', subject, tool_use_id: `c-${subject}` })
  await callTool($, { tool: 'TaskUpdate', taskId: '1', status: 'in_progress', tool_use_id: 'u1' })
  await clock.advance(3 * 60_000)
  await callTool($, { tool: 'TaskUpdate', taskId: '1', status: 'completed', tool_use_id: 'u2' })
  expect(statuses.at(-1)).toBe('50% · ~3m')
  await callTool($, { tool: 'TaskUpdate', taskId: '2', status: 'in_progress', tool_use_id: 'u3' })
  await callTool($, { tool: 'TaskUpdate', taskId: '2', status: 'completed', tool_use_id: 'u4' })
  expect(statuses.at(-1)).toBe('100%')
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /100%/ })).toBeDefined()
  expect(await ui.find({ text: /^ {2}done$/ })).toBeDefined()
  expect(await ui.find({ text: /2\/2 tasks/ })).toBeDefined()
  expect(await ui.find({ text: /left|<1m|ETA/ })).toBeUndefined()
  await ui.unmount()
})

test('with no task list, workflow progress counts agents, never reads 100% while the run is open, and has no ETA', async ($, on) => {
  mock.clock(on)
  const statuses: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {}, text: 'Workflow started: wf_ab12cd34' }))
  // biome-ignore lint/correctness/useYield: the bottom of the chain answers the step without streaming
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model: e.model, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
  })
  await $.turn.start({ text: 'review', turnId: 'WF1' })
  const script = "export const meta = { name: 'two-phase', phases: [{ title: 'Review' }, { title: 'Verify' }] }"
  await callTool($, { tool: 'Workflow', script, tool_use_id: 'wf-call' })
  const s = $.turn.step({ turnId: 'WF1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'loopA' })
  for await (const _ of s) void _
  await s.result
  await $.turn.complete({ agentId: 'loopA', turnId: 'WF1', reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false })
  // One agent seen, and done; phase two has not started.
  expect(statuses.at(-1)).toBe('99%')
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /^ 99% $/ })).toBeDefined()
  expect(await ui.find({ text: /^ {2}ETA —$/ })).toBeDefined()
  expect(await ui.find({ text: /^ {2}1\/1 agents · / })).toBeDefined()
  expect(await ui.find({ text: /phases/ })).toBeUndefined()
  expect(await ui.find({ text: /100%|left|<1m/ })).toBeUndefined()
  await ui.unmount()
  // The completion notice (it carries the run's tool-use-id) ends the run: now it is whole.
  await $.turn.start({
    text: '<task-notification><task-id>x</task-id><tool-use-id>wf-call</tool-use-id><summary>Dynamic workflow "two-phase" completed</summary></task-notification>',
    turnId: 'WF2',
  })
  expect(statuses.at(-1)).toBe('100%')
})

test('with nothing to measure, the progress row says so', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /no plan yet/ })).toBeDefined()
  await ui.unmount()
})

test('any Agent call without an explicit model is flagged in the status line, inherited or from its definition; a passed model or an unlinked spawn is not', async ($, on) => {
  // The engine stubs, with a status line that records what it is shown.
  mock.clock(on)
  const statuses: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5']
  let k = 0
  on('agent.spawn', () => ({ model: models[k] ?? 'claude-sonnet-5-5', agentId: `ag${++k}` }))
  const agentCall = agentCalls(on)
  await $.turn.start({ text: 'fan out', turnId: 'S1' })
  await agentCall($, spawn('general-purpose', 'review panel')) // none passed, the parent's model: inherited
  expect(statuses.at(-1)).toMatch(/1 running · 1⚠/)
  await agentCall($, spawn('Explore', 'map call sites')) // none passed, its definition chose sonnet: flagged too
  expect(statuses.at(-1)).toMatch(/2 running · 2⚠/)
  await agentCall($, spawn('Explore', 'pinned model'), 'sonnet') // a model passed: not flagged
  expect(statuses.at(-1)).toMatch(/3 running · 2⚠/)
  await $.agent.spawn(spawn('Explore', 'unlinked spawn')) // no Agent call to read: whether one was passed is unknown, not flagged
  expect(statuses.at(-1)).toMatch(/4 running · 2⚠/)
  // Four workers fold into rows, where the flag sits in the label cell.
  const ui = await $.ui.mount({ ...pane(120), surface: 'terminal' })
  expect(await ui.find({ text: /^W1⚠ T2 opus/ })).toBeDefined()
  expect(await ui.find({ text: /^W2⚠ T1 sonnet/ })).toBeDefined()
  expect(await ui.find({ text: /^W[34]⚠/ })).toBeUndefined()
  await ui.unmount()
})

test('/clear starts the pane fresh', async ($, on) => {
  engine(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'c1' }))
  await $.turn.start({ text: 'go', turnId: 'C1' })
  await $.agent.spawn(spawn('Explore', 'look around'))
  await $.session.end({ reason: 'clear', sessionId: 's' } as never)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /look around/ })).toBeUndefined()
  await ui.unmount()
})

test('a credential in an agent description is redacted before it is stored', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'r1' }))
  await $.turn.start({ text: 'go', turnId: 'R1' })
  await $.agent.spawn(spawn('Explore', 'scan with API_TOKEN=abcdefghijklmnop1234 set'))
  // Wide enough that the now row shows the whole stored description, so a leak could not hide in a cut.
  const ui = await $.ui.mount({ ...pane(120), surface: 'terminal' })
  expect(await ui.find({ text: /W1 scan with API_TOKEN=•••/ })).toBeDefined()
  expect(await ui.find({ text: /abcdefghijklmnop1234/ })).toBeUndefined()
  await ui.unmount()
})

test('a credential in an agent name is redacted before the worker is stored', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'n1' }))
  await $.turn.start({ text: 'go', turnId: 'N1' })
  // With no description the now row shows the stored type, which is the agent's name.
  await $.agent.spawn({ ...spawn('Explore', ''), name: 'scout API_TOKEN=abcdefghijklmnop1234' })
  const ui = await $.ui.mount({ ...pane(120), surface: 'terminal' })
  expect(await ui.find({ text: /W1 scout API_TOKEN=•••/ })).toBeDefined()
  expect(await ui.find({ text: /abcdefghijklmnop1234/ })).toBeUndefined()
  await ui.unmount()
})

test('a pane that cannot be drawn says so in one row instead of throwing', async ($, on) => {
  let isBroken = false
  on('clock.now', () => {
    if (isBroken) throw new Error('clock unavailable')
    return { value: 1000 }
  })
  on('ui.status', () => ({ value: undefined }))
  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  expect(await ui.find({ text: /no plan yet/ })).toBeDefined()
  await ui.unmount()
  isBroken = true
  const failed = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  const row = await failed.find({ text: /conductor-mod render failed: / })
  expect(row).toBeDefined()
  expect(String(row?.text).length).toBeLessThanOrEqual(60)
  await failed.unmount()
})

test('a store or engine failure inside /conductor-mod comes back as text, not an exception', async ($, on) => {
  engine(on)
  on('ui.close', () => {
    throw new Error('pane host gone')
  })
  const out = await $.command.run({ command: 'conductor-mod', args: 'close' } as never)
  expect((out as { text?: string }).text).toMatch(/^conductor-mod failed: /)
})

test('a failed hook leaves a log row whose label column is wide enough for conductor-mod, with a gap before the text', async ($, on) => {
  let calls = 0
  on('clock.now', () => {
    calls += 1
    if (calls === 1) throw new Error('clock unavailable')
    return { value: 1000 }
  })
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'go', turnId: 'F1' })
  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  const row = logRows(await ui.drawn()).find(r => /^conductor-mod/.test(textOf(r.children?.[1] as Drawn)))
  expect(textOf(row?.children?.[2] as Drawn)).toMatch(/^turn\.start failed: /)
  const label = row?.children?.[1] as Exclude<Drawn, string>
  expect(Number(label.props?.width)).toBeGreaterThan('conductor-mod'.length)
  await ui.unmount()
})

test('a credential in an architect agent type is redacted before it reaches the log', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'ad1' }))
  await $.turn.start({ text: 'go', turnId: 'D1' })
  await $.agent.spawn(spawn('architect-API_TOKEN=abcdefghijklmnop1234', 'review the plan'))
  const ui = await $.ui.mount({ ...pane(120), surface: 'terminal' })
  expect(await ui.find({ text: /before a plan · architect-API_TOKEN=••• \(inferred\)/ })).toBeDefined()
  expect(await ui.find({ text: /abcdefghijklmnop1234/ })).toBeUndefined()
  await ui.unmount()
})

test('live servers are counted last in the status line and drop out when their notice arrives', async ($, on) => {
  mock.clock(on)
  const statuses: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_$, e) => ({
    result: {},
    text: (e as unknown as { run_in_background?: boolean }).run_in_background
      ? `Command running in background with ID: job-${e.tool_use_id}`
      : 'ok',
  }))
  await $.session.measure({ context: { window: 200_000, tokens: 100_000, percent: 50 }, rateLimits: [], changed: ['context'] })
  expect(statuses.at(-1)).toBe('ctx 50%')
  await $.turn.start({ text: 'serve', turnId: 'SS1' })
  await callTool($, { tool: 'Bash', command: 'pnpm dev --port 3300', run_in_background: true, tool_use_id: 'ss1' })
  expect(statuses.at(-1)).toBe('ctx 50% · 1 srv')
  await callTool($, { tool: 'Bash', command: 'npm run dev -- --port 5173', run_in_background: true, tool_use_id: 'ss2' })
  expect(statuses.at(-1)).toBe('ctx 50% · 2 srv')
  await $.turn.start({ text: '<task-notification><task-id>job-ss1</task-id><status>killed</status></task-notification>', turnId: 'SS2' })
  expect(statuses.at(-1)).toBe('ctx 50% · 1 srv')
  await callTool($, { tool: 'KillShell', shell_id: 'job-ss2', tool_use_id: 'ss3' })
  expect(statuses.at(-1)).toBe('ctx 50%')
})

test('a server call that was denied is not recorded', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ deny: 'not allowed' }))
  await callTool($, { tool: 'Bash', command: 'pnpm dev --port 3300', run_in_background: true, tool_use_id: 'dn1' })
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /:3300/ })).toBeUndefined()
  await ui.unmount()
})

test('/conductor-mod reset and /clear forget the servers', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {}, text: 'Command running in background with ID: rs1abc' }))
  await callTool($, { tool: 'Bash', command: 'pnpm dev --port 3300', run_in_background: true, tool_use_id: 'rs1' })
  let ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /:3300/ })).toBeDefined()
  await ui.unmount()
  await $.command.run({ command: 'conductor-mod', args: 'reset' } as never)
  ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /:3300/ })).toBeUndefined()
  await ui.unmount()
})
