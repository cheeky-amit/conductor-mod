// The session's task list, read from TaskCreate / TaskUpdate (or TodoWrite) calls: progress, ETA, now and next.
import type { PlanTask, TaskStatus } from '../../types'
import { isObject, redact, shorten } from './util'

export type TaskEvent =
  | { kind: 'create'; id: string; subject: string; at: number }
  | { kind: 'status'; id: string; status: TaskStatus; at: number }
  | { kind: 'subject'; id: string; subject: string }
  | { kind: 'replace'; todos: { subject: string; status: TaskStatus }[]; at: number }

/** A subject as stored: credentials masked first, then cut to fit the strip. */
const clean = (s: string) => shorten(redact(s), 80)

const STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed', 'deleted']
const isStatus = (v: unknown): v is TaskStatus => typeof v === 'string' && (STATUSES as readonly string[]).includes(v)
/** The new task's id in TaskCreate's result text, e.g. `Task #3 created successfully: …`. */
const TASK_ID = /Task #(\d+)/

const withStatus = (t: PlanTask, status: TaskStatus, at: number): PlanTask => {
  if (status === t.status) return t
  if (status === 'in_progress') return { ...t, status, startedAt: at, completedAt: null }
  if (status === 'completed') return { ...t, status, completedAt: at }
  if (status === 'pending') return { ...t, status, startedAt: null, completedAt: null }
  return { ...t, status }
}

const fresh = (id: string, subject: string, at: number): PlanTask => ({
  id,
  subject,
  status: 'pending',
  createdAt: at,
  startedAt: null,
  completedAt: null,
})

export const applyTaskEvent = (tasks: PlanTask[], e: TaskEvent): PlanTask[] => {
  switch (e.kind) {
    case 'create':
      return tasks.some(t => t.id === e.id) ? tasks : [...tasks, fresh(e.id, e.subject, e.at)]
    case 'subject':
      return tasks.map(t => (t.id === e.id ? { ...t, subject: e.subject } : t))
    case 'status':
      return tasks.map(t => (t.id === e.id ? withStatus(t, e.status, e.at) : t))
    case 'replace': {
      const todos = e.todos.map(td => {
        const id = `todo:${td.subject}`
        return withStatus(tasks.find(t => t.id === id) ?? fresh(id, td.subject, e.at), td.status, e.at)
      })
      return [...tasks.filter(t => !t.id.startsWith('todo:')), ...todos]
    }
  }
}

export const taskFromCreate = (input: Record<string, unknown>, resultText: string, at: number): TaskEvent | null => {
  const subject = typeof input.subject === 'string' ? input.subject.trim() : ''
  const id = TASK_ID.exec(resultText)?.[1]
  return subject && id ? { kind: 'create', id, subject: clean(subject), at } : null
}

export const taskFromUpdate = (input: Record<string, unknown>, at: number): TaskEvent[] => {
  const raw = input.taskId
  const id = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : ''
  if (!id) return []
  const out: TaskEvent[] = []
  if (typeof input.subject === 'string' && input.subject.trim()) out.push({ kind: 'subject', id, subject: clean(input.subject) })
  if (isStatus(input.status)) out.push({ kind: 'status', id, status: input.status, at })
  return out
}

export const taskFromTodoWrite = (input: Record<string, unknown>, at: number): TaskEvent | null => {
  const raw = input.todos
  if (!Array.isArray(raw)) return null
  const todos = raw
    .filter(isObject)
    .filter(t => typeof t.content === 'string' && t.content.trim() !== '' && isStatus(t.status))
    .map(t => ({ subject: clean(String(t.content)), status: t.status as TaskStatus }))
  // A non-empty list that yields nothing is malformed, not "clear the list"; only a literal [] clears.
  return todos.length === 0 && raw.length > 0 ? null : { kind: 'replace', todos, at }
}

export const liveTasks = (tasks: PlanTask[]) => tasks.filter(t => t.status !== 'deleted')

export const taskProgress = (tasks: PlanTask[]) => {
  const live = liveTasks(tasks)
  return { done: live.filter(t => t.status === 'completed').length, total: live.length }
}

export const meanTaskMs = (tasks: PlanTask[]) => {
  const d = liveTasks(tasks)
    .filter(t => t.status === 'completed' && t.completedAt !== null)
    .map(t => (t.completedAt as number) - (t.startedAt ?? t.createdAt))
    .filter(ms => ms >= 0)
  return d.length > 0 ? d.reduce((s, ms) => s + ms, 0) / d.length : null
}

/** What is left: a full mean per item not started, the unspent part of the mean for one under way. */
export const remainingMs = (items: { startedAt: number | null }[], mean: number | null, now: number) =>
  mean === null ? null : items.reduce((s, t) => s + (t.startedAt !== null ? Math.max(0, mean - Math.max(0, now - t.startedAt)) : mean), 0)

export const taskEta = (tasks: PlanTask[], now: number) =>
  remainingMs(
    liveTasks(tasks).filter(t => t.status !== 'completed'),
    meanTaskMs(tasks),
    now,
  )

export const nextTask = (tasks: PlanTask[]) => liveTasks(tasks).find(t => t.status === 'pending')?.subject ?? null
export const currentTask = (tasks: PlanTask[]) => liveTasks(tasks).find(t => t.status === 'in_progress')?.subject ?? null
