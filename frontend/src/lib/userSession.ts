import type { UserSession } from './types'

export const USER_SESSION_STORAGE_KEY = 'app_user_session_v1'
export const USER_SHORTCUT_HOTKEYS = [
  'Alt+1',
  'Alt+2',
  'Alt+3',
  'Alt+4',
  'Alt+5',
  'Alt+6',
  'Alt+7',
  'Alt+8',
]

export type StoredShortcutItem = {
  to: string
  hotkey?: string | null
}

function userShortcutsKey(userId: number) {
  return `app_user_shortcuts_v1:${userId}`
}

export function loadStoredUserSession(): UserSession | null {
  try {
    const raw = localStorage.getItem(USER_SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.token || !parsed?.user?.id) return null
    return parsed as UserSession
  } catch {
    return null
  }
}

export function saveStoredUserSession(session: UserSession) {
  localStorage.setItem(USER_SESSION_STORAGE_KEY, JSON.stringify(session))
}

export function clearStoredUserSession() {
  localStorage.removeItem(USER_SESSION_STORAGE_KEY)
}

export function loadStoredShortcuts(userId: number): StoredShortcutItem[] {
  try {
    const raw = localStorage.getItem(userShortcutsKey(userId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => {
        if (typeof item === 'string') return { to: item, hotkey: null }
        if (!item || typeof item !== 'object') return null
        const to = String((item as any).to || '').trim()
        const hotkey = String((item as any).hotkey || '').trim() || null
        if (!to) return null
        return { to, hotkey }
      })
      .filter(Boolean) as StoredShortcutItem[]
  } catch {
    return []
  }
}

export function saveStoredShortcuts(userId: number, shortcuts: StoredShortcutItem[]) {
  localStorage.setItem(userShortcutsKey(userId), JSON.stringify(shortcuts))
}
