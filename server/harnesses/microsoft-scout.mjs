import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const text = (value) => typeof value === 'string' ? value : ''
const timestamp = (value) => {
  if (typeof value !== 'string' || !value.trim()) return 0
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : 0
}

export function createMicrosoftScout(storePath = () =>
  process.env.BOT_CROSSING_SCOUT_DB || path.join(os.homedir(), '.scout', 'copilot', 'session-store.db')) {
  let warning = ''
  const store = () => {
    const file = typeof storePath === 'function' ? storePath() : storePath
    if (!path.isAbsolute(file)) throw new Error('BOT_CROSSING_SCOUT_DB must be an absolute file path')
    return path.resolve(file)
  }

  return {
    id: 'microsoft-scout',
    name: 'Microsoft Scout',
    async detect() {
      try {
        return (await fsp.stat(store())).isFile()
      } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
      }
    },
    async diagnostic() {
      return warning
    },
    async scanThreads() {
      warning = ''
      let db
      try {
        const { DatabaseSync } = await import('node:sqlite')
        db = new DatabaseSync(store(), { readOnly: true })
        const required = ['id', 'summary', 'created_at', 'updated_at']
        const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name))
        if (!required.every((column) => columns.has(column))) {
          throw new Error('Unsupported Scout database: sessions metadata columns are missing')
        }
        // Metadata only: never select turns, checkpoints, tool output, or usage payloads.
        const rows = db.prepare(
          'SELECT id, summary, created_at, updated_at FROM sessions ORDER BY updated_at DESC'
        ).all()
        const threads = []
        let invalid = 0
        for (const row of rows) {
          const createdAt = timestamp(row.created_at)
          if (!text(row.id) || !createdAt) {
            invalid++
            continue
          }
          const summary = text(row.summary).trim()
          threads.push({
            id: `microsoft-scout:${row.id}`,
            title: summary.slice(0, 160) || `Scout session ${row.id.slice(0, 8)}`,
            preview: '',
            project: 'Microsoft Scout',
            projectPath: path.dirname(store()),
            cwd: '',
            worktree: '',
            gitBranch: '',
            model: '',
            effort: '',
            createdAt,
            lastActivityAt: Math.max(createdAt, timestamp(row.updated_at)),
            lastFocusedAt: 0,
            running: false,
            unread: false,
            hasError: false,
            archived: false,
            sizeBytes: 0,
            source: 'scout-session-store',
            canOpen: false,
            canNewSession: false,
            subagents: [],
            ref: { sessionId: row.id },
            scout: {
              summary,
              createdAt: text(row.created_at),
              updatedAt: text(row.updated_at),
              label: 'Session history (execution state unavailable)',
            },
          })
        }
        if (invalid) warning = `Microsoft Scout: skipped ${invalid} invalid session metadata records`
        return threads.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      } catch (error) {
        warning = `Microsoft Scout: ${error.message}`
        throw error
      } finally {
        db?.close()
      }
    },
    async openThread() {
      return { ok: false, error: 'Scout session deep links are not configured. Open this session from Scout history.' }
    },
    async newSession() {
      return { ok: false, error: 'This adapter is read-only. Start a new conversation in Microsoft Scout.' }
    },
  }
}

export default createMicrosoftScout()
