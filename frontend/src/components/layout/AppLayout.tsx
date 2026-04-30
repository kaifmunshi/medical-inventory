import { useEffect, useState } from 'react'
import { Box } from '@mui/material'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import TopMenuBar from './TopMenuBar'

const DESKTOP_SIDEBAR_STORAGE_KEY = 'desktop_sidebar_collapsed'

export default function AppLayout() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(false)

  useEffect(() => {
    try {
      setDesktopSidebarCollapsed(localStorage.getItem(DESKTOP_SIDEBAR_STORAGE_KEY) === '1')
    } catch {
      // ignore storage read errors
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(DESKTOP_SIDEBAR_STORAGE_KEY, desktopSidebarCollapsed ? '1' : '0')
    } catch {
      // ignore storage write errors
    }
  }, [desktopSidebarCollapsed])

  return (
    <Box sx={{ display: 'flex', width: '100%', minWidth: 0, minHeight: '100vh', alignItems: 'stretch', bgcolor: 'background.default' }}>
      <Sidebar
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
        collapsed={desktopSidebarCollapsed}
      />
      <Box
        component="main"
        sx={{
          flex: 1,
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
          overflowX: 'hidden',
          px: { xs: 1, sm: 1.25, lg: 1.5 },
          py: { xs: 0.875, sm: 1.25 },
        }}
      >
        <TopMenuBar
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
          onToggleDesktopSidebar={() => setDesktopSidebarCollapsed((prev) => !prev)}
          desktopSidebarCollapsed={desktopSidebarCollapsed}
        />
        <Outlet />
      </Box>
    </Box>
  )
}
