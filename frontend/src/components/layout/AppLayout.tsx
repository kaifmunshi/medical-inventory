import { Box } from '@mui/material'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'

export default function AppLayout() {
  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <Sidebar />

      {/* Main content */}
      <Box
        component="main"
        sx={{
          flex: 1,
          px: { xs: 2, md: 3 },
          py: { xs: 2, md: 3 },
          maxWidth: '1200px',
          width: '100%',
          mx: 'auto',
        }}
      >
        <Outlet />
      </Box>
    </Box>
  )
}
