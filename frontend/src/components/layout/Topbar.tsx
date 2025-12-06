import { Box, Paper, Typography } from '@mui/material'

export default function Topbar() {
  const now = new Date().toLocaleString()

  return (
    <Box
      sx={{
        px: { xs: 2, md: 3 },
        pt: { xs: 2, md: 3 },
        pb: 1,
      }}
    >
      <Box sx={{ maxWidth: '1200px', mx: 'auto' }}>
        <Paper
          elevation={0}
          sx={{
            px: { xs: 2, md: 3 },
            py: { xs: 1.5, md: 2 },
            display: 'flex',
            alignItems: { xs: 'flex-start', sm: 'center' },
            flexDirection: { xs: 'column', sm: 'row' },
            gap: 0.5,
            borderRadius: 3,                    // smaller, clean radius
            bgcolor: 'rgba(255,255,255,0.96)',
            boxShadow: '0 18px 40px rgba(0,0,0,0.06)',
          }}
        >
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Medical Inventory
            </Typography>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ display: { xs: 'none', sm: 'block' } }}
            >
              Simple billing &amp; stock for Ayurvedic medicines
            </Typography>
          </Box>

          <Box sx={{ flexGrow: 1 }} />

          <Typography
            variant="body2"
            color="text.secondary"
            sx={{
              fontSize: 12,
              whiteSpace: 'nowrap',
              mt: { xs: 0.5, sm: 0 },
            }}
          >
            {now}
          </Typography>
        </Paper>
      </Box>
    </Box>
  )
}
