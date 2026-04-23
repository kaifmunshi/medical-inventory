import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useToast } from '../ui/Toaster'
import type { AppUser, UserSession } from '../../lib/types'
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
  const [shortcuts, setShortcutsState] = useState<StoredShortcutItem[]>([])

  useEffect(() => {
    const stored = loadStoredUserSession()
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
      setSession(nextSession)
      setLoginOpen(false)
      setPin('')
      toast.push(`Signed in as ${nextSession.user.name}`, 'success')
    },
    onError: (err: any) => {
      toast.push(String(err?.message || 'Failed to sign in'), 'error')
    },
  })

  function signOut() {
    clearStoredUserSession()
    setSession(null)
    setLoginOpen(hasConfiguredUsers)
    setSelectedUserId('')
    setPin('')
  }

  function promptSwitchUser() {
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

  const value = useMemo<UserSessionContextValue>(
    () => ({
      session,
      currentUser: session?.user || null,
      shortcuts,
      setShortcuts,
      hasConfiguredUsers,
      signOut,
      promptSwitchUser,
      hasMinRole,
    }),
    [session, shortcuts, hasConfiguredUsers],
  )

  return (
    <UserSessionContext.Provider value={value}>
      {children}
      <Dialog open={ready && loginOpen && hasConfiguredUsers} fullWidth maxWidth="xs">
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
    </UserSessionContext.Provider>
  )
}

export function useUserSession() {
  const value = useContext(UserSessionContext)
  if (!value) throw new Error('useUserSession must be used inside UserSessionProvider')
  return value
}
