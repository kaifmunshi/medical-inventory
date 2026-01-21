import { useMemo, useState, useEffect } from 'react'
import {
  Grid,
  Paper,
  Typography,
  Stack,
  Dialog,
  DialogTitle,
  DialogContent,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Tooltip,
  Button,
  Divider,
  TextField,
  MenuItem,
} from '@mui/material'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listBills, getPaymentsSummary } from '../services/billing'
import { listReturns } from '../services/returns'
import { listItems } from '../services/inventory'
import { todayRange } from '../lib/date'
import {
  createCashbookEntry,
  getCashbookSummary,
  clearCashbookToday,
  listCashbookEntries,
  type CashbookEntry,
} from '../services/cashbook'

function formatExpiry(exp?: string | null) {
  if (!exp) return '-'
  const s = String(exp)
  const iso = s.length > 10 ? s.slice(0, 10) : s
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${d}-${m}-${y}`
}

const LOW_STOCK_THRESH = 2 // ≤ 2 is low-stock
const EXPIRY_WINDOW_DAYS = 60 // within next 60 days

const to2 = (n: any) => Math.round(Number(n || 0) * 100) / 100

// ✅ Persist toggle across route changes / refresh
const MONEY_TOGGLE_KEY = 'dash_show_money_cards'

export default function Dashboard() {
  const { from, to } = todayRange()
  const qc = useQueryClient()

  const [openLow, setOpenLow] = useState(false)
  const [openExp, setOpenExp] = useState(false)

  // Money cards are safe in your case (single-user local). Keep shortcut anyway.
  // ✅ Persisted value
  const [showMoneyCards, setShowMoneyCards] = useState(() => {
    const saved = localStorage.getItem(MONEY_TOGGLE_KEY)
    return saved == null ? true : saved === '1'
  })

  // ✅ Keep localStorage in sync
  useEffect(() => {
    localStorage.setItem(MONEY_TOGGLE_KEY, showMoneyCards ? '1' : '0')
  }, [showMoneyCards])

  // breakdown dialog (Collected Today)
  const [openCollectedBreakdown, setOpenCollectedBreakdown] = useState(false)

  // Ctrl + Shift + S => toggle money cards
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        setShowMoneyCards((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  // -------------------- Cashbook UI --------------------
  const [openCashbook, setOpenCashbook] = useState(false)
  const [cbType, setCbType] = useState<'WITHDRAWAL' | 'EXPENSE'>('EXPENSE')
  const [cbAmount, setCbAmount] = useState<string>('')
  const [cbNote, setCbNote] = useState<string>('')

  // ✅ NEW: Cashbook History (custom range)
  const [openCashbookHistory, setOpenCashbookHistory] = useState(false)
  const [histFrom, setHistFrom] = useState(from)
  const [histTo, setHistTo] = useState(to)

  // Bills created today (used for "Billed Today" + "Credit Pending")
  const qBills = useQuery({
    queryKey: ['dash-bills', from, to],
    queryFn: () => listBills({ from_date: from, to_date: to, limit: 500 }),
  })

  // Returns created today
  const qReturns = useQuery({
    queryKey: ['dash-returns', from, to],
    queryFn: () => listReturns({ from_date: from, to_date: to, limit: 500 }),
  })

  // Inventory for low-stock + expiry
  const qInv = useQuery({
    queryKey: ['dash-inventory'],
    queryFn: () => listItems(''),
  })

  // ✅ Collected Today MUST come from BillPayment rows (not from bills)
  // Because credit bills get paid later and those amounts are stored in BillPayment.
  const qCollected = useQuery({
    queryKey: ['dash-collected', from, to],
    queryFn: () => getPaymentsSummary({ from_date: from, to_date: to }),
  })

  // ✅ NEW: Cashbook summary for today (withdrawals + misc expenses)
  const qCashbook = useQuery({
    queryKey: ['dash-cashbook', from, to],
    queryFn: () => getCashbookSummary({ from_date: from, to_date: to }),
  })

  // ✅ NEW: Cashbook History list (only fetch when dialog open)
  const qCashbookHistory = useQuery({
    queryKey: ['dash-cashbook-history', histFrom, histTo],
    queryFn: () => listCashbookEntries({ from_date: histFrom, to_date: histTo, limit: 500 }),
    enabled: openCashbookHistory,
  })

  // ✅ NEW: Cashbook History summary (only fetch when dialog open)
  const qCashbookHistorySummary = useQuery({
    queryKey: ['dash-cashbook-history-summary', histFrom, histTo],
    queryFn: () => getCashbookSummary({ from_date: histFrom, to_date: histTo }),
    enabled: openCashbookHistory,
  })

  // -------------------- Money Computations (with clear meaning) --------------------
  const billedToday = useMemo(() => {
    /**
     * "Billed Today" = total value of bills created today (includes credit bills).
     * This is NOT the same as money collected today.
     */
    const bills = (qBills.data || []) as any[]
    let total = 0
    for (const b of bills) total += Number(b.total_amount || 0)
    return to2(total)
  }, [qBills.data])

  const collectedTodayCash = to2(qCollected.data?.cash_collected)
  const collectedTodayOnline = to2(qCollected.data?.online_collected)
  const collectedTodayTotal = to2(qCollected.data?.total_collected)

  const cashOutTodayTotal = to2(qCashbook.data?.cash_out)
  const cashOutTodayWithdrawals = to2(qCashbook.data?.withdrawals)
  const cashOutTodayExpenses = to2(qCashbook.data?.expenses)

  const { returnsTodayCash, returnsTodayOnline, returnsTodayTotal } = useMemo(() => {
    /**
     * Returns Today = refunds issued today.
     * Prefer refund_cash/refund_online (accurate cash/online impact).
     * Fallback: subtotal_return if refund fields are missing.
     */
    const rets = (qReturns.data || []) as any[]
    let cash = 0
    let online = 0
    let total = 0

    for (const r of rets) {
      const rc = Number(r.refund_cash ?? 0)
      const ro = Number(r.refund_online ?? 0)

      // If backend sends refund_cash/online properly, use them.
      if (rc !== 0 || ro !== 0) {
        cash += rc
        online += ro
        total += rc + ro
        continue
      }

      // Fallback
      const sub =
        typeof r.subtotal_return === 'number'
          ? Number(r.subtotal_return)
          : (r.items || []).reduce((s: number, it: any) => s + Number(it.mrp) * Number(it.quantity), 0)

      total += Number(sub || 0)
    }

    return {
      returnsTodayCash: to2(cash),
      returnsTodayOnline: to2(online),
      returnsTodayTotal: to2(total),
    }
  }, [qReturns.data])

  const netCashInHandToday = useMemo(() => {
    /**
     * Net Cash In Hand Today:
     * cash collected today - cash refunds today - (withdrawals/expenses)
     *
     * ✅ You asked: these expenses should deduct from net cash only.
     */
    return to2(collectedTodayCash - returnsTodayCash - cashOutTodayTotal)
  }, [collectedTodayCash, returnsTodayCash, cashOutTodayTotal])

  const netOnlineToday = useMemo(() => {
    /**
     * Net Online Today:
     * online collected today - online refunds today
     * (cashbook should NOT affect online)
     */
    return to2(collectedTodayOnline - returnsTodayOnline)
  }, [collectedTodayOnline, returnsTodayOnline])

  const netTotalToday = useMemo(() => {
    /**
     * Net Total Today:
     * total collected today - total refunds today - cash-out
     * (Because cash-out reduces real total available money)
     */
    return to2(collectedTodayTotal - returnsTodayTotal - cashOutTodayTotal)
  }, [collectedTodayTotal, returnsTodayTotal, cashOutTodayTotal])

  // -------- Credit Pending (ALL dates) --------
  const qAllBillsForPending = useQuery({
    queryKey: ['dash-credit-pending-all'],
    queryFn: () => listBills({ limit: 500, offset: 0 }), // adjust if you ever have >500 bills
  })

  const creditPendingAllDates = useMemo(() => {
    const bills = (qAllBillsForPending.data || []) as any[]
    let pending = 0
    for (const b of bills) {
      const status = String(b.payment_status || '').toUpperCase()
      if (status === 'PAID') continue
      const total = Number(b.total_amount || 0)
      const paid = Number(b.paid_amount || 0)
      pending += Math.max(0, total - paid)
    }
    return to2(pending)
  }, [qAllBillsForPending.data])

  // ---- Low Stock (aggregated by name + brand; expiry/mrp ignored) ----
  const { lowStockItems, lowStockCount } = useMemo(() => {
    const items = (qInv.data || []) as any[]

    type Agg = {
      _key: string
      name: string
      brand: string | null
      stock: number
      _variants: Array<{ id: number; mrp: number; expiry_date?: string | null; stock: number }>
    }

    const map = new Map<string, Agg>()

    for (const it of items) {
      const name = String(it?.name ?? '').trim()
      const brand = it?.brand != null ? String(it.brand).trim() : null
      const stock = Number(it?.stock ?? 0)
      const mrp = Number(it?.mrp ?? 0)
      if (!name) continue

      const key = `${name.toLowerCase()}|${(brand ?? '').toLowerCase()}`
      const existing = map.get(key)

      if (!existing) {
        map.set(key, {
          _key: key,
          name,
          brand,
          stock,
          _variants: [{ id: Number(it?.id ?? 0), mrp, expiry_date: it?.expiry_date ?? null, stock }],
        })
      } else {
        existing.stock += stock
        existing._variants.push({
          id: Number(it?.id ?? 0),
          mrp,
          expiry_date: it?.expiry_date ?? null,
          stock,
        })
      }
    }

    const aggregated = Array.from(map.values())
    const lows = aggregated
      .filter((it) => Number(it.stock || 0) <= LOW_STOCK_THRESH)
      .sort((a, b) => a.name.localeCompare(b.name))

    return { lowStockItems: lows, lowStockCount: lows.length }
  }, [qInv.data])

  // ---- Expiring Soon (≤ 60 days) ----
  const { expiringSoonItems, expiringSoonCount } = useMemo(() => {
    const items = (qInv.data || []) as any[]
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    function daysUntil(exp: string | null | undefined) {
      if (!exp) return Infinity
      const d = new Date(String(exp).length <= 10 ? `${exp}T00:00:00` : String(exp))
      if (isNaN(d.getTime())) return Infinity
      d.setHours(0, 0, 0, 0)
      return Math.ceil((d.getTime() - today.getTime()) / 86400000)
    }

    const soon = items
      .map((it: any) => ({ ...it, _daysLeft: daysUntil(it.expiry_date) }))
      .filter((it: any) => it._daysLeft >= 0 && it._daysLeft <= EXPIRY_WINDOW_DAYS)
      .sort((a: any, b: any) => a._daysLeft - b._daysLeft)

    return { expiringSoonItems: soon, expiringSoonCount: soon.length }
  }, [qInv.data])

  const cardBase = {
    p: 2.5,
    borderRadius: 3,
    height: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    justifyContent: 'space-between',
    gap: 0.5,
    boxShadow: '0 18px 40px rgba(0,0,0,0.04)',
    bgcolor: 'rgba(255,255,255,0.96)',
    backdropFilter: 'blur(4px)',
  }

  // -------------------- Cashbook mutations --------------------
  const mAddCashbook = useMutation({
    mutationFn: () =>
      createCashbookEntry({
        entry_type: cbType,
        amount: Number(cbAmount || 0),
        note: cbNote?.trim() ? cbNote.trim() : undefined,
      }),
    onSuccess: () => {
      setCbAmount('')
      setCbNote('')
      setOpenCashbook(false)
      qc.invalidateQueries({ queryKey: ['dash-cashbook'] })
      // also affects net row
      qc.invalidateQueries({ queryKey: ['dash-collected'] })
      qc.invalidateQueries({ queryKey: ['dash-returns'] })
    },
  })

  const mClearCashbook = useMutation({
    mutationFn: clearCashbookToday,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dash-cashbook'] })
      qc.invalidateQueries({ queryKey: ['dash-cashbook-history'] })
      qc.invalidateQueries({ queryKey: ['dash-cashbook-history-summary'] })
    },
  })

  const canAddCashbook = Number(cbAmount || 0) > 0 && !mAddCashbook.isPending

  return (
    <Stack gap={2}>
      <Stack direction="row" alignItems="baseline" justifyContent="space-between" flexWrap="wrap" gap={1}>
        <Typography variant="h5" sx={{ fontWeight: 600 }}>
          Quick Overview
        </Typography>
      </Stack>

      <Grid container spacing={2} alignItems="stretch">
        {showMoneyCards && (
          <>
            {/* Billed Today */}
            <Grid item xs={12} sm={6} md={3}>
              <Paper sx={cardBase}>
                <Typography variant="subtitle2" color="text.secondary">
                  Billed Today
                </Typography>
                <Typography variant="h5" sx={{ fontWeight: 700 }}>
                  ₹{billedToday.toFixed(2)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Includes credit bills (this is billing value, not cash received)
                </Typography>
              </Paper>
            </Grid>

            {/* Collected Today */}
            <Grid item xs={12} sm={6} md={3}>
              <Paper
                sx={{
                  ...cardBase,
                  cursor: 'pointer',
                  '&:hover': { bgcolor: 'rgba(255,255,255,1)', boxShadow: '0 20px 45px rgba(0,0,0,0.06)' },
                }}
                onClick={() => setOpenCollectedBreakdown(true)}
              >
                <Typography variant="subtitle2" color="text.secondary">
                  Collected Today
                </Typography>
                <Typography variant="h5" sx={{ fontWeight: 700 }}>
                  ₹{collectedTodayTotal.toFixed(2)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Cash ₹{collectedTodayCash.toFixed(2)} • Online ₹{collectedTodayOnline.toFixed(2)}
                </Typography>
              </Paper>
            </Grid>

            {/* Credit Pending (All dates) */}
            <Grid item xs={12} sm={6} md={3}>
              <Paper sx={cardBase}>
                <Typography variant="subtitle2" color="text.secondary">
                  Credit Pending
                </Typography>
                <Typography variant="h5" sx={{ fontWeight: 700 }}>
                  ₹{creditPendingAllDates.toFixed(2)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Total outstanding (all dates)
                </Typography>
              </Paper>
            </Grid>

            {/* Returns Today */}
            <Grid item xs={12} sm={6} md={3}>
              <Paper sx={cardBase}>
                <Typography variant="subtitle2" color="text.secondary">
                  Returns Today
                </Typography>
                <Typography variant="h5" sx={{ fontWeight: 700 }}>
                  ₹{returnsTodayTotal.toFixed(2)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Refunds: Cash ₹{returnsTodayCash.toFixed(2)} • Online ₹{returnsTodayOnline.toFixed(2)}
                </Typography>
              </Paper>
            </Grid>

            {/* ✅ Cash Out Today (Withdrawal + Expense) */}
            <Grid item xs={12} sm={6} md={3}>
              <Paper sx={cardBase}>
                <Stack direction="row" alignItems="baseline" justifyContent="space-between">
                  <Typography variant="subtitle2" color="text.secondary">
                    Cash Out Today
                  </Typography>

                  <Stack direction="row" gap={1}>
                    <Button
                      size="small"
                      onClick={() => {
                        // default range = today when opening
                        setHistFrom(from)
                        setHistTo(to)
                        setOpenCashbookHistory(true)
                      }}
                    >
                      History
                    </Button>
                    <Button size="small" onClick={() => setOpenCashbook(true)}>
                      Add
                    </Button>
                  </Stack>
                </Stack>

                <Typography variant="h5" sx={{ fontWeight: 700 }}>
                  ₹{cashOutTodayTotal.toFixed(2)}
                </Typography>

                <Stack direction="row" gap={1} flexWrap="wrap">
                  <Typography variant="caption" color="text.secondary">
                    Withdrawal ₹{cashOutTodayWithdrawals.toFixed(2)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    •
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Expense ₹{cashOutTodayExpenses.toFixed(2)}
                  </Typography>
                </Stack>

                <Stack direction="row" justifyContent="flex-end" mt={0.5}>
                  <Button
                    size="small"
                    color="error"
                    onClick={() => {
                      const ok = window.confirm("Clear ONLY today's withdrawals/expenses? This cannot be undone.")
                      if (!ok) return
                      mClearCashbook.mutate()
                    }}
                    disabled={mClearCashbook.isPending}
                  >
                    Clear Today
                  </Button>

                </Stack>
              </Paper>
            </Grid>

            {/* Net row */}
            <Grid item xs={12}>
              <Paper sx={{ ...cardBase, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Stack>
                  <Typography variant="subtitle2" color="text.secondary">
                    Net Today (Collected − Refunds − Cash Out)
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Helps you match cash drawer and online settlement for the day.
                  </Typography>
                </Stack>

                <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} alignItems={{ sm: 'center' }}>
                  <Typography variant="body2">
                    Cash: <b>₹{netCashInHandToday.toFixed(2)}</b>
                  </Typography>
                  <Typography variant="body2">
                    Online: <b>₹{netOnlineToday.toFixed(2)}</b>
                  </Typography>
                  <Typography variant="body2">
                    Total: <b>₹{netTotalToday.toFixed(2)}</b>
                  </Typography>
                </Stack>
              </Paper>
            </Grid>
          </>
        )}

        {/* Always visible cards */}
        <Grid item xs={12} sm={6} md={3}>
          <Tooltip title="Click to view low stock details">
            <Paper
              sx={{
                ...cardBase,
                cursor: 'pointer',
                '&:hover': { bgcolor: 'rgba(255,255,255,1)', boxShadow: '0 20px 45px rgba(0,0,0,0.06)' },
              }}
              onClick={() => setOpenLow(true)}
            >
              <Typography variant="subtitle2" color="text.secondary">
                Low Stock
              </Typography>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>
                {lowStockCount} items
              </Typography>
            </Paper>
          </Tooltip>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Tooltip title={`Items expiring within ${EXPIRY_WINDOW_DAYS} days`}>
            <Paper
              sx={{
                ...cardBase,
                cursor: 'pointer',
                '&:hover': { bgcolor: 'rgba(255,255,255,1)', boxShadow: '0 20px 45px rgba(0,0,0,0.06)' },
              }}
              onClick={() => setOpenExp(true)}
            >
              <Typography variant="subtitle2" color="text.secondary">
                Expiring Soon
              </Typography>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>
                {expiringSoonCount} items
              </Typography>
            </Paper>
          </Tooltip>
        </Grid>
      </Grid>

      {/* ✅ Cashbook Add Dialog */}
      <Dialog open={openCashbook} onClose={() => setOpenCashbook(false)} fullWidth maxWidth="xs">
        <DialogTitle>Add Withdrawal / Expense</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} mt={1}>
            <TextField
              select
              label="Type"
              value={cbType}
              onChange={(e) => setCbType((e.target.value as any) || 'EXPENSE')}
              fullWidth
            >
              <MenuItem value="EXPENSE">Expense (Tea, etc.)</MenuItem>
              <MenuItem value="WITHDRAWAL">Withdrawal (Cash taken out)</MenuItem>
            </TextField>

            <TextField
              label="Amount"
              type="number"
              value={cbAmount}
              onChange={(e) => setCbAmount(e.target.value)}
              fullWidth
              inputProps={{ min: 0, step: '0.01' }}
            />

            <TextField label="Note (optional)" value={cbNote} onChange={(e) => setCbNote(e.target.value)} fullWidth />

            <Stack direction="row" justifyContent="flex-end" gap={1} mt={1}>
              <Button onClick={() => setOpenCashbook(false)}>Cancel</Button>
              <Button variant="contained" onClick={() => mAddCashbook.mutate()} disabled={!canAddCashbook}>
                {mAddCashbook.isPending ? 'Saving...' : 'Save'}
              </Button>
            </Stack>
          </Stack>
        </DialogContent>
      </Dialog>

      {/* ✅ Cashbook History Dialog */}
      <Dialog open={openCashbookHistory} onClose={() => setOpenCashbookHistory(false)} fullWidth maxWidth="md">
        <DialogTitle>Withdrawals / Expenses History</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label="From"
                type="date"
                value={histFrom}
                onChange={(e) => setHistFrom(e.target.value)}
                InputLabelProps={{ shrink: true }}
                fullWidth
              />
              <TextField
                label="To"
                type="date"
                value={histTo}
                onChange={(e) => setHistTo(e.target.value)}
                InputLabelProps={{ shrink: true }}
                fullWidth
              />
            </Stack>

            <Paper sx={{ p: 1.5, borderRadius: 2, bgcolor: 'rgba(255,255,255,0.92)' }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} justifyContent="space-between">
                <Typography variant="body2">
                  Total: <b>₹{to2(qCashbookHistorySummary.data?.cash_out).toFixed(2)}</b>
                </Typography>
                <Typography variant="body2">
                  Withdrawals: <b>₹{to2(qCashbookHistorySummary.data?.withdrawals).toFixed(2)}</b>
                </Typography>
                <Typography variant="body2">
                  Expenses: <b>₹{to2(qCashbookHistorySummary.data?.expenses).toFixed(2)}</b>
                </Typography>
                <Typography variant="body2">
                  Count: <b>{qCashbookHistorySummary.data?.count ?? 0}</b>
                </Typography>
              </Stack>
            </Paper>

            {qCashbookHistory.isLoading ? (
              <Typography color="text.secondary">Loading…</Typography>
            ) : (qCashbookHistory.data || []).length === 0 ? (
              <Typography color="text.secondary">No entries in selected range.</Typography>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Date/Time</TableCell>
                    <TableCell>Type</TableCell>
                    <TableCell>Note</TableCell>
                    <TableCell align="right">Amount</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(qCashbookHistory.data as CashbookEntry[]).map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{String(r.created_at).replace('T', ' ')}</TableCell>
                      <TableCell>{r.entry_type}</TableCell>
                      <TableCell>{r.note || '-'}</TableCell>
                      <TableCell align="right">₹{to2(r.amount).toFixed(2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            <Stack direction="row" justifyContent="flex-end" mt={1}>
              <Button onClick={() => setOpenCashbookHistory(false)}>Close</Button>
            </Stack>
          </Stack>
        </DialogContent>
      </Dialog>

      {/* Collected Today breakdown dialog */}
      <Dialog open={openCollectedBreakdown} onClose={() => setOpenCollectedBreakdown(false)} fullWidth maxWidth="xs">
        <DialogTitle>Collected Today (Breakdown)</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} mt={1}>
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2" color="text.secondary">
                Cash
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                ₹{collectedTodayCash.toFixed(2)}
              </Typography>
            </Stack>

            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2" color="text.secondary">
                Online
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                ₹{collectedTodayOnline.toFixed(2)}
              </Typography>
            </Stack>

            <Divider />

            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2" color="text.secondary">
                Total Collected
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 800 }}>
                ₹{collectedTodayTotal.toFixed(2)}
              </Typography>
            </Stack>

            <Stack direction="row" justifyContent="space-between" mt={1}>
              <Typography variant="body2" color="text.secondary">
                Returns Today (Refunds)
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                ₹{returnsTodayTotal.toFixed(2)}
              </Typography>
            </Stack>

            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2" color="text.secondary">
                Cash Out Today
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                ₹{cashOutTodayTotal.toFixed(2)}
              </Typography>
            </Stack>

            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2" color="text.secondary">
                Net (Collected − Refunds − Cash Out)
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 800 }}>
                ₹{netTotalToday.toFixed(2)}
              </Typography>
            </Stack>
          </Stack>

          <Stack alignItems="flex-end" mt={2}>
            <Button onClick={() => setOpenCollectedBreakdown(false)}>Close</Button>
          </Stack>
        </DialogContent>
      </Dialog>

      {/* Low Stock dialog */}
      <Dialog open={openLow} onClose={() => setOpenLow(false)} fullWidth maxWidth="sm">
        <DialogTitle>Low Stock Items (≤ {LOW_STOCK_THRESH})</DialogTitle>
        <DialogContent>
          {lowStockItems.length === 0 ? (
            <Typography color="text.secondary" p={1}>
              All items are sufficiently stocked.
            </Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Brand</TableCell>
                  <TableCell align="right">Stock</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {lowStockItems.map((it: any) => (
                  <TableRow key={it._key}>
                    <TableCell>{it.name}</TableCell>
                    <TableCell>{it.brand || '-'}</TableCell>
                    <TableCell align="right" sx={{ color: 'error.main' }}>
                      {it.stock}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Stack alignItems="flex-end" p={1}>
            <Button onClick={() => setOpenLow(false)}>Close</Button>
          </Stack>
        </DialogContent>
      </Dialog>

      {/* Expiring Soon dialog */}
      <Dialog open={openExp} onClose={() => setOpenExp(false)} fullWidth maxWidth="md">
        <DialogTitle>Expiring Soon (≤ {EXPIRY_WINDOW_DAYS} days)</DialogTitle>
        <DialogContent>
          {expiringSoonItems.length === 0 ? (
            <Typography color="text.secondary" p={1}>
              No items expiring soon.
            </Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Brand</TableCell>
                  <TableCell>Expiry</TableCell>
                  <TableCell>Qty</TableCell>
                  <TableCell align="right">Days Left</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {expiringSoonItems.map((it: any) => (
                  <TableRow key={it._key}>
                    <TableCell>{it.name}</TableCell>
                    <TableCell>{it.brand || '-'}</TableCell>
                    <TableCell>{formatExpiry(it.expiry_date)}</TableCell>
                    <TableCell>{it.stock || '-'}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>
                      {it._daysLeft}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Stack alignItems="flex-end" p={1}>
            <Button onClick={() => setOpenExp(false)}>Close</Button>
          </Stack>
        </DialogContent>
      </Dialog>
    </Stack>
  )
}
