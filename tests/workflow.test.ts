import { expect, test } from 'claude-code/testing'

import {
  activeRun,
  endRunByText,
  finishRunAgent,
  loopPhase,
  parseWorkflowMeta,
  runProgress,
  runRefOf,
  startRun,
  stepRunAgent,
  workflowMetaOf,
} from '../hooks/model/workflow'

const SCRIPT = `export const meta = {
  name: 'review-changes',
  description: 'Review changed files, verify each finding',
  phases: [{ title: 'Review' }, { title: "Verify", detail: 'adversarial' }],
}
const x = { name: 'not-this-one' }`

const firstRun = (runs: ReturnType<typeof startRun>) => {
  const run = runs[0]
  if (!run) throw new Error('expected at least one run')
  return run
}

test('meta: name and phase titles come from the meta literal only', () => {
  expect(parseWorkflowMeta(SCRIPT)).toEqual({ name: 'review-changes', phases: ['Review', 'Verify'] })
  expect(parseWorkflowMeta('no meta here')).toEqual({ name: 'workflow', phases: [] })
  expect(parseWorkflowMeta("export const meta = { name: 'x' }")).toEqual({ name: 'x', phases: [] })
})

test('run reference is the wf_ id in a text', () => {
  expect(runRefOf('Started workflow wf_ab12cd34 in background')).toBe('wf_ab12cd34')
  expect(runRefOf('nothing')).toBe(null)
})

test('unclaimed loops during a run become its agents; phases progress when agents carry one', () => {
  let runs = startRun([], { id: 'tu1', ref: 'wf_ab12cd34', name: 'review-changes', phases: ['Review', 'Verify'], at: 0 })
  runs = stepRunAgent(runs, { agentId: 'l1', phase: 'Review', at: 1 })
  runs = stepRunAgent(runs, { agentId: 'l2', phase: 'Review', at: 1 })
  runs = stepRunAgent(runs, { agentId: 'l1', phase: null, at: 2 }) // a later step keeps its phase
  runs = finishRunAgent(runs, 'l1', 3)
  runs = finishRunAgent(runs, 'l2', 3)
  runs = stepRunAgent(runs, { agentId: 'l3', phase: 'Verify', at: 4 })
  const p = runProgress(activeRun(runs) ?? firstRun(runs))
  expect([p.done, p.total, p.hasPhaseData]).toEqual([2, 3, true])
  expect(p.phases.map(x => [x.title, x.done, x.total, x.state])).toEqual([
    ['Review', 2, 2, 'done'],
    ['Verify', 0, 1, 'current'],
  ])
})

test('without phase data, only totals; the completion notice ends the run by its ref', () => {
  let runs = startRun([], { id: 'tu1', ref: 'wf_ab12cd34', name: 'w', phases: ['A', 'B'], at: 0 })
  runs = stepRunAgent(runs, { agentId: 'l1', phase: null, at: 1 })
  const p = runProgress(firstRun(runs))
  expect([p.hasPhaseData, p.phases.map(x => x.state)]).toEqual([false, ['waiting', 'waiting']])
  runs = endRunByText(runs, '<task-notification> workflow wf_ab12cd34 completed', 9)
  expect([runs[0]?.endedAt, activeRun(runs)]).toEqual([9, null])
  expect(stepRunAgent(runs, { agentId: 'late', phase: null, at: 10 })).toEqual(runs) // no active run: ignored
})

test('a notice without a known ref ends the only active run; runs are capped', () => {
  let runs = startRun([], { id: 'a', ref: null, name: 'w', phases: [], at: 0 })
  runs = endRunByText(runs, '<task-notification>workflow finished</task-notification>', 5)
  expect(runs[0]?.endedAt).toBe(5)
  for (let i = 0; i < 7; i += 1) runs = startRun(runs, { id: `r${i}`, ref: null, name: 'w', phases: [], at: i })
  expect(runs.length).toBe(5)
})

test('loopPhase reads a phase field when the event has one', () => {
  expect([loopPhase({ phase: 'Verify' }), loopPhase({}), loopPhase(null)]).toEqual(['Verify', null, null])
})

test('a notice carrying a run tool-use-id ends that run even when another run is open', () => {
  let runs = startRun([], { id: 'tu1', ref: null, name: 'a', phases: [], at: 0 })
  runs = startRun(runs, { id: 'tu2', ref: null, name: 'b', phases: [], at: 1 })
  const notice =
    '<task-notification>\n<task-id>x1</task-id>\n<tool-use-id>tu1</tool-use-id>\n<summary>Dynamic workflow "a" completed</summary>'
  runs = endRunByText(runs, notice, 7)
  expect(runs.map(r => [r.id, r.endedAt])).toEqual([
    ['tu1', 7],
    ['tu2', null],
  ])
})

test('a notice naming an ended run, by ref or by id, leaves the other open run alone', () => {
  let runs = startRun([], { id: 'tu1', ref: 'wf_aaaa1111', name: 'a', phases: [], at: 0 })
  runs = startRun(runs, { id: 'tu2', ref: 'wf_bbbb2222', name: 'b', phases: [], at: 1 })
  runs = endRunByText(runs, '<task-notification>workflow wf_aaaa1111 completed</task-notification>', 3)
  expect(runs.map(r => r.endedAt)).toEqual([3, null])
  const again = endRunByText(runs, '<task-notification>workflow wf_aaaa1111 completed again</task-notification>', 8)
  expect(again).toEqual(runs)
  const byId = endRunByText(runs, '<task-notification><tool-use-id>tu1</tool-use-id> workflow completed</task-notification>', 9)
  expect(byId).toEqual(runs)
})

test('the fallback reads the summary only: a body that mentions workflow does not end an unrelated run', () => {
  const runs = startRun([], { id: 'tu1', ref: null, name: 'w', phases: [], at: 0 })
  const unrelated =
    '<task-notification>\n<summary>Background command "npm test" completed</summary>\n<result>ran the workflow tests</result>\n</task-notification>'
  expect(endRunByText(runs, unrelated, 4)).toEqual(runs)
  const own = '<task-notification>\n<summary>Dynamic workflow "w" completed</summary>\n</task-notification>'
  expect(endRunByText(runs, own, 4)[0]?.endedAt).toBe(4)
})

test('the fallback is for a notice with no tool-use-id: an Agent or Bash notice that says "workflow" leaves the open run alone', () => {
  const runs = startRun([], { id: 'tu1', ref: null, name: 'w', phases: [], at: 0 })
  const agent =
    '<task-notification>\n<task-id>a7</task-id>\n<tool-use-id>toolu_agent7</tool-use-id>\n<status>completed</status>\n<summary>Agent "Fix workflow strip" completed</summary>\n</task-notification>'
  expect(endRunByText(runs, agent, 4)).toEqual(runs)
  const bash =
    '<task-notification>\n<task-id>bru8ytew2</task-id>\n<tool-use-id>toolu_bash2</tool-use-id>\n<summary>Background command "run workflow tests" completed (exit code 0)</summary>\n</task-notification>'
  expect(endRunByText(runs, bash, 4)).toEqual(runs)
  // Without any tool-use-id the fallback still applies.
  const bare = '<task-notification>\n<summary>Dynamic workflow "w" completed</summary>\n</task-notification>'
  expect(endRunByText(runs, bare, 4)[0]?.endedAt).toBe(4)
})

test('an ended run shows its last phase as done even if an agent never reported finishing', () => {
  let runs = startRun([], { id: 'tu1', ref: 'wf_ab12cd34', name: 'w', phases: ['A', 'B'], at: 0 })
  runs = stepRunAgent(runs, { agentId: 'l1', phase: 'A', at: 1 })
  runs = finishRunAgent(runs, 'l1', 2)
  runs = stepRunAgent(runs, { agentId: 'l2', phase: 'B', at: 3 }) // never finishes
  expect(runProgress(firstRun(runs)).phases.map(x => x.state)).toEqual(['done', 'current'])
  runs = endRunByText(runs, 'workflow wf_ab12cd34 completed', 9)
  expect(runProgress(firstRun(runs)).phases.map(x => x.state)).toEqual(['done', 'done'])
})

test('a Workflow call is stored with credentials masked in its name and phase titles', () => {
  const script =
    "export const meta = { name: 'deploy API_TOKEN=abcdefghijklmnop1234', phases: [{ title: 'push --token=abcdefghijklmnop1234' }] }"
  const fromScript = workflowMetaOf({ script })
  expect(JSON.stringify(fromScript)).not.toContain('abcdefghijklmnop1234')
  expect(fromScript.name).toContain('deploy')
  expect(fromScript.phases[0]).toContain('push')
  const fromName = workflowMetaOf({ name: 'run API_TOKEN=abcdefghijklmnop1234' })
  expect(fromName.name).not.toContain('abcdefghijklmnop1234')
  expect(workflowMetaOf({})).toEqual({ name: 'workflow', phases: [] })
})

test('meta: an apostrophe inside a double-quoted name or title (and the other way round) keeps the name and the phase', () => {
  const script = `export const meta = {
  name: "Amit's flow",
  phases: [{ title: "Review Amit's spec" }, { title: 'Say "done"' }, { title: \`Verify what's left\` }, { title: 'It\\'s over' }],
}`
  expect(parseWorkflowMeta(script)).toEqual({
    name: "Amit's flow",
    phases: ["Review Amit's spec", 'Say "done"', "Verify what's left", "It's over"],
  })
  expect(parseWorkflowMeta('export const meta = { name: "a \\"b\\" c" }')).toEqual({ name: 'a "b" c', phases: [] })
  expect(workflowMetaOf({ script })).toEqual({
    name: "Amit's flow",
    phases: ["Review Amit's spec", 'Say "done"', "Verify what's left", "It's over"],
  })
})
