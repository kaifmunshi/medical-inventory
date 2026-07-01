import { useState } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
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
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import MergeTypeIcon from '@mui/icons-material/MergeType'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createCustomer,
  fetchCustomers,
  fetchUnlinkedBillCandidates,
  getCustomerSummary,
  mergeCustomers,
  updateCustomer,
  type CustomerSummary,
  type UnlinkedBillCandidate,
} from '../../services/customers'
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
  const [selectedExtraBillIds, setSelectedExtraBillIds] = useState<number[]>([])

  const customersQ = useQuery<Customer[], Error>({
    queryKey: ['customers', q],
    queryFn: () => fetchCustomers({ q: q.trim() || undefined, limit: 1000 }),
  })
  const keepSummaryQ = useQuery<CustomerSummary, Error>({
    queryKey: ['customer-summary', keepCustomer?.id, 'with-note-matches'],
    queryFn: () => getCustomerSummary(Number(keepCustomer?.id)),
    enabled: Boolean(keepCustomer?.id),
  })
  const removeSummaryQ = useQuery<CustomerSummary, Error>({
    queryKey: ['customer-summary', removeCustomer?.id, 'with-note-matches'],
    queryFn: () => getCustomerSummary(Number(removeCustomer?.id)),
    enabled: Boolean(removeCustomer?.id),
  })
  const unlinkedBillsQ = useQuery<UnlinkedBillCandidate[], Error>({
    queryKey: ['customer-merge-unlinked-bills', keepCustomer?.id, removeCustomer?.id],
    queryFn: () =>
      fetchUnlinkedBillCandidates({
        keep_customer_id: Number(keepCustomer?.id),
        remove_customer_id: Number(removeCustomer?.id),
      }),
    enabled: Boolean(keepCustomer?.id && removeCustomer?.id),
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
    mutationFn: ({ keepId, removeId, extraBillIds }: { keepId: number; removeId: number; extraBillIds: number[] }) =>
      mergeCustomers(keepId, removeId, extraBillIds),
    onSuccess: (result) => {
      toast.push(`Customers clubbed. ${result.moved_bills} bills moved.`, 'success')
      queryClient.invalidateQueries({ queryKey: ['customers'] })
      queryClient.invalidateQueries({ queryKey: ['customer-summary'] })
      queryClient.invalidateQueries({ queryKey: ['customer-merge-unlinked-bills'] })
      queryClient.invalidateQueries({ queryKey: ['customer-ledger'] })
      queryClient.invalidateQueries({ queryKey: ['parties'] })
      queryClient.invalidateQueries({ queryKey: ['debtors'] })
      setMergeOpen(false)
      setKeepCustomer(null)
      setRemoveCustomer(null)
      setSelectedExtraBillIds([])
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
    setSelectedExtraBillIds([])
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
    mergeM.mutate({
      keepId: Number(keepCustomer.id),
      removeId: Number(removeCustomer.id),
      extraBillIds: selectedExtraBillIds,
    })
  }

  function toggleExtraBill(billId: number) {
    setSelectedExtraBillIds((current) =>
      current.includes(billId)
        ? current.filter((id) => id !== billId)
        : [...current, billId],
    )
  }

  function toggleAllExtraBills(bills: UnlinkedBillCandidate[]) {
    const billIds = bills.map((bill) => Number(bill.id))
    const selected = new Set(selectedExtraBillIds)
    const allSelected = billIds.length > 0 && billIds.every((id) => selected.has(id))
    setSelectedExtraBillIds(allSelected ? [] : billIds)
  }

  function previewContent(summary?: CustomerSummary, loading = false) {
    if (loading) {
      return <Typography variant="body2">Loading records...</Typography>
    }

    if (!summary) {
      return (
        <Typography variant="body2" color="text.secondary">
          Select a customer to preview records.
        </Typography>
      )
    }

    const bills = summary.bills || []

    return (
      <Stack gap={1.25}>
        <Box>
          <Typography fontWeight={700}>
            {summary.customer.name}
          </Typography>

          <Typography variant="caption" color="text.secondary">
            {summary.customer.phone || 'No phone'}
            {summary.customer.address_line
              ? ` • ${summary.customer.address_line}`
              : ''}
          </Typography>
        </Box>

        <Stack direction="row" spacing={2} flexWrap="wrap">
          <Typography variant="caption">
            Bills: <strong>{summary.totals.total_bills}</strong>
          </Typography>

          <Typography variant="caption">
            Sales: <strong>₹{money(summary.totals.total_sales)}</strong>
          </Typography>

          <Typography variant="caption">
            Pending: <strong>₹{money(summary.totals.total_pending)}</strong>
          </Typography>
        </Stack>

        <Box
          sx={{
            maxHeight: 350,
            overflowY: 'auto',
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
            p: 1,
          }}
        >
          {bills.length === 0 ? (
            <Typography variant="caption" color="text.secondary">
              No bill records.
            </Typography>
          ) : (
            bills.map((bill: any) => (
              <Stack
                key={bill.id}
                direction="row"
                justifyContent="space-between"
                alignItems="center"
                spacing={2}
                sx={{
                  py: 0.75,
                  borderBottom:
                    bill !== bills[bills.length - 1]
                      ? '1px solid rgba(0,0,0,0.08)'
                      : 'none',
                }}
              >
                <Box>
                  <Typography variant="body2" fontWeight={600}>
                    Bill #{bill.id}
                  </Typography>

                  <Typography variant="caption" color="text.secondary">
                    {formatDate(bill.date_time)}
                  </Typography>
                </Box>

                <Typography variant="body2" fontWeight={600}>
                  ₹{money(bill.total_amount)}
                </Typography>
              </Stack>
            ))
          )}
        </Box>
      </Stack>
    )
  }

  function unlinkedBillsContent() {
    if (!keepCustomer || !removeCustomer) return null

    if (unlinkedBillsQ.isLoading) {
      return (
        <Typography variant="body2" color="text.secondary">
          Checking unlinked matching bills...
        </Typography>
      )
    }

    if (unlinkedBillsQ.isError) {
      return (
        <Alert severity="error">
          Failed to load unlinked matching bills: {unlinkedBillsQ.error.message}
        </Alert>
      )
    }

    const bills = unlinkedBillsQ.data || []
    const selectedSet = new Set(selectedExtraBillIds)
    const allSelected = bills.length > 0 && bills.every((bill) => selectedSet.has(Number(bill.id)))
    const someSelected = bills.some((bill) => selectedSet.has(Number(bill.id))) && !allSelected

    return (
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack gap={1.25}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            justifyContent="space-between"
            alignItems={{ xs: 'flex-start', sm: 'center' }}
            gap={1}
          >
            <Box>
              <Typography variant="subtitle2" fontWeight={800}>
                Unmatched Unlinked Bills
              </Typography>
              <Typography variant="caption" color="text.secondary">
                These loose bills mention the selected names but do not exactly match either customer. Tick the ones that should move to Keep.
              </Typography>
            </Box>

            {bills.length > 0 && (
              <Stack direction="row" alignItems="center" gap={0.5}>
                <Checkbox
                  size="small"
                  checked={allSelected}
                  indeterminate={someSelected}
                  onChange={() => toggleAllExtraBills(bills)}
                />
                <Typography variant="caption">
                  {selectedExtraBillIds.length} selected
                </Typography>
              </Stack>
            )}
          </Stack>

          {bills.length === 0 ? (
            <Box
              sx={{
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 1,
                px: 1.5,
                py: 1.25,
              }}
            >
              <Typography variant="caption" color="text.secondary">
                No unlinked matching bills found.
              </Typography>
            </Box>
          ) : (
            <Box sx={{ overflowX: 'auto', maxHeight: 260, overflowY: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 48 }}></th>
                    <th>Bill</th>
                    <th>Date</th>
                    <th>Notes</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((bill) => {
                    const billId = Number(bill.id)
                    return (
                      <tr key={bill.id}>
                        <td>
                          <Checkbox
                            size="small"
                            checked={selectedSet.has(billId)}
                            onChange={() => toggleExtraBill(billId)}
                          />
                        </td>
                        <td>#{bill.id}</td>
                        <td>{formatDate(bill.date_time)}</td>
                        <td style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>
                          {bill.notes || '-'}
                        </td>
                        <td>{bill.payment_status || '-'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700 }}>₹{money(bill.total_amount)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </Box>
          )}
        </Stack>
      </Paper>
    )
  }

  const rows = customersQ.data || []
  const mergeOptions = rows

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

      <Dialog open={mergeOpen} onClose={() => setMergeOpen(false)} maxWidth="lg" fullWidth>
        <DialogTitle>Club Customers</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2} mt={1}>
            <Alert severity="info">
              Keep customer remains. Remove customer will be archived after bills, receipts, and ledger links move to Keep.
            </Alert>

            <Stack direction={{ xs: 'column', md: 'row' }} gap={2} alignItems="flex-start">
              <Paper variant="outlined" sx={{ p: 2, flex: 1, width: '100%' }}>
                <Stack gap={1.25}>
                  <Typography variant="subtitle2" fontWeight={800}>
                    Keep Customer
                  </Typography>

                  <Autocomplete
                    options={mergeOptions.filter((customer) => Number(customer.id) !== Number(removeCustomer?.id || 0))}
                    value={keepCustomer}
                    onChange={(_, value) => {
                      setKeepCustomer(value)
                      setSelectedExtraBillIds([])
                    }}
                    getOptionLabel={(option) =>
                      `#${option.id} | ${option.name}${option.phone ? ` | ${option.phone}` : ''}`
                    }
                    isOptionEqualToValue={(option, value) => Number(option.id) === Number(value.id)}
                    renderInput={(params) => <TextField {...params} label="Final customer" />}
                  />

                  <Typography variant="caption" color="text.secondary">
                    Records under this customer will remain.
                  </Typography>

                  {keepCustomer && (
                    <Box sx={{ mt: 1 }}>
                      {previewContent(keepSummaryQ.data, keepSummaryQ.isLoading)}
                    </Box>
                  )}
                </Stack>
              </Paper>

              <Paper variant="outlined" sx={{ p: 2, flex: 1, width: '100%' }}>
                <Stack gap={1.25}>
                  <Typography variant="subtitle2" fontWeight={800}>
                    Remove Duplicate
                  </Typography>

                  <Autocomplete
                    options={mergeOptions.filter((customer) => Number(customer.id) !== Number(keepCustomer?.id || 0))}
                    value={removeCustomer}
                    onChange={(_, value) => {
                      setRemoveCustomer(value)
                      setSelectedExtraBillIds([])
                    }}
                    getOptionLabel={(option) => `${option.name}${option.phone ? ` | ${option.phone}` : ''}`}
                    isOptionEqualToValue={(option, value) => Number(option.id) === Number(value.id)}
                    renderInput={(params) => <TextField {...params} label="Duplicate customer" />}
                  />

                  <Typography variant="caption" color="text.secondary">
                    Records under this customer will move to Keep, then this customer will be archived.
                  </Typography>

                  {removeCustomer && (
                    <Box sx={{ mt: 1 }}>
                      {previewContent(removeSummaryQ.data, removeSummaryQ.isLoading)}
                    </Box>
                  )}
                </Stack>
              </Paper>
            </Stack>

            {unlinkedBillsContent()}

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
    </Stack>
  )
}
