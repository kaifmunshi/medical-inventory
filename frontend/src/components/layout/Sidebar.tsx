// frontend/src/components/layout/Sidebar.tsx
import {
  Box,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
} from '@mui/material'
import {
  Inventory2,
  PointOfSale,
  AssignmentReturn,
  SwapHoriz,
  BarChart,
  Dashboard,
  PlaylistAddCheck,
  CreditCard, // ✅ NEW ICON
  AccountBalanceWallet,
} from '@mui/icons-material'
import { NavLink, useLocation } from 'react-router-dom'

const links = [
  { to: '/', label: 'Dashboard', icon: <Dashboard /> },
  { to: '/inventory', label: 'Inventory', icon: <Inventory2 /> },
  { to: '/billing', label: 'Billing', icon: <PointOfSale /> },
  { to: '/returns', label: 'Returns', icon: <AssignmentReturn /> },
  { to: '/exchange', label: 'Exchange', icon: <SwapHoriz /> },
  { to: '/reports', label: 'Reports', icon: <BarChart /> },
  { to: '/cashbook', label: 'Cashbook', icon: <AccountBalanceWallet /> },

  // ✅ NEW
  { to: '/credit-bills', label: 'Credit Bills', icon: <CreditCard /> },

  { to: '/requested-items', label: 'Requested Items', icon: <PlaylistAddCheck /> },
]

export default function Sidebar() {
  const { pathname } = useLocation()
  const year = new Date().getFullYear()

  return (
    <Box
      component="aside"
      sx={{
        width: 240,
        flexShrink: 0,
        display: { xs: 'none', sm: 'flex' },
        flexDirection: 'column',
        py: 3,
        px: 2,
        gap: 2,
        bgcolor: 'primary.main',
        background:
          'linear-gradient(180deg, #145c3b 0%, #0d3324 45%, #082018 100%)',
        color: 'rgba(255,255,255,0.94)',
        boxShadow: '4px 0 22px rgba(0,0,0,0.18)',
      }}
    >
      <Box sx={{ mb: 1 }}>
        <Typography variant="h6" sx={{ fontWeight: 700, letterSpacing: 0.4 }}>
          Good Luck
        </Typography>
        <Typography variant="body2" sx={{ opacity: 0.8 }}>
          Ayurvedic and Unani Store
        </Typography>
      </Box>

      <List sx={{ mt: 1 }}>
        {links.map((link) => {
          const active = pathname === link.to
          return (
            <ListItemButton
              key={link.to}
              component={NavLink}
              to={link.to}
              sx={{
                mb: 0.5,
                borderRadius: 2,
                px: 2,
                '& .MuiListItemIcon-root': {
                  minWidth: 32,
                  color: 'inherit',
                  opacity: active ? 1 : 0.8,
                },
                '& .MuiListItemText-primary': {
                  fontSize: 14,
                  fontWeight: active ? 600 : 500,
                },
                '&:hover': {
                  bgcolor: 'rgba(255,255,255,0.12)',
                },
                ...(active && {
                  bgcolor: 'rgba(255,255,255,0.18)',
                }),
              }}
            >
              <ListItemIcon>{link.icon}</ListItemIcon>
              <ListItemText primary={link.label} />
            </ListItemButton>
          )
        })}
      </List>

      <Box sx={{ flexGrow: 1 }} />

      <Typography variant="caption" sx={{ opacity: 0.7 }}>
        © {year} Good Luck Store
      </Typography>
    </Box>
  )
}
