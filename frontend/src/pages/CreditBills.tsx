// F:\medical-inventory\frontend\src\pages\CreditBills.tsx
import { useMemo, useState } from 'react'
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Link,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import { useMutation, useQuery } from '@tanstack/react-query'
import { getBill, listBills, receivePayment, listBillPayments } from '../services/billing'
import { todayRange } from '../lib/date'

function itemsPreview(items: any[], max = 6) {
  const names = (items || []).map(
    (it: any) => it.item_name || it.name || it.item?.name || `#${it.item_id}`
  )
  if (names.length <= max) return names.join(', ') || '—'
  const head = names.slice(0, max).join(', ')
  return `${head} +${names.length - max} more`
}

function money(n: number | string | undefined | null) {
  const v = Number(n || 0)
  return v.toFixed(2)
}

function isPaidStatus(s: any) {
  return String(s || '').toUpperCase() === 'PAID'
}

// ✅ small colored status chip
function StatusChip({ status }: { status: any }) {
  const s = String(status || '').toUpperCase()

  const sx =
    s === 'PAID'
      ? { bgcolor: 'success.main', color: '#fff' }
      : s === 'PARTIAL'
        ? { bgcolor: 'warning.main', color: '#fff' }
        : s === 'UNPAID'
          ? { bgcolor: 'error.main', color: '#fff' }
          : { bgcolor: 'grey.300', color: 'text.primary' }

  return <Chip size="small" label={s || '-'} sx={sx} />
}

export default function CreditBills() {
  const { from: todayFrom, to: todayTo } = todayRange()

  // ✅ UI inputs (user changes freely)
  const [uiFrom, setUiFrom] = useState(todayFrom)
  const [uiTo, setUiTo] = useState(todayTo)

  // ✅ Applied date range (sent to API). null => ALL bills
  const [appliedFrom, setAppliedFrom] = useState<string | null>(null)
  const [appliedTo, setAppliedTo] = useState<string | null>(null)

  const [q, setQ] = useState('')

  // Bill detail dialog
  const [openDetailDlg, setOpenDetailDlg] = useState(false)
  const [detail, setDetail] = useState<any | null>(null)
  const [detailPayments, setDetailPayments] = useState<any[]>([])
  const [detailLoadingPayments, setDetailLoadingPayments] = useState(false)

  // Receive payment dialog
  const [openPayDlg, setOpenPayDlg] = useState(false)
  const [payBill, setPayBill] = useState<any | null>(null)
  const [payMode, setPayMode] = useState<'cash' | 'online' | 'split'>('cash')
  const [cash, setCash] = useState<number | ''>('')
  const [online, setOnline] = useState<number | ''>('')
  const [note, setNote] = useState('')

  const qBills = useQuery({
    queryKey: ['credit-bills', appliedFrom, appliedTo, q],
    // ✅ date range applies ONLY when user clicks "Apply Range"
    queryFn: () =>
      listBills({
        from_date: appliedFrom || undefined,
        to_date: appliedTo || undefined,
        q,
        limit: 500,
      }),
  })

  const creditRows = useMemo(() => {
    const bills = (qBills.data || []) as any[]

    // ✅ client-side search over id/notes/item names
    const t = q.trim().toLowerCase()
    const searched =
      !t
        ? bills
        : bills.filter((b) => {
            // id
            if (String(b.id ?? '').includes(t)) return true
            // notes
            if (String(b.notes ?? '').toLowerCase().includes(t)) return true
            // items
            return (b.items || []).some((it: any) => {
              const name = String(it.item_name || it.name || it.item?.name || '')
              return name.toLowerCase().includes(t)
            })
          })

    // ✅ credit bills = UNPAID or PARTIAL (or is_credit true)
    const filtered = searched.filter((b) => {
      const status = String(b.payment_status || '').toUpperCase()
      if (status === 'UNPAID' || status === 'PARTIAL') return true
      if (b.is_credit === true) return true
      // fallback: if payment_mode is credit
      if (String(b.payment_mode || '').toLowerCase() === 'credit') return true
      return false
    })

    return filtered.map((b) => {
      const total = Number(b.total_amount || 0)
      const paid = Number(b.paid_amount || 0)
      const pendingNum = Math.max(0, total - paid)
      const status = (b.payment_status || (pendingNum > 0 ? 'UNPAID' : 'PAID')) as string

      return {
        raw: b,
        id: b.id,
        notes: String(b.notes || ''),
        date: b.date_time || b.created_at || '',
        total: money(total),
        paid: money(paid),
        pending: money(pendingNum),
        pendingNum,
        status,
        mode: b.payment_mode || '',
        itemsPreview: itemsPreview(b.items || []),
      }
    })
  }, [qBills.data, q])

  async function openBillDetail(row: any) {
    let b = row.raw
    if (!b?.items || !Array.isArray(b.items) || b.items.length === 0) {
      try {
        b = await getBill(row.id)
      } catch {}
    }
    setDetail(b)
    setOpenDetailDlg(true)

    // load payment history
    setDetailLoadingPayments(true)
    try {
      const pays = await listBillPayments(row.id)
      setDetailPayments(pays || [])
    } catch {
      setDetailPayments([])
    } finally {
      setDetailLoadingPayments(false)
    }
  }

  async function refreshDetailIfOpen(billId: number) {
    if (!openDetailDlg) return
    if (!detail?.id) return
    if (Number(detail.id) !== Number(billId)) return

    try {
      const b = await getBill(billId)
      setDetail(b)
    } catch {}

    setDetailLoadingPayments(true)
    try {
      const pays = await listBillPayments(billId)
      setDetailPayments(pays || [])
    } catch {
      setDetailPayments([])
    } finally {
      setDetailLoadingPayments(false)
    }
  }

  function openReceivePayment(row: any) {
    const b = row.raw
    setPayBill(b)
    setPayMode('cash')
    setCash('')
    setOnline('')
    setNote('')
    setOpenPayDlg(true)
  }

  const mPay = useMutation({
    mutationFn: async () => {
      if (!payBill?.id) throw new Error('Bill missing')

      const cashAmt = Number(cash || 0)
      const onlineAmt = Number(online || 0)

      // quick validations (backend will also validate)
      if (payMode === 'cash' && onlineAmt !== 0) throw new Error('Online must be 0 for cash mode')
      if (payMode === 'online' && cashAmt !== 0) throw new Error('Cash must be 0 for online mode')
      if (payMode !== 'split' && cashAmt + onlineAmt <= 0) throw new Error('Amount must be > 0')
      if (payMode === 'split' && cashAmt + onlineAmt <= 0)
        throw new Error('Split must have some amount')

      return receivePayment(payBill.id, {
        mode: payMode,
        cash_amount: cashAmt,
        online_amount: onlineAmt,
        note: note || undefined,
      })
    },
    onSuccess: async (_out) => {
      const billId = payBill?.id
      setOpenPayDlg(false)
      setPayBill(null)
      await qBills.refetch()
      if (billId) await refreshDetailIfOpen(billId)
    },
  })

  // ✅ show "Last Payment Mode" based on latest payment entry (if any)
  const lastPayment = useMemo(() => {
    const pays = Array.isArray(detailPayments) ? detailPayments : []
    if (pays.length === 0) return null
    // assume API returns desc order; still safe to fallback to first
    return pays[0]
  }, [detailPayments])

  const lastPaymentModeLabel = lastPayment?.mode ? String(lastPayment.mode) : null

  return (
    <>
      <Stack gap={2}>
        <Typography variant="h5">Credit Bills</Typography>

        <Paper sx={{ p: 2 }}>
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            gap={2}
            alignItems={{ md: 'center' }}
            justifyContent="space-between"
          >
            <Stack direction={{ xs: 'column', md: 'row' }} gap={2} alignItems={{ md: 'center' }}>
              <TextField
                label="From"
                type="date"
                value={uiFrom}
                onChange={(e) => setUiFrom(e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
              <TextField
                label="To"
                type="date"
                value={uiTo}
                onChange={(e) => setUiTo(e.target.value)}
                InputLabelProps={{ shrink: true }}
              />

              <Button
                variant="contained"
                onClick={() => {
                  setAppliedFrom(uiFrom)
                  setAppliedTo(uiTo)
                }}
                disabled={qBills.isFetching}
              >
                Apply Range
              </Button>

              <Button
                variant="outlined"
                onClick={() => {
                  setAppliedFrom(null)
                  setAppliedTo(null)
                }}
                disabled={qBills.isFetching}
              >
                All Bills
              </Button>

              <TextField
                label="Search (id/item/notes)"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </Stack>

            <Button variant="outlined" onClick={() => qBills.refetch()} disabled={qBills.isFetching}>
              Refresh
            </Button>
          </Stack>

          {/* Optional: small hint showing whether date filter is active */}
          <Box mt={1}>
            {appliedFrom && appliedTo ? (
              <Typography variant="caption" color="text.secondary">
                Showing range: <b>{appliedFrom}</b> to <b>{appliedTo}</b>
              </Typography>
            ) : (
              <Typography variant="caption" color="text.secondary">
                Showing: <b>All bills</b>
              </Typography>
            )}
          </Box>
        </Paper>

        <Paper sx={{ p: 2 }}>
          <Box sx={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Bill ID</th>
                  <th style={{ minWidth: 160 }}>Name</th>
                  <th>Date/Time</th>
                  <th>Total</th>
                  <th>Paid</th>
                  <th>Pending</th>
                  <th>Status</th>
                  <th>Mode</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {creditRows.map((r: any) => {
                  const isSettled = isPaidStatus(r.status) || Number(r.pendingNum || 0) <= 0

                  return (
                    <tr key={`cb-${r.id}`}>
                      <td>
                        <Tooltip title={r.itemsPreview} arrow placement="top">
                          <Link component="button" onClick={() => openBillDetail(r)} underline="hover">
                            {r.id}
                          </Link>
                        </Tooltip>
                      </td>
                       <td>
                        {r.notes ? (
                          <Tooltip title={r.notes} arrow placement="top">
                            <span>{r.notes}</span>
                          </Tooltip>
                        ) : (
                          <Typography variant="body2" color="text.secondary">
                            —
                          </Typography>
                        )}
                      </td>
                      <td>{r.date}</td>
                      <td>{r.total}</td>
                      <td>{r.paid}</td>
                      <td>{r.pending}</td>
                      <td>
                        <StatusChip status={r.status} />
                      </td>
                      <td>{r.mode}</td>
                      <td>
                        {isSettled ? (
                          <Typography variant="body2" color="text.secondary">
                            —
                          </Typography>
                        ) : (
                          <Button size="small" variant="contained" onClick={() => openReceivePayment(r)}>
                            Receive Payment
                          </Button>
                        )}
                      </td>
                    </tr>
                  )
                })}

                {creditRows.length === 0 && (
                  <tr>
                    <td colSpan={9}>
                      <Box p={2} color="text.secondary">
                        No credit bills.
                      </Box>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Box>
        </Paper>
      </Stack>

      {/* ---------------- Bill Detail Dialog ---------------- */}
      <Dialog open={openDetailDlg} onClose={() => setOpenDetailDlg(false)} fullWidth maxWidth="md">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Bill Details
          <IconButton onClick={() => setOpenDetailDlg(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>

        <DialogContent dividers>
          {!detail ? (
            <Typography color="text.secondary">Loading…</Typography>
          ) : (
            <Stack gap={2}>
              <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1}>
                <Typography variant="subtitle1">
                  ID: <b>{detail.id}</b>
                </Typography>
                <Typography variant="subtitle1">
                  Date/Time: <b>{detail.date_time || detail.created_at || '-'}</b>
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
                    {(detail.items || []).map((it: any, idx: number) => {
                      const name = it.item_name || it.name || it.item?.name || `#${it.item_id}`
                      const qty = Number(it.quantity)
                      const mrp = Number(it.mrp)
                      return (
                        <tr key={idx}>
                          <td>{name}</td>
                          <td>{qty}</td>
                          <td>{money(mrp)}</td>
                          <td>{money(qty * mrp)}</td>
                        </tr>
                      )
                    })}
                    {(detail.items || []).length === 0 && (
                      <tr>
                        <td colSpan={4}>
                          <Box p={2} color="text.secondary">
                            No items.
                          </Box>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Box>

              <Stack gap={0.5} sx={{ ml: 'auto', maxWidth: 420 }}>
                <Typography>
                  Total: <b>{money(detail.total_amount)}</b>
                </Typography>
                <Typography>
                  Paid: <b>{money(detail.paid_amount)}</b>
                </Typography>
                <Typography>
                  Pending:{' '}
                  <b>{money(Number(detail.total_amount || 0) - Number(detail.paid_amount || 0))}</b>
                </Typography>

                <Stack direction="row" alignItems="center" gap={1}>
                  <Typography>
                    Status: <b style={{ verticalAlign: 'middle' }}>{detail.payment_status || '-'}</b>
                  </Typography>
                  <StatusChip status={detail.payment_status || '-'} />
                </Stack>

                <Typography>
                  Paid At: <b>{detail.paid_at || '-'}</b>
                </Typography>

                {/* keep original payment_mode, but also show last payment mode */}
                <Typography>
                  Payment Mode: <b>{detail.payment_mode || '-'}</b>
                </Typography>
                <Typography color="text.secondary">
                  Last Payment Mode: <b>{lastPaymentModeLabel ? lastPaymentModeLabel : '-'}</b>
                </Typography>

                {detail.notes ? (
                  <Typography sx={{ mt: 1 }}>
                    Notes: <i>{detail.notes}</i>
                  </Typography>
                ) : null}
              </Stack>

              <Divider />

              <Typography variant="subtitle1">Payment History</Typography>
              {detailLoadingPayments ? (
                <Typography color="text.secondary">Loading payments…</Typography>
              ) : (
                <Box sx={{ overflowX: 'auto' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Date/Time</th>
                        <th>Mode</th>
                        <th>Cash</th>
                        <th>Online</th>
                        <th>Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(detailPayments || []).map((p: any) => (
                        <tr key={p.id}>
                          <td>{p.received_at || '-'}</td>
                          <td>{p.mode || '-'}</td>
                          <td>{money(p.cash_amount)}</td>
                          <td>{money(p.online_amount)}</td>
                          <td>{p.note || ''}</td>
                        </tr>
                      ))}
                      {(detailPayments || []).length === 0 && (
                        <tr>
                          <td colSpan={5}>
                            <Box p={2} color="text.secondary">
                              No payments yet.
                            </Box>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </Box>
              )}
            </Stack>
          )}
        </DialogContent>
      </Dialog>

      {/* ---------------- Receive Payment Dialog ---------------- */}
      <Dialog open={openPayDlg} onClose={() => setOpenPayDlg(false)} fullWidth maxWidth="sm">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Receive Payment (Bill #{payBill?.id})
          <IconButton onClick={() => setOpenPayDlg(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>

        <DialogContent dividers>
          {!payBill ? (
            <Typography color="text.secondary">No bill selected.</Typography>
          ) : (
            <Stack gap={2}>
              <Typography color="text.secondary">
                Total ₹{money(payBill.total_amount)} | Paid ₹{money(payBill.paid_amount)} | Pending ₹
                {money(Number(payBill.total_amount || 0) - Number(payBill.paid_amount || 0))}
              </Typography>

              <TextField
                select
                label="Mode"
                value={payMode}
                onChange={(e) => {
                  const v = e.target.value as any
                  setPayMode(v)
                  if (v === 'cash') setOnline('')
                  if (v === 'online') setCash('')
                }}
              >
                <MenuItem value="cash">Cash</MenuItem>
                <MenuItem value="online">Online</MenuItem>
                <MenuItem value="split">Split</MenuItem>
              </TextField>

              {(payMode === 'cash' || payMode === 'split') && (
                <TextField
                  label="Cash Amount"
                  type="number"
                  value={cash}
                  onChange={(e) => setCash(e.target.value as any)}
                />
              )}

              {(payMode === 'online' || payMode === 'split') && (
                <TextField
                  label="Online Amount"
                  type="number"
                  value={online}
                  onChange={(e) => setOnline(e.target.value as any)}
                />
              )}

              <TextField
                label="Note (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />

              <Box textAlign="right">
                <Button variant="contained" onClick={() => mPay.mutate()} disabled={mPay.isPending}>
                  Save Payment
                </Button>
              </Box>

              {mPay.isError ? (
                <Typography color="error">
                  {(mPay.error as any)?.message || 'Payment failed'}
                </Typography>
              ) : null}
            </Stack>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
