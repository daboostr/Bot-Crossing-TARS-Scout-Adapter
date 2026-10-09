import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createMicrosoftScout } from '../server/harnesses/microsoft-scout.mjs'

async function fixture(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scout-session-test-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'session-store.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT, cwd TEXT,
    repository TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE turns (session_id TEXT, user_message TEXT, assistant_response TEXT);`)
  db.close()
  return { file, adapter: createMicrosoftScout(file) }
}

test('detects stores without silently falling back to another database', async (t) => {
  const { file, adapter } = await fixture(t)
  assert.equal(await adapter.detect(), true)
  assert.deepEqual(await adapter.scanThreads(), [])
  assert.equal(await createMicrosoftScout(`${file}.absent`).detect(), false)
  await assert.rejects(createMicrosoftScout('relative.db').detect(), /absolute/)
})

test('groups all sessions as Scout, exports metadata only, and never modifies the store', async (t) => {
  const { file, adapter } = await fixture(t)
  const db = new DatabaseSync(file)
  const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)')
  insert.run('one', 'Synthetic task', 'C:\\repo-one', 'private-repo', '2026-01-01 12:00:00', '2026-01-01 13:00:00')
  insert.run('two', '', 'C:\\repo-two', 'other-private-repo', '2026-01-01T14:00:00Z', '2026-01-01T15:00:00Z')
  db.prepare('INSERT INTO turns VALUES (?, ?, ?)').run('one', 'PRIVATE PROMPT', 'PRIVATE ANSWER')
  db.close()
  const before = await fsp.readFile(file)
  const threads = await adapter.scanThreads()
  assert.equal(threads.length, 2)
  assert.deepEqual(threads.map((thread) => thread.id), ['microsoft-scout:two', 'microsoft-scout:one'])
  assert.ok(threads.every((thread) => thread.project === 'Microsoft Scout'))
  assert.equal(threads[1].createdAt, Date.parse('2026-01-01T12:00:00Z'))
  assert.ok(threads.every((thread) => !thread.running && !thread.unread && !thread.hasError))
  assert.ok(threads.every((thread) => !thread.canOpen && !thread.canNewSession && thread.sizeBytes === 0))
  assert.match(threads[0].title, /Scout session two/)
  assert.doesNotMatch(JSON.stringify(threads), /PRIVATE|private-repo|repo-one|repo-two/)
  assert.deepEqual(await fsp.readFile(file), before)
  assert.equal((await adapter.openThread()).ok, false)
  assert.equal((await adapter.newSession()).ok, false)
})

test('reports invalid records and clears warnings on the next successful scan', async (t) => {
  const { file, adapter } = await fixture(t)
  const db = new DatabaseSync(file)
  db.prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)').run('bad', 'not-a-date')
  db.close()
  assert.deepEqual(await adapter.scanThreads(), [])
  assert.match(await adapter.diagnostic(), /skipped 1/)
  const fix = new DatabaseSync(file)
  fix.prepare('UPDATE sessions SET created_at = ?').run('2026-01-01T12:00:00Z')
  fix.close()
  assert.equal((await adapter.scanThreads()).length, 1)
  assert.equal(await adapter.diagnostic(), '')
})

test('surfaces incompatible schemas instead of returning an empty success', async (t) => {
  const { file, adapter } = await fixture(t)
  const db = new DatabaseSync(file)
  db.exec('DROP TABLE sessions; CREATE TABLE sessions (id TEXT)')
  db.close()
  await assert.rejects(adapter.scanThreads(), /metadata columns/)
  assert.match(await adapter.diagnostic(), /Unsupported Scout database/)
})

test('observes sessions written after the first scan without a restart', async (t) => {
  const { file, adapter } = await fixture(t)
  assert.deepEqual(await adapter.scanThreads(), [])
  const db = new DatabaseSync(file)
  db.prepare('INSERT INTO sessions (id, summary, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('new', 'New session', '2026-01-01T12:00:00Z', '2026-01-01T12:00:00Z')
  db.close()
  assert.equal((await adapter.scanThreads())[0].id, 'microsoft-scout:new')
})
