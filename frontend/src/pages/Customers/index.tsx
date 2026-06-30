import { useState, type MouseEvent } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Popover,
  Stack,
  TextField,
  Typography,
  IconButton,
} from '@mui/material'
import EditIcon from '@mui/icons-material/Edit'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import MergeTypeIcon from '@mui/icons-material/MergeType'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createCustomer, fetchCustomers, getCustomerSummary, mergeCustomers, updateCustomer, type CustomerSummary } from '../../services/customers'
import type { Customer } from '../../lib/types'
import { useToast } from '../../components/ui/Toaster'
import { useNavigate } from 'react-router-dom'

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

function money(value?: number | string | null) {
  return Number(value || 0).toFixed(2)
}

export default function CustomersPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useToast()

  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [addressLine, setAddressLine] = useState('')
  const [nameError, setNameError] = useState('')
  const [editTarget, setEditTarget] = useState<Customer | null>(null)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [keepCustomer, setKeepCustomer] = useState<Customer | null>(null)
  const [removeCustomer, setRemoveCustomer] = useState<Customer | null>(null)
  const [previewAnchor, setPreviewAnchor] = useState<HTMLElement | null>(null)
  const [previewSide, setPreviewSide] = useState<'keep' | 'remove' | null>(null)

  const customersQ = useQuery<Customer[], Error>({
    queryKey: ['customers', q],
    queryFn: () => fetchCustomers({ q: q.trim() || undefined }),
  })
  const keepSummaryQ = useQuery<CustomerSummary, Error>({
    queryKey: ['customer-summary', keepCustomer?.id],
    queryFn: () => getCustomerSummary(Number(keepCustomer?.id)),
    enabled: Boolean(keepCustomer?.id),
  })
  const removeSummaryQ = useQuery<CustomerSummary, Error>({
    queryKey: ['customer-summary', removeCustomer?.id],
    queryFn: () => getCustomerSummary(Number(removeCustomer?.id)),
    enabled: Boolean(removeCustomer?.id),
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
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Failed to create customer'
      toast.push(String(msg), 'error')
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
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Failed to update customer'
      toast.push(String(msg), 'error')
    },
  })
  const mergeM = useMutation({
    mutationFn: ({ keepId, removeId }: { keepId: number; removeId: number }) => mergeCustomers(keepId, removeId),
    onSuccess: (result) => {
      toast.push(`Customers clubbed. ${result.moved_bills} bills moved.`, 'success')
      queryClient.invalidateQueries({ queryKey: ['customers'] })
      queryClient.invalidateQueries({ queryKey: ['customer-summary'] })
      queryClient.invalidateQueries({ queryKey: ['customer-ledger'] })
      queryClient.invalidateQueries({ queryKey: ['parties'] })
      queryClient.invalidateQueries({ queryKey: ['debtors'] })
      setMergeOpen(false)
      setKeepCustomer(null)
      setRemoveCustomer(null)
      setPreviewAnchor(null)
      setPreviewSide(null)
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Failed to club customers'
      toast.push(String(msg), 'error')
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

  function openMerge() {
    setOpen(false)
    setEditTarget(null)
    setKeepCustomer(null)
    setRemoveCustomer(null)
    setPreviewAnchor(null)
    setPreviewSide(null)
    setMergeOpen(true)
  }

  function saveMerge() {
    if (!keepCustomer || !removeCustomer) {
      toast.push('Select both customers first', 'error')
      return
    }
    if (Number(keepCustomer.id) === Number(removeCustomer.id)) {
      toast.push('Keep and remove customers must be different', 'error')
      return
    }
    mergeM.mutate({ keepId: Number(keepCustomer.id), removeId: Number(removeCustomer.id) })
  }

  function beginPreview(event: MouseEvent<HTMLElement>, side: 'keep' | 'remove') {
    setPreviewAnchor(event.currentTarget)
    setPreviewSide(side)
  }

  function closePreview() {
    setPreviewAnchor(null)
    setPreviewSide(null)
  }

  function previewContent(summary?: CustomerSummary, loading = false) {
    if (loading) return <Typography variant="body2">Loading records...</Typography>
    if (!summary) return <Typography variant="body2" color="text.secondary">Select a customer to preview records.</Typography>
    const bills = summary.bills || []
    return (
      <Stack gap={1} sx={{ width: 360, maxWidth: '80vw' }}>
        <Box>
          <Typography fontWeight={800}>{summary.customer.name}</Typography>
          <Typography variant="caption" color="text.secondary">
            {summary.customer.phone || 'No phone'}{summary.customer.address_line ? ` | ${summary.customer.address_line}` : ''}
          </Typography>
        </Box>
        <Stack direction="row" gap={1} flexWrap="wrap">
          <Typography variant="caption">Bills: {summary.totals.total_bills}</Typography>
          <Typography variant="caption">Sales: Rs {money(summary.totals.total_sales)}</Typography>
          <Typography variant="caption">Pending: Rs {money(summary.totals.total_pending)}</Typography>
        </Stack>
        <Box sx={{ maxHeight: 220, overflow: 'auto', borderTop: '1px solid', borderColor: 'divider', pt: 1 }}>
          {bills.slice(0, 6).map((bill: any) => (
            <Stack key={bill.id} direction="row" justifyContent="space-between" gap={1} sx={{ py: 0.5 }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" fontWeight={700}>Bill #{bill.id}</Typography>
                <Typography variant="caption" color="text.secondary">{formatDate(bill.date_time)}</Typography>
              </Box>
              <Typography variant="body2">Rs {money(bill.total_amount)}</Typography>
            </Stack>
          ))}
          {bills.length === 0 ? <Typography variant="caption" color="text.secondary">No bill records.</Typography> : null}
          {bills.length > 6 ? <Typography variant="caption" color="text.secondary">+{bills.length - 6} more</Typography> : null}
        </Box>
      </Stack>
    )
  }

  const rows = customersQ.data || []
  const mergeOptions = rows
  const previewSummary = previewSide === 'keep' ? keepSummaryQ.data : previewSide === 'remove' ? removeSummaryQ.data : undefined
  const previewLoading = previewSide === 'keep' ? keepSummaryQ.isLoading : previewSide === 'remove' ? removeSummaryQ.isLoading : false

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
          <Button variant="outlined" startIcon={<MergeTypeIcon />} onClick={openMerge}>
            Club
          </Button>
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
                        <Button size="small" onClick={() => navigate(`/customer-ledger?customer_id=${r.id}`)}>
                          Ledger
                        </Button>
                        <IconButton
                          size="small"
                          color="primary"
                          onClick={() => navigate(`/customers/${r.id}/summary`)}
                          title="Open Summary"
                        >
                          <ReceiptLongIcon fontSize="small" />
                        </IconButton>
                        <IconButton size="small" onClick={() => openEdit(r)} disabled={updateM.isPending}>
                          <EditIcon fontSize="small" />
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

      <Dialog open={mergeOpen} onClose={() => setMergeOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>Club Customers</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2} mt={1}>
            <Alert severity="info">
              Keep customer remains. Remove customer disappears after bills, receipts, and ledger links move to Keep.
            </Alert>
            <Stack direction={{ xs: 'column', md: 'row' }} gap={2}>
              <Paper
                variant="outlined"
                sx={{ p: 2, flex: 1 }}
                onMouseEnter={(e) => beginPreview(e, 'keep')}
                onMouseLeave={closePreview}
              >
                <Stack gap={1.25}>
                  <Typography variant="subtitle2" fontWeight={800}>Keep Customer</Typography>
                  <Autocomplete
                    options={mergeOptions}
                    value={keepCustomer}
                    onChange={(_, value) => setKeepCustomer(value)}
                    getOptionLabel={(option) => `${option.name}${option.phone ? ` | ${option.phone}` : ''}`}
                    isOptionEqualToValue={(option, value) => Number(option.id) === Number(value.id)}
                    renderInput={(params) => <TextField {...params} label="Final customer" />}
                  />
                  <Typography variant="caption" color="text.secondary">
                    Hover here to preview records that will remain.
                  </Typography>
                </Stack>
              </Paper>

              <Paper
                variant="outlined"
                sx={{ p: 2, flex: 1 }}
                onMouseEnter={(e) => beginPreview(e, 'remove')}
                onMouseLeave={closePreview}
              >
                <Stack gap={1.25}>
                  <Typography variant="subtitle2" fontWeight={800}>Remove Duplicate</Typography>
                  <Autocomplete
                    options={mergeOptions.filter((customer) => Number(customer.id) !== Number(keepCustomer?.id || 0))}
                    value={removeCustomer}
                    onChange={(_, value) => setRemoveCustomer(value)}
                    getOptionLabel={(option) => `${option.name}${option.phone ? ` | ${option.phone}` : ''}`}
                    isOptionEqualToValue={(option, value) => Number(option.id) === Number(value.id)}
                    renderInput={(params) => <TextField {...params} label="Duplicate customer" />}
                  />
                  <Typography variant="caption" color="text.secondary">
                    Hover here to preview records that will move and then disappear under this name.
                  </Typography>
                </Stack>
              </Paper>
            </Stack>

            {keepCustomer && removeCustomer && Number(keepCustomer.id) === Number(removeCustomer.id) ? (
              <Alert severity="error">Keep and Remove must be different customers.</Alert>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMergeOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            color="warning"
            onClick={saveMerge}
            disabled={
              mergeM.isPending ||
              !keepCustomer ||
              !removeCustomer ||
              Number(keepCustomer?.id || 0) === Number(removeCustomer?.id || 0)
            }
          >
            {mergeM.isPending ? 'Clubbing...' : 'Club Customers'}
          </Button>
        </DialogActions>
      </Dialog>

      <Popover
        open={Boolean(previewAnchor)}
        anchorEl={previewAnchor}
        onClose={closePreview}
        disableRestoreFocus
        sx={{ pointerEvents: 'none' }}
        slotProps={{ paper: { sx: { p: 2, pointerEvents: 'none' } } }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      >
        {previewContent(previewSummary, previewLoading)}
      </Popover>
    </Stack>
  )
}
