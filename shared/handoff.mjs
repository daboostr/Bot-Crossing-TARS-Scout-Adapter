const STATES = {
  pending: ['working', 'Pending (queued or executing)'],
  running: ['working', 'Running (executor reported)'],
  'waiting-on-user': ['waiting', 'Waiting on you'],
  'ready-for-review': ['waiting', 'Ready for your review'],
  completed: ['celebrating', 'Completed (executor reported)'],
  failed: ['blocked', 'Failed'],
  cancelled: ['idle', 'Cancelled'],
  unknown: ['idle', 'Status unknown'],
}

const ALIASES = {
  queued: 'pending',
  'in-progress': 'running',
  working: 'running',
  done: 'completed',
  succeeded: 'completed',
  success: 'completed',
  error: 'failed',
  canceled: 'cancelled',
}

export function normalizeHandoffStatus(value, folder) {
  if (value === undefined || value === null || value === '') {
    return folder === 'done' ? 'completed' : 'pending'
  }
  if (typeof value !== 'string') return 'unknown'
  const status = value.trim().toLowerCase()
  const normalized = Object.hasOwn(ALIASES, status) ? ALIASES[status] : status
  return Object.hasOwn(STATES, normalized) ? normalized : 'unknown'
}

export function handoffBehaviour(status) {
  return (Object.hasOwn(STATES, status) ? STATES[status] : STATES.unknown)[0]
}

export function handoffLabel(status) {
  return (Object.hasOwn(STATES, status) ? STATES[status] : STATES.unknown)[1]
}
