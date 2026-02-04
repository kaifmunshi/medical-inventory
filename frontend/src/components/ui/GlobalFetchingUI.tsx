// frontend/src/components/ui/GlobalFetchingUI.tsx
import { useEffect, useMemo, useState } from 'react'
import { useIsFetching, useIsMutating } from '@tanstack/react-query'
import { Backdrop, LinearProgress, Paper, Stack, Typography } from '@mui/material'

export default function GlobalFetchingUI() {
  const fetching = useIsFetching()
  const mutating = useIsMutating()

  const busyCount = fetching + mutating
  const isBusy = busyCount > 0

  // ✅ prevent flicker: only show overlay if busy for > 500ms
  const [showOverlay, setShowOverlay] = useState(false)

  useEffect(() => {
    if (!isBusy) {
      setShowOverlay(false)
      return
    }
    const t = window.setTimeout(() => setShowOverlay(true), 500)
    return () => window.clearTimeout(t)
  }, [isBusy])

  const label = useMemo(() => {
    if (mutating > 0) return 'Saving…'
    return 'Loading…'
  }, [mutating])

  return (
    <>
      {/* ✅ Top slim bar: feels alive but not intrusive */}
      {isBusy && (
        <LinearProgress
          sx={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 2000,
            height: 3,
            borderRadius: 0,
            opacity: 0.9,
          }}
        />
      )}

      {/* ✅ Soft overlay only for slow loads */}
      <Backdrop
        open={showOverlay}
        sx={{
          zIndex: 1900,
          backdropFilter: 'blur(2px)',
          backgroundColor: 'rgba(255,255,255,0.55)',
        }}
      >
        <Paper
          elevation={0}
          sx={{
            px: 2.25,
            py: 1.75,
            borderRadius: 3,
            bgcolor: 'rgba(255,255,255,0.92)',
            boxShadow: '0 20px 70px rgba(0,0,0,0.10)',
            minWidth: 280,
          }}
        >
          <Stack spacing={0.6} alignItems="center">
            <Typography sx={{ fontWeight: 900 }}>{label}</Typography>
            <Typography variant="caption" color="text.secondary">
              Please wait… data is syncing
            </Typography>
            <LinearProgress sx={{ width: '100%', mt: 0.8, borderRadius: 999, height: 7 }} />
          </Stack>
        </Paper>
      </Backdrop>
    </>
  )
}
