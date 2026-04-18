import { Box, Chip, Grid, Paper, Stack, Typography } from '@mui/material'
import { appMenuGroups } from '../../components/layout/menuConfig'

function shortcutGroups() {
  return appMenuGroups
    .map((group) => ({
      ...group,
      shortcuts: group.items.filter((item) => item.shortcut),
    }))
    .filter((group) => group.shortcuts.length > 0)
}

function keyCaps(shortcut: string) {
  return shortcut.split('+').map((part) => part.trim())
}

export default function ShortcutsPage() {
  const groups = shortcutGroups()
  const totalShortcuts = groups.reduce((sum, group) => sum + group.shortcuts.length, 0)

  return (
    <Stack gap={2.5}>
      <Paper
        sx={{
          p: { xs: 2.75, md: 4 },
          position: 'relative',
          overflow: 'hidden',
          color: 'white',
          background:
            'linear-gradient(145deg, rgba(10,45,33,0.98) 0%, rgba(17,88,62,0.95) 52%, rgba(28,111,78,0.92) 100%)',
        }}
      >
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(circle at 88% 18%, rgba(216,164,87,0.30) 0%, rgba(216,164,87,0) 28%),' +
              'radial-gradient(circle at 8% 92%, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 24%)',
            pointerEvents: 'none',
          }}
        />

        <Stack gap={1.5} sx={{ position: 'relative' }}>
          <Typography variant="overline" sx={{ letterSpacing: 1.5, opacity: 0.82 }}>
            Read-Only Guide
          </Typography>
          <Typography variant="h4" sx={{ fontWeight: 700, lineHeight: 1.05 }}>
            Keyboard Shortcuts
          </Typography>
          <Typography sx={{ maxWidth: 760, opacity: 0.88 }}>
            A clean reference for the live navigation shortcuts available across the app. This page is generated from the same
            shared menu configuration used by the navigation, so it stays in sync automatically.
          </Typography>

          <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.2} flexWrap="wrap">
            <Chip label={`${groups.length} sections`} sx={{ bgcolor: 'rgba(255,255,255,0.14)', color: 'white', fontWeight: 700 }} />
            <Chip label={`${totalShortcuts} shortcuts`} sx={{ bgcolor: 'rgba(255,255,255,0.14)', color: 'white', fontWeight: 700 }} />
            <Chip label="Global Alt shortcuts" sx={{ bgcolor: 'rgba(216,164,87,0.22)', color: 'white', fontWeight: 700 }} />
          </Stack>
        </Stack>
      </Paper>

      <Grid container spacing={2}>
        {groups.map((group) => (
          <Grid item xs={12} lg={6} key={group.key}>
            <Paper
              sx={{
                p: 0,
                height: '100%',
                overflow: 'hidden',
                border: '1px solid rgba(13,51,36,0.08)',
                background:
                  'linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(247,250,246,0.96) 100%)',
              }}
            >
              <Box
                sx={{
                  px: 2.2,
                  py: 1.8,
                  borderBottom: '1px solid rgba(13,51,36,0.08)',
                  background:
                    'linear-gradient(90deg, rgba(31,107,74,0.08) 0%, rgba(216,164,87,0.10) 100%)',
                }}
              >
                <Stack direction="row" gap={1.1} alignItems="center">
                  <Box
                    sx={{
                      width: 38,
                      height: 38,
                      display: 'grid',
                      placeItems: 'center',
                      borderRadius: 2.5,
                      bgcolor: 'rgba(31,107,74,0.12)',
                      color: 'primary.main',
                    }}
                  >
                    {group.icon}
                  </Box>
                  <Box>
                    <Typography variant="h6" sx={{ fontWeight: 700, lineHeight: 1.1 }}>
                      {group.label}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {group.hint}
                    </Typography>
                  </Box>
                </Stack>
              </Box>

              <Stack gap={1.1} sx={{ p: 1.5 }}>
                {group.shortcuts.map((item) => (
                  <Box
                    key={item.to}
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: { xs: '1fr', sm: '1.1fr auto' },
                      gap: 1.4,
                      alignItems: 'center',
                      px: 1.4,
                      py: 1.3,
                      borderRadius: 2.5,
                      border: '1px solid rgba(13,51,36,0.08)',
                      background: item.to === '/shortcuts'
                        ? 'linear-gradient(135deg, rgba(216,164,87,0.10) 0%, rgba(31,107,74,0.05) 100%)'
                        : 'rgba(255,255,255,0.75)',
                    }}
                  >
                    <Stack direction="row" gap={1.2} alignItems="flex-start">
                      <Box
                        sx={{
                          width: 34,
                          height: 34,
                          display: 'grid',
                          placeItems: 'center',
                          borderRadius: 2,
                          bgcolor: 'rgba(31,107,74,0.08)',
                          color: 'primary.main',
                          flexShrink: 0,
                        }}
                      >
                        {item.icon}
                      </Box>
                      <Box>
                        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                          {item.label}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {item.hint}
                        </Typography>
                      </Box>
                    </Stack>

                    <Stack direction="row" gap={0.6} justifyContent={{ xs: 'flex-start', sm: 'flex-end' }} flexWrap="wrap">
                      {keyCaps(item.shortcut as string).map((part) => (
                        <Box
                          key={`${item.to}-${part}`}
                          sx={{
                            minWidth: 38,
                            px: 1,
                            py: 0.65,
                            borderRadius: 1.8,
                            textAlign: 'center',
                            fontSize: 12,
                            fontWeight: 800,
                            letterSpacing: 0.3,
                            color: 'primary.main',
                            bgcolor: 'rgba(31,107,74,0.09)',
                            border: '1px solid rgba(31,107,74,0.14)',
                            boxShadow: 'inset 0 -2px 0 rgba(13,51,36,0.06)',
                          }}
                        >
                          {part}
                        </Box>
                      ))}
                    </Stack>
                  </Box>
                ))}
              </Stack>
            </Paper>
          </Grid>
        ))}
      </Grid>
    </Stack>
  )
}
