import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { handoffLabel, normalizeHandoffStatus } from '../../shared/handoff.mjs'

const MAX_JOB_BYTES = 2 * 1024 * 1024
const text = (value) => typeof value === 'string' ? value : ''
const timestamp = (value) => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function decodeJob(bytes) {
  // Windows PowerShell writers may emit UTF-8 or UTF-16 with a byte-order mark.
  if (((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) &&
      bytes.length % 2 !== 0) throw new SyntaxError('Incomplete UTF-16 job')
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return bytes.subarray(2).swap16().toString('utf16le')
  return bytes.toString('utf8').replace(/^\uFEFF/, '')
}

export function createTarsHandoff(rootPath = () =>
  process.env.BOT_CROSSING_TARS_HANDOFF || path.join(os.homedir(), '.copilot', 'handoff')) {
  let warnings = []
  const root = () => {
    const dir = typeof rootPath === 'function' ? rootPath() : rootPath
    if (!path.isAbsolute(dir)) throw new Error('BOT_CROSSING_TARS_HANDOFF must be an absolute directory')
    return path.resolve(dir)
  }

  async function entries(dir) {
    try {
      return await fsp.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  return {
    id: 'tars-handoff',
    name: 'TARS Voice Handoffs',
    async detect() {
      try {
        return (await fsp.stat(root())).isDirectory()
      } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
      }
    },
    async diagnostic() {
      return warnings.length ? `TARS: ${warnings.join('; ')}` : ''
    },
    async scanThreads() {
      warnings = []
      const dir = root()
      const jobs = new Map()
      // Read done last so a copy-and-delete completion cannot produce two bots.
      for (const folder of ['queue', 'done']) {
        for (const entry of await entries(path.join(dir, folder))) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue
          const file = path.join(dir, folder, entry.name)
          let job, stat
          try {
            stat = await fsp.stat(file)
            if (stat.size > MAX_JOB_BYTES) {
              warnings.push(`${folder}/${entry.name}: job exceeds 2 MiB`)
              continue
            }
            const bytes = await fsp.readFile(file)
            if (bytes.length > MAX_JOB_BYTES) {
              warnings.push(`${folder}/${entry.name}: job exceeds 2 MiB`)
              continue
            }
            job = JSON.parse(decodeJob(bytes))
          } catch (error) {
            if (error.code === 'ENOENT') continue
            if (error instanceof SyntaxError) {
              warnings.push(`${folder}/${entry.name}: incomplete or malformed JSON`)
              continue
            }
            throw error
          }
          if (!job || typeof job !== 'object' || Array.isArray(job) ||
              typeof job.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(job.id) ||
              !timestamp(job.createdAt)) {
            warnings.push(`${folder}/${entry.name}: invalid job ID or creation time`)
            continue
          }
          const status = normalizeHandoffStatus(job.status, folder)
          if (status === 'unknown') warnings.push(`${folder}/${entry.name}: unrecognized status`)
          const createdAt = timestamp(job.createdAt)
          const lastActivityAt = Math.max(createdAt, timestamp(job.updatedAt),
            timestamp(job.startedAt), timestamp(job.completedAt), stat.mtimeMs)
          const thread = {
            id: `tars-handoff:${job.id}`,
            title: text(job.summary) || text(job.request).slice(0, 80) || 'Untitled handoff',
            preview: text(job.request).slice(0, 400),
            project: 'TARS Voice Handoffs',
            projectPath: dir,
            cwd: dir,
            worktree: '',
            gitBranch: '',
            model: '',
            effort: '',
            createdAt,
            lastActivityAt,
            lastFocusedAt: 0,
            running: status === 'running',
            unread: status === 'waiting-on-user' || status === 'ready-for-review',
            hasError: status === 'failed',
            archived: false,
            sizeBytes: 0,
            source: 'tars-queue',
            canOpen: false,
            canNewSession: false,
            subagents: [],
            ref: { jobId: job.id },
            // Never forward context, transcripts, notes, or arbitrary job fields.
            handoff: {
              status,
              label: handoffLabel(status),
              request: text(job.request),
              result: text(job.result),
              createdAt: text(job.createdAt),
              completedAt: text(job.completedAt),
            },
          }
          const previous = jobs.get(thread.id)
          if (!previous || thread.lastActivityAt >= previous.lastActivityAt) {
            jobs.set(thread.id, thread)
          }
        }
      }
      return [...jobs.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    },
    async openThread() {
      return { ok: false, error: 'TARS jobs have no execution-session link. Read the request and result on the card.' }
    },
    async newSession() {
      return { ok: false, error: 'This adapter is read-only. Submit new handoffs through TARS Voice.' }
    },
  }
}

export default createTarsHandoff()
