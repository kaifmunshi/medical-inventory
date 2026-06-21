import React from 'react'
import { Box, Button, Card, CardContent, Typography } from '@mui/material'
import ErrorIcon from '@mui/icons-material/Error'

interface ErrorBoundaryProps {
  children: React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error) {
    console.error('Error Boundary caught:', error)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
    window.location.href = '/'
  }

  render() {
    if (this.state.hasError) {
      return (
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: '100vh',
            backgroundColor: '#f5f5f5',
            padding: 2,
          }}
        >
          <Card sx={{ maxWidth: 500, width: '100%' }}>
            <CardContent sx={{ textAlign: 'center' }}>
              <ErrorIcon sx={{ fontSize: 64, color: 'error.main', marginBottom: 2 }} />
              <Typography variant="h5" gutterBottom>
                Something went wrong
              </Typography>
              <Typography variant="body2" color="textSecondary" sx={{ marginBottom: 3 }}>
                {this.state.error?.message || 'An unexpected error occurred. Please refresh the page.'}
              </Typography>
              <Button variant="contained" onClick={this.handleReset}>
                Go to Dashboard
              </Button>
            </CardContent>
          </Card>
        </Box>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
