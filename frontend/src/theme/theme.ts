import { createTheme } from '@mui/material/styles'

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#1f6b4a',          // herbal green
    },
    secondary: {
      main: '#d8a457',          // warm ayurvedic gold
    },
    background: {
      default: '#f4f7f4',
      paper: '#ffffff',
    },
  },
  typography: {
    fontFamily: [
      'system-ui',
      '-apple-system',
      'BlinkMacSystemFont',
      '"Segoe UI"',
      'sans-serif',
    ].join(','),
    h5: { fontWeight: 600 },
    h6: { fontWeight: 600 },
    body1: { fontSize: 14.5 },
  },
  shape: { borderRadius: 16 },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          background:
            'radial-gradient(circle at 0 0, rgba(31,107,74,0.10) 0, transparent 55%),' +
            'radial-gradient(circle at 100% 100%, rgba(216,164,87,0.18) 0, transparent 55%),' +
            'linear-gradient(135deg, #f5fbf7 0%, #fdfaf3 100%)',
          backgroundAttachment: 'fixed',
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          borderRadius: 18,
          boxShadow: '0 18px 40px rgba(0,0,0,0.05)',
        },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: 10 },
      },
    },
    MuiSnackbar: {
      styleOverrides: {
        root: { zIndex: 1301 }, // above drawers
      },
    },
  },
})

export default theme
