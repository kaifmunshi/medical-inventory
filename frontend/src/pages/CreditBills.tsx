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
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  editBillPayment,
  getBill,
  listBills,
  receivePayment,
  listBillPayments,
  recoverBillPayment,
  undoBillPayment,
} from '../services/billing'
import { getExchangeByReturn, listExchangeRecords } from '../services/returns'
import { todayRange } from '../lib/date'
import ConfirmDialog from '../components/ui/ConfirmDialog'

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

function round2(n: number) {
  return Math.round(n * 100) / 100
}

function computeBillProration(bill: any) {
  const items = (bill?.items || []) as any[]
  const sub = items.reduce((s: number, it: any) => s + Number(it.mrp) * Number(it.quantity), 0)

  const discPct = Number(bill?.discount_percent || 0)
  const taxPct = Number(bill?.tax_percent || 0)

  const discAmt = (sub * discPct) / 100
  const afterDisc = sub - discAmt
  const taxAmt = (afterDisc * taxPct) / 100
  const computedTotal = afterDisc + taxAmt

  const finalTotal =
    bill?.total_amount !== undefined && bill?.total_amount !== null
      ? Number(bill.total_amount)
      : computedTotal

  const factor = computedTotal > 0 ? finalTotal / computedTotal : 1
  return { discPct, taxPct, computedTotal, finalTotal, factor }
}

function chargedLine(bill: any, mrp: number, qty: number) {
  const { discPct, taxPct, factor } = computeBillProration(bill)

  const lineSub = Number(mrp) * Number(qty)
  const afterDisc = lineSub * (1 - discPct / 100)
  const afterTax = afterDisc * (1 + taxPct / 100)

  return round2(afterTax * factor)
}

function lineDiscountPercent(mrp: number, sp: number) {
  if (Number(mrp) <= 0) return 0
  const pct = ((Number(mrp) - Number(sp)) / Number(mrp)) * 100
  return round2(Math.min(100, Math.max(0, pct)))
}

function isPaidStatus(s: any) {
  return String(s || '').toUpperCase() === 'PAID'
}

function billHasUndoableCreditComponent(bill: any, payments: any[]) {
  if (String(bill?.payment_mode || '').toLowerCase() === 'credit') return true
  if (Boolean(bill?.is_credit)) return true

  const total = Number(bill?.total_amount || 0)
  return (payments || []).some((p: any) => {
    const isOpeningPayment = String(p?.note || '') === 'auto: payment at bill creation'
    if (!isOpeningPayment) return false
    const openingPaid = Number(p?.cash_amount || 0) + Number(p?.online_amount || 0)
    return openingPaid + 0.0001 < total
  })
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
  const [openExchangeDlg, setOpenExchangeDlg] = useState(false)
  const [exchangeDetail, setExchangeDetail] = useState<any | null>(null)
  const [undoPaymentRow, setUndoPaymentRow] = useState<any | null>(null)
  const [recoverPaymentRow, setRecoverPaymentRow] = useState<any | null>(null)
  const [editPaymentRow, setEditPaymentRow] = useState<any | null>(null)

  // Receive payment dialog
  const [openPayDlg, setOpenPayDlg] = useState(false)
  const [payBill, setPayBill] = useState<any | null>(null)
  const [payMode, setPayMode] = useState<'cash' | 'online' | 'split'>('cash')
  const [cash, setCash] = useState<number | ''>('')
  const [online, setOnline] = useState<number | ''>('')
  const [note, setNote] = useState('')
  const [paymentDate, setPaymentDate] = useState(todayFrom)
  const payPending = useMemo(
    () => round2(Math.max(0, Number(payBill?.total_amount || 0) - Number(payBill?.paid_amount || 0))),
    [payBill]
  )

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
  const qExchanges = useQuery({
    queryKey: ['credit-bills-exchanges', appliedFrom, appliedTo],
    queryFn: async () => {
      const out: any[] = []
      let offset = 0
      const limit = 500
      while (true) {
        const rows = await listExchangeRecords({
          from_date: appliedFrom || undefined,
          to_date: appliedTo || undefined,
          limit,
          offset,
        })
        out.push(...(rows || []))
        if (!rows || rows.length < limit) break
        offset += limit
      }
      return out
    },
  })

  const creditRows = useMemo(() => {
    const bills = (qBills.data || []) as any[]
    const exchangeByNewBillId = new Map<number, any>()
    for (const ex of (qExchanges.data || []) as any[]) {
      exchangeByNewBillId.set(Number(ex.new_bill_id), ex)
    }

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
        exchange: exchangeByNewBillId.get(Number(b.id)) || null,
        itemsPreview: itemsPreview(b.items || []),
      }
    })
  }, [qBills.data, qExchanges.data, q])

  async function openBillDetail(row: any) {
    let b = row.raw
    try {
      b = await getBill(row.id)
    } catch {}
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

  async function openExchangeDetail(ex: any) {
    try {
      const d = await getExchangeByReturn(Number(ex?.return_id))
      setExchangeDetail(d)
      setOpenExchangeDlg(true)
    } catch {
      setExchangeDetail(null)
      setOpenExchangeDlg(true)
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

  function detailHasPendingBalance(bill: any) {
    return Number(bill?.total_amount || 0) - Number(bill?.paid_amount || 0) > 0.0001
  }

  function openReceivePayment(row: any) {
    const b = row.raw
    setPayBill(b)
    setPayMode('cash')
    setCash('')
    setOnline('')
    setNote('')
    setPaymentDate(todayFrom)
    setOpenPayDlg(true)
  }

  function openReceivePaymentForBill(bill: any) {
    if (!bill?.id) return
    setPayBill(bill)
    setPayMode('cash')
    setCash('')
    setOnline('')
    setNote('')
    setPaymentDate(todayFrom)
    setOpenPayDlg(true)
  }

  function paymentDateOnly(raw: any) {
    const s = String(raw || '')
    return s.length >= 10 ? s.slice(0, 10) : todayFrom
  }

  function openEditPayment(payment: any) {
    setEditPaymentRow(payment)
    setPayMode((payment?.mode as any) || 'cash')
    setCash(Number(payment?.cash_amount || 0) || '')
    setOnline(Number(payment?.online_amount || 0) || '')
    setNote(payment?.note || '')
    setPaymentDate(paymentDateOnly(payment?.received_at))
  }

  function handleSplitCashInPayDialog(raw: string) {
    if (payMode !== 'split') {
      setCash(raw === '' ? '' : Number(raw))
      return
    }
    if (raw === '') {
      setCash('')
      setOnline(payPending > 0 ? payPending : '')
      return
    }
    const c = Math.min(payPending, Math.max(0, round2(Number(raw))))
    setCash(c)
    setOnline(round2(Math.max(0, payPending - c)))
  }

  function handleSplitOnlineInPayDialog(raw: string) {
    if (payMode !== 'split') {
      setOnline(raw === '' ? '' : Number(raw))
      return
    }
    if (raw === '') {
      setOnline('')
      setCash(payPending > 0 ? payPending : '')
      return
    }
    const o = Math.min(payPending, Math.max(0, round2(Number(raw))))
    setOnline(o)
    setCash(round2(Math.max(0, payPending - o)))
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
        payment_date: paymentDate || undefined,
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

  const mUndoPay = useMutation({
    mutationFn: async (payment: any) => {
      if (!detail?.id) throw new Error('Bill missing')
      if (!payment?.id) throw new Error('Payment missing')
      return undoBillPayment(Number(detail.id), Number(payment.id))
    },
    onSuccess: async () => {
      const billId = Number(detail?.id || 0)
      setUndoPaymentRow(null)
      await qBills.refetch()
      if (billId) await refreshDetailIfOpen(billId)
    },
  })

  const mRecoverPay = useMutation({
    mutationFn: async (payment: any) => {
      if (!detail?.id) throw new Error('Bill missing')
      if (!payment?.id) throw new Error('Payment missing')
      return recoverBillPayment(Number(detail.id), Number(payment.id))
    },
    onSuccess: async () => {
      const billId = Number(detail?.id || 0)
      setRecoverPaymentRow(null)
      await qBills.refetch()
      if (billId) await refreshDetailIfOpen(billId)
    },
  })

  const mEditPay = useMutation({
    mutationFn: async () => {
      if (!detail?.id) throw new Error('Bill missing')
      if (!editPaymentRow?.id) throw new Error('Payment missing')

      const cashAmt = Number(cash || 0)
      const onlineAmt = Number(online || 0)

      if (payMode === 'cash' && onlineAmt !== 0) throw new Error('Online must be 0 for cash mode')
      if (payMode === 'online' && cashAmt !== 0) throw new Error('Cash must be 0 for online mode')
      if (payMode !== 'split' && cashAmt + onlineAmt <= 0) throw new Error('Amount must be > 0')
      if (payMode === 'split' && cashAmt + onlineAmt <= 0) throw new Error('Split must have some amount')

      return editBillPayment(Number(detail.id), Number(editPaymentRow.id), {
        mode: payMode,
        cash_amount: cashAmt,
        online_amount: onlineAmt,
        note: note || undefined,
        payment_date: paymentDate || undefined,
      })
    },
    onSuccess: async () => {
      const billId = Number(detail?.id || 0)
      setEditPaymentRow(null)
      await qBills.refetch()
      if (billId) await refreshDetailIfOpen(billId)
    },
  })

  // ✅ show "Last Payment Mode" based on latest payment entry (if any)
  const lastPayment = useMemo(() => {
    const pays = Array.isArray(detailPayments) ? detailPayments.filter((p: any) => !p?.is_deleted) : []
    if (pays.length === 0) return null
    return pays[0]
  }, [detailPayments])

  const canUndoDetailPayments = useMemo(
    () => billHasUndoableCreditComponent(detail, detailPayments),
    [detail, detailPayments]
  )

  const activeDetailPayments = useMemo(
    () => (detailPayments || []).filter((p: any) => !p?.is_deleted),
    [detailPayments]
  )

  const deletedDetailPayments = useMemo(
    () => (detailPayments || []).filter((p: any) => p?.is_deleted),
    [detailPayments]
  )

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
                    <tr
                      key={`cb-${r.id}`}
                      onDoubleClick={() => openBillDetail(r)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <Tooltip title={r.itemsPreview} arrow placement="top">
                          <Link component="button" onClick={() => openBillDetail(r)} underline="hover">
                            {r.id}
                          </Link>
                        </Tooltip>
                        {r.exchange ? (
                          <Chip
                            size="small"
                            label={`EXCH #${r.exchange.id}`}
                            onClick={() => openExchangeDetail(r.exchange)}
                            sx={{ ml: 1, bgcolor: '#e9f4ff', color: '#0b4b7a', fontWeight: 700 }}
                          />
                        ) : null}
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

              <Box textAlign={{ xs: 'left', md: 'right' }}>
                {detailHasPendingBalance(detail) ? (
                  <Button
                    variant="contained"
                    onClick={() => openReceivePaymentForBill(detail)}
                    disabled={mPay.isPending}
                  >
                    Receive Payment
                  </Button>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    Bill fully paid
                  </Typography>
                )}
              </Box>

              <Divider />

              <Box sx={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ minWidth: 220 }}>Item</th>
                      <th>Qty</th>
                      <th>MRP</th>
                      <th>SP</th>
                      <th>Disc. %</th>
                      <th>Computed Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail.items || []).map((it: any, idx: number) => {
                      const name = it.item_name || it.name || it.item?.name || `#${it.item_id}`
                      const qty = Number(it.quantity)
                      const mrp = Number(it.mrp)
                      const lineCharged = chargedLine(detail, mrp, qty)
                      const sp = qty > 0 ? round2(lineCharged / qty) : 0
                      const lineDiscPct = lineDiscountPercent(mrp, sp)
                      return (
                        <tr key={idx}>
                          <td>{name}</td>
                          <td>{qty}</td>
                          <td>{money(mrp)}</td>
                          <td>{money(sp)}</td>
                          <td>{money(lineDiscPct)}</td>
                          <td>{money(lineCharged)}</td>
                        </tr>
                      )
                    })}
                    {(detail.items || []).length === 0 && (
                      <tr>
                        <td colSpan={6}>
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
                  Subtotal (MRP x Qty): <b>{money(detail.subtotal)}</b>
                </Typography>
                <Typography>
                  Discount %: <b>{money(detail.discount_percent)}</b>
                </Typography>
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
                  <Typography>Status:</Typography>
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
              </Stack>

              {detail.notes ? (
                <Box sx={{ width: '100%' }}>
                  <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                    Notes
                  </Typography>
                  <Typography sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {detail.notes}
                  </Typography>
                </Box>
              ) : null}

              <Divider />

              <Typography variant="subtitle1">Payment History</Typography>
              {detailLoadingPayments ? (
                <Typography color="text.secondary">Loading payments…</Typography>
              ) : (
                <Box sx={{ overflowX: 'auto' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: 120 }}>Date</th>
                        <th>Mode</th>
                        <th>Cash</th>
                        <th>Online</th>
                        <th style={{ minWidth: 220 }}>Note</th>
                        <th style={{ width: 64 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeDetailPayments.map((p: any) => (
                        <tr key={p.id}>
                          <td style={{ maxWidth: 120, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {p.received_at ? String(p.received_at).slice(0, 10) : '-'}
                          </td>
                          <td>{p.mode || '-'}</td>
                          <td>{money(p.cash_amount)}</td>
                          <td>{money(p.online_amount)}</td>
                          <td style={{ minWidth: 220 }}>{p.note || ''}</td>
                          <td align="right">
                            <Box
                              sx={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'flex-end',
                                gap: 0.25,
                                whiteSpace: 'nowrap',
                              }}
                            >
                              <IconButton
                                size="small"
                                onClick={() => openEditPayment(p)}
                                disabled={mEditPay.isPending}
                                color="primary"
                                sx={{ p: 0.25 }}
                              >
                                <EditOutlinedIcon fontSize="small" />
                              </IconButton>
                              {canUndoDetailPayments ? (
                                <IconButton
                                  size="small"
                                  color="error"
                                  onClick={() => setUndoPaymentRow(p)}
                                  disabled={mUndoPay.isPending}
                                  sx={{ p: 0.25 }}
                                >
                                  <DeleteOutlineIcon fontSize="small" />
                                </IconButton>
                              ) : (
                                <Typography variant="body2" color="text.secondary">
                                  -
                                </Typography>
                              )}
                            </Box>
                          </td>
                        </tr>
                      ))}
                      {activeDetailPayments.length === 0 && (
                        <tr>
                          <td colSpan={6}>
                            <Box p={2} color="text.secondary">
                              No active payments.
                            </Box>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </Box>
              )}

              <Divider />

              <Typography variant="subtitle1">Deleted Payment History</Typography>
              <Box sx={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 120 }}>Date</th>
                      <th>Mode</th>
                      <th>Cash</th>
                      <th>Online</th>
                      <th style={{ minWidth: 220 }}>Note</th>
                      <th style={{ width: 120 }}>Deleted</th>
                      <th style={{ width: 64 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {deletedDetailPayments.map((p: any) => (
                      <tr key={`deleted-${p.id}`}>
                        <td style={{ maxWidth: 120, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {p.received_at ? String(p.received_at).slice(0, 10) : '-'}
                        </td>
                        <td>{p.mode || '-'}</td>
                        <td>{money(p.cash_amount)}</td>
                        <td>{money(p.online_amount)}</td>
                        <td style={{ minWidth: 220 }}>{p.note || ''}</td>
                        <td style={{ maxWidth: 120, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {p.deleted_at ? String(p.deleted_at).slice(0, 10) : '-'}
                        </td>
                        <td align="right">
                          {canUndoDetailPayments ? (
                            <Button
                              size="small"
                              variant="outlined"
                              onClick={() => setRecoverPaymentRow(p)}
                              disabled={mRecoverPay.isPending}
                              sx={{ minWidth: 0, px: 1 }}
                            >
                              Recover
                            </Button>
                          ) : (
                            <Typography variant="body2" color="text.secondary">
                              -
                            </Typography>
                          )}
                        </td>
                      </tr>
                    ))}
                    {deletedDetailPayments.length === 0 && (
                      <tr>
                        <td colSpan={7}>
                          <Box p={2} color="text.secondary">
                            No deleted payments.
                          </Box>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Box>
            </Stack>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(undoPaymentRow)}
        title="Undo Payment"
        onClose={() => {
          if (!mUndoPay.isPending) setUndoPaymentRow(null)
        }}
        onConfirm={() => {
          if (undoPaymentRow) mUndoPay.mutate(undoPaymentRow)
        }}
      >
        <Typography sx={{ mt: 1 }}>
          Undo payment of ₹{money(Number(undoPaymentRow?.cash_amount || 0) + Number(undoPaymentRow?.online_amount || 0))}
          {undoPaymentRow?.received_at ? ` received at ${undoPaymentRow.received_at}` : ''}?
        </Typography>
        {mUndoPay.isError ? (
          <Typography color="error" sx={{ mt: 1 }}>
            {(mUndoPay.error as any)?.message || 'Undo failed'}
          </Typography>
        ) : null}
      </ConfirmDialog>

      <Dialog open={Boolean(editPaymentRow)} onClose={() => !mEditPay.isPending && setEditPaymentRow(null)} fullWidth maxWidth="sm">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Edit Payment
          <IconButton onClick={() => !mEditPay.isPending && setEditPaymentRow(null)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Stack gap={2}>
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
                onChange={(e) => setCash(e.target.value === '' ? '' : Number(e.target.value))}
              />
            )}

            {(payMode === 'online' || payMode === 'split') && (
              <TextField
                label="Online Amount"
                type="number"
                value={online}
                onChange={(e) => setOnline(e.target.value === '' ? '' : Number(e.target.value))}
              />
            )}

            <TextField
              label="Note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />

            <TextField
              label="Payment Date"
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              InputLabelProps={{ shrink: true }}
            />

            <Box textAlign="right">
              <Button variant="contained" onClick={() => mEditPay.mutate()} disabled={mEditPay.isPending}>
                Save Changes
              </Button>
            </Box>

            {mEditPay.isError ? (
              <Typography color="error">
                {(mEditPay.error as any)?.message || 'Edit failed'}
              </Typography>
            ) : null}
          </Stack>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(recoverPaymentRow)}
        title="Recover Payment"
        onClose={() => {
          if (!mRecoverPay.isPending) setRecoverPaymentRow(null)
        }}
        onConfirm={() => {
          if (recoverPaymentRow) mRecoverPay.mutate(recoverPaymentRow)
        }}
      >
        <Typography sx={{ mt: 1 }}>
          Recover payment of ₹{money(Number(recoverPaymentRow?.cash_amount || 0) + Number(recoverPaymentRow?.online_amount || 0))}
          {recoverPaymentRow?.received_at ? ` received at ${recoverPaymentRow.received_at}` : ''}?
        </Typography>
        {mRecoverPay.isError ? (
          <Typography color="error" sx={{ mt: 1 }}>
            {(mRecoverPay.error as any)?.message || 'Recover failed'}
          </Typography>
        ) : null}
      </ConfirmDialog>

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
                  if (v === 'split') {
                    setCash('')
                    setOnline(payPending > 0 ? payPending : '')
                  }
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
                  onChange={(e) => handleSplitCashInPayDialog(e.target.value)}
                />
              )}

              {(payMode === 'online' || payMode === 'split') && (
                <TextField
                  label="Online Amount"
                  type="number"
                  value={online}
                  onChange={(e) => handleSplitOnlineInPayDialog(e.target.value)}
                />
              )}

              <TextField
                label="Note (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />

              <TextField
                label="Payment Date"
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
                InputLabelProps={{ shrink: true }}
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

      {/* ---------------- Exchange Detail Dialog ---------------- */}
      <Dialog open={openExchangeDlg} onClose={() => setOpenExchangeDlg(false)} fullWidth maxWidth="md">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Exchange Details
          <IconButton onClick={() => setOpenExchangeDlg(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          {!exchangeDetail ? (
            <Typography color="text.secondary">Exchange details not found.</Typography>
          ) : (
            <Stack gap={2}>
              <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1}>
                <Typography variant="subtitle1">
                  Return ID: <b>{exchangeDetail.return_id}</b> | New Bill ID: <b>{exchangeDetail.new_bill_id}</b>
                </Typography>
                <Typography variant="subtitle1">
                  Date/Time: <b>{exchangeDetail.created_at || exchangeDetail.return?.date_time || '-'}</b>
                </Typography>
              </Stack>

              <Divider />

              <Stack direction={{ xs: 'column', md: 'row' }} gap={3}>
                <Stack gap={0.5}>
                  <Typography variant="subtitle2">Exchange Summary</Typography>
                  <Typography>Theoretical Net: <b>₹{money(exchangeDetail.theoretical_net)}</b></Typography>
                  <Typography>Rounding Adj: <b>₹{money(exchangeDetail.rounding_adjustment)}</b></Typography>
                  <Typography>Final Net Due: <b>₹{money(exchangeDetail.net_due)}</b></Typography>
                  <Typography>
                    Payment: <b>{String(exchangeDetail.payment_mode || '').toUpperCase() || '-'}</b>
                    {' '}| Cash ₹{money(exchangeDetail.payment_cash)} | Online ₹{money(exchangeDetail.payment_online)}
                  </Typography>
                  <Typography>
                    Refund: Cash ₹{money(exchangeDetail.refund_cash)} | Online ₹{money(exchangeDetail.refund_online)}
                  </Typography>
                </Stack>
              </Stack>

              <Divider />

              <Typography variant="subtitle2">Returned Items</Typography>
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
                    {(exchangeDetail.return?.items || []).map((it: any, idx: number) => (
                      <tr key={`ex-ret-${idx}`}>
                        <td>{it.item_name || `#${it.item_id}`}</td>
                        <td>{Number(it.quantity || 0)}</td>
                        <td>{money(it.mrp)}</td>
                        <td>{money(it.line_total ?? Number(it.quantity || 0) * Number(it.mrp || 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Box>

              <Typography variant="subtitle2">New Bill Items</Typography>
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
                    {(exchangeDetail.bill?.items || []).map((it: any, idx: number) => (
                      <tr key={`ex-bill-${idx}`}>
                        <td>{it.item_name || `#${it.item_id}`}</td>
                        <td>{Number(it.quantity || 0)}</td>
                        <td>{money(it.mrp)}</td>
                        <td>{money(it.line_total ?? Number(it.quantity || 0) * Number(it.mrp || 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Box>
            </Stack>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
