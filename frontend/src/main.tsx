// frontend\src\main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider, CssBaseline } from '@mui/material'
import App from './App'
import theme from './theme/theme'
import './styles.css'


const client = new QueryClient()


ReactDOM.createRoot(document.getElementById('root')!).render(
<React.StrictMode>
<QueryClientProvider client={client}>
<ThemeProvider theme={theme}>
<CssBaseline />
<BrowserRouter>
<App />
</BrowserRouter>
</ThemeProvider>
</QueryClientProvider>
</React.StrictMode>
)