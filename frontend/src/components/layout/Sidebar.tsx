import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Collapse,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Tooltip,
  Typography,
} from '@mui/material'
import { ExpandLess, ExpandMore } from '@mui/icons-material'
import { NavLink, useLocation } from 'react-router-dom'
import { appMenuGroups } from './menuConfig'

type SidebarProps = {
  mobileOpen?: boolean
  onCloseMobile?: () => void
}

const STORAGE_KEY = 'sidebar_group_state'

function defaultExpanded() {
  return Object.fromEntries(appMenuGroups.map((group) => [group.key, true])) as Record<string, boolean>
}

export default function Sidebar({ mobileOpen = false, onCloseMobile }: SidebarProps) {
  const { pathname } = useLocation()
  const year = new Date().getFullYear()
  const [expanded, setExpanded] = useState<Record<string, boolean>>(defaultExpanded)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      setExpanded({ ...defaultExpanded(), ...(parsed || {}) })
    } catch {
      // ignore malformed persisted state
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(expanded))
  }, [expanded])

  const activeGroupKey = useMemo(() => {
    const group = appMenuGroups.find((entry) =>
      entry.items.some((item) => item.to === pathname || (item.to !== '/' && pathname.startsWith(item.to))),
    )
    return group?.key || ''
  }, [pathname])

  useEffect(() => {
    if (activeGroupKey) {
      setExpanded((prev) => ({ ...prev, [activeGroupKey]: true }))
    }
  }, [activeGroupKey])

  function toggleGroup(groupKey: string) {
    setExpanded((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }))
  }

  const sidebarBody = (
    <Box
      component="aside"
      sx={{
        width: 260,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        py: 2,
        px: 1.5,
        gap: 1.5,
        bgcolor: '#0f4d32',
        background: 'linear-gradient(180deg, #145c3b 0%, #0f4d32 45%, #0b3c28 100%)',
        color: 'rgba(255,255,255,0.92)',
        borderRight: '1px solid rgba(0,0,0,0.2)',
        boxShadow: '4px 0 18px rgba(0,0,0,0.14)',
      }}
    >
      <Box sx={{ mb: 0.5, p: 0.5, bgcolor: '#ffffff', borderRadius: 1.5, display: 'inline-flex' }}>
        <Box component="img" src="/logo.png" alt="Logo" sx={{ height: 28, width: 'auto', display: 'block', maxWidth: '100%', objectFit: 'contain' }} />
      </Box>

      <Box sx={{ overflowY: 'auto', pr: 0.5, mr: -0.5 }}>
        {appMenuGroups.map((group, index) => {
          const isActiveGroup = activeGroupKey === group.key
          const isOpen = Boolean(expanded[group.key])

          if (group.items.length === 1) {
            const link = group.items[0]
            const active = pathname === link.to || (link.to !== '/' && pathname.startsWith(link.to))
            return (
              <Box key={group.key} sx={{ mb: 1.35 }}>
                {index > 0 && <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', mb: 1.15 }} />}
                <ListItemButton
                  component={NavLink}
                  to={link.to}
                  onClick={onCloseMobile}
                  sx={{
                    mb: 0.5,
                    borderRadius: 1.5,
                    px: 1,
                    py: 0.75,
                    bgcolor: active ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.03)',
                    boxShadow: active ? 'inset 0 0 0 1px rgba(255,255,255,0.10)' : 'none',
                    '&:hover': {
                      bgcolor: active ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)',
                    },
                  }}
                >
                  <ListItemIcon sx={{ minWidth: 34, color: 'inherit', opacity: active ? 1 : 0.78 }}>{group.icon}</ListItemIcon>
                  <ListItemText
                    primary={group.label}
                    primaryTypographyProps={{ fontSize: 13, fontWeight: active ? 700 : 500 }}
                  />
                </ListItemButton>
              </Box>
            )
          }

          return (
            <Box key={group.key} sx={{ mb: 1.35 }}>
              {index > 0 && <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', mb: 1.15 }} />}
              <ListItemButton
                onClick={() => toggleGroup(group.key)}
                sx={{
                  mb: 0.5,
                  borderRadius: 1.5,
                  px: 1,
                  py: 0.75,
                  bgcolor: isActiveGroup ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.03)',
                  '&:hover': {
                    bgcolor: 'rgba(255,255,255,0.08)',
                  },
                }}
              >
                <ListItemIcon sx={{ minWidth: 34, color: 'inherit' }}>{group.icon}</ListItemIcon>
                <ListItemText
                  primary={group.label}
                  primaryTypographyProps={{ fontSize: 13, fontWeight: 700 }}
                />
                <Tooltip title={isOpen ? 'Collapse section' : 'Expand section'}>
                  <IconButton size="small" sx={{ color: 'inherit' }}>
                    {isOpen ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
                  </IconButton>
                </Tooltip>
              </ListItemButton>

              <Collapse in={isOpen} timeout="auto" unmountOnExit>
                <List sx={{ mt: 0, py: 0 }}>
                  {group.items.map((link) => {
                    const active = pathname === link.to || (link.to !== '/' && pathname.startsWith(link.to))
                    return (
                      <ListItemButton
                        key={link.to}
                        component={NavLink}
                        to={link.to}
                        onClick={onCloseMobile}
                        sx={{
                          mb: 0.25,
                          ml: 0.75,
                          borderRadius: 1.25,
                          px: 1,
                          py: 0.65,
                          alignItems: 'flex-start',
                          '& .MuiListItemIcon-root': {
                            minWidth: 30,
                            mt: 0.15,
                            color: 'inherit',
                            opacity: active ? 1 : 0.78,
                          },
                          '& .MuiListItemText-primary': {
                            fontSize: 13.5,
                            fontWeight: active ? 700 : 600,
                            lineHeight: 1.2,
                          },
                          '& .MuiListItemText-secondary': {
                            mt: 0.35,
                            fontSize: 11.2,
                            lineHeight: 1.22,
                            color: 'rgba(255,255,255,0.72)',
                          },
                          '&:hover': {
                            bgcolor: 'rgba(255,255,255,0.12)',
                          },
                          ...(active && {
                            bgcolor: 'rgba(255,255,255,0.18)',
                            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)',
                          }),
                        }}
                      >
                        <ListItemIcon>{link.icon}</ListItemIcon>
                        <ListItemText primary={link.label} primaryTypographyProps={{ fontSize: 13 }} />
                      </ListItemButton>
                    )
                  })}
                </List>
              </Collapse>
            </Box>
          )
        })}
      </Box>

      <Box sx={{ flexGrow: 1 }} />

      <Typography variant="caption" sx={{ opacity: 0.55, fontSize: 10 }}>
        {year}
      </Typography>
    </Box>
  )

  return (
    <>
      <Box
        sx={{
          width: 260,
          flexShrink: 0,
          display: { xs: 'none', md: 'block' },
        }}
      >
        {sidebarBody}
      </Box>
      <Drawer
        open={mobileOpen}
        onClose={onCloseMobile}
        ModalProps={{ keepMounted: true }}
        sx={{
          display: { xs: 'block', md: 'none' },
          '& .MuiDrawer-paper': {
            width: 260,
            border: 'none',
            background: 'transparent',
            boxShadow: 'none',
          },
        }}
      >
        {sidebarBody}
      </Drawer>
    </>
  )
}
