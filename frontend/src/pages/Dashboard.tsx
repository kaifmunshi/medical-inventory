// F:\medical-inventory\frontend\src\pages\Dashboard.tsx
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
} from '@mui/material'
import { useQuery } from '@tanstack/react-query'
import { listBills, getPaymentsSummary } from '../services/billing'
import { listReturns } from '../services/returns'
import { listItems } from '../services/inventory'
import { todayRange } from '../lib/date'

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

  const creditPending = useMemo(() => {
    /**
     * "Credit Pending" = outstanding amount across ALL dates.
     * = sum(max(0, total_amount - paid_amount)) for bills not fully paid.
     *
     * NOTE: We only have today's bills loaded in qBills,
     * so we fetch all bills once with a bigger limit using a separate query below.
     * (This keeps meaning correct: "all dates" pending.)
     */
    return 0
  }, [])

  const collectedTodayCash = to2(qCollected.data?.cash_collected)
  const collectedTodayOnline = to2(qCollected.data?.online_collected)
  const collectedTodayTotal = to2(qCollected.data?.total_collected)

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
     * cash collected today - cash refunds today
     * (This is what physically remains in cash drawer due to today's movements.)
     */
    return to2(collectedTodayCash - returnsTodayCash)
  }, [collectedTodayCash, returnsTodayCash])

  const netOnlineToday = useMemo(() => {
    /**
     * Net Online Today:
     * online collected today - online refunds today
     */
    return to2(collectedTodayOnline - returnsTodayOnline)
  }, [collectedTodayOnline, returnsTodayOnline])

  const netTotalToday = useMemo(() => {
    /**
     * Net Total Today:
     * total collected today - total refunds today
     */
    return to2(collectedTodayTotal - returnsTodayTotal)
  }, [collectedTodayTotal, returnsTodayTotal])

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

            {/* Net (optional small explanation row) */}
            <Grid item xs={12}>
              <Paper sx={{ ...cardBase, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Stack>
                  <Typography variant="subtitle2" color="text.secondary">
                    Net Today (Collected − Refunds)
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
                Net (Collected − Refunds)
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