import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTarsHandoff } from '../server/harnesses/tars-handoff.mjs'
import { handoffBehaviour, handoffLabel, normalizeHandoffStatus } from '../shared/handoff.mjs'

const CREATED = '2026-01-01T12:00:00.000Z'
const job = (id, fields = {}) => ({
  id, request: 'Create a synthetic example', summary: 'Example task',
  status: 'pending', createdAt: CREATED, ...fields,
})

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tars-handoff-test-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const adapter = createTarsHandoff(root)
  const write = async (folder, item) => {
    await fsp.mkdir(path.join(root, folder), { recursive: true })
    const file = path.join(root, folder, `${item.id}.json`)
    await fsp.writeFile(file, JSON.stringify(item))
    await fsp.utimes(file, new Date(CREATED), new Date(CREATED))
    return file
  }
  return { root, adapter, write }
}

test('detects an empty install, handles absent source, and rejects relative paths', async (t) => {
  const { root, adapter } = await fixture(t)
  assert.equal(await adapter.detect(), true)
  assert.deepEqual(await adapter.scanThreads(), [])
  assert.equal(await createTarsHandoff(path.join(root, 'missing')).detect(), false)
  await assert.rejects(createTarsHandoff('relative').detect(), /absolute directory/)
})

test('projects queue and done without modifying files or exposing attached history', async (t) => {
  const { root, adapter, write } = await fixture(t)
  const pendingFile = await write('queue', job('pending-1', {
    context: { sessionId: 'private-session', transcript: 'PRIVATE HISTORY' },
    note: 'PRIVATE NOTE', arbitrarySecret: 'DO NOT FORWARD',
  }))
  const doneFile = await write('done', job('done-1', {
    status: 'done', result: 'Synthetic artifact created', completedAt: '2026-01-01T13:00:00Z',
  }))
  await fsp.mkdir(path.join(root, 'replies'))
  const reply = path.join(root, 'replies', 'done-1.txt')
  await fsp.writeFile(reply, 'Do not consume this spoken reply')
  const files = [pendingFile, doneFile, reply]
  const before = await Promise.all(files.map((file) => fsp.readFile(file, 'utf8')))
  const threads = await adapter.scanThreads()
  assert.equal(threads.length, 2)
  const pending = threads.find((thread) => thread.id === 'tars-handoff:pending-1')
  const done = threads.find((thread) => thread.id === 'tars-handoff:done-1')
  assert.equal(pending.project, 'TARS Voice Handoffs')
  assert.equal(pending.running, true)
  assert.equal(pending.unread, false)
  assert.equal(handoffBehaviour(pending.handoff.status), 'working')
  assert.equal(done.handoff.status, 'completed')
  assert.equal(done.handoff.result, 'Synthetic artifact created')
  assert.equal(handoffBehaviour(done.handoff.status), 'celebrating')
  assert.equal(done.prState, undefined)
  assert.equal(done.sizeBytes, 0)
  assert.equal(done.canOpen, false)
  assert.doesNotMatch(JSON.stringify(threads), /PRIVATE|DO NOT FORWARD|private-session/)
  assert.deepEqual(await Promise.all(files.map((file) => fsp.readFile(file, 'utf8'))), before)
  assert.equal((await adapter.openThread({ jobId: 'done-1' })).ok, false)
  assert.equal((await adapter.newSession(root)).ok, false)
})

test('waiting in done remains waiting, and explicit running and failure map correctly', async (t) => {
  const { adapter, write } = await fixture(t)
  await write('done', job('waiting', { status: 'waiting-on-user', result: 'Please review' }))
  await write('queue', job('running', { status: 'in-progress' }))
  await write('done', job('failed', { status: 'failed' }))
  const threads = await adapter.scanThreads()
  const waiting = threads.find((thread) => thread.ref.jobId === 'waiting')
  const running = threads.find((thread) => thread.ref.jobId === 'running')
  const failed = threads.find((thread) => thread.ref.jobId === 'failed')
  assert.equal(waiting.unread, true)
  assert.equal(handoffBehaviour(waiting.handoff.status), 'waiting')
  assert.equal(running.running, true)
  assert.equal(handoffBehaviour(running.handoff.status), 'working')
  assert.equal(failed.hasError, true)
  assert.equal(handoffBehaviour(failed.handoff.status), 'blocked')
})

test('deduplicates completion copies and prefers a newer requeued version', async (t) => {
  const { adapter, write } = await fixture(t)
  await write('queue', job('same'))
  await write('done', job('same', { status: 'completed', completedAt: '2026-01-01T13:00:00Z' }))
  assert.equal((await adapter.scanThreads()).length, 1)
  assert.equal((await adapter.scanThreads())[0].handoff.status, 'completed')
  await write('queue', job('same', { updatedAt: '2026-01-01T14:00:00Z' }))
  assert.equal((await adapter.scanThreads())[0].handoff.status, 'pending')
})

test('skips partial, invalid, and oversized JSON with surfaced diagnostics', async (t) => {
  const { root, adapter, write } = await fixture(t)
  await write('queue', job('valid'))
  await write('queue', job('bad-date', { createdAt: 'not-a-date' }))
  await write('queue', job('large', { request: 'x'.repeat(2 * 1024 * 1024) }))
  await fsp.writeFile(path.join(root, 'queue', 'partial.json'), '{"id":')
  await fsp.writeFile(path.join(root, 'queue', 'partial-utf16.json'), Buffer.from([0xfe, 0xff, 0x00]))
  assert.equal((await adapter.scanThreads()).length, 1)
  assert.match(await adapter.diagnostic(), /malformed JSON/)
  assert.match(await adapter.diagnostic(), /invalid job/)
  assert.match(await adapter.diagnostic(), /exceeds 2 MiB/)
  await fsp.rm(path.join(root, 'queue', 'partial.json'))
  await fsp.rm(path.join(root, 'queue', 'partial-utf16.json'))
  await fsp.rm(path.join(root, 'queue', 'bad-date.json'))
  await fsp.rm(path.join(root, 'queue', 'large.json'))
  await adapter.scanThreads()
  assert.equal(await adapter.diagnostic(), '')
})

test('does not hide source-directory read failures', async (t) => {
  const { root, adapter } = await fixture(t)
  await fsp.writeFile(path.join(root, 'queue'), 'Not a directory')
  await assert.rejects(adapter.scanThreads(), { code: 'ENOTDIR' })
})

test('reads Windows UTF-8 and UTF-16 BOM files without changing their encoding', async (t) => {
  const { root, adapter } = await fixture(t)
  await fsp.mkdir(path.join(root, 'queue'))
  const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(job('utf8')))])
  const utf16 = Buffer.from(JSON.stringify(job('utf16')), 'utf16le')
  const bigEndian = Buffer.from(JSON.stringify(job('big-endian')), 'utf16le').swap16()
  const buffers = [
    ['utf8.json', utf8],
    ['utf16.json', Buffer.concat([Buffer.from([0xff, 0xfe]), utf16])],
    ['big-endian.json', Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian])],
  ]
  for (const [name, bytes] of buffers) await fsp.writeFile(path.join(root, 'queue', name), bytes)
  assert.equal((await adapter.scanThreads()).length, 3)
  assert.equal(await adapter.diagnostic(), '')
  for (const [name, bytes] of buffers) assert.deepEqual(await fsp.readFile(path.join(root, 'queue', name)), bytes)
})

test('normalizes reported states without treating unknown states as successful', () => {
  assert.equal(normalizeHandoffStatus(undefined, 'queue'), 'pending')
  assert.equal(normalizeHandoffStatus(undefined, 'done'), 'completed')
  assert.equal(normalizeHandoffStatus(' canceled ', 'done'), 'cancelled')
  assert.equal(normalizeHandoffStatus('unrecognized', 'done'), 'unknown')
  assert.equal(normalizeHandoffStatus({}, 'done'), 'unknown')
  assert.equal(normalizeHandoffStatus('constructor', 'done'), 'unknown')
  assert.equal(handoffBehaviour('ready-for-review'), 'waiting')
  assert.equal(handoffBehaviour('unknown'), 'idle')
  assert.match(handoffLabel('pending'), /queued or executing/)
})
