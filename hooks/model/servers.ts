// Local servers: the ones this session started in the background, and the localhost ports it used.
// Everything is read from session events (tool calls and task notices); nothing here asks the machine what is listening.
import type { Server } from '../../types'
import { fitSegments, fmtDuration, isObject, redact, shorten } from './util'

export const MAX_SERVERS = 12

const SERVER_CMD =
  /\b(dev|serve|server|start|preview|vite|next|nuxt|astro|storybook|uvicorn|gunicorn|flask|runserver|http\.server|webpack-dev-server|wrangler\s+dev)\b|\brails\s+s\b|\bphp\s+-S\b|\bdocker\s+compose\s+up\b|--port\b|\bPORT=\d+/i
const NOT_SERVER = /\b(test|build|lint|install|tsc|check)\b/i
/** A port the server part of a command asks for, in order of trust: a flag or `PORT=`, then `http.server N`, then a bare `host:port` (`php -S localhost:8000`). */
const PORT_FLAG = /(?:--port[=\s]+|\s-p\s+|\bPORT=)(\d{2,5})\b/
const PORT_HTTP_SERVER = /\bhttp\.server\s+(\d{2,5})\b/
const PORT_HOST = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/
/** A `NAME=value` token: its value may name a service the server calls (`VITE_API=http://localhost:8000`), never the server's own port. */
const ENV_ASSIGN = /\b[A-Za-z_]\w*=\S*/g
/** Any sign that a call's command or URL names this machine, so the call may use a server. */
const LOCAL_HINT = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i
/** `a && b`, `a || b`, `a ; b`, `a | b`: each part is judged alone. */
const SEGMENT_SPLIT = /&&|\|\||;|\|/
const LOCAL = /\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b/gi
/**
 * The background job id in a Bash result, e.g. `Command running in background with ID: b7k2x9` (inferred: the spike did not observe one).
 * 4 to 32 id characters; a longer token is not an id.
 */
const JOB_ID = /\bID:\s*([A-Za-z0-9_-]{4,32})(?![A-Za-z0-9_-])/
/** A notice with no `<status>` is judged on all its text. */
const FAILED = /\bfail(ed|ure)?\b|\berror\b|exit code [1-9]/i
/** A notice with a `<status>` (inferred) is judged on that alone: `failed`, `error`, or a non-zero exit code. */
const STATUS_TAG = /<status>([\s\S]*?)<\/status>/i
const STATUS_FAILED = /\b(?:fail(?:ed|ure)?|error)\b|\bexit(?:ed)?[\s_-]*(?:with[\s_-]*)?(?:code)?[\s:=_-]*[1-9]\d*\b/i
/** The tools that stop a background job, taking its id as `bash_id`, `shell_id` or `task_id` (inferred). */
const STOP_TOOLS = new Set(['KillShell', 'KillBash', 'TaskStop'])
/** What a job id is made of; a notice names a job only when these do not run on either side of it. */
const ID_CHARS = 'A-Za-z0-9_-'

const isServerPart = (seg: string) => SERVER_CMD.test(seg) && !NOT_SERVER.test(seg)

/** A server command: some part of a chain (`npm install && npm run dev`) looks like one and is not a test, build or the like. */
export const isServerCommand = (cmd: string) => cmd.split(SEGMENT_SPLIT).some(isServerPart)

/**
 * The port the server asks for, read from the part of the chain that is the server and nowhere else: not `curl localhost:8000 &&`
 * before it, and not a `NAME=value` URL on it. None named: null, so the first local port the session uses can be adopted.
 */
export const portOf = (cmd: string): number | null => {
  const seg = cmd.split(SEGMENT_SPLIT).find(isServerPart) ?? ''
  const m = PORT_FLAG.exec(seg) ?? PORT_HTTP_SERVER.exec(seg) ?? PORT_HOST.exec(seg.replace(ENV_ASSIGN, ' '))
  const n = Number(m?.[1])
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null
}

export const localPorts = (text: string): number[] => [
  ...new Set([...text.matchAll(LOCAL)].map(m => Number(m[1])).filter(n => n > 0 && n < 65536)),
]

export const jobIdOf = (text: string) => JOB_ID.exec(text)?.[1] ?? null

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const jobOfInput = (input: Record<string, unknown>) =>
  [input.bash_id, input.shell_id, input.task_id, input.id].map(str).find(Boolean) ?? null

/** Over the cap, drop the oldest server that isn't live (or the oldest of all). */
const cap = (list: Server[]) => {
  if (list.length <= MAX_SERVERS) return list
  const drop = list.find(s => s.status !== 'live') ?? list[0]
  return list.filter(s => s !== drop)
}

const hasFailed = (text: string) => {
  const status = STATUS_TAG.exec(text)?.[1]
  return status === undefined ? FAILED.test(text) : STATUS_FAILED.test(status)
}

const end = (s: Server, at: number, text: string): Server => ({ ...s, status: hasFailed(text) ? 'failed' : 'stopped', endedAt: at })

export const liveServers = (list: Server[]) => list.filter(s => s.status === 'live')

const later = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b))

/**
 * Puts `s` in the list, in place when it is there. A live server with a port takes over the `seen` rows on that port, summing their
 * uses and keeping the later last use: one server is one row, whichever of its start and its first probe came first.
 */
const settle = (list: Server[], s: Server): Server[] => {
  const seen = s.status === 'live' && s.port !== null ? list.filter(x => x.status === 'seen' && x.port === s.port && x.id !== s.id) : []
  const merged: Server = {
    ...s,
    uses: seen.reduce((n, x) => n + x.uses, s.uses),
    lastUsedAt: seen.reduce((t, x) => later(t, x.lastUsedAt), s.lastUsedAt),
  }
  const rest = list.filter(x => !seen.includes(x))
  return rest.some(x => x.id === s.id) ? rest.map(x => (x.id === s.id ? merged : x)) : [...rest, merged]
}

/** True when a call could change the list: a background Bash call, a stop, a call about a job, or a command or URL that names this machine. */
export const mayAffectServers = (tool: string, input: Record<string, unknown>): boolean =>
  (tool === 'Bash' && input.run_in_background === true) ||
  STOP_TOOLS.has(tool) ||
  jobOfInput(input) !== null ||
  LOCAL_HINT.test(`${str(input.command)} ${str(input.url)}`)

export type CallFacts = {
  tool: string
  input: Record<string, unknown>
  resultText: string
  didRun: boolean
  at: number
  by: string
  callId: string
}

/**
 * One tool call's effect on the server list: a start, a stop, a port learned from output, or ports used.
 * Only the redacted command (cut to 60), ports and job ids are kept from a call.
 */
export const serversAfterCall = (list: Server[], c: CallFacts): Server[] => {
  if (!c.didRun || !isObject(c.input)) return list
  const command = str(c.input.command)
  if (c.tool === 'Bash' && c.input.run_in_background === true) {
    if (!isServerCommand(command)) return list
    const s: Server = {
      id: c.callId,
      jobId: jobIdOf(c.resultText),
      port: portOf(command),
      command: shorten(redact(command), 60),
      status: 'live',
      startedAt: c.at,
      endedAt: null,
      lastUsedAt: null,
      uses: 0,
      by: c.by,
    }
    return cap(settle(list, s))
  }
  const job = jobOfInput(c.input)
  if (job && STOP_TOOLS.has(c.tool)) return list.map(s => (s.jobId === job && s.status === 'live' ? end(s, c.at, '') : s))
  if (job) {
    const port = localPorts(c.resultText)[0]
    const blank = port ? list.find(s => s.jobId === job && s.port === null) : undefined
    return blank ? settle(list, { ...blank, port: port as number }) : list
  }
  const target = command || str(c.input.url)
  if (!target) return list
  const used = (s: Server): Server => ({ ...s, uses: s.uses + 1, lastUsedAt: c.at })
  return localPorts(target).reduce<Server[]>((acc, port) => {
    const live = acc.find(s => s.port === port && s.status === 'live')
    if (live) return acc.map(s => (s === live ? used(s) : s))
    // (inferred) With exactly one live server whose port is not known, the first local port the session uses is taken to be its own.
    const blank = liveServers(acc).filter(s => s.port === null)
    const [only] = blank
    if (only && blank.length === 1) return settle(acc, { ...used(only), port })
    const known = acc.find(s => s.port === port && s.status === 'seen')
    if (known) return acc.map(s => (s === known ? used(s) : s))
    const seen: Server = {
      id: `port:${port}`,
      jobId: null,
      port,
      command: '',
      status: 'seen',
      startedAt: c.at,
      endedAt: null,
      lastUsedAt: c.at,
      uses: 1,
      by: c.by,
    }
    return cap([...acc.filter(s => s.id !== seen.id), seen])
  }, list)
}

const escapeRe = (s: string) => s.replace(/[\\^$.*+?()[\]{}|-]/g, '\\$&')

/** True when `text` names `jobId` as a whole token (`b10` is not `b1`): no id character runs on to either side of it (inferred). */
const namesJob = (text: string, jobId: string) => new RegExp(`(?:^|[^${ID_CHARS}])${escapeRe(jobId)}(?![${ID_CHARS}])`).test(text)

const names = (s: Server, text: string) => s.status === 'live' && s.jobId !== null && namesJob(text, s.jobId)

/** A background-task notice ends the live server whose job id it names, as `stopped` or `failed` (inferred: the notice's wording was not observed). */
export const serversAfterNotice = (list: Server[], text: string, at: number): Server[] =>
  list.some(s => names(s, text)) ? list.map(s => (names(s, text) ? end(s, at, text) : s)) : list

const RANK: Record<Server['status'], number> = { live: 0, seen: 1, failed: 2, stopped: 3 }
export const serverOrder = (list: Server[]) =>
  [...list].sort((a, b) => RANK[a.status] - RANK[b.status] || (b.lastUsedAt ?? b.startedAt) - (a.lastUsedAt ?? a.startedAt))

/**
 * What follows a server row's port and state, in at most `room` cells and with a leading space: when this session last hit it and
 * how often, then what started it. The command is what is cut first, then the count, then the time.
 */
export const serverTail = (s: Server, now: number, room: number): string => {
  const used = s.lastUsedAt !== null ? ` used ${fmtDuration(now - s.lastUsedAt)} ago` : ' not used yet'
  const times = s.uses > 0 ? ` ·${s.uses}×` : ''
  const from = s.command ? ` · ${s.command}` : s.status === 'seen' ? ' · started elsewhere' : ''
  return fitSegments(
    [used, times, from].filter(text => text !== '').map(text => ({ text })),
    room,
  )
    .map(seg => seg.text)
    .join('')
    .replace(/ +…$/, '…')
}
