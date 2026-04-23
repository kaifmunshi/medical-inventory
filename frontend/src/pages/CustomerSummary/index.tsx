import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Link,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
  Autocomplete,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import EditIcon from '@mui/icons-material/Edit'
import SwapHorizIcon from '@mui/icons-material/SwapHoriz'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { fetchCustomers, getCustomerSummary, moveCustomerBills } from '../../services/customers'
import { getBill } from '../../services/billing'
import type { Customer } from '../../lib/types'
import BillEditDialog from '../../components/billing/BillEditDialog'
import BillPaymentsPanel from '../../components/billing/BillPaymentsPanel'
import { buildSalesReportLink } from '../../lib/reportLinks'

function money(n: number | string | null | undefined) {
  return Number(n || 0).toFixed(2)
}

function formatDateTime(value?: string | null) {
  const raw = String(value || '')
  if (!raw) return '-'
  try {
    return new Date(raw).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    })
  } catch {
    return raw
  }
}

function statusChip(status: string, isDeleted: boolean) {
  if (isDeleted) return <Chip size="small" label="Deleted" color="default" variant="outlined" />
  const key = String(status || '').toUpperCase()
  if (key === 'PAID') return <Chip size="small" label="Paid" color="success" />
  if (key === 'PARTIAL') return <Chip size="small" label="Partial" color="warning" />
  return <Chip size="small" label="Unpaid" color="error" />
}

export default function CustomerSummaryPage() {
  const { customerId } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const numericCustomerId = Number(customerId || 0)
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'DELETED' | 'OPEN' | 'PAID'>('ALL')
  const [moveOpen, setMoveOpen] = useState(false)
  const [moveTarget, setMoveTarget] = useState<Customer | null>(null)
  const [moveSearch, setMoveSearch] = useState('')
  const [billOpen, setBillOpen] = useState(false)
  const [billLoading, setBillLoading] = useState(false)
  const [billDetail, setBillDetail] = useState<any | null>(null)
  const [billEditOpen, setBillEditOpen] = useState(false)

  const summaryQ = useQuery({
    queryKey: ['customer-summary', numericCustomerId],
    queryFn: () => getCustomerSummary(numericCustomerId),
    enabled: Number.isFinite(numericCustomerId) && numericCustomerId > 0,
  })

  const customersQ = useQuery<Customer[], Error>({
    queryKey: ['customers', moveSearch],
    queryFn: () => fetchCustomers({ q: moveSearch.trim() || undefined }),
    enabled: moveOpen,
  })

  const moveM = useMutation({
    mutationFn: ({ sourceId, destinationId }: { sourceId: number; destinationId: number }) =>
      moveCustomerBills(sourceId, destinationId),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['customer-summary'] })
      qc.invalidateQueries({ queryKey: ['customers'] })
      setMoveOpen(false)
      setMoveTarget(null)
      navigate(`/customers/${res.destination_customer_id}/summary`)
    },
  })

  const customer = summaryQ.data?.customer
  const bills = summaryQ.data?.bills || []
  const totals = summaryQ.data?.totals

  const filteredBills = useMemo(() => {
    if (statusFilter === 'ALL') return bills
    if (statusFilter === 'ACTIVE') return bills.filter((bill: any) => !bill.is_deleted)
    if (statusFilter === 'DELETED') return bills.filter((bill: any) => bill.is_deleted)
    if (statusFilter === 'PAID') return bills.filter((bill: any) => String(bill.payment_status || '').toUpperCase() === 'PAID')
    return bills.filter((bill: any) => ['UNPAID', 'PARTIAL'].includes(String(bill.payment_status || '').toUpperCase()))
  }, [bills, statusFilter])

  async function openBillDetail(billId: number) {
    if (!Number.isFinite(billId) || billId <= 0) return
    setBillOpen(true)
    setBillLoading(true)
    setBillDetail(null)
    try {
      const data = await getBill(billId)
      setBillDetail(data)
    } catch {
      setBillDetail(null)
    } finally {
      setBillLoading(false)
    }
  }

  if (summaryQ.isLoading) {
    return <Typography>Loading customer summary...</Typography>
  }

  if (summaryQ.isError || !customer || !totals) {
    return (
      <Alert severity="error">
        Failed to load customer summary.
      </Alert>
    )
  }

  return (
    <Stack gap={2}>
      <Paper sx={{ p: 2.25 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={2}>
          <Stack gap={1}>
            <Stack direction="row" gap={1} flexWrap="wrap">
              <Button startIcon={<ArrowBackIcon />} variant="outlined" onClick={() => navigate('/customers')}>
                Back to Customers
              </Button>
              <Button variant="outlined" onClick={() => navigate('/billing')}>
                Open Billing
              </Button>
              <Button
                variant="outlined"
                onClick={() =>
                  navigate(
                    buildSalesReportLink({
                      q: customer.phone || customer.name,
                      from: '2000-01-01',
                      to: '2099-12-31',
                      deletedFilter: 'all',
                    })
                  )
                }
              >
                Open Reports
              </Button>
            </Stack>
            <Box>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>
                Customer Summary
              </Typography>
              <Typography variant="h6" sx={{ mt: 0.5 }}>
                {customer.name}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {customer.phone || 'No phone'} {customer.address_line ? `• ${customer.address_line}` : ''}
              </Typography>
            </Box>
          </Stack>

          <Stack gap={1} alignItems={{ md: 'flex-end' }}>
            <Button
              startIcon={<SwapHorizIcon />}
              variant="contained"
              onClick={() => setMoveOpen(true)}
              disabled={bills.length === 0}
            >
              Move Bills To Another Customer
            </Button>
            <Typography variant="body2" color="text.secondary">
              All bills are shown here, including deleted and partially paid ones.
            </Typography>
          </Stack>
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} gap={1} flexWrap="wrap">
          <Chip label={`Bills: ${totals.total_bills}`} />
          <Chip label={`Active: ${totals.active_bills}`} color="success" variant="outlined" />
          <Chip label={`Deleted: ${totals.deleted_bills}`} variant="outlined" />
          <Chip label={`Sales: Rs ${money(totals.total_sales)}`} color="primary" />
          <Chip label={`Collected: Rs ${money(totals.total_paid)}`} color="success" variant="outlined" />
          <Chip label={`Pending: Rs ${money(totals.total_pending)}`} color="warning" variant="outlined" />
          <Chip label={`Paid: ${totals.paid_bills}`} color="success" variant="outlined" />
          <Chip label={`Open: ${totals.partial_bills + totals.unpaid_bills}`} color="warning" variant="outlined" />
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} gap={2} alignItems={{ md: 'center' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            Bills Register
          </Typography>
          <TextField
            select
            size="small"
            label="View"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            sx={{ minWidth: 180, ml: { md: 'auto' } }}
          >
            <MenuItem value="ALL">All Bills</MenuItem>
            <MenuItem value="ACTIVE">Active Bills</MenuItem>
            <MenuItem value="DELETED">Deleted Bills</MenuItem>
            <MenuItem value="OPEN">Open / Pending</MenuItem>
            <MenuItem value="PAID">Paid Bills</MenuItem>
          </TextField>
        </Stack>

        <Box sx={{ overflowX: 'auto', mt: 2 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Bill #</th>
                <th>Date</th>
                <th>Mode</th>
                <th>Status</th>
                <th>Total</th>
                <th>Paid</th>
                <th>Pending</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredBills.map((bill: any) => {
                const pending = Math.max(0, Number(bill.total_amount || 0) - Number(bill.paid_amount || 0))
                return (
                  <tr key={bill.id}>
                    <td>
                      <Link component="button" underline="hover" onClick={() => openBillDetail(Number(bill.id))}>
                        #{bill.id}
                      </Link>
                    </td>
                    <td>{formatDateTime(bill.date_time)}</td>
                    <td>{bill.payment_mode || '-'}</td>
                    <td>{statusChip(String(bill.payment_status || ''), Boolean(bill.is_deleted))}</td>
                    <td>Rs {money(bill.total_amount)}</td>
                    <td>Rs {money(bill.paid_amount)}</td>
                    <td>Rs {money(pending)}</td>
                    <td style={{ maxWidth: 320, whiteSpace: 'normal', wordBreak: 'break-word' }}>
                      {bill.notes || '-'}
                    </td>
                    <td>
                      <Button size="small" onClick={() => openBillDetail(Number(bill.id))}>
                        Open
                      </Button>
                    </td>
                  </tr>
                )
              })}
              {filteredBills.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <Box p={2} color="text.secondary">No bills found for this customer in the selected view.</Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Dialog open={moveOpen} onClose={() => setMoveOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Move Bills To Another Customer</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2} sx={{ mt: 1 }}>
            <Alert severity="info">
              This will move every bill currently tagged to {customer.name} to the selected customer, including deleted bills.
            </Alert>
            <Autocomplete
              options={(customersQ.data || []).filter((row) => Number(row.id) !== Number(customer.id))}
              value={moveTarget}
              onChange={(_, value) => setMoveTarget(value)}
              onInputChange={(_, value) => setMoveSearch(value)}
              getOptionLabel={(option) => `${option.name}${option.phone ? ` • ${option.phone}` : ''}`}
              renderInput={(params) => <TextField {...params} label="Destination Customer" fullWidth />}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMoveOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => moveM.mutate({ sourceId: Number(customer.id), destinationId: Number(moveTarget?.id || 0) })}
            disabled={!moveTarget || moveM.isPending}
          >
            {moveM.isPending ? 'Moving...' : 'Move Bills'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={billOpen} onClose={() => setBillOpen(false)} fullWidth maxWidth="md">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Bill Details {billDetail?.id ? `#${billDetail.id}` : ''}
          <IconButton onClick={() => setBillOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          {billLoading ? (
            <Typography color="text.secondary">Loading…</Typography>
          ) : !billDetail ? (
            <Typography color="error">Failed to load bill details.</Typography>
          ) : (
            <Stack gap={2}>
              <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1}>
                <Typography variant="subtitle1">
                  ID: <b>{billDetail.id}</b>
                </Typography>
                <Typography variant="subtitle1">
                  Date/Time: <b>{billDetail.date_time || '-'}</b>
                </Typography>
              </Stack>

              <Divider />

              <Box sx={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ minWidth: 220 }}>Item</th>
                      <th>Qty</th>
                      <th>MRP</th>
                      <th>Line Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(billDetail.items || []).map((it: any, idx: number) => (
                      <tr key={idx}>
                        <td>{it.item_name || `#${it.item_id}`}</td>
                        <td>{Number(it.quantity || 0)}</td>
                        <td>{money(it.mrp)}</td>
                        <td>{money(it.line_total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Box>

              <Stack gap={0.5} sx={{ ml: 'auto', maxWidth: 420 }}>
                <Typography>Total: <b>{money(billDetail.total_amount || 0)}</b></Typography>
                <Typography>Payment Mode: <b>{billDetail.payment_mode || '-'}</b></Typography>
                <Typography>Payment Status: <b>{billDetail.payment_status || '-'}</b></Typography>
                <Typography>Paid Amount: <b>{money(billDetail.paid_amount || 0)}</b></Typography>
                <Typography>Pending Amount: <b>{money(Math.max(0, Number(billDetail.total_amount || 0) - Number(billDetail.paid_amount || 0)))}</b></Typography>
                {billDetail.notes ? <Typography sx={{ mt: 1 }}>Notes: <i>{billDetail.notes}</i></Typography> : null}
                {!billDetail.is_deleted ? (
                  <Box sx={{ pt: 1 }}>
                    <Button size="small" variant="outlined" startIcon={<EditIcon />} onClick={() => setBillEditOpen(true)}>
                      Edit Bill
                    </Button>
                  </Box>
                ) : null}
              </Stack>

              <Divider />
              <BillPaymentsPanel
                bill={billDetail}
                onBillUpdated={async (updatedBill) => {
                  setBillDetail(updatedBill)
                  qc.invalidateQueries({ queryKey: ['customer-summary', numericCustomerId] })
                }}
              />
            </Stack>
          )}
        </DialogContent>
      </Dialog>

      <BillEditDialog
        open={billEditOpen}
        bill={billDetail}
        onClose={() => setBillEditOpen(false)}
        onSaved={(updated) => {
          setBillDetail(updated)
          qc.invalidateQueries({ queryKey: ['customer-summary', numericCustomerId] })
        }}
      />
    </Stack>
  )
}
