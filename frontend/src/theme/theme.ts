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
    h5: { fontWeight: 600, fontSize: '1.22rem' },
    h6: { fontWeight: 600, fontSize: '1rem' },
    body1: { fontSize: 14 },
    body2: { fontSize: 13 },
    button: { fontSize: 13, fontWeight: 600, textTransform: 'none' },
  },
  shape: { borderRadius: 14 },
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
        'input[type=number]::-webkit-outer-spin-button, input[type=number]::-webkit-inner-spin-button': {
          WebkitAppearance: 'none !important',
          margin: 0,
        },
        'input[type=number]': {
          MozAppearance: 'textfield !important',
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          borderRadius: 16,
          boxShadow: '0 12px 28px rgba(0,0,0,0.045)',
        },
      },
    },
    MuiButton: {
      defaultProps: {
        size: 'small',
        disableElevation: true,
      },
      styleOverrides: {
        root: {
          borderRadius: 10,
          minHeight: 32,
          paddingInline: 12,
        },
      },
    },
    MuiIconButton: {
      defaultProps: {
        size: 'small',
      },
      styleOverrides: {
        root: {
          borderRadius: 10,
        },
      },
    },
    MuiChip: {
      defaultProps: {
        size: 'small',
      },
      styleOverrides: {
        root: {
          fontSize: 12,
          height: 26,
        },
      },
    },
    MuiTextField: {
      defaultProps: {
        size: 'small',
      },
    },
    MuiFormControl: {
      defaultProps: {
        size: 'small',
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
