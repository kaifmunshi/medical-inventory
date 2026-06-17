import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import LockOpenIcon from '@mui/icons-material/LockOpen'
import LockOutlinedIcon from '@mui/icons-material/LockOutlined'
import LogoutIcon from '@mui/icons-material/Logout'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useToast } from '../ui/Toaster'
import type { AppUser, UserSession } from '../../lib/types'
import {
  clearStoredLastActivity,
  clearStoredSessionLock,
  readStoredLastActivity,
  saveStoredLastActivity,
  saveStoredSessionLock,
  SESSION_INACTIVITY_LOCK_MS,
  shouldRestoreSessionLocked,
} from '../../lib/sessionLock'
import {
  clearStoredUserSession,
  loadStoredShortcuts,
  loadStoredUserSession,
  type StoredShortcutItem,
  saveStoredShortcuts,
  saveStoredUserSession,
} from '../../lib/userSession'
import { fetchUsers, loginUserSession } from '../../services/users'

type UserRole = 'OWNER' | 'MANAGER' | 'STAFF'

type UserSessionContextValue = {
  session: UserSession | null
  currentUser: AppUser | null
  isLocked: boolean
  shortcuts: StoredShortcutItem[]
  setShortcuts: (shortcuts: StoredShortcutItem[]) => void
  hasConfiguredUsers: boolean
  signOut: () => void
  promptSwitchUser: () => void
  hasMinRole: (role: UserRole) => boolean
}

const UserSessionContext = createContext<UserSessionContextValue | null>(null)

const ROLE_ORDER: Record<UserRole, number> = { STAFF: 1, MANAGER: 2, OWNER: 3 }

function normalizeShortcutList(input: StoredShortcutItem[]) {
  const seenPaths = new Set<string>()
  const seenHotkeys = new Set<string>()
  const normalized: StoredShortcutItem[] = []

  for (const item of input) {
    const to = String(item?.to || '').trim()
    if (!to || seenPaths.has(to)) continue
    const hotkey = String(item?.hotkey || '').trim() || null
    if (hotkey && seenHotkeys.has(hotkey)) continue
    seenPaths.add(to)
    if (hotkey) seenHotkeys.add(hotkey)
    normalized.push({ to, hotkey })
    if (normalized.length >= 8) break
  }

  return normalized
}

export function UserSessionProvider({ children }: { children: ReactNode }) {
  const toast = useToast()
  const [session, setSession] = useState<UserSession | null>(null)
  const [ready, setReady] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [selectedUserId, setSelectedUserId] = useState<number | ''>('')
  const [pin, setPin] = useState('')
  const [isLocked, setIsLocked] = useState(false)
  const [unlockPin, setUnlockPin] = useState('')
  const [shortcuts, setShortcutsState] = useState<StoredShortcutItem[]>([])
  const lastActivityRef = useRef(Date.now())
  const lastPersistedActivityRef = useRef(0)

  useEffect(() => {
    const stored = loadStoredUserSession()
    if (stored?.user?.id) {
      const activityAt = readStoredLastActivity(stored.user.id) || Date.now()
      lastActivityRef.current = activityAt
      lastPersistedActivityRef.current = activityAt
      setIsLocked(shouldRestoreSessionLocked(stored.user.id))
    }
    setSession(stored)
    setReady(true)
    setLoginOpen(false)
  }, [])

  useEffect(() => {
    if (!session?.user?.id) {
      setShortcutsState([])
      return
    }
    setShortcutsState(loadStoredShortcuts(session.user.id))
  }, [session?.user?.id])

  const rememberActivity = useCallback((userId: number, activityAt = Date.now()) => {
    lastActivityRef.current = activityAt
    lastPersistedActivityRef.current = activityAt
    saveStoredLastActivity(userId, activityAt)
  }, [])

  const lockSession = useCallback(() => {
    const userId = session?.user?.id
    if (!userId) return
    saveStoredSessionLock(userId)
    setIsLocked(true)
    setLoginOpen(false)
    setPin('')
    setUnlockPin('')
  }, [session?.user?.id])

  useEffect(() => {
    const userId = session?.user?.id
    if (!userId || isLocked) return undefined

    const now = Date.now()
    const storedActivityAt = readStoredLastActivity(userId)
    if (storedActivityAt && now - storedActivityAt >= SESSION_INACTIVITY_LOCK_MS) {
      lockSession()
      return undefined
    }

    rememberActivity(userId, storedActivityAt || now)

    let lockTimer: number | undefined
    const scheduleLock = () => {
      window.clearTimeout(lockTimer)
      const remainingMs = Math.max(0, SESSION_INACTIVITY_LOCK_MS - (Date.now() - lastActivityRef.current))
      lockTimer = window.setTimeout(lockSession, remainingMs)
    }
    const lockIfInactive = () => {
      const storedActivityAt = readStoredLastActivity(userId)
      const lastActivityAt = storedActivityAt || lastActivityRef.current
      if (Date.now() - lastActivityAt >= SESSION_INACTIVITY_LOCK_MS) {
        lockSession()
        return true
      }
      return false
    }
    const handleActivity = () => {
      if (lockIfInactive()) return
      const activityAt = Date.now()
      lastActivityRef.current = activityAt
      if (activityAt - lastPersistedActivityRef.current >= 1000) {
        lastPersistedActivityRef.current = activityAt
        saveStoredLastActivity(userId, activityAt)
      }
      scheduleLock()
    }
    const handleWake = () => {
      if (document.visibilityState === 'visible' && !lockIfInactive()) {
        scheduleLock()
      }
    }

    const activityEvents = ['mousedown', 'mousemove', 'keydown', 'touchstart', 'wheel', 'scroll', 'pointerdown']
    activityEvents.forEach((eventName) => window.addEventListener(eventName, handleActivity, { passive: true }))
    window.addEventListener('focus', handleWake)
    document.addEventListener('visibilitychange', handleWake)
    scheduleLock()

    return () => {
      window.clearTimeout(lockTimer)
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, handleActivity))
      window.removeEventListener('focus', handleWake)
      document.removeEventListener('visibilitychange', handleWake)
    }
  }, [session?.user?.id, isLocked, lockSession, rememberActivity])

  const usersQ = useQuery<AppUser[], Error>({
    queryKey: ['session-active-users'],
    queryFn: () => fetchUsers({ active_only: true }),
    enabled: ready,
  })

  const hasConfiguredUsers = (usersQ.data || []).length > 0

  useEffect(() => {
    if (!ready || usersQ.isLoading) return
    if (session?.user?.id) {
      setLoginOpen(false)
      return
    }
    setLoginOpen(hasConfiguredUsers)
  }, [ready, usersQ.isLoading, hasConfiguredUsers, session?.user?.id])

  useEffect(() => {
    if (!loginOpen) return
    if (selectedUserId) return
    const firstUser = (usersQ.data || [])[0]
    if (firstUser?.id) setSelectedUserId(firstUser.id)
  }, [loginOpen, selectedUserId, usersQ.data])

  const selectedUser = useMemo(
    () => (usersQ.data || []).find((user) => Number(user.id) === Number(selectedUserId)) || null,
    [selectedUserId, usersQ.data],
  )

  const loginM = useMutation({
    mutationFn: loginUserSession,
    onSuccess: (nextSession) => {
      saveStoredUserSession(nextSession)
      clearStoredSessionLock(nextSession.user.id)
      rememberActivity(nextSession.user.id)
      setSession(nextSession)
      setIsLocked(false)
      setLoginOpen(false)
      setPin('')
      setUnlockPin('')
      toast.push(`Signed in as ${nextSession.user.name}`, 'success')
    },
    onError: (err: any) => {
      toast.push(String(err?.message || 'Failed to sign in'), 'error')
    },
  })

  const unlockM = useMutation({
    mutationFn: loginUserSession,
    onSuccess: (nextSession) => {
      if (session?.user?.id && Number(nextSession.user.id) !== Number(session.user.id)) {
        toast.push('Unlock failed for the current user', 'error')
        return
      }
      saveStoredUserSession(nextSession)
      clearStoredSessionLock(nextSession.user.id)
      rememberActivity(nextSession.user.id)
      setSession(nextSession)
      setIsLocked(false)
      setUnlockPin('')
      toast.push('Unlocked', 'success')
    },
    onError: (err: any) => {
      toast.push(String(err?.message || 'Invalid PIN'), 'error')
    },
  })

  function signOut() {
    if (session?.user?.id) {
      clearStoredSessionLock(session.user.id)
      clearStoredLastActivity(session.user.id)
    }
    clearStoredUserSession()
    setSession(null)
    setIsLocked(false)
    setLoginOpen(hasConfiguredUsers)
    setSelectedUserId('')
    setPin('')
    setUnlockPin('')
  }

  function promptSwitchUser() {
    if (isLocked) {
      toast.push('Unlock with PIN first', 'warning')
      return
    }
    if (!hasConfiguredUsers) {
      toast.push('No active users are configured yet', 'info')
      return
    }
    setLoginOpen(true)
    setPin('')
  }

  function setShortcuts(shortcutList: StoredShortcutItem[]) {
    const normalized = normalizeShortcutList(shortcutList)
    setShortcutsState(normalized)
    if (session?.user?.id) {
      saveStoredShortcuts(session.user.id, normalized)
    }
  }

  function hasMinRole(role: UserRole) {
    const currentRole = session?.user?.role || 'STAFF'
    return ROLE_ORDER[currentRole] >= ROLE_ORDER[role]
  }

  function submitLogin() {
    if (!selectedUser?.id) {
      toast.push('Choose a user first', 'warning')
      return
    }
    loginM.mutate({
      user_id: selectedUser.id,
      pin: selectedUser.has_pin ? pin.trim() : undefined,
    })
  }

  function submitUnlock() {
    const user = session?.user
    if (!user?.id) return
    if (user.has_pin && !unlockPin.trim()) {
      toast.push('Enter PIN to unlock', 'warning')
      return
    }
    unlockM.mutate({
      user_id: user.id,
      pin: user.has_pin ? unlockPin.trim() : undefined,
    })
  }

  const value = useMemo<UserSessionContextValue>(
    () => ({
      session,
      currentUser: session?.user || null,
      isLocked,
      shortcuts,
      setShortcuts,
      hasConfiguredUsers,
      signOut,
      promptSwitchUser,
      hasMinRole,
    }),
    [session, isLocked, shortcuts, hasConfiguredUsers],
  )

  return (
    <UserSessionContext.Provider value={value}>
      {children}
      <Dialog open={ready && !isLocked && loginOpen && hasConfiguredUsers} fullWidth maxWidth="xs">
        <DialogTitle>{session ? 'Switch User' : 'Sign In'}</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2} sx={{ mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Choose the counter user for this session. Role-based permissions and personal shortcuts will follow this sign-in.
            </Typography>

            {usersQ.isError ? (
              <Alert severity="error">Failed to load active users.</Alert>
            ) : null}

            <TextField
              select
              label="User"
              value={selectedUserId}
              onChange={(e) => {
                setSelectedUserId(Number(e.target.value) || '')
                setPin('')
              }}
              disabled={usersQ.isLoading || loginM.isPending}
              fullWidth
            >
              {(usersQ.data || []).map((user) => (
                <MenuItem key={user.id} value={user.id}>
                  {user.name} • {user.role}
                </MenuItem>
              ))}
            </TextField>

            {selectedUser?.has_pin ? (
              <TextField
                label="PIN"
                value={pin}
                onChange={(e) => setPin(String(e.target.value || '').replace(/\D/g, '').slice(0, 6))}
                inputProps={{ inputMode: 'numeric', pattern: '[0-9]*', maxLength: 6 }}
                type="password"
                fullWidth
              />
            ) : selectedUser ? (
              <Alert severity="info">This user does not have a PIN set.</Alert>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          {session ? <Button onClick={() => setLoginOpen(false)}>Cancel</Button> : null}
          <Button variant="contained" onClick={submitLogin} disabled={loginM.isPending || !selectedUser}>
            {loginM.isPending ? 'Signing In…' : 'Continue'}
          </Button>
        </DialogActions>
      </Dialog>
      {ready && isLocked && session?.user ? (
        <Paper
          role="dialog"
          aria-label="Session locked"
          elevation={8}
          sx={{
            position: 'fixed',
            right: { xs: 12, sm: 20 },
            bottom: { xs: 12, sm: 20 },
            width: { xs: 'calc(100% - 24px)', sm: 390 },
            zIndex: (theme) => theme.zIndex.modal + 1,
            p: 1.5,
            borderRadius: 1,
            border: '1px solid',
            borderColor: 'warning.light',
            bgcolor: 'background.paper',
          }}
        >
          <Stack gap={1.2}>
            <Stack direction="row" gap={1} alignItems="center">
              <LockOutlinedIcon color="warning" fontSize="small" />
              <Stack sx={{ minWidth: 0 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 800, lineHeight: 1.2 }}>
                  Session locked
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap>
                  {session.user.name} • Inventory access only
                </Typography>
              </Stack>
            </Stack>

            {session.user.has_pin ? (
              <TextField
                label="PIN"
                value={unlockPin}
                onChange={(e) => setUnlockPin(String(e.target.value || '').replace(/\D/g, '').slice(0, 6))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitUnlock()
                }}
                inputProps={{ inputMode: 'numeric', pattern: '[0-9]*', maxLength: 6 }}
                type="password"
                autoFocus
                size="small"
                fullWidth
                disabled={unlockM.isPending}
              />
            ) : (
              <Alert severity="info">This user does not have a PIN set.</Alert>
            )}

            <Stack direction={{ xs: 'column', sm: 'row' }} gap={0.8}>
              <Button
                variant="contained"
                startIcon={<LockOpenIcon />}
                onClick={submitUnlock}
                disabled={unlockM.isPending || (session.user.has_pin && !unlockPin.trim())}
                fullWidth
              >
                {unlockM.isPending ? 'Unlocking…' : 'Unlock'}
              </Button>
              <Button variant="outlined" startIcon={<LogoutIcon />} onClick={signOut} fullWidth>
                Sign Out
              </Button>
            </Stack>
          </Stack>
        </Paper>
      ) : null}
    </UserSessionContext.Provider>
  )
}

export function useUserSession() {
  const value = useContext(UserSessionContext)
  if (!value) throw new Error('useUserSession must be used inside UserSessionProvider')
  return value
}
