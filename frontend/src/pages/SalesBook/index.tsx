import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableFooter,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import { useQuery } from '@tanstack/react-query'
import { last15DaysRange, toYMD } from '../../lib/date'
import { listBills, listPayments } from '../../services/billing'
import { listReturns } from '../../services/returns'
import { listCashbookEntries } from '../../services/cashbook'
import { fetchPurchases } from '../../services/purchases'

type DayRow = {
  date: string
  billed: number
  cash: number
  online: number
  collected: number
  credit: number
  returns: number
  purchases: number
  expenses: number
  withdrawals: number
  outflow: number
  netCash: number
  netOnline: number
  net: number
}

type ViewMode = 'daily' | 'weekly' | 'monthly'
type DisplayRow = DayRow & {
  sortKey: string
  title: string
  subtitle: string
}

function money(n: number | string | null | undefined) {
  return Number(n || 0).toFixed(2)
}

function to2(n: number) {
  return Math.round(Number(n || 0) * 100) / 100
}

type BreakdownLine = { label: string; value: number }

function formatDateLabel(ymd: string) {
  const dt = new Date(`${ymd}T00:00:00`)
  if (Number.isNaN(dt.getTime())) return { weekday: '', date: ymd }
  return {
    weekday: dt.toLocaleDateString('en-IN', { weekday: 'short' }).toUpperCase(),
    date: dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
  }
}

function BreakdownCell(props: {
  totalLabel: string
  total: number
  lines: BreakdownLine[]
  totalColor?: string
  compact?: boolean
}) {
  const totalSize = props.compact ? 14 : 15
  const lineSize = props.compact ? 11 : 12
  return (
    <Stack alignItems="flex-start" spacing={props.compact ? 0.125 : 0.25}>
      <Typography sx={{ fontSize: totalSize, fontWeight: 800, color: props.totalColor || 'text.primary' }}>
        {props.totalLabel}: ₹{money(props.total)}
      </Typography>
      {props.lines.map((x) => (
        <Typography key={x.label} sx={{ fontSize: lineSize, color: 'text.secondary' }}>
          {x.label}: ₹{money(x.value)}
        </Typography>
      ))}
    </Stack>
  )
}

function addDaysYmd(ymd: string, days: number) {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, (m || 1) - 1, d || 1)
  dt.setDate(dt.getDate() + days)
  return toYMD(dt)
}

function startOfWeekYmd(ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, (m || 1) - 1, d || 1)
  const day = dt.getDay()
  const diff = day === 0 ? -6 : 1 - day
  dt.setDate(dt.getDate() + diff)
  return toYMD(dt)
}

function endOfWeekYmd(start: string) {
  return addDaysYmd(start, 6)
}

function monthStartYmd(ymd: string) {
  return `${ymd.slice(0, 7)}-01`
}

function monthEndYmd(start: string) {
  const [y, m] = start.split('-').map(Number)
  const dt = new Date(y, m, 0)
  return toYMD(dt)
}

function monthLabel(ymd: string) {
  const dt = new Date(`${ymd}T00:00:00`)
  return dt.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
}

async function fetchAllBills(from_date: string, to_date: string) {
  const out: any[] = []
  const limit = 500
  let offset = 0
  while (true) {
    const rows = await listBills({ from_date, to_date, limit, offset, deleted_filter: 'active' })
    out.push(...(rows || []))
    if (!rows || rows.length < limit) break
    offset += limit
  }
  return out
}

async function fetchAllPayments(from_date: string, to_date: string) {
  const out: any[] = []
  const limit = 500
  let offset = 0
  while (true) {
    const rows = await listPayments({ from_date, to_date, limit, offset })
    out.push(...(rows || []))
    if (!rows || rows.length < limit) break
    offset += limit
  }
  return out
}

async function fetchAllReturns(from_date: string, to_date: string) {
  const out: any[] = []
  const limit = 500
  let offset = 0
  while (true) {
    const rows = await listReturns({ from_date, to_date, limit, offset })
    out.push(...(rows || []))
    if (!rows || rows.length < limit) break
    offset += limit
  }
  return out
}

async function fetchAllCashbook(from_date: string, to_date: string) {
  const out: any[] = []
  const limit = 500
  let offset = 0
  while (true) {
    const rows = await listCashbookEntries({ from_date, to_date, limit, offset })
    out.push(...(rows || []))
    if (!rows || rows.length < limit) break
    offset += limit
  }
  return out
}

async function fetchAllPurchases(from_date: string, to_date: string) {
  const out: any[] = []
  const limit = 500
  let offset = 0
  while (true) {
    const rows = await fetchPurchases({ from_date, to_date, limit, offset })
    out.push(...(rows || []))
    if (!rows || rows.length < limit) break
    offset += limit
  }
  return out
}

export default function SalesBookPage() {
  const r = useMemo(() => last15DaysRange(), [])
  const [from, setFrom] = useState(r.from)
  const [to, setTo] = useState(r.to)
  const [viewMode, setViewMode] = useState<ViewMode>('daily')
  const [density, setDensity] = useState<'compact' | 'comfortable'>('comfortable')
  const [dateSort, setDateSort] = useState<'asc' | 'desc'>('asc')
  const validRange = Boolean(from && to && from <= to)

  const qBills = useQuery({
    queryKey: ['sales-book-bills', from, to],
    queryFn: () => fetchAllBills(from, to),
    enabled: validRange,
  })

  const qPayments = useQuery({
    queryKey: ['sales-book-payments', from, to],
    queryFn: () => fetchAllPayments(from, to),
    enabled: validRange,
  })

  const qReturns = useQuery({
    queryKey: ['sales-book-returns', from, to],
    queryFn: () => fetchAllReturns(from, to),
    enabled: validRange,
  })

  const qCashbook = useQuery({
    queryKey: ['sales-book-cashbook', from, to],
    queryFn: () => fetchAllCashbook(from, to),
    enabled: validRange,
  })

  const qPurchases = useQuery({
    queryKey: ['sales-book-purchases', from, to],
    queryFn: () => fetchAllPurchases(from, to),
    enabled: validRange,
  })

  const loading = qBills.isLoading || qPayments.isLoading || qReturns.isLoading || qCashbook.isLoading || qPurchases.isLoading

  const rows = useMemo(() => {
    if (!validRange) return [] as DayRow[]

    const billsMap = new Map<string, { billed: number; credit: number }>()
    const paymentsMap = new Map<string, { cash: number; online: number }>()
    const returnsMap = new Map<string, number>()
    const purchaseMap = new Map<string, number>()
    const cashbookMap = new Map<string, { expenses: number; withdrawals: number }>()

    for (const b of (qBills.data || []) as any[]) {
      const d = String(b?.date_time || '').slice(0, 10)
      if (!d) continue
      const total = Number(b?.total_amount || 0)
      const isCredit = Boolean(b?.is_credit) || String(b?.payment_mode || '').toLowerCase() === 'credit'
      const prev = billsMap.get(d) || { billed: 0, credit: 0 }
      prev.billed += total
      if (isCredit) prev.credit += total
      billsMap.set(d, prev)
    }

    for (const p of (qPayments.data || []) as any[]) {
      const d = String(p?.received_at || '').slice(0, 10)
      if (!d) continue
      const prev = paymentsMap.get(d) || { cash: 0, online: 0 }
      prev.cash += Number(p?.cash_amount || 0)
      prev.online += Number(p?.online_amount || 0)
      paymentsMap.set(d, prev)
    }

    for (const r0 of (qReturns.data || []) as any[]) {
      const d = String(r0?.date_time || '').slice(0, 10)
      if (!d) continue
      const prev = returnsMap.get(d) || 0
      returnsMap.set(d, prev + Number(r0?.refund_cash || 0) + Number(r0?.refund_online || 0))
    }

    for (const purchase of (qPurchases.data || []) as any[]) {
      const d = String(purchase?.invoice_date || '').slice(0, 10)
      if (!d) continue
      const prev = purchaseMap.get(d) || 0
      purchaseMap.set(d, prev + Number(purchase?.total_amount || 0))
    }

    for (const c of (qCashbook.data || []) as any[]) {
      const d = String(c?.created_at || '').slice(0, 10)
      if (!d) continue
      const t = String(c?.entry_type || '').toUpperCase()
      const prev = cashbookMap.get(d) || { expenses: 0, withdrawals: 0 }
      if (t === 'EXPENSE') prev.expenses += Number(c?.amount || 0)
      if (t === 'WITHDRAWAL') prev.withdrawals += Number(c?.amount || 0)
      cashbookMap.set(d, prev)
    }

    const out: DayRow[] = []
    for (let d = from; d <= to; d = addDaysYmd(d, 1)) {
      const b = billsMap.get(d) || { billed: 0, credit: 0 }
      const p = paymentsMap.get(d) || { cash: 0, online: 0 }
      const rt = returnsMap.get(d) || 0
      const purchaseAmount = purchaseMap.get(d) || 0
      const cb = cashbookMap.get(d) || { expenses: 0, withdrawals: 0 }
      const collected = p.cash + p.online
      const returnsCashOnline = rt
      const cashOut = cb.expenses + cb.withdrawals
      const pnl = b.billed - returnsCashOnline - cb.expenses - purchaseAmount

      out.push({
        date: d,
        billed: to2(b.billed),
        cash: to2(p.cash),
        online: to2(p.online),
        collected: to2(collected),
        credit: to2(b.credit),
        returns: to2(returnsCashOnline),
        purchases: to2(purchaseAmount),
        expenses: to2(cb.expenses),
        withdrawals: to2(cb.withdrawals),
        outflow: to2(returnsCashOnline + cb.expenses + cb.withdrawals + purchaseAmount),
        netCash: to2(p.cash - returnsCashOnline - cashOut),
        netOnline: to2(p.online),
        net: to2(pnl),
      })
    }
    return out
  }, [validRange, from, to, qBills.data, qPayments.data, qReturns.data, qCashbook.data, qPurchases.data])

  const displayRows = useMemo(() => {
    if (viewMode === 'daily') {
      return rows.map((row) => {
        const dateLabel = formatDateLabel(row.date)
        return {
          ...row,
          sortKey: row.date,
          title: dateLabel.date,
          subtitle: dateLabel.weekday,
        }
      })
    }

    const grouped = new Map<string, DisplayRow>()
    for (const row of rows) {
      const sortKey = viewMode === 'weekly' ? startOfWeekYmd(row.date) : monthStartYmd(row.date)
      const existing = grouped.get(sortKey)
      if (!existing) {
        grouped.set(sortKey, {
          ...row,
          sortKey,
          title: viewMode === 'weekly' ? `Week of ${formatDateLabel(sortKey).date}` : monthLabel(sortKey),
          subtitle:
            viewMode === 'weekly'
              ? `${formatDateLabel(sortKey).date} - ${formatDateLabel(endOfWeekYmd(sortKey)).date}`
              : `${formatDateLabel(sortKey).date} - ${formatDateLabel(monthEndYmd(sortKey)).date}`,
        })
        continue
      }
      existing.billed = to2(existing.billed + row.billed)
      existing.cash = to2(existing.cash + row.cash)
      existing.online = to2(existing.online + row.online)
      existing.collected = to2(existing.collected + row.collected)
      existing.credit = to2(existing.credit + row.credit)
      existing.returns = to2(existing.returns + row.returns)
      existing.purchases = to2(existing.purchases + row.purchases)
      existing.expenses = to2(existing.expenses + row.expenses)
      existing.withdrawals = to2(existing.withdrawals + row.withdrawals)
      existing.outflow = to2(existing.outflow + row.outflow)
      existing.netCash = to2(existing.netCash + row.netCash)
      existing.netOnline = to2(existing.netOnline + row.netOnline)
      existing.net = to2(existing.net + row.net)
    }
    return Array.from(grouped.values())
  }, [rows, viewMode])

  const totals = useMemo(() => {
    let billed = 0
    let cash = 0
    let online = 0
    let collected = 0
    let credit = 0
    let returns = 0
    let purchases = 0
    let expenses = 0
    let withdrawals = 0
    let outflow = 0
    let netCash = 0
    let netOnline = 0
    let net = 0
    for (const r0 of displayRows) {
      billed += r0.billed
      cash += r0.cash
      online += r0.online
      collected += r0.collected
      credit += r0.credit
      returns += r0.returns
      purchases += r0.purchases
      expenses += r0.expenses
      withdrawals += r0.withdrawals
      outflow += r0.outflow
      netCash += r0.netCash
      netOnline += r0.netOnline
      net += r0.net
    }
    return {
      billed: to2(billed),
      cash: to2(cash),
      online: to2(online),
      collected: to2(collected),
      credit: to2(credit),
      returns: to2(returns),
      purchases: to2(purchases),
      expenses: to2(expenses),
      withdrawals: to2(withdrawals),
      outflow: to2(outflow),
      netCash: to2(netCash),
      netOnline: to2(netOnline),
      net: to2(net),
    }
  }, [displayRows])

  const sortedRows = useMemo(() => {
    const copy = [...displayRows]
    copy.sort((a, b) =>
      dateSort === 'asc' ? a.sortKey.localeCompare(b.sortKey) : b.sortKey.localeCompare(a.sortKey)
    )
    return copy
  }, [displayRows, dateSort])

  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            Sales Book
          </Typography>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            sx={{ ml: { sm: 'auto' }, width: { sm: '100%' }, alignItems: { sm: 'center' } }}
          >
            <TextField
              label="From"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              InputLabelProps={{ shrink: true }}
              size="small"
            />
            <TextField
              label="To"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              InputLabelProps={{ shrink: true }}
              size="small"
            />
            <Box sx={{ display: { xs: 'none', sm: 'block' }, flexGrow: 1 }} />
            <ToggleButtonGroup
              size="small"
              value={viewMode}
              exclusive
              onChange={(_, value) => value && setViewMode(value)}
            >
              <ToggleButton value="daily">Day</ToggleButton>
              <ToggleButton value="weekly">Week</ToggleButton>
              <ToggleButton value="monthly">Month</ToggleButton>
            </ToggleButtonGroup>
            <Stack direction="row" spacing={0.75} sx={{ ml: { sm: 'auto' } }}>
              <Button
                size="small"
                variant={density === 'compact' ? 'contained' : 'outlined'}
                onClick={() => setDensity('compact')}
              >
                Compact
              </Button>
              <Button
                size="small"
                variant={density === 'comfortable' ? 'contained' : 'outlined'}
                onClick={() => setDensity('comfortable')}
              >
                Comfortable
              </Button>
            </Stack>
          </Stack>
        </Stack>
        {!validRange ? (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            Please select a valid date range.
          </Alert>
        ) : null}
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} flexWrap="wrap" useFlexGap>
          <Chip label={`Sales ₹${money(totals.billed)}`} />
          <Chip label={`Purchases ₹${money(totals.purchases)}`} color="warning" />
          <Chip label={`Collections ₹${money(totals.collected)}`} color="success" />
          <Chip label={`Outflow ₹${money(totals.outflow)}`} color="warning" />
          <Chip label={`P&L ₹${money(totals.net)}`} color={totals.net < 0 ? 'error' : 'primary'} />
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        {loading ? (
          <Typography color="text.secondary">Loading sales book...</Typography>
        ) : (
          <TableContainer sx={{ maxHeight: 560 }}>
            <Table
              size="small"
              stickyHeader
              sx={{
                tableLayout: 'fixed',
                width: '100%',
                '& th, & td': { px: 2 },
              }}
            >
              <colgroup>
                <col style={{ width: '18%' }} />
                <col style={{ width: '24%' }} />
                <col style={{ width: '29%' }} />
                <col style={{ width: '29%' }} />
              </colgroup>
              <TableHead>
                <TableRow>
                  <TableCell
                    sx={{ bgcolor: '#f3f6f9', fontWeight: 800, position: 'sticky', left: 0, zIndex: 4 }}
                  >
                    <TableSortLabel
                      active
                      direction={dateSort}
                      onClick={() => setDateSort((s) => (s === 'asc' ? 'desc' : 'asc'))}
                    >
                      Date
                    </TableSortLabel>
                  </TableCell>
                  <TableCell sx={{ bgcolor: '#eef5ff', fontWeight: 800 }}>
                    Sales/Collection
                  </TableCell>
                  <TableCell sx={{ bgcolor: '#fff8e8', fontWeight: 800 }}>
                    Outflow
                  </TableCell>
                  <TableCell sx={{ bgcolor: '#edf4ff', fontWeight: 800 }}>
                    Net
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {sortedRows.map((r0, idx) => (
                  <TableRow
                    key={r0.date}
                    hover
                    sx={{
                      bgcolor: idx % 2 === 0 ? 'rgba(15,23,42,0.015)' : 'transparent',
                      '& td': { py: density === 'compact' ? 0.75 : 1.25 },
                    }}
                  >
                    <TableCell
                      sx={{
                        position: 'sticky',
                        left: 0,
                        zIndex: 2,
                        bgcolor: idx % 2 === 0 ? 'rgba(245,247,250,1)' : 'rgba(255,255,255,1)',
                        fontWeight: 700,
                      }}
                    >
                      <Stack spacing={0.125}>
                        <Typography sx={{ fontSize: 11, color: 'text.secondary', fontWeight: 700 }}>
                          {r0.subtitle}
                        </Typography>
                        <Typography sx={{ fontSize: 13, fontWeight: 800 }}>
                          {r0.title}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <BreakdownCell
                        totalLabel="Sales"
                        total={r0.billed}
                        compact={density === 'compact'}
                        lines={[
                          { label: 'Collected', value: r0.collected },
                          { label: 'Credit', value: r0.credit },
                          { label: 'Cash', value: r0.cash },
                          { label: 'Online', value: r0.online },
                        ]}
                      />
                    </TableCell>
                    <TableCell>
                      <BreakdownCell
                        totalLabel="Outflow"
                        total={r0.outflow}
                        compact={density === 'compact'}
                        lines={[
                          { label: 'Returns', value: r0.returns },
                          { label: 'Purchases', value: r0.purchases },
                          { label: 'Expenses', value: r0.expenses },
                          { label: 'Withdrawals', value: r0.withdrawals },
                        ]}
                      />
                    </TableCell>
                    <TableCell>
                      <Stack alignItems="flex-start" spacing={density === 'compact' ? 0.125 : 0.25}>
                        <Chip
                          size="small"
                          label={r0.net < 0 ? 'LOSS' : 'PROFIT'}
                          sx={{
                            height: density === 'compact' ? 20 : 22,
                            fontWeight: 800,
                            bgcolor: r0.net < 0 ? 'rgba(211,47,47,0.12)' : 'rgba(46,125,50,0.12)',
                            color: r0.net < 0 ? '#d32f2f' : '#2e7d32',
                          }}
                        />
                        <BreakdownCell
                          totalLabel="P&L"
                          total={r0.net}
                          compact={density === 'compact'}
                          totalColor={r0.net < 0 ? '#d32f2f' : '#2e7d32'}
                          lines={[
                            { label: 'Cash Flow', value: r0.netCash },
                            { label: 'Online Flow', value: r0.netOnline },
                          ]}
                        />
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell sx={{ position: 'sticky', left: 0, zIndex: 3, bgcolor: '#e8edf2', fontWeight: 900 }}>
                    Total
                  </TableCell>
                  <TableCell sx={{ bgcolor: '#e8edf2' }}>
                    <BreakdownCell
                      totalLabel="Sales"
                      total={totals.billed}
                      compact={density === 'compact'}
                      lines={[
                        { label: 'Collected', value: totals.collected },
                        { label: 'Credit', value: totals.credit },
                        { label: 'Cash', value: totals.cash },
                        { label: 'Online', value: totals.online },
                      ]}
                    />
                  </TableCell>
                  <TableCell sx={{ bgcolor: '#e8edf2' }}>
                    <BreakdownCell
                      totalLabel="Outflow"
                      total={totals.outflow}
                      compact={density === 'compact'}
                      lines={[
                        { label: 'Returns', value: totals.returns },
                        { label: 'Purchases', value: totals.purchases },
                        { label: 'Expenses', value: totals.expenses },
                        { label: 'Withdrawals', value: totals.withdrawals },
                      ]}
                    />
                  </TableCell>
                  <TableCell sx={{ bgcolor: '#e8edf2' }}>
                    <BreakdownCell
                      totalLabel="P&L"
                      total={totals.net}
                      compact={density === 'compact'}
                      totalColor={totals.net < 0 ? '#d32f2f' : '#2e7d32'}
                      lines={[
                        { label: 'Cash Flow', value: totals.netCash },
                        { label: 'Online Flow', value: totals.netOnline },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </TableContainer>
        )}

        <Stack direction="row" justifyContent="flex-end" mt={1.5}>
          <Button
            variant="outlined"
            size="small"
            onClick={() => {
              const d = last15DaysRange()
              setFrom(d.from)
              setTo(d.to)
            }}
          >
            Last 15 Days
          </Button>
        </Stack>
      </Paper>
    </Stack>
  )
}
