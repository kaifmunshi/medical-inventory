import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import {
  AppBar,
  Box,
  Button,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  Toolbar,
  Typography,
} from '@mui/material'
import { Menu as MenuIcon } from '@mui/icons-material'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { appMenuGroups, quickShortcutItems } from './menuConfig'

type TopMenuBarProps = {
  onOpenMobileMenu?: () => void
}

export default function TopMenuBar({ onOpenMobileMenu }: TopMenuBarProps) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [anchorEls, setAnchorEls] = useState<Record<string, HTMLElement | null>>({})

  const activeGroupKey = useMemo(() => {
    const group = appMenuGroups.find((entry) =>
      entry.items.some((item) => item.to === pathname || (item.to !== '/' && pathname.startsWith(item.to))),
    )
    return group?.key || ''
  }, [pathname])
  const activeGroup = useMemo(
    () => appMenuGroups.find((entry) => entry.key === activeGroupKey) || appMenuGroups[0],
    [activeGroupKey],
  )

  function openMenu(groupKey: string, event: MouseEvent<HTMLElement>) {
    setAnchorEls((prev) => ({ ...prev, [groupKey]: event.currentTarget }))
  }

  function closeMenu(groupKey: string) {
    setAnchorEls((prev) => ({ ...prev, [groupKey]: null }))
  }

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const key = String(event.key || '').toUpperCase()
      const match = quickShortcutItems.find((item) => {
        const shortcutKey = String(item.shortcut || '').split('+').pop()?.toUpperCase()
        return shortcutKey === key
      })
      if (!match) return
      event.preventDefault()
      navigate(match.to)
    }

    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [navigate])

  const barSx = {
    top: 0,
    zIndex: 10,
    borderRadius: 2,
    border: '1px solid rgba(13, 51, 36, 0.12)',
    bgcolor: 'rgba(247, 250, 245, 0.94)',
    background: 'linear-gradient(180deg, rgba(247,250,245,0.96) 0%, rgba(239,248,244,0.96) 100%)',
    color: 'text.primary',
    mb: 1.5,
  }

  return (
    <AppBar position="sticky" color="inherit" elevation={0} sx={barSx}>
      <Toolbar
        disableGutters
        sx={{
          minHeight: 44,
          px: { xs: 1, md: 1.5 },
          py: 0.5,
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 0.5,
        }}
      >
        <Stack direction="row" gap={1} alignItems="center" sx={{ minWidth: 0 }}>
          <IconButton
            onClick={onOpenMobileMenu}
            size="small"
            sx={{ display: { xs: 'inline-flex', md: 'none' } }}
          >
            <MenuIcon />
          </IconButton>
          <Box component="img" src="/logo.png" alt="Logo" sx={{ height: 28, width: 'auto', display: 'block' }} />
        </Stack>

        <Stack direction="row" gap={0.25} flexWrap="wrap" justifyContent="flex-end" sx={{ rowGap: 0.5 }}>
          {appMenuGroups.map((group) => {
            const open = Boolean(anchorEls[group.key])
            const active = activeGroupKey === group.key
            const direct = group.items.length === 1
            const buttonProps = {
              size: 'small' as const,
              sx: {
                borderRadius: 1.5,
                px: 1,
                py: 0.35,
                minWidth: 0,
                color: active ? 'primary.dark' : 'text.primary',
                bgcolor: active ? 'rgba(31,107,74,0.12)' : 'rgba(255,255,255,0.45)',
                border: '1px solid',
                borderColor: active ? 'rgba(31,107,74,0.24)' : 'rgba(13,51,36,0.08)',
                fontWeight: active ? 700 : 500,
                fontSize: 13,
                '&:hover': { bgcolor: 'rgba(31,107,74,0.08)' },
              },
            }

            if (direct) {
              const target = group.items[0]
              return (
                <Button
                  key={group.key}
                  component={NavLink}
                  to={target.to}
                  startIcon={target.icon}
                  {...buttonProps}
                >
                  {group.shortLabel || group.label}
                </Button>
              )
            }

            return (
              <Box key={group.key}>
                <Button
                  onClick={(event) => openMenu(group.key, event)}
                  {...buttonProps}
                  startIcon={group.icon}
                >
                  {group.shortLabel || group.label}
                </Button>
                <Menu
                  anchorEl={anchorEls[group.key]}
                  open={open}
                  onClose={() => closeMenu(group.key)}
                  anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
                  transformOrigin={{ vertical: 'top', horizontal: 'left' }}
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
                  <Box sx={{ px: 1.5, py: 0.75, bgcolor: 'rgba(31,107,74,0.08)', borderBottom: '1px solid', borderColor: 'divider' }}>
                    <Typography variant="caption" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.06 }}>
                      {group.label}
                    </Typography>
                  </Box>
                  {group.items.map((item) => {
                    const itemActive = item.to === pathname || (item.to !== '/' && pathname.startsWith(item.to))
                    return (
                      <MenuItem
                        key={item.to}
                        selected={itemActive}
                        dense
                        onClick={() => {
                          closeMenu(group.key)
                          navigate(item.to)
                        }}
                        sx={{ gap: 1, py: 0.5, fontSize: 13 }}
                      >
                        {item.icon}
                        <Typography variant="body2">{item.label}</Typography>
                      </MenuItem>
                    )
                  })}
                </Menu>
              </Box>
            )
          })}
        </Stack>
      </Toolbar>
      {activeGroup && activeGroup.items.length > 1 && (
        <Box
          sx={{
            px: { xs: 1, md: 1.5 },
            py: 0.5,
            borderTop: '1px solid',
            borderColor: 'divider',
            bgcolor: 'rgba(31,107,74,0.05)',
          }}
        >
          <Stack direction="row" gap={0.25} flexWrap="wrap" alignItems="center">
            {activeGroup.items.map((item) => {
              const itemActive = item.to === pathname || (item.to !== '/' && pathname.startsWith(item.to))
              return (
                <Button
                  key={item.to}
                  component={NavLink}
                  to={item.to}
                  size="small"
                  startIcon={item.icon}
                  sx={{
                    borderRadius: 1.5,
                    px: 0.75,
                    py: 0.25,
                    minWidth: 0,
                    fontSize: 12,
                    color: itemActive ? 'primary.dark' : 'text.secondary',
                    bgcolor: itemActive ? 'rgba(31,107,74,0.12)' : 'transparent',
                    fontWeight: itemActive ? 700 : 500,
                    '&:hover': { bgcolor: 'rgba(31,107,74,0.08)' },
                  }}
                >
                  {item.label}
                </Button>
              )
            })}
          </Stack>
        </Box>
      )}
    </AppBar>
  )
}
