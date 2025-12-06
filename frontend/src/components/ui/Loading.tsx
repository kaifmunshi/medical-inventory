import { Box, CircularProgress } from '@mui/material'
export default function Loading() {
return (
<Box display="flex" alignItems="center" justifyContent="center" minHeight={200}>
<CircularProgress />
</Box>
)
}