import { useEffect, useState } from 'react'
import { Box } from '@mui/material'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import TopMenuBar from './TopMenuBar'
import { useQuery } from '@tanstack/react-query'
import { fetchUsers } from '../../services/users'
import type { AppUser } from '../../lib/types'

export default function AppLayout() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const usersQ = useQuery<AppUser[], Error>({
    queryKey: ['app-operators'],
    queryFn: () => fetchUsers({ active_only: true }),
  })

  const users = usersQ.data || []
  useEffect(() => {
    const user = users[0]
    if (user) {
      localStorage.setItem('current_operator', JSON.stringify({ id: user.id, name: user.name, role: user.role }))
    } else {
      localStorage.removeItem('current_operator')
    }
  }, [users])

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <Sidebar mobileOpen={mobileMenuOpen} onCloseMobile={() => setMobileMenuOpen(false)} />

      <Box
        component="main"
        sx={{
          flex: 1,
          minWidth: 0,
          px: { xs: 1, sm: 1.5 },
          py: { xs: 1, sm: 1.5 },
          width: '100%',
        }}
      >
        <TopMenuBar
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
        />
        <Outlet />
      </Box>
    </Box>
  )
}
