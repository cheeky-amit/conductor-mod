import { expect, test } from 'claude-code/testing'

import {
  isServerCommand,
  jobIdOf,
  liveServers,
  localPorts,
  mayAffectServers,
  portOf,
  serverOrder,
  serversAfterCall,
  serversAfterNotice,
  serverTail,
} from '../hooks/model/servers'
import type { PaneData } from '../hooks/view/kit'
import { serversInline, serversInlineFit } from '../hooks/view/servers'
import type { Server } from '../types'

const bg = (command: string, resultText: string, at = 0) => ({
  tool: 'Bash',
  input: { command, run_in_background: true },
  resultText,
  didRun: true,
  at,
  by: 'main',
  callId: `c${at}`,
})
const fg = (command: string, at: number) => ({
  tool: 'Bash',
  input: { command },
  resultText: '',
  didRun: true,
  at,
  by: 'main',
  callId: `f${at}`,
})
const mk = (id: string, status: Server['status'], lastUsedAt: number | null, jobId: string | null = null): Server => ({
  id,
  jobId,
  port: 1,
  command: '',
  status,
  startedAt: 0,
  endedAt: null,
  lastUsedAt,
  uses: 0,
  by: 'main',
})

test('server commands are recognised; ordinary commands are not', () => {
  expect(
    ['npm run dev', 'pnpm dev --port 3300', 'npx vite', 'python3 -m http.server 8000', 'uvicorn app:app --reload', 'next dev -p 4000'].map(
      isServerCommand,
    ),
  ).toEqual([true, true, true, true, true, true])
  expect(['npm test', 'git status', 'ls -la', 'npm run build'].map(isServerCommand)).toEqual([false, false, false, false])
})

test('a chain is a server command when one of its parts is one and that part is not a test or build', () => {
  expect(
    [
      'npm install && npm run dev',
      'next build && next start',
      'cd ~/test-app && npm run dev',
      'sleep 1; vite',
      'npm run dev | tee dev.log',
    ].map(isServerCommand),
  ).toEqual([true, true, true, true, true])
  expect(
    ['npm test && npm run build', 'npm install || npm run lint', 'next build; tsc --noEmit', 'git pull && npm install'].map(
      isServerCommand,
    ),
  ).toEqual([false, false, false, false])
})

test('ports come from flags, env, URLs; local URLs are found in any text', () => {
  expect([
    portOf('pnpm dev --port 3300'),
    portOf('next dev -p 4000'),
    portOf('PORT=5173 npm start'),
    portOf('python3 -m http.server 8000'),
    portOf('npm run dev'),
  ]).toEqual([3300, 4000, 5173, 8000, null])
  expect(localPorts('ready on http://localhost:3300 and http://127.0.0.1:5173/x, again localhost:3300')).toEqual([3300, 5173])
  expect(localPorts('https://example.com:443')).toEqual([])
  expect([jobIdOf('Command running in background with ID: b7k2x9'), jobIdOf('nothing')]).toEqual(['b7k2x9', null])
})

test('a flag names the port before a host:port does, and a host:port is the last resort', () => {
  const api = 'VITE_API=http://localhost:8000 npm run dev -- --port 5173'
  const db = 'DATABASE_URL=postgres://app@localhost:5432/db pnpm dev --port 3300'
  expect([portOf(api), portOf(db)]).toEqual([5173, 3300])
  expect([
    portOf('VITE_API=http://localhost:8000 npm run dev -p 4000'),
    portOf('VITE_API=http://localhost:8000 PORT=5174 npm start'),
    portOf('DB=localhost:5432 python3 -m http.server 8000'),
    portOf('VITE_API=http://localhost:8000 npm run dev'),
    portOf('DB_PORT=5432 pnpm dev'),
  ]).toEqual([4000, 5174, 8000, null, null])
})

test("the port is the server part of a chain's: another command or an env URL does not set it", () => {
  expect([
    portOf('curl localhost:8000/health && npm run dev'),
    portOf('psql -p 5432 x && npm run dev'),
    portOf('VITE_API=http://localhost:8000 npm run dev'),
    portOf('curl -s http://localhost:8000/health; VITE_API=http://localhost:8000 npm run dev'),
  ]).toEqual([null, null, null, null])
  expect([
    portOf('curl localhost:8000/health && npm run dev -- --port 5173'),
    portOf('psql -p 5432 x && next dev -p 4000'),
    portOf('sleep 1 && PORT=5174 npm start'),
    portOf('npm install && python3 -m http.server 8000'),
    portOf('npm install && php -S localhost:8080'),
    portOf('DB=localhost:5432 npm install && php -S 0.0.0.0:9000'),
  ]).toEqual([5173, 4000, 5174, 8000, 8080, 9000])
})

test('a chained server with no port of its own is adopted by the first local port the session uses, not by a probe in its chain', () => {
  let s = serversAfterCall([], bg('curl localhost:8000/health && npm run dev', 'Command running in background with ID: b7k2x9'))
  expect([s[0]?.status, s[0]?.port]).toEqual(['live', null])
  s = serversAfterCall(s, fg('curl -s localhost:5173/', 5))
  expect(s.map(x => [x.status, x.port])).toEqual([['live', 5173]])
})

test('a job id is 4 to 32 id characters: a longer token is not one', () => {
  expect([
    jobIdOf(`ID: ${'a'.repeat(32)}`),
    jobIdOf(`ID: ${'a'.repeat(33)}`),
    jobIdOf('ID: abc'),
    jobIdOf('ID: abcd'),
    jobIdOf('with ID: b7k2x9, done'),
  ]).toEqual(['a'.repeat(32), null, null, 'abcd', 'b7k2x9'])
})

test('a background server starts live; its port can arrive later in its output', () => {
  let s = serversAfterCall([], bg('npm run dev', 'Command running in background with ID: b7k2x9'))
  expect([s[0]?.status, s[0]?.jobId, s[0]?.port]).toEqual(['live', 'b7k2x9', null])
  s = serversAfterCall(s, {
    tool: 'BashOutput',
    input: { bash_id: 'b7k2x9' },
    resultText: '  ➜  Local:   http://localhost:5173/',
    didRun: true,
    at: 5,
    by: 'main',
    callId: 'o1',
  })
  expect(s[0]?.port).toBe(5173)
  expect(serversAfterCall([], bg('npm test', 'with ID: zz11'))).toEqual([])
  expect(serversAfterCall([], { ...bg('npm run dev', 'with ID: zz11'), didRun: false })).toEqual([])
})

test('using a port bumps its server; a port started elsewhere is listed as seen', () => {
  let s = serversAfterCall([], bg('pnpm dev --port 3300', 'with ID: b1aaaa', 0))
  s = serversAfterCall(s, fg('curl -s http://localhost:3300/api/health', 10))
  s = serversAfterCall(s, {
    tool: 'mcp__claude-in-chrome__navigate',
    input: { url: 'http://localhost:3300/login' },
    resultText: '',
    didRun: true,
    at: 20,
    by: 'agent',
    callId: 'n1',
  })
  s = serversAfterCall(s, fg('curl localhost:8080', 30))
  const byPort = (p: number) => s.find(x => x.port === p)
  expect([byPort(3300)?.uses, byPort(3300)?.lastUsedAt]).toEqual([2, 20])
  expect([byPort(8080)?.status, byPort(8080)?.uses]).toEqual(['seen', 1])
})

test('a notice or a stop call naming the job ends it; failure is told apart', () => {
  const start = serversAfterCall([], bg('npm run dev', 'with ID: b7k2x9'))
  const done = serversAfterNotice(start, '<task-notification><task-id>b7k2x9</task-id><status>killed</status></task-notification>', 9)
  expect([done[0]?.status, done[0]?.endedAt]).toEqual(['stopped', 9])
  const failed = serversAfterNotice(start, '<task-notification> b7k2x9 failed: exit code 1 </task-notification>', 9)
  expect(failed[0]?.status).toBe('failed')
  const stopped = serversAfterCall(start, {
    tool: 'KillShell',
    input: { shell_id: 'b7k2x9' },
    resultText: 'killed',
    didRun: true,
    at: 4,
    by: 'main',
    callId: 'k1',
  })
  expect(stopped[0]?.status).toBe('stopped')
  expect(serversAfterNotice(start, '<task-notification> other123 done', 9)).toEqual(start)
})

test('a notice with a status is judged on its status alone; without one, on all its text', () => {
  const start = serversAfterCall([], bg('npm run dev', 'with ID: b7k2x9'))
  const notice = (status: string, summary = '') =>
    `<task-notification><task-id>b7k2x9</task-id><status>${status}</status><summary>${summary}</summary></task-notification>`
  const after = (text: string) => serversAfterNotice(start, text, 9)[0]?.status
  // `killed` stays stopped even when the summary talks about errors, failures or exit codes.
  expect(after(notice('killed', 'stopped the dev server; see error-handling.md, test failed earlier, exit code 1'))).toBe('stopped')
  expect(after(notice('completed', 'no error'))).toBe('stopped')
  expect(after(notice('exit code 0'))).toBe('stopped')
  expect([after(notice('failed')), after(notice('error')), after(notice('exited with code 137')), after(notice('Exit code: 1'))]).toEqual([
    'failed',
    'failed',
    'failed',
    'failed',
  ])
  // Without a status tag the whole text is read, as before.
  expect(after('<task-notification>b7k2x9 hit an error</task-notification>')).toBe('failed')
  expect(after('<task-notification>b7k2x9 finished</task-notification>')).toBe('stopped')
})

test('a notice names a job by its whole id: the notice for b10 stops b10 and leaves b1', () => {
  const both = [mk('s1', 'live', null, 'b1'), mk('s10', 'live', null, 'b10')]
  const notice = '<task-notification><task-id>b10</task-id><status>killed</status></task-notification>'
  expect(serversAfterNotice(both, notice, 9).map(s => [s.jobId, s.status])).toEqual([
    ['b1', 'live'],
    ['b10', 'stopped'],
  ])
  // The same either way round: the notice for b1 leaves b10 running.
  expect(serversAfterNotice(both, '<task-notification><task-id>b1</task-id></task-notification>', 9).map(s => s.status)).toEqual([
    'stopped',
    'live',
  ])
  // Bare text works when the id has a non-id character (or the edge of the text) on each side.
  expect(serversAfterNotice(both, 'b10', 9).map(s => s.status)).toEqual(['live', 'stopped'])
  expect(serversAfterNotice(both, 'Background command (b10) finished.', 9).map(s => s.status)).toEqual(['live', 'stopped'])
  // An id found only inside a longer token names nothing.
  expect(serversAfterNotice(both, 'xb1 and b1x and b10_ and b1-2 done', 9)).toEqual(both)
})

test('ids from real results work the same way: a prefix of another id does not match it', () => {
  let s = serversAfterCall([], bg('npm run dev', 'with ID: b7k2', 1))
  s = serversAfterCall(s, bg('pnpm dev --port 3300', 'with ID: b7k2x9', 2))
  expect(s.map(x => x.jobId)).toEqual(['b7k2', 'b7k2x9'])
  const after = serversAfterNotice(s, '<task-notification><task-id>b7k2x9</task-id></task-notification>', 9)
  expect(after.map(x => x.status)).toEqual(['live', 'stopped'])
  const killed = serversAfterCall(s, {
    tool: 'TaskStop',
    input: { task_id: 'b7k2' },
    resultText: '',
    didRun: true,
    at: 5,
    by: 'main',
    callId: 'k2',
  })
  expect(killed.map(x => x.status)).toEqual(['stopped', 'live'])
})

test('one server is one row: a probe before the start joins the live row, and later hits count on it', () => {
  let s = serversAfterCall([], fg('curl localhost:3300', 5))
  s = serversAfterCall(s, fg('curl localhost:3300/x', 8))
  expect(s.map(x => [x.status, x.port, x.uses])).toEqual([['seen', 3300, 2]])
  s = serversAfterCall(s, bg('pnpm dev --port 3300', 'with ID: b7k2x9', 10))
  expect(s).toHaveLength(1)
  expect(s[0]).toMatchObject({ status: 'live', port: 3300, jobId: 'b7k2x9', uses: 2, lastUsedAt: 8, command: 'pnpm dev --port 3300' })
  s = serversAfterCall(s, fg('curl localhost:3300/y', 20))
  expect(s).toHaveLength(1)
  expect(s[0]).toMatchObject({ status: 'live', uses: 3, lastUsedAt: 20 })
  // The later last use wins: a probe stamped after the start is kept when the start is the earlier event.
  const late = serversAfterCall(serversAfterCall([], fg('curl localhost:4000', 50)), bg('pnpm dev --port 4000', 'with ID: z9z9z9', 40))
  expect(late[0]).toMatchObject({ status: 'live', uses: 1, lastUsedAt: 50 })
})

test('one server is one row: with its port unknown, the first local port used afterwards is its own', () => {
  let s = serversAfterCall([], bg('npm run dev', 'with ID: b7k2x9', 1))
  expect(s[0]?.port).toBe(null)
  s = serversAfterCall(s, fg('curl localhost:5173', 5))
  expect(s).toHaveLength(1)
  expect(s[0]).toMatchObject({ status: 'live', port: 5173, uses: 1, lastUsedAt: 5 })
  s = serversAfterCall(s, fg('curl localhost:5173/x', 9))
  expect(s[0]).toMatchObject({ uses: 2, lastUsedAt: 9 })
  // The port is settled now: another port is a different thing, in use but not started here.
  s = serversAfterCall(s, fg('curl localhost:5432', 12))
  expect(s.map(x => [x.status, x.port, x.uses])).toEqual([
    ['live', 5173, 2],
    ['seen', 5432, 1],
  ])
})

test('one server is one row: check, start without a port, check again', () => {
  let s = serversAfterCall([], fg('curl localhost:5173', 2))
  s = serversAfterCall(s, bg('npm run dev', 'with ID: b7k2x9', 4))
  s = serversAfterCall(s, fg('curl localhost:5173', 8))
  expect(s).toHaveLength(1)
  expect(s[0]).toMatchObject({ status: 'live', port: 5173, uses: 2, lastUsedAt: 8 })
})

test('one server is one row: a port learned from its output takes over the row seen for it', () => {
  let s = serversAfterCall([], fg('curl localhost:5173', 2))
  s = serversAfterCall(s, bg('npm run dev', 'with ID: b7k2x9', 4))
  expect(s).toHaveLength(2)
  s = serversAfterCall(s, {
    tool: 'BashOutput',
    input: { bash_id: 'b7k2x9' },
    resultText: 'Local: http://localhost:5173/',
    didRun: true,
    at: 6,
    by: 'main',
    callId: 'o2',
  })
  expect(s).toHaveLength(1)
  expect(s[0]).toMatchObject({ status: 'live', port: 5173, uses: 1, lastUsedAt: 2 })
})

test('with two live servers of unknown port, or none, a used port is not guessed: it is listed in use', () => {
  let two = serversAfterCall([], bg('npm run dev', 'with ID: aaaa1', 1))
  two = serversAfterCall(two, bg('uvicorn app:app --reload', 'with ID: bbbb2', 2))
  two = serversAfterCall(two, fg('curl localhost:5173', 5))
  expect(two.map(x => [x.status, x.port])).toEqual([
    ['live', null],
    ['live', null],
    ['seen', 5173],
  ])
  // A stopped server is not a candidate either.
  let stopped = serversAfterCall([], bg('npm run dev', 'with ID: aaaa1', 1))
  stopped = serversAfterNotice(stopped, '<task-id>aaaa1</task-id>', 3)
  stopped = serversAfterCall(stopped, fg('curl localhost:5173', 5))
  expect(stopped.map(x => [x.status, x.port])).toEqual([
    ['stopped', null],
    ['seen', 5173],
  ])
})

test('a live row takes a hit before a row seen on the same port', () => {
  const seen: Server = { ...mk('port:3300', 'seen', 1), port: 3300, uses: 1 }
  const live: Server = { ...mk('c1', 'live', null, 'b7k2x9'), port: 3300 }
  const after = serversAfterCall([seen, live], fg('curl localhost:3300', 9))
  expect(after.map(x => [x.id, x.uses, x.lastUsedAt])).toEqual([
    ['port:3300', 1, 1],
    ['c1', 1, 9],
  ])
})

test('only a call that could touch a server is looked at', () => {
  const may = (tool: string, input: Record<string, unknown>) => mayAffectServers(tool, input)
  expect([
    may('Bash', { command: 'npm run dev', run_in_background: true }),
    may('Bash', { command: 'sleep 1', run_in_background: true }),
    may('KillShell', { shell_id: 'b7k2x9' }),
    may('TaskStop', { task_id: 'b7k2x9' }),
    may('BashOutput', { bash_id: 'b7k2x9' }),
    may('Bash', { command: 'curl -s http://localhost:3300/health' }),
    may('Bash', { command: 'curl 127.0.0.1:8080' }),
    may('Bash', { command: 'nc 0.0.0.0 9000' }),
    may('WebFetch', { url: 'http://[::1]:3000/' }),
    may('mcp__claude-in-chrome__navigate', { url: 'http://LOCALHOST:5173/' }),
  ]).toEqual([true, true, true, true, true, true, true, true, true, true])
  expect([
    may('Bash', { command: 'git status' }),
    may('Bash', { command: 'npm run dev' }),
    may('Read', { file_path: '/a/b.ts' }),
    may('Edit', { file_path: '/a/localhost.ts', old_string: 'localhost:3000', new_string: 'x' }),
    may('WebFetch', { url: 'https://example.com:443/' }),
    may('Grep', { pattern: 'localhost' }),
    may('Bash', {}),
  ]).toEqual([false, false, false, false, false, false, false])
})

test('commands are redacted before storage; order puts live first, list is capped', () => {
  const s = serversAfterCall([], bg('API_TOKEN=abcdefghijklmnop1234 npm run dev', 'with ID: r1abcd'))
  expect(s[0]?.command.includes('abcdefghijklmnop1234')).toBe(false)
  expect(s[0]?.command).toMatch(/^API_TOKEN=•••/)
  expect(serverOrder([mk('a', 'stopped', 9), mk('b', 'seen', 5), mk('c', 'live', 1), mk('d', 'live', 7)]).map(x => x.id)).toEqual([
    'd',
    'c',
    'b',
    'a',
  ])
  expect(liveServers([mk('a', 'stopped', 9), mk('c', 'live', 1)]).map(x => x.id)).toEqual(['c'])
  let many: Server[] = []
  for (let i = 0; i < 15; i += 1) many = serversAfterCall(many, fg(`curl localhost:${3000 + i}`, i))
  expect(many.length).toBe(12)
})

test('a port seen in a foreground command keeps the port and nothing else from the call', () => {
  const s = serversAfterCall([], fg('API_TOKEN=abcdefghijklmnop1234 curl http://localhost:3300/x?id=abcdefghijklmnop1234', 1))
  expect(JSON.stringify(s)).not.toContain('abcdefghijklmnop1234')
  expect(s[0]).toMatchObject({ port: 3300, status: 'seen', command: '' })
})

test('the row tail keeps the use time and count, and gives the command what is left of its room', () => {
  const s: Server = { ...mk('a', 'live', 8_000), port: 3300, command: 'pnpm dev --port 3300', uses: 2 }
  expect(serverTail(s, 20_000, 97)).toBe(' used 12s ago ·2× · pnpm dev --port 3300')
  expect(serverTail(s, 20_000, 17)).toBe(' used 12s ago ·2×')
  expect(serverTail(s, 20_000, 30)).toBe(' used 12s ago ·2× · pnpm dev…')
  for (const room of [0, 1, 4, 5, 13, 16, 17, 20, 40, 97]) expect(serverTail(s, 20_000, room).length).toBeLessThanOrEqual(room)
  const seen: Server = { ...s, status: 'seen', command: '', uses: 1 }
  expect(serverTail(seen, 20_000, 60)).toBe(' used 12s ago ·1× · started elsewhere')
  expect(serverTail({ ...s, lastUsedAt: null, uses: 0 }, 0, 40)).toBe(' not used yet · pnpm dev --port 3300')
})

test('the inline text lists the first three servers, live first, and keeps whole entries only', () => {
  const list = [
    { ...mk('a', 'stopped', 9), port: 8000 },
    { ...mk('b', 'seen', 5), port: 5173 },
    { ...mk('c', 'live', 1), port: 3300 },
    { ...mk('d', 'live', 7), port: null },
    { ...mk('e', 'failed', 2), port: 9000 },
  ]
  const d = { servers: list } as unknown as PaneData
  expect(serversInline(d)).toBe(':?● :3300● :5173○')
  expect(serversInlineFit(d, 100)).toBe(' · srv :?● :3300● :5173○')
  // ` · srv ` is 7 cells, an entry 3 to 6 more, one more cell between entries.
  expect(serversInlineFit(d, 24)).toBe(' · srv :?● :3300● :5173○')
  expect(serversInlineFit(d, 23)).toBe(' · srv :?● :3300●')
  expect(serversInlineFit(d, 17)).toBe(' · srv :?● :3300●')
  expect(serversInlineFit(d, 16)).toBe(' · srv :?●')
  expect(serversInlineFit(d, 10)).toBe(' · srv :?●')
  expect(serversInlineFit(d, 9)).toBe('')
  expect(serversInlineFit({ servers: [] } as unknown as PaneData, 50)).toBe('')
})
