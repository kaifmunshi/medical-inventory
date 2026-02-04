// frontend/src/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider, CssBaseline } from '@mui/material'
import App from './App'
import theme from './theme/theme'
import './styles.css'
import GlobalFetchingUI from './components/ui/GlobalFetchingUI'

const client = new QueryClient({
  defaultOptions: {
    queries: {
      // ✅ feels smoother on slow networks
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

function Root() {
  return (
    <>
      <GlobalFetchingUI />
      <App />
    </>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <BrowserRouter>
          <Root />
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>
)

// ✅ remove splash once React has mounted
const splash = document.getElementById('app-splash')
if (splash) splash.remove()
