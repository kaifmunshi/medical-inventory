import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useToast } from '../components/ui/Toaster'
import { useUserSession } from '../components/session/UserSessionProvider'
import { allMenuItems } from '../components/layout/menuConfig'
import type { AppUser, FinancialYear } from '../lib/types'
import { type StoredShortcutItem, USER_SHORTCUT_HOTKEYS } from '../lib/userSession'
import { createFinancialYear, fetchFinancialYears, updateFinancialYear } from '../services/settings'
import { createUser, fetchUsers, updateUser } from '../services/users'

type UserRole = 'OWNER' | 'MANAGER' | 'STAFF'

function financialYearForStart(startYear: number) {
  const safeYear = Number(startYear || 0)
  return {
    label: `FY ${String(safeYear).slice(-2)}-${String(safeYear + 1).slice(-2)}`,
    start_date: `${safeYear}-04-01`,
    end_date: `${safeYear + 1}-03-31`,
  }
}

function prettyRange(year: FinancialYear) {
  return `${year.start_date} to ${year.end_date}`
}

function pinError(pin: string) {
  const text = String(pin || '').trim()
  if (!text) return ''
  if (!/^\d+$/.test(text)) return 'PIN must contain digits only'
  if (text.length < 4 || text.length > 6) return 'PIN must be 4 to 6 digits'
  return ''
}

export default function Settings() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { currentUser, hasMinRole, shortcuts, setShortcuts, promptSwitchUser } = useUserSession()

  const today = new Date()
  const currentStartYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1

  const [createYearOpen, setCreateYearOpen] = useState(false)
  const [createYearStart, setCreateYearStart] = useState(currentStartYear + 1)
  const [createYearActive, setCreateYearActive] = useState(true)

  const [userDialogOpen, setUserDialogOpen] = useState(false)
  const [editingUser, setEditingUser] = useState<AppUser | null>(null)
  const [userName, setUserName] = useState('')
  const [userRole, setUserRole] = useState<UserRole>('STAFF')
  const [userPin, setUserPin] = useState('')
  const [userActive, setUserActive] = useState(true)

  const yearsQ = useQuery<FinancialYear[], Error>({
    queryKey: ['settings-financial-years'],
    queryFn: fetchFinancialYears,
  })

  const usersQ = useQuery<AppUser[], Error>({
    queryKey: ['settings-users'],
    queryFn: () => fetchUsers({ active_only: false }),
  })

  const yearPreview = useMemo(() => financialYearForStart(createYearStart), [createYearStart])
  const activeYear = useMemo(() => (yearsQ.data || []).find((year) => year.is_active) || null, [yearsQ.data])
  const canManageYears = hasMinRole('MANAGER')
  const canManageUsers = hasMinRole('OWNER')
  const shortcutCount = shortcuts.length
  const shortcutLookup = useMemo(() => new Map(shortcuts.map((item) => [item.to, item])), [shortcuts])
  const usedHotkeys = useMemo(
    () => new Set(shortcuts.map((item) => String(item.hotkey || '').trim()).filter(Boolean)),
    [shortcuts],
  )
  const selectedShortcutItems = useMemo(
    () =>
      shortcuts
        .map((shortcut) => {
          const item = allMenuItems.find((entry) => entry.to === shortcut.to)
          return item ? { ...shortcut, item } : null
        })
        .filter(
          (
            entry,
          ): entry is {
            to: string
            hotkey?: string | null
            item: (typeof allMenuItems)[number]
          } => Boolean(entry),
        ),
    [shortcuts],
  )
  const userPinValidation = pinError(userPin)

  const createYearM = useMutation({
    mutationFn: createFinancialYear,
    onSuccess: () => {
      toast.push('Financial year created', 'success')
      queryClient.invalidateQueries({ queryKey: ['settings-financial-years'] })
      setCreateYearOpen(false)
      setCreateYearStart(currentStartYear + 1)
      setCreateYearActive(true)
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to create financial year'), 'error'),
  })

  const updateYearM = useMutation({
    mutationFn: ({ yearId, payload }: { yearId: number; payload: Partial<FinancialYear> }) =>
      updateFinancialYear(yearId, payload),
    onSuccess: () => {
      toast.push('Financial year updated', 'success')
      queryClient.invalidateQueries({ queryKey: ['settings-financial-years'] })
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to update financial year'), 'error'),
  })

  const createUserM = useMutation({
    mutationFn: createUser,
    onSuccess: () => {
      toast.push('User created', 'success')
      queryClient.invalidateQueries({ queryKey: ['settings-users'] })
      closeUserDialog()
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to create user'), 'error'),
  })

  const updateUserM = useMutation({
    mutationFn: ({
      userId,
      payload,
    }: {
      userId: number
      payload: Partial<{ name: string; role: UserRole; pin: string; is_active: boolean }>
    }) => updateUser(userId, payload),
    onSuccess: () => {
      toast.push('User updated', 'success')
      queryClient.invalidateQueries({ queryKey: ['settings-users'] })
      closeUserDialog()
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to update user'), 'error'),
  })

  function openCreateUser() {
    setEditingUser(null)
    setUserName('')
    setUserRole('STAFF')
    setUserPin('')
    setUserActive(true)
    setUserDialogOpen(true)
  }

  function openEditUser(user: AppUser) {
    setEditingUser(user)
    setUserName(user.name)
    setUserRole(user.role)
    setUserPin('')
    setUserActive(Boolean(user.is_active))
    setUserDialogOpen(true)
  }

  function closeUserDialog() {
    setUserDialogOpen(false)
    setEditingUser(null)
    setUserName('')
    setUserRole('STAFF')
    setUserPin('')
    setUserActive(true)
  }

  function submitFinancialYear() {
    if (!canManageYears) {
      toast.push('Manager sign-in is required for financial year changes', 'warning')
      return
    }
    if (!Number.isInteger(createYearStart) || createYearStart < 2000 || createYearStart > 2100) {
      toast.push('Choose a valid start year', 'warning')
      return
    }
    const duplicate = (yearsQ.data || []).some((year) => year.start_date === yearPreview.start_date)
    if (duplicate) {
      toast.push('That financial year already exists', 'warning')
      return
    }
    createYearM.mutate({
      label: yearPreview.label,
      start_date: yearPreview.start_date,
      end_date: yearPreview.end_date,
      is_active: createYearActive,
    })
  }

  function submitUser() {
    const cleanName = userName.trim()
    if (!cleanName) {
      toast.push('User name is required', 'warning')
      return
    }
    if (userPinValidation) {
      toast.push(userPinValidation, 'warning')
      return
    }

    if (!editingUser) {
      createUserM.mutate({
        name: cleanName,
        role: userRole,
        pin: userPin.trim() || undefined,
      })
      return
    }

    const payload: Partial<{ name: string; role: UserRole; pin: string; is_active: boolean }> = {
      name: cleanName,
      role: userRole,
      is_active: userActive,
    }
    if (userPin.trim()) payload.pin = userPin.trim()
    updateUserM.mutate({ userId: editingUser.id, payload })
  }

  function clearUserPin() {
    if (!editingUser) return
    updateUserM.mutate({
      userId: editingUser.id,
      payload: { name: userName.trim() || editingUser.name, role: userRole, is_active: userActive, pin: '' },
    })
  }

  function setShortcutList(next: StoredShortcutItem[]) {
    setShortcuts(next)
  }

  function toggleShortcut(path: string) {
    const existing = shortcutLookup.get(path)
    if (existing) {
      setShortcutList(shortcuts.filter((item) => item.to !== path))
      return
    }
    if (shortcuts.length >= 8) {
      toast.push('Keep up to 8 quick shortcuts for a clean top bar', 'warning')
      return
    }
    setShortcutList([...shortcuts, { to: path, hotkey: null }])
  }

  function changeShortcutHotkey(path: string, nextHotkey: string) {
    const normalizedHotkey = nextHotkey || null
    const conflict = shortcuts.find((item) => item.to !== path && item.hotkey === normalizedHotkey)
    if (normalizedHotkey && conflict) {
      toast.push(`${normalizedHotkey} is already assigned to another page`, 'warning')
      return
    }
    setShortcutList(
      shortcuts.map((item) => (item.to === path ? { ...item, hotkey: normalizedHotkey } : item)),
    )
  }

  return (
    <Stack gap={1.5}>
      <Paper sx={{ p: { xs: 1.5, md: 1.75 } }}>
        <Stack direction={{ xs: 'column', lg: 'row' }} justifyContent="space-between" gap={1.5}>
          <Stack gap={0.6}>
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              Settings
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Financial year control, user PIN sign-in, and personal shortcuts. Everything here works directly after commit.
            </Typography>
            <Stack direction="row" gap={0.75} flexWrap="wrap">
              {currentUser ? <Chip label={`${currentUser.name} • ${currentUser.role}`} color="primary" /> : null}
              {activeYear ? <Chip label={`Active FY ${activeYear.label}`} variant="outlined" /> : null}
              <Chip label={`Shortcuts ${shortcutCount}/8`} variant="outlined" />
            </Stack>
          </Stack>

          <Stack direction={{ xs: 'column', sm: 'row' }} gap={0.75} alignItems={{ sm: 'flex-start' }}>
            <Button variant="outlined" onClick={promptSwitchUser}>
              Switch User
            </Button>
            <Button variant="contained" onClick={() => setCreateYearOpen(true)} disabled={!canManageYears}>
              Add Financial Year
            </Button>
          </Stack>
        </Stack>
      </Paper>

      <Paper sx={{ p: { xs: 1.5, md: 1.75 } }}>
        <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1.5} sx={{ mb: 1.25 }}>
          <Box>
            <Typography variant="h6">Financial Years</Typography>
            <Typography variant="body2" color="text.secondary">
              Only `01 Apr to 31 Mar` is allowed. The active year is the real working year. Locked years are view-only.
            </Typography>
          </Box>
          {!canManageYears ? <Alert severity="info">Manager sign-in required for FY changes.</Alert> : null}
        </Stack>

        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Range</th>
                <th>Status</th>
                <th>Rules</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {(yearsQ.data || []).map((year) => (
                <tr key={year.id}>
                  <td style={{ fontWeight: 700 }}>{year.label}</td>
                  <td>{prettyRange(year)}</td>
                  <td>
                    <Stack direction="row" gap={0.75} flexWrap="wrap">
                      {year.is_active ? <Chip label="Active" color="success" /> : <Chip label="Inactive" variant="outlined" />}
                      {year.is_locked ? <Chip label="Locked" color="warning" /> : <Chip label="Open" variant="outlined" />}
                    </Stack>
                  </td>
                  <td>
                    <Typography variant="body2" color="text.secondary">
                      Apr 01 to Mar 31 only
                    </Typography>
                  </td>
                  <td>
                    <Stack direction={{ xs: 'column', md: 'row' }} gap={0.75}>
                      <Button
                        variant={year.is_active ? 'contained' : 'outlined'}
                        onClick={() => updateYearM.mutate({ yearId: year.id, payload: { is_active: true } })}
                        disabled={!canManageYears || updateYearM.isPending || year.is_active}
                      >
                        {year.is_active ? 'Current' : 'Set Active'}
                      </Button>
                      <Button
                        color={year.is_locked ? 'warning' : 'error'}
                        variant="outlined"
                        onClick={() => updateYearM.mutate({ yearId: year.id, payload: { is_locked: !year.is_locked } })}
                        disabled={!canManageYears || updateYearM.isPending}
                      >
                        {year.is_locked ? 'Unlock' : 'Lock'}
                      </Button>
                    </Stack>
                  </td>
                </tr>
              ))}
              {(yearsQ.data || []).length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <Box p={2} color="text.secondary">
                      No financial years configured yet.
                    </Box>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Paper sx={{ p: { xs: 1.5, md: 1.75 } }}>
        <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1.5} sx={{ mb: 1.25 }}>
          <Box>
            <Typography variant="h6">My Shortcuts</Typography>
            <Typography variant="body2" color="text.secondary">
              Personal page shortcuts for the signed-in user. Optional hotkeys use `Alt+1` to `Alt+8`.
            </Typography>
          </Box>
          <Chip label={`${shortcutCount}/8 selected`} color={shortcutCount > 0 ? 'primary' : 'default'} />
        </Stack>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', xl: '1.2fr 1fr' },
            gap: 1.5,
            alignItems: 'start',
          }}
        >
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.9 }}>
              Selected pages
            </Typography>
            {selectedShortcutItems.length === 0 ? (
              <Alert severity="info">No quick pages selected yet.</Alert>
            ) : (
              <Stack gap={0.8}>
                {selectedShortcutItems.map(({ item, hotkey }) => (
                  <Paper
                    key={item.to}
                    variant="outlined"
                    sx={{
                      p: 1,
                      borderRadius: 2,
                      borderColor: 'rgba(13,51,36,0.12)',
                      boxShadow: 'none',
                    }}
                  >
                    <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1} alignItems={{ sm: 'center' }}>
                      <Stack direction="row" gap={0.8} alignItems="center">
                        <Box sx={{ color: 'primary.main', display: 'inline-flex' }}>{item.icon}</Box>
                        <Box>
                          <Typography variant="body2" sx={{ fontWeight: 700 }}>
                            {item.label}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {item.to}
                          </Typography>
                        </Box>
                      </Stack>

                      <Stack direction={{ xs: 'column', sm: 'row' }} gap={0.75} alignItems={{ sm: 'center' }}>
                        <TextField
                          select
                          label="Hotkey"
                          value={hotkey || ''}
                          onChange={(e) => changeShortcutHotkey(item.to, e.target.value)}
                          sx={{ minWidth: 118 }}
                        >
                          <MenuItem value="">No hotkey</MenuItem>
                          {USER_SHORTCUT_HOTKEYS.map((choice) => (
                            <MenuItem
                              key={choice}
                              value={choice}
                              disabled={usedHotkeys.has(choice) && hotkey !== choice}
                            >
                              {choice}
                            </MenuItem>
                          ))}
                        </TextField>
                        <Button variant="outlined" color="inherit" onClick={() => toggleShortcut(item.to)}>
                          Remove
                        </Button>
                      </Stack>
                    </Stack>
                  </Paper>
                ))}
              </Stack>
            )}
          </Box>

          <Box>
            <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.9 }}>
              Choose pages
            </Typography>
            <Stack direction="row" gap={0.75} flexWrap="wrap">
              {allMenuItems.map((item) => {
                const selected = shortcutLookup.has(item.to)
                return (
                  <Button
                    key={item.to}
                    variant={selected ? 'contained' : 'outlined'}
                    color={selected ? 'primary' : 'inherit'}
                    startIcon={item.icon}
                    onClick={() => toggleShortcut(item.to)}
                    sx={{ borderRadius: 999, justifyContent: 'flex-start' }}
                  >
                    {item.label}
                  </Button>
                )
              })}
            </Stack>
          </Box>
        </Box>
      </Paper>

      <Paper id="users" sx={{ p: { xs: 1.5, md: 1.75 } }}>
        <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1.5} sx={{ mb: 1.25 }}>
          <Box>
            <Typography variant="h6">Users & PIN</Typography>
            <Typography variant="body2" color="text.secondary">
              PIN controls actual sign-in now. Sensitive actions follow the signed-in role.
            </Typography>
          </Box>
          <Button variant="contained" onClick={openCreateUser} disabled={!canManageUsers}>
            Add User
          </Button>
        </Stack>

        {!canManageUsers ? <Alert severity="info" sx={{ mb: 1.25 }}>Owner sign-in required to manage users.</Alert> : null}

        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>PIN</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {(usersQ.data || []).map((user) => (
                <tr key={user.id}>
                  <td style={{ fontWeight: 700 }}>{user.name}</td>
                  <td>{user.role}</td>
                  <td>{user.has_pin ? 'Configured' : 'Not set'}</td>
                  <td>{user.is_active ? 'Active' : 'Inactive'}</td>
                  <td>
                    <Stack direction={{ xs: 'column', md: 'row' }} gap={0.75}>
                      <Button variant="outlined" onClick={() => openEditUser(user)} disabled={!canManageUsers}>
                        Edit
                      </Button>
                      <Button
                        onClick={() =>
                          updateUserM.mutate({
                            userId: user.id,
                            payload: { name: user.name, role: user.role, is_active: !user.is_active },
                          })
                        }
                        disabled={!canManageUsers || updateUserM.isPending}
                      >
                        {user.is_active ? 'Deactivate' : 'Activate'}
                      </Button>
                    </Stack>
                  </td>
                </tr>
              ))}
              {(usersQ.data || []).length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <Box p={2} color="text.secondary">
                      No users configured yet.
                    </Box>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Dialog open={createYearOpen} onClose={() => setCreateYearOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add Financial Year</DialogTitle>
        <DialogContent dividers>
          <Stack gap={1.5} sx={{ mt: 1 }}>
            <TextField
              label="Start FY Year"
              type="number"
              value={createYearStart}
              onChange={(e) => setCreateYearStart(Number(e.target.value) || 0)}
              inputProps={{ min: 2000, max: 2100 }}
              helperText="Range is fixed as 01 Apr to 31 Mar."
            />
            <TextField label="Label" value={yearPreview.label} InputProps={{ readOnly: true }} />
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={1}>
              <TextField label="Start Date" value={yearPreview.start_date} InputProps={{ readOnly: true }} fullWidth />
              <TextField label="End Date" value={yearPreview.end_date} InputProps={{ readOnly: true }} fullWidth />
            </Stack>
            <TextField
              select
              label="Activation"
              value={createYearActive ? 'active' : 'inactive'}
              onChange={(e) => setCreateYearActive(e.target.value === 'active')}
            >
              <MenuItem value="active">Create and set active</MenuItem>
              <MenuItem value="inactive">Create as inactive</MenuItem>
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateYearOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={submitFinancialYear} disabled={createYearM.isPending}>
            {createYearM.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={userDialogOpen} onClose={closeUserDialog} maxWidth="sm" fullWidth>
        <DialogTitle>{editingUser ? `Edit User • ${editingUser.name}` : 'Add User'}</DialogTitle>
        <DialogContent dividers>
          <Stack gap={1.5} sx={{ mt: 1 }}>
            <TextField label="Name" value={userName} onChange={(e) => setUserName(e.target.value)} fullWidth />
            <TextField select label="Role" value={userRole} onChange={(e) => setUserRole(e.target.value as UserRole)}>
              <MenuItem value="OWNER">OWNER</MenuItem>
              <MenuItem value="MANAGER">MANAGER</MenuItem>
              <MenuItem value="STAFF">STAFF</MenuItem>
            </TextField>
            <TextField
              label={editingUser ? 'New PIN (leave blank to keep current)' : 'PIN'}
              value={userPin}
              onChange={(e) => setUserPin(String(e.target.value || '').replace(/\D/g, '').slice(0, 6))}
              error={Boolean(userPinValidation)}
              helperText={userPinValidation || '4 to 6 digits. Leave blank only if this user should not require a PIN.'}
              inputProps={{ inputMode: 'numeric', pattern: '[0-9]*', maxLength: 6 }}
              type="password"
              fullWidth
            />
            {editingUser ? (
              <TextField
                select
                label="Status"
                value={userActive ? 'active' : 'inactive'}
                onChange={(e) => setUserActive(e.target.value === 'active')}
              >
                <MenuItem value="active">Active</MenuItem>
                <MenuItem value="inactive">Inactive</MenuItem>
              </TextField>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          {editingUser ? (
            <>
              <Button onClick={clearUserPin} color="warning" disabled={updateUserM.isPending}>
                Clear PIN
              </Button>
              <Divider flexItem orientation="vertical" sx={{ display: { xs: 'none', sm: 'block' } }} />
            </>
          ) : null}
          <Button onClick={closeUserDialog}>Cancel</Button>
          <Button
            variant="contained"
            onClick={submitUser}
            disabled={createUserM.isPending || updateUserM.isPending}
          >
            {createUserM.isPending || updateUserM.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
