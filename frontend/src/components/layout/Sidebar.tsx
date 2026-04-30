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
  collapsed?: boolean
}

const STORAGE_KEY = 'sidebar_group_state'

function defaultExpanded() {
  return Object.fromEntries(appMenuGroups.map((group) => [group.key, true])) as Record<string, boolean>
}

export default function Sidebar({ mobileOpen = false, onCloseMobile, collapsed = false }: SidebarProps) {
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
      // ignore malformed state
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

  function renderSidebarBody(isCollapsed: boolean) {
    return (
      <Box
        component="aside"
        sx={{
          width: isCollapsed ? 88 : 252,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          py: 1.5,
          px: isCollapsed ? 1 : 1.25,
          gap: 1,
          overflowY: 'auto',
          bgcolor: '#0f4d32',
          background: 'linear-gradient(180deg, #145c3b 0%, #0f4d32 45%, #0b3c28 100%)',
          color: 'rgba(255,255,255,0.92)',
          borderRight: '1px solid rgba(0,0,0,0.2)',
          boxShadow: '4px 0 18px rgba(0,0,0,0.12)',
          transition: 'width 180ms ease',
        }}
      >
        <Box
          sx={{
            mb: 0.25,
            p: 0.5,
            bgcolor: '#ffffff',
            borderRadius: 1.5,
            display: 'inline-flex',
            alignSelf: isCollapsed ? 'center' : 'flex-start',
          }}
        >
          <Box
            component="img"
            src="/logo.png"
            alt="Logo"
            sx={{ height: isCollapsed ? 24 : 28, width: 'auto', display: 'block', maxWidth: '100%', objectFit: 'contain' }}
          />
        </Box>

        <Box sx={{ overflowY: 'auto', pr: 0.5, mr: -0.5, flex: 1, minHeight: 0 }}>
          {appMenuGroups.map((group, index) => {
            const isActiveGroup = activeGroupKey === group.key
            const isOpen = Boolean(expanded[group.key])

            if (group.items.length === 1) {
              const link = group.items[0]
              const active = pathname === link.to || (link.to !== '/' && pathname.startsWith(link.to))
              return (
                <Box key={group.key} sx={{ mb: 1.35 }}>
                  {index > 0 && <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', mb: 0.9 }} />}
                  <Tooltip title={isCollapsed ? group.label : ''} placement="right">
                    <ListItemButton
                      component={NavLink}
                      to={link.to}
                      onClick={onCloseMobile}
                      sx={{
                        mb: 0.35,
                        borderRadius: 1.5,
                        px: isCollapsed ? 0.9 : 1,
                        py: 0.7,
                        justifyContent: isCollapsed ? 'center' : 'flex-start',
                        bgcolor: active ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.03)',
                        boxShadow: active ? 'inset 0 0 0 1px rgba(255,255,255,0.10)' : 'none',
                        '&:hover': {
                          bgcolor: active ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)',
                        },
                      }}
                    >
                      <ListItemIcon sx={{ minWidth: isCollapsed ? 0 : 34, color: 'inherit', opacity: active ? 1 : 0.78 }}>
                        {group.icon}
                      </ListItemIcon>
                      {!isCollapsed ? (
                        <ListItemText
                          primary={group.label}
                          primaryTypographyProps={{ fontSize: 12.5, fontWeight: active ? 700 : 500 }}
                        />
                      ) : null}
                    </ListItemButton>
                  </Tooltip>
                </Box>
              )
            }

            return (
              <Box key={group.key} sx={{ mb: 1.35 }}>
                {index > 0 && <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', mb: 0.9 }} />}
                <Tooltip title={isCollapsed ? `${group.label} ${isOpen ? '(collapse)' : '(expand)'}` : ''} placement="right">
                  <ListItemButton
                    onClick={() => toggleGroup(group.key)}
                    sx={{
                      mb: 0.35,
                      borderRadius: 1.5,
                      px: isCollapsed ? 0.9 : 1,
                      py: 0.7,
                      justifyContent: isCollapsed ? 'center' : 'flex-start',
                      bgcolor: isActiveGroup ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.03)',
                      '&:hover': {
                        bgcolor: 'rgba(255,255,255,0.08)',
                      },
                    }}
                  >
                    <ListItemIcon sx={{ minWidth: isCollapsed ? 0 : 34, color: 'inherit' }}>{group.icon}</ListItemIcon>
                    {!isCollapsed ? (
                      <>
                        <ListItemText primary={group.label} primaryTypographyProps={{ fontSize: 12.5, fontWeight: 700 }} />
                        <Tooltip title={isOpen ? 'Collapse section' : 'Expand section'}>
                          <IconButton size="small" sx={{ color: 'inherit' }}>
                            {isOpen ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
                          </IconButton>
                        </Tooltip>
                      </>
                    ) : null}
                  </ListItemButton>
                </Tooltip>

                <Collapse in={isOpen} timeout="auto" unmountOnExit>
                  <List sx={{ mt: 0, py: 0 }}>
                    {group.items.map((link) => {
                      const active = pathname === link.to || (link.to !== '/' && pathname.startsWith(link.to))
                      return (
                        <Tooltip key={link.to} title={isCollapsed ? link.label : ''} placement="right">
                          <ListItemButton
                            component={NavLink}
                            to={link.to}
                            onClick={onCloseMobile}
                            sx={{
                              mb: 0.2,
                              ml: isCollapsed ? 0 : 0.6,
                              borderRadius: 1.25,
                              px: isCollapsed ? 0.8 : 1,
                              py: 0.6,
                              minHeight: 34,
                              justifyContent: isCollapsed ? 'center' : 'flex-start',
                              alignItems: 'center',
                              '& .MuiListItemIcon-root': {
                              minWidth: isCollapsed ? 0 : 28,
                              mt: 0,
                              color: 'inherit',
                              opacity: active ? 1 : 0.78,
                            },
                            '& .MuiListItemText-primary': {
                              fontSize: 12.5,
                              fontWeight: active ? 700 : 600,
                              lineHeight: 1.2,
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
                            {!isCollapsed ? <ListItemText primary={link.label} primaryTypographyProps={{ fontSize: 12.5 }} /> : null}
                          </ListItemButton>
                        </Tooltip>
                      )
                    })}
                  </List>
                </Collapse>
              </Box>
            )
          })}
        </Box>

        {!isCollapsed ? (
          <Typography variant="caption" sx={{ opacity: 0.72, px: 1 }}>
            © {year} Good Luck Store
          </Typography>
        ) : null}
      </Box>
    )
  }

  return (
    <>
      <Box
        sx={{
          display: { xs: 'none', md: 'block' },
          position: 'sticky',
          top: 0,
          width: collapsed ? 88 : 252,
          minWidth: collapsed ? 88 : 252,
          height: '100vh',
          alignSelf: 'flex-start',
          flexShrink: 0,
          overflow: 'hidden',
          transition: 'width 180ms ease, min-width 180ms ease',
        }}
      >
        {renderSidebarBody(collapsed)}
      </Box>
      <Drawer
        variant="temporary"
        open={mobileOpen}
        onClose={onCloseMobile}
        ModalProps={{ keepMounted: true }}
        sx={{
          display: { xs: 'block', md: 'none' },
          '& .MuiDrawer-paper': { width: 260, border: 0 },
        }}
      >
        {renderSidebarBody(false)}
      </Drawer>
    </>
  )
}
