import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import {
  AppBar,
  Box,
  Button,
  Chip,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  Toolbar,
  Typography,
} from '@mui/material'
import {
  KeyboardDoubleArrowLeft,
  KeyboardDoubleArrowRight,
  Logout,
  Menu as MenuIcon,
  Settings as SettingsIcon,
  SwapHoriz,
} from '@mui/icons-material'
import { useQuery } from '@tanstack/react-query'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { allMenuItems, appMenuGroups, quickShortcutItems } from './menuConfig'
import { fetchFinancialYears } from '../../services/settings'
import { useUserSession } from '../session/UserSessionProvider'

type TopMenuBarProps = {
  onOpenMobileMenu?: () => void
  onToggleDesktopSidebar?: () => void
  desktopSidebarCollapsed?: boolean
}

function routeMatches(target: string, pathname: string) {
  const basePath = String(target || '').split('#')[0] || '/'
  if (basePath === '/') return pathname === '/'
  return pathname === basePath || pathname.startsWith(`${basePath}/`)
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tagName = String(target.tagName || '').toLowerCase()
  return target.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select'
}

function hotkeyMatches(event: KeyboardEvent, combo?: string | null) {
  if (!combo) return false
  const parts = combo
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  if (parts.length === 0) return false

  const key = parts[parts.length - 1]
  const requiresAlt = parts.includes('alt')
  const requiresCtrl = parts.includes('ctrl')
  const requiresShift = parts.includes('shift')
  const requiresMeta = parts.includes('meta')

  if (event.altKey !== requiresAlt) return false
  if (event.ctrlKey !== requiresCtrl) return false
  if (event.shiftKey !== requiresShift) return false
  if (event.metaKey !== requiresMeta) return false

  return String(event.key || '').toLowerCase() === key
}

export default function TopMenuBar({
  onOpenMobileMenu,
  onToggleDesktopSidebar,
  desktopSidebarCollapsed = false,
}: TopMenuBarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const { currentUser, shortcuts, signOut, promptSwitchUser } = useUserSession()
  const [userMenuAnchor, setUserMenuAnchor] = useState<HTMLElement | null>(null)
  const yearsQ = useQuery({
    queryKey: ['topbar-financial-years'],
    queryFn: fetchFinancialYears,
  })

  const activeItem = useMemo(
    () => allMenuItems.find((item) => routeMatches(item.to, location.pathname)) || allMenuItems[0],
    [location.pathname],
  )
  const activeGroup = useMemo(
    () => appMenuGroups.find((group) => group.items.some((item) => routeMatches(item.to, location.pathname))) || appMenuGroups[0],
    [location.pathname],
  )
  const activeYear = useMemo(() => (yearsQ.data || []).find((year) => year.is_active) || null, [yearsQ.data])
  const shortcutLinks = useMemo(
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

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return

      const customMatch = shortcutLinks.find((entry) => hotkeyMatches(event, entry.hotkey))
      if (customMatch) {
        event.preventDefault()
        navigate(customMatch.to)
        return
      }

      const builtInMatch = quickShortcutItems.find((item) => hotkeyMatches(event, item.shortcut))
      if (!builtInMatch) return
      event.preventDefault()
      navigate(builtInMatch.to)
    }

    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [navigate, shortcutLinks])

  function openUserMenu(event: MouseEvent<HTMLElement>) {
    setUserMenuAnchor(event.currentTarget)
  }

  function closeUserMenu() {
    setUserMenuAnchor(null)
  }

  return (
    <AppBar
      position="sticky"
      color="inherit"
      elevation={0}
      sx={{
        top: 0,
        zIndex: 10,
        borderRadius: 2,
        border: '1px solid rgba(13, 51, 36, 0.10)',
        bgcolor: 'rgba(250, 252, 249, 0.95)',
        backdropFilter: 'blur(10px)',
        color: 'text.primary',
        mb: 1,
      }}
    >
      <Toolbar
        disableGutters
        sx={{
          minHeight: 46,
          px: { xs: 1, md: 1.25 },
          py: 0.4,
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 1,
        }}
      >
        <Stack direction="row" gap={0.75} alignItems="center" sx={{ minWidth: 0, flex: 1 }}>
          <IconButton onClick={onOpenMobileMenu} sx={{ display: { xs: 'inline-flex', md: 'none' } }}>
            <MenuIcon fontSize="small" />
          </IconButton>
          <IconButton onClick={onToggleDesktopSidebar} sx={{ display: { xs: 'none', md: 'inline-flex' } }}>
            {desktopSidebarCollapsed ? (
              <KeyboardDoubleArrowRight fontSize="small" />
            ) : (
              <KeyboardDoubleArrowLeft fontSize="small" />
            )}
          </IconButton>
          <Box component="img" src="/logo.png" alt="Logo" sx={{ height: 24, width: 'auto', display: 'block' }} />
          <Stack spacing={0.1} sx={{ minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 700, lineHeight: 1.15 }} noWrap>
              {activeItem?.label || 'Dashboard'}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }} noWrap>
              {activeGroup?.label || 'Workspace'}
              {activeYear ? ` • ${activeYear.label}` : ''}
            </Typography>
          </Stack>
        </Stack>

        <Stack direction="row" gap={0.6} alignItems="center" sx={{ flexShrink: 0 }}>
          {activeYear ? (
            <Chip
              label={`${activeYear.start_date} to ${activeYear.end_date}`}
              variant="outlined"
              sx={{ display: { xs: 'none', lg: 'inline-flex' }, bgcolor: 'rgba(255,255,255,0.55)' }}
            />
          ) : null}
          {currentUser ? (
            <Button
              onClick={openUserMenu}
              variant="text"
              sx={{
                px: 1,
                minWidth: 0,
                borderRadius: 999,
                bgcolor: 'rgba(31,107,74,0.08)',
                color: 'primary.dark',
                fontWeight: 700,
              }}
            >
              {currentUser.name}
            </Button>
          ) : null}
        </Stack>
      </Toolbar>

      {shortcutLinks.length > 0 ? (
        <Box
          sx={{
            px: { xs: 1, md: 1.25 },
            py: 0.45,
            borderTop: '1px solid',
            borderColor: 'divider',
            bgcolor: 'rgba(15,23,42,0.02)',
          }}
        >
          <Stack direction="row" gap={0.5} flexWrap="wrap" alignItems="center">
            <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', mr: 0.25 }}>
              My Shortcuts
            </Typography>
            {shortcutLinks.map(({ item, hotkey }) => {
              const itemActive = routeMatches(item.to, location.pathname)
              return (
                <Button
                  key={item.to}
                  component={NavLink}
                  to={item.to}
                  size="small"
                  startIcon={item.icon}
                  sx={{
                    borderRadius: 999,
                    px: 0.9,
                    py: 0.15,
                    minWidth: 0,
                    fontSize: 12,
                    color: itemActive ? 'primary.dark' : 'text.secondary',
                    bgcolor: itemActive ? 'rgba(31,107,74,0.12)' : 'rgba(255,255,255,0.58)',
                    '&:hover': { bgcolor: 'rgba(31,107,74,0.08)' },
                  }}
                >
                  {item.label}
                  {hotkey ? (
                    <Typography component="span" sx={{ ml: 0.6, fontSize: 11, opacity: 0.75 }}>
                      {hotkey}
                    </Typography>
                  ) : null}
                </Button>
              )
            })}
          </Stack>
        </Box>
      ) : null}

      <Menu
        anchorEl={userMenuAnchor}
        open={Boolean(userMenuAnchor)}
        onClose={closeUserMenu}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            sx: {
              mt: 0.5,
              minWidth: 220,
              borderRadius: 2,
              border: '1px solid',
              borderColor: 'divider',
            },
          },
        }}
      >
        {currentUser ? (
          <Box sx={{ px: 1.5, py: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
            <Typography variant="body2" sx={{ fontWeight: 700 }}>
              {currentUser.name}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {currentUser.role}
              {activeYear ? ` • ${activeYear.label}` : ''}
            </Typography>
          </Box>
        ) : null}
        <MenuItem
          dense
          onClick={() => {
            closeUserMenu()
            promptSwitchUser()
          }}
          sx={{ gap: 1, py: 0.75 }}
        >
          <SwapHoriz fontSize="small" />
          Switch User
        </MenuItem>
        <MenuItem
          dense
          onClick={() => {
            closeUserMenu()
            navigate('/settings')
          }}
          sx={{ gap: 1, py: 0.75 }}
        >
          <SettingsIcon fontSize="small" />
          Settings
        </MenuItem>
        <MenuItem
          dense
          onClick={() => {
            closeUserMenu()
            signOut()
          }}
          sx={{ gap: 1, py: 0.75 }}
        >
          <Logout fontSize="small" />
          Sign Out
        </MenuItem>
      </Menu>
    </AppBar>
  )
}
