// frontend/src/pages/RequestedItems/index.tsx
import { useState } from 'react'
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Paper,
  Stack,
} from '@mui/material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchRequestedItems,
  createRequestedItem,
  toggleRequestedItemAvailability,
} from '../../services/requestedItems'
import type { RequestedItem } from '../../lib/types'

function formatDate(dt?: string) {
  if (!dt) return ''
  try {
    const d = new Date(dt)
    return d.toLocaleString()
  } catch {
    return dt
  }
}

export default function RequestedItemsPage() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [customerName, setCustomerName] = useState('')
  const [mobile, setMobile] = useState('')
  const [mobileError, setMobileError] = useState('') // 👈 NEW
  const [itemName, setItemName] = useState('')
  const [notes, setNotes] = useState('')

  const { data, isLoading, isError, error } = useQuery<RequestedItem[], Error>({
    queryKey: ['requested-items'],
    queryFn: fetchRequestedItems,
  })

  const createMutation = useMutation({
    mutationFn: createRequestedItem,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['requested-items'] })
      setOpen(false)
      setCustomerName('')
      setMobile('')
      setMobileError('')
      setItemName('')
      setNotes('')
    },
  })

  const toggleMutation = useMutation({
    mutationFn: ({
      id,
      is_available,
    }: {
      id: number
      is_available: boolean
    }) => toggleRequestedItemAvailability(id, is_available),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['requested-items'] })
    },
  })

  // ---------- Handlers ----------

  const handleSubmit = () => {
    if (!itemName.trim()) {
      return
    }
    if (mobile.length !== 10) {
      setMobileError('Mobile number must be exactly 10 digits')
      return
    }

    createMutation.mutate({
      customer_name: customerName.trim() || undefined,
      mobile: mobile, // already digits-only
      item_name: itemName.trim(),
      notes: notes.trim() || undefined,
    })
  }

  // Mobile input change: keep only digits & max 10
  const handleMobileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    const digits = raw.replace(/\D/g, '').slice(0, 10)
    setMobile(digits)

    if (!digits) {
      setMobileError('')
    } else if (digits.length !== 10) {
      setMobileError('Mobile number must be exactly 10 digits')
    } else {
      setMobileError('')
    }
  }

  const rows = data || []

  return (
    <Box sx={{ p: 3 }}>
      <Stack direction="row" justifyContent="space-between" mb={3}>
        <Box>
          <Typography variant="h5" fontWeight={600}>
            Requested Items
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Simple list of items customers asked for and whether they are now
            available.
          </Typography>
        </Box>

        <Button variant="contained" onClick={() => setOpen(true)}>
          Add Request
        </Button>
      </Stack>

      {isLoading && <Typography>Loading...</Typography>}
      {isError && (
        <Typography color="error">
          Failed to load requested items: {error.message}
        </Typography>
      )}

      {!isLoading && !isError && (
        <Paper sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Available</TableCell>
                <TableCell>Item Name</TableCell>
                <TableCell>Customer Name</TableCell>
                <TableCell>Mobile</TableCell>
                <TableCell>Notes</TableCell>
                <TableCell>Created</TableCell>
                <TableCell align="center">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(rows ?? []).map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Checkbox
                      checked={row.is_available}
                      onChange={(e) =>
                        toggleMutation.mutate({
                          id: row.id,
                          is_available: e.target.checked,
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>{row.item_name}</TableCell>
                  <TableCell>{row.customer_name || '-'}</TableCell>
                  <TableCell>{row.mobile}</TableCell>
                  <TableCell>{row.notes || '-'}</TableCell>
                  <TableCell>{formatDate(row.created_at)}</TableCell>
                </TableRow>
              ))}
              {rows && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7}>
                    <Typography align="center" sx={{ py: 2 }}>
                      No requested items yet.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Paper>
      )}

      {/* Add Request dialog */}
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add Requested Item</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <TextField
              label="Item Name"
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
              required
              fullWidth
            />
            <TextField
              label="Customer Name"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              fullWidth
            />
            <TextField
              label="Mobile"
              value={mobile}
              onChange={handleMobileChange}
              required
              fullWidth
              type="tel"
              inputProps={{
                maxLength: 10,
                inputMode: 'numeric',
              }}
              error={Boolean(mobileError)}
              helperText={mobileError || 'Enter 10-digit mobile number'}
            />
            <TextField
              label="Notes (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              fullWidth
              multiline
              minRows={2}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            variant="contained"
            disabled={createMutation.isPending}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>

    </Box>
  )
}
