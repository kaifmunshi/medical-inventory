// frontend/src/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider, CssBaseline } from '@mui/material'
import App from './App'
import theme from './theme/theme'
import './styles.css'
import DisableNumberInputScroll from './components/ui/DisableNumberInputScroll'
import EnterKeyDefaultAction from './components/ui/EnterKeyDefaultAction'

const client = new QueryClient({
  defaultOptions: {
    queries: {
      // ✅ feels smoother on slow networks
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      // Large ledger/report responses should not accumulate as users move
      // through many date ranges during a long-running counter session.
      gcTime: 60_000,
      retry: 1,
    },
  },
})

// Older client installations may have registered a service worker or retained
// an application cache. This app is local-first and ships hashed assets, so
// keeping those legacy caches can only serve an obsolete frontend after update.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((registration) => void registration.unregister())
  })
}
if ('caches' in window) {
  void caches.keys().then((keys) => {
    keys.forEach((key) => void caches.delete(key))
  })
}

function Root() {
  return (
    <>
      <DisableNumberInputScroll />
      <EnterKeyDefaultAction />
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
