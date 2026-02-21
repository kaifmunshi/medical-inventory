import { useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  TextField,
  Typography,
  IconButton,
} from '@mui/material'
import EditIcon from '@mui/icons-material/Edit'
import DeleteIcon from '@mui/icons-material/Delete'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createCustomer, deleteCustomer, fetchCustomers, updateCustomer } from '../../services/customers'
import type { Customer } from '../../lib/types'

function formatDate(dt?: string) {
  if (!dt) return '-'
  try {
    const d = new Date(dt)
    const datePart = d.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
    const timePart = d.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    })
    return `${datePart} | ${timePart}`
  } catch {
    return dt
  }
}

export default function CustomersPage() {
  const queryClient = useQueryClient()

  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [addressLine, setAddressLine] = useState('')
  const [nameError, setNameError] = useState('')
  const [editTarget, setEditTarget] = useState<Customer | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null)

  const customersQ = useQuery<Customer[], Error>({
    queryKey: ['customers', q],
    queryFn: () => fetchCustomers({ q: q.trim() || undefined }),
  })

  const createM = useMutation({
    mutationFn: createCustomer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] })
      setOpen(false)
      setName('')
      setPhone('')
      setAddressLine('')
      setNameError('')
    },
  })
  const updateM = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: { name: string; phone?: string; address_line?: string } }) =>
      updateCustomer(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] })
      setEditTarget(null)
      setName('')
      setPhone('')
      setAddressLine('')
      setNameError('')
    },
  })
  const deleteM = useMutation({
    mutationFn: (id: number) => deleteCustomer(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] })
      setDeleteTarget(null)
    },
  })

  function openAdd() {
    setName('')
    setPhone('')
    setAddressLine('')
    setNameError('')
    setOpen(true)
  }

  function openEdit(row: Customer) {
    setEditTarget(row)
    setOpen(false)
    setName(String(row.name || ''))
    setPhone(String(row.phone || ''))
    setAddressLine(String(row.address_line || ''))
    setNameError('')
  }

  function saveCustomer() {
    const nm = name.trim()
    if (!nm) {
      setNameError('Name is required')
      return
    }
    createM.mutate({
      name: nm,
      phone: phone.trim() || undefined,
      address_line: addressLine.trim() || undefined,
    })
  }
  function saveEditedCustomer() {
    if (!editTarget) return
    const nm = name.trim()
    if (!nm) {
      setNameError('Name is required')
      return
    }
    updateM.mutate({
      id: Number(editTarget.id),
      payload: {
        name: nm,
        phone: phone.trim() || undefined,
        address_line: addressLine.trim() || undefined,
      },
    })
  }

  function handlePhoneChange(raw: string) {
    const digits = raw.replace(/\D/g, '').slice(0, 10)
    setPhone(digits)
  }

  const rows = customersQ.data || []

  return (
    <Stack gap={2}>
      <Typography variant="h5">Customers</Typography>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} alignItems={{ sm: 'center' }}>
          <TextField
            label="Search (name / phone / address)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            fullWidth
          />
          <Button variant="contained" onClick={openAdd}>
            Add Customer
          </Button>
        </Stack>
      </Paper>

      {customersQ.isLoading && <Typography>Loading...</Typography>}
      {customersQ.isError && (
        <Typography color="error">Failed to load customers: {customersQ.error.message}</Typography>
      )}

      {!customersQ.isLoading && !customersQ.isError && (
        <Paper sx={{ p: 2 }}>
          <Box sx={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Address</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td>{r.phone || '-'}</td>
                    <td style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{r.address_line || '-'}</td>
                    <td>{formatDate(r.created_at)}</td>
                    <td>
                      <Stack direction="row" gap={1}>
                        <IconButton size="small" onClick={() => openEdit(r)} disabled={updateM.isPending}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                        <IconButton
                          size="small"
                          color="error"
                          onClick={() => setDeleteTarget(r)}
                          disabled={deleteM.isPending}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Stack>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      <Box p={2} color="text.secondary">
                        No customers yet.
                      </Box>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Box>
        </Paper>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add Customer</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2} mt={1}>
            <TextField
              label="Name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (nameError) setNameError('')
              }}
              required
              error={Boolean(nameError)}
              helperText={nameError || ''}
              fullWidth
            />
            <TextField
              label="Phone (optional)"
              value={phone}
              onChange={(e) => handlePhoneChange(e.target.value)}
              type="tel"
              inputProps={{ maxLength: 10, inputMode: 'numeric' }}
              helperText="Up to 10 digits"
              fullWidth
            />
            <TextField
              label="Address (optional)"
              value={addressLine}
              onChange={(e) => setAddressLine(e.target.value)}
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={saveCustomer} variant="contained" disabled={createM.isPending}>
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(editTarget)} onClose={() => setEditTarget(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Edit Customer</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2} mt={1}>
            <TextField
              label="Name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (nameError) setNameError('')
              }}
              required
              error={Boolean(nameError)}
              helperText={nameError || ''}
              fullWidth
            />
            <TextField
              label="Phone (optional)"
              value={phone}
              onChange={(e) => handlePhoneChange(e.target.value)}
              type="tel"
              inputProps={{ maxLength: 10, inputMode: 'numeric' }}
              helperText="Up to 10 digits"
              fullWidth
            />
            <TextField
              label="Address (optional)"
              value={addressLine}
              onChange={(e) => setAddressLine(e.target.value)}
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditTarget(null)}>Cancel</Button>
          <Button onClick={saveEditedCustomer} variant="contained" disabled={updateM.isPending}>
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete Customer</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2">
            {deleteTarget ? `Delete customer "${deleteTarget.name}"?` : ''}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            disabled={deleteM.isPending}
            onClick={() => {
              if (!deleteTarget) return
              deleteM.mutate(deleteTarget.id)
            }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
