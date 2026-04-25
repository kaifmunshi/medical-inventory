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
} from '@mui/material'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { createParty, fetchParties, updateParty } from '../../services/parties'
import type { Party } from '../../lib/types'
import { useToast } from '../../components/ui/Toaster'

function formatDate(dt?: string) {
  if (!dt) return '-'
  try {
    return new Date(dt).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    })
  } catch {
    return dt
  }
}

export default function SuppliersPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Party | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [addressLine, setAddressLine] = useState('')
  const [gstNumber, setGstNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [openingBalance, setOpeningBalance] = useState('0')

  const suppliersQ = useQuery<Party[], Error>({
    queryKey: ['suppliers', q],
    queryFn: () => fetchParties({ q: q.trim() || undefined, party_group: 'SUNDRY_CREDITOR', is_active: true }),
  })

  const createM = useMutation({
    mutationFn: createParty,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      resetForm()
      setOpen(false)
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to create supplier'), 'error'),
  })

  const updateM = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: any }) => updateParty(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      resetForm()
      setEditTarget(null)
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to update supplier'), 'error'),
  })

  function resetForm() {
    setName('')
    setPhone('')
    setAddressLine('')
    setGstNumber('')
    setNotes('')
    setOpeningBalance('0')
  }

  function openAdd() {
    resetForm()
    setEditTarget(null)
    setOpen(true)
  }

  function resetFilters() {
    setQ('')
  }

  function openEdit(row: Party) {
    setEditTarget(row)
    setOpen(false)
    setName(row.name || '')
    setPhone(row.phone || '')
    setAddressLine(row.address_line || '')
    setGstNumber(row.gst_number || '')
    setNotes(row.notes || '')
    setOpeningBalance(String(row.opening_balance ?? 0))
  }

  function saveCreate() {
    if (!name.trim()) {
      toast.push('Supplier name is required', 'error')
      return
    }
    createM.mutate({
      name: name.trim(),
      party_group: 'SUNDRY_CREDITOR',
      phone: phone.trim() || undefined,
      address_line: addressLine.trim() || undefined,
      gst_number: gstNumber.trim() || undefined,
      notes: notes.trim() || undefined,
      opening_balance: Number(openingBalance || 0),
      opening_balance_type: 'CR',
    })
  }

  function saveEdit() {
    if (!editTarget) return
    if (!name.trim()) {
      toast.push('Supplier name is required', 'error')
      return
    }
    updateM.mutate({
      id: Number(editTarget.id),
      payload: {
        name: name.trim(),
        party_group: 'SUNDRY_CREDITOR',
        phone: phone.trim() || undefined,
        address_line: addressLine.trim() || undefined,
        gst_number: gstNumber.trim() || undefined,
        notes: notes.trim() || undefined,
        opening_balance: Number(openingBalance || 0),
        opening_balance_type: 'CR',
      },
    })
  }

  const rows = suppliersQ.data || []

  return (
    <Stack gap={2}>
      <Typography variant="h5">Suppliers</Typography>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} alignItems={{ sm: 'center' }}>
          <TextField
            label="Search suppliers"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            fullWidth
          />
          <Button variant="outlined" onClick={resetFilters}>Reset Filters</Button>
          <Button variant="contained" onClick={openAdd}>Add Supplier</Button>
          <Button variant="outlined" onClick={() => navigate('/purchases?new=1')}>New Purchase</Button>
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>GST</th>
                <th>Address</th>
                <th>Opening</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} onDoubleClick={() => openEdit(row)} style={{ cursor: 'pointer' }}>
                  <td>{row.name}</td>
                  <td>{row.phone || '-'}</td>
                  <td>{row.gst_number || '-'}</td>
                  <td style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{row.address_line || '-'}</td>
                  <td>{Number(row.opening_balance || 0).toFixed(2)}</td>
                  <td>{formatDate(row.created_at)}</td>
                  <td>
                    <Stack direction="row" gap={1}>
                      <Button size="small" variant="outlined" onClick={() => navigate(`/purchases?new=1&supplier_id=${row.id}`)}>
                        New Purchase
                      </Button>
                      <Button size="small" onClick={() => navigate(`/supplier-ledger?supplier_id=${row.id}`)}>
                        Ledger
                      </Button>
                    </Stack>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <Box p={2} color="text.secondary">No suppliers yet.</Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Add Supplier</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2} mt={1}>
            <TextField label="Supplier Name" value={name} onChange={(e) => setName(e.target.value)} required />
            <TextField label="Phone" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))} />
            <TextField label="GST Number" value={gstNumber} onChange={(e) => setGstNumber(e.target.value)} />
            <TextField label="Address" value={addressLine} onChange={(e) => setAddressLine(e.target.value)} multiline minRows={2} />
            <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} multiline minRows={2} />
            <TextField label="Opening Balance" type="number" value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveCreate} disabled={createM.isPending}>Save</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(editTarget)} onClose={() => setEditTarget(null)} fullWidth maxWidth="sm">
        <DialogTitle>Edit Supplier</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2} mt={1}>
            <TextField label="Supplier Name" value={name} onChange={(e) => setName(e.target.value)} required />
            <TextField label="Phone" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))} />
            <TextField label="GST Number" value={gstNumber} onChange={(e) => setGstNumber(e.target.value)} />
            <TextField label="Address" value={addressLine} onChange={(e) => setAddressLine(e.target.value)} multiline minRows={2} />
            <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} multiline minRows={2} />
            <TextField label="Opening Balance" type="number" value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditTarget(null)}>Cancel</Button>
          <Button variant="contained" onClick={saveEdit} disabled={updateM.isPending}>Update</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
