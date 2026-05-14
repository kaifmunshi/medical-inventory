export const SESSION_INACTIVITY_LOCK_MS = 5 * 60 * 1000

const SESSION_LOCK_STORAGE_PREFIX = 'app_user_session_lock_v1'
const SESSION_ACTIVITY_STORAGE_PREFIX = 'app_user_session_activity_v1'

function keyFor(prefix: string, userId: number) {
  return `${prefix}:${userId}`
}

function readNumber(value: string | null) {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function normalizePath(value: string) {
  const raw = String(value || '/').split('?')[0].split('#')[0]
  return raw.startsWith('/') ? raw : `/${raw}`
}

export function isLockAllowedPath(pathname: string) {
  const path = normalizePath(pathname)
  return path === '/inventory' || path.startsWith('/inventory/')
}

export function readStoredLastActivity(userId: number) {
  try {
    return readNumber(localStorage.getItem(keyFor(SESSION_ACTIVITY_STORAGE_PREFIX, userId)))
  } catch {
    return null
  }
}

export function saveStoredLastActivity(userId: number, activityAt = Date.now()) {
  try {
    localStorage.setItem(keyFor(SESSION_ACTIVITY_STORAGE_PREFIX, userId), String(activityAt))
  } catch {
    // ignore storage write errors
  }
}

export function clearStoredLastActivity(userId: number) {
  try {
    localStorage.removeItem(keyFor(SESSION_ACTIVITY_STORAGE_PREFIX, userId))
  } catch {
    // ignore storage write errors
  }
}

export function readStoredSessionLocked(userId: number) {
  try {
    return readNumber(localStorage.getItem(keyFor(SESSION_LOCK_STORAGE_PREFIX, userId))) !== null
  } catch {
    return false
  }
}

export function saveStoredSessionLock(userId: number, lockedAt = Date.now()) {
  try {
    localStorage.setItem(keyFor(SESSION_LOCK_STORAGE_PREFIX, userId), String(lockedAt))
  } catch {
    // ignore storage write errors
  }
}

export function clearStoredSessionLock(userId: number) {
  try {
    localStorage.removeItem(keyFor(SESSION_LOCK_STORAGE_PREFIX, userId))
  } catch {
    // ignore storage write errors
  }
}

export function shouldRestoreSessionLocked(userId: number, now = Date.now()) {
  if (readStoredSessionLocked(userId)) return true
  const lastActivityAt = readStoredLastActivity(userId)
  return lastActivityAt !== null && now - lastActivityAt >= SESSION_INACTIVITY_LOCK_MS
}
