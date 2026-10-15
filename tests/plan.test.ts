import { expect, test } from 'claude-code/testing'
import type { TaskEvent } from '../hooks/model/plan'
import {
  applyTaskEvent,
  currentTask,
  meanTaskMs,
  nextTask,
  remainingMs,
  taskEta,
  taskFromCreate,
  taskFromTodoWrite,
  taskFromUpdate,
  taskProgress,
} from '../hooks/model/plan'
import type { PlanTask } from '../types'

const run = (events: TaskEvent[]) => events.reduce<PlanTask[]>(applyTaskEvent, [])
const MIN = 60_000

test('TaskCreate is read from its input subject and the id in its result text', () => {
  expect(taskFromCreate({ subject: 'Write tests' }, 'Task #2 created successfully: Write tests', 5)).toEqual({
    kind: 'create',
    id: '2',
    subject: 'Write tests',
    at: 5,
  })
  expect(taskFromCreate({ subject: 'x' }, 'no id here', 5)).toBe(null)
  expect(taskFromCreate({}, 'Task #2 created', 5)).toBe(null)
  // Only the `Task #N` token counts: digits elsewhere in the result text cannot create a phantom task.
  expect(taskFromCreate({ subject: 'x' }, 'Updated 3 files. Task #7 created successfully', 0)).toEqual({
    kind: 'create',
    id: '7',
    subject: 'x',
    at: 0,
  })
  expect(taskFromCreate({ subject: 'x' }, 'Updated 3 files, nothing created', 0)).toBe(null)
})

test('task subjects are redacted before they are stored, by every adapter', () => {
  const secret = 'abcdefghijklmnop1234'
  const text = `deploy API_TOKEN=${secret}`
  const created = taskFromCreate({ subject: text }, 'Task #1 created successfully', 0)
  expect(created).not.toBe(null)
  expect(JSON.stringify(created)).not.toContain(secret)
  expect(JSON.stringify(taskFromUpdate({ taskId: '1', subject: text }, 0))).not.toContain(secret)
  const todo = taskFromTodoWrite({ todos: [{ content: text, status: 'pending' }] }, 0)
  expect(todo).not.toBe(null)
  expect(JSON.stringify(todo)).not.toContain(secret)
  // Redaction runs before the cut, so a secret that straddles the 80-char limit is masked, not truncated into the open.
  const long = taskFromCreate({ subject: `${'x'.repeat(70)} API_TOKEN=${secret}` }, 'Task #1 created successfully', 0)
  expect(JSON.stringify(long)).not.toContain('abcdefg')
})

test('TaskUpdate yields a status and/or subject change; unknown statuses are ignored', () => {
  expect(taskFromUpdate({ taskId: '2', status: 'in_progress' }, 9)).toEqual([{ kind: 'status', id: '2', status: 'in_progress', at: 9 }])
  expect(taskFromUpdate({ taskId: 3, subject: 'Renamed', status: 'bogus' }, 9)).toEqual([{ kind: 'subject', id: '3', subject: 'Renamed' }])
  expect(taskFromUpdate({ status: 'completed' }, 9)).toEqual([])
})

test('status changes stamp start and completion; reopening clears completion', () => {
  const t = run([
    { kind: 'create', id: '1', subject: 'a', at: 0 },
    { kind: 'status', id: '1', status: 'in_progress', at: 1 * MIN },
    { kind: 'status', id: '1', status: 'completed', at: 4 * MIN },
  ])
  expect([t[0]?.startedAt, t[0]?.completedAt]).toEqual([1 * MIN, 4 * MIN])
  const reopened = applyTaskEvent(t, { kind: 'status', id: '1', status: 'in_progress', at: 5 * MIN })
  expect([reopened[0]?.status, reopened[0]?.startedAt, reopened[0]?.completedAt]).toEqual(['in_progress', 5 * MIN, null])
})

test('progress and ETA: mean of finished tasks × what is left, in-progress time credited', () => {
  const t = run([
    { kind: 'create', id: '1', subject: 'a', at: 0 },
    { kind: 'create', id: '2', subject: 'b', at: 0 },
    { kind: 'create', id: '3', subject: 'c', at: 0 },
    { kind: 'create', id: '4', subject: 'gone', at: 0 },
    { kind: 'status', id: '4', status: 'deleted', at: 0 },
    { kind: 'status', id: '1', status: 'in_progress', at: 0 },
    { kind: 'status', id: '1', status: 'completed', at: 3 * MIN },
    { kind: 'status', id: '2', status: 'in_progress', at: 3 * MIN },
  ])
  expect(taskProgress(t)).toEqual({ done: 1, total: 3 })
  expect(meanTaskMs(t)).toBe(3 * MIN)
  // At 4 min: task 2 has 2 min left, task 3 a full 3 min.
  expect(taskEta(t, 4 * MIN)).toBe(5 * MIN)
  expect([currentTask(t), nextTask(t)]).toEqual(['b', 'c'])
})

test('no finished task: no ETA; a task never marked in progress times from creation', () => {
  const t0 = run([{ kind: 'create', id: '1', subject: 'a', at: 0 }])
  expect(taskEta(t0, MIN)).toBe(null)
  const t1 = applyTaskEvent(t0, { kind: 'status', id: '1', status: 'completed', at: 2 * MIN })
  expect(meanTaskMs(t1)).toBe(2 * MIN)
})

test('clock skew cannot push the time left above one mean per item', () => {
  // Started "in the future" (now < startedAt): credited as 0 elapsed, so the full mean remains, never more.
  expect(remainingMs([{ startedAt: 10 * MIN }], 3 * MIN, 4 * MIN)).toBe(3 * MIN)
  expect(remainingMs([{ startedAt: 3 * MIN }], 3 * MIN, 4 * MIN)).toBe(2 * MIN)
  expect(remainingMs([{ startedAt: null }], null, 4 * MIN)).toBe(null)
})

test('TodoWrite replaces the todo list by content, keeping times of unchanged items', () => {
  const e1 = taskFromTodoWrite(
    {
      todos: [
        { content: 'a', status: 'in_progress' },
        { content: 'b', status: 'pending' },
      ],
    },
    0,
  )
  const e2 = taskFromTodoWrite(
    {
      todos: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'pending' },
        { content: 'c', status: 'nope' },
      ],
    },
    2 * MIN,
  )
  expect(e1 && e2).toBeTruthy()
  const t = run([e1 as TaskEvent, e2 as TaskEvent])
  expect(t.map(x => [x.id, x.status])).toEqual([
    ['todo:a', 'completed'],
    ['todo:b', 'pending'],
  ])
  expect(meanTaskMs(t)).toBe(2 * MIN)
})

test('TodoWrite skips blank items; a non-empty list with nothing usable is ignored, an empty one clears', () => {
  expect(
    taskFromTodoWrite(
      {
        todos: [
          { content: '   ', status: 'pending' },
          { content: 'a', status: 'pending' },
        ],
      },
      0,
    ),
  ).toEqual({ kind: 'replace', todos: [{ subject: 'a', status: 'pending' }], at: 0 })
  expect(
    taskFromTodoWrite(
      {
        todos: [
          { content: ' ', status: 'pending' },
          { content: 'x', status: 'nope' },
        ],
      },
      0,
    ),
  ).toBe(null)
  expect(taskFromTodoWrite({ todos: [] }, 0)).toEqual({ kind: 'replace', todos: [], at: 0 })
})
