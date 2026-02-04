// frontend/src/components/ui/Loading.tsx
import { Box, LinearProgress, Paper, Stack, Typography } from '@mui/material'

export default function Loading(props: { label?: string; hint?: string; minHeight?: number }) {
  const { label = 'Loading…', hint = 'Please wait a moment', minHeight = 220 } = props

  return (
    <Box display="flex" alignItems="center" justifyContent="center" minHeight={minHeight} px={2}>
      <Paper
        elevation={0}
        sx={{
          width: 'min(520px, 100%)',
          p: 2,
          borderRadius: 3,
          bgcolor: 'rgba(255,255,255,0.92)',
          boxShadow: '0 18px 60px rgba(0,0,0,0.08)',
        }}
      >
        <Stack spacing={1} alignItems="center">
          <Typography sx={{ fontWeight: 900 }}>{label}</Typography>
          <Typography variant="caption" color="text.secondary">
            {hint}
          </Typography>

          <LinearProgress sx={{ width: '100%', borderRadius: 999, height: 8, mt: 1 }} />

          {/* subtle skeleton shimmer bar */}
          <Box
            sx={{
              mt: 1.2,
              width: '100%',
              height: 10,
              borderRadius: 999,
              bgcolor: 'rgba(0,0,0,0.05)',
              position: 'relative',
              overflow: 'hidden',
              '&::after': {
                content: '""',
                position: 'absolute',
                inset: 0,
                width: '45%',
                borderRadius: 999,
                background:
                  'linear-gradient(90deg, rgba(0,0,0,0), rgba(0,0,0,0.08), rgba(0,0,0,0))',
                animation: 'loadingWave 1.1s ease-in-out infinite',
              },
              '@keyframes loadingWave': {
                '0%': { transform: 'translateX(-60%)' },
                '100%': { transform: 'translateX(220%)' },
              },
            }}
          />
        </Stack>
      </Paper>
    </Box>
  )
}
