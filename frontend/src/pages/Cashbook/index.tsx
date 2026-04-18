import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
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
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableFooter,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import EditIcon from '@mui/icons-material/Edit'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createCashbookEntry,
  deleteCashbookEntry,
  getCashbookDay,
  listCashbookEntries,
  type CashbookType,
} from '../../services/cashbook'
import { getBill, listPayments } from '../../services/billing'
import { listExchangeRecords, listReturns } from '../../services/returns'
import { toYMD } from '../../lib/date'
import BillEditDialog from '../../components/billing/BillEditDialog'

function money(n: number | string | null | undefined) {
  return Number(n || 0).toFixed(2)
}

function isoDate(s: string | null | undefined) {
  const v = String(s || '')
  return v.length >= 10 ? v.slice(0, 10) : '-'
}

function isoTime(s: string | null | undefined) {
  const v = String(s || '')
  return v.length >= 19 ? v.slice(11, 19) : '-'
}

function addDays(ymd: string, days: number) {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, (m || 1) - 1, d || 1)
  dt.setDate(dt.getDate() + days)
  return toYMD(dt)
}

function addMonths(ymd: string, months: number) {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, (m || 1) - 1, d || 1)
  dt.setMonth(dt.getMonth() + months)
  return toYMD(dt)
}

function weekRange(ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, (m || 1) - 1, d || 1)
  const day = dt.getDay() // 0 Sun ... 6 Sat
  const diffToMonday = day === 0 ? -6 : 1 - day
  const start = new Date(dt)
  start.setDate(dt.getDate() + diffToMonday)
  const end = new Date(start)
  end.setDate(start.getDate() + 6)
  return { from: toYMD(start), to: toYMD(end) }
}

function monthRange(ymd: string) {
  const [y, m] = ymd.split('-').map(Number)
  const start = new Date(y, (m || 1) - 1, 1)
  const end = new Date(y, (m || 1), 0)
  return { from: toYMD(start), to: toYMD(end) }
}

function typeLabel(type: string) {
  const t = String(type || '').toUpperCase()
  if (t === 'OPENING') return { text: 'Opn', color: 'text.secondary' as const }
  if (t === 'RETURN') return { text: 'Ret', color: 'warning.dark' as const }
  if (t === 'SPLIT') return { text: 'Spl', color: 'success.dark' as const }
  if (t === 'RECEIPT') return { text: 'Rcpt', color: 'success.dark' as const }
  if (t === 'WITHDRAWAL') return { text: 'Wdl', color: 'warning.dark' as const }
  return { text: 'Exp', color: 'error.dark' as const }
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
  return { discPct, taxPct, factor }
}

function chargedLine(bill: any, mrp: number, qty: number) {
  const { discPct, taxPct, factor } = computeBillProration(bill)
  const lineSub = Number(mrp) * Number(qty)
  const afterDisc = lineSub * (1 - discPct / 100)
  const afterTax = afterDisc * (1 + taxPct / 100)
  return round2(afterTax * factor)
}

export default function CashbookPage() {
  const qc = useQueryClient()
  const today = useMemo(() => toYMD(new Date()), [])
  const [selectedDate, setSelectedDate] = useState(today)
  const [recordsFilter, setRecordsFilter] = useState<'DAY' | 'ALL'>('DAY')
  const [allView, setAllView] = useState<'ALL' | 'WEEK' | 'MONTH'>('ALL')
  const [allAnchorDate, setAllAnchorDate] = useState(today)
  const [debouncedAllAnchorDate, setDebouncedAllAnchorDate] = useState(today)

  const [entryType, setEntryType] = useState<CashbookType>('RECEIPT')
  const [entryDate, setEntryDate] = useState(today)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [billOpen, setBillOpen] = useState(false)
  const [billLoading, setBillLoading] = useState(false)
  const [billDetail, setBillDetail] = useState<any | null>(null)
  const [billEditOpen, setBillEditOpen] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedAllAnchorDate(allAnchorDate), 250)
    return () => clearTimeout(t)
  }, [allAnchorDate])

  useEffect(() => {
    if (recordsFilter === 'DAY') setEntryDate(selectedDate)
  }, [recordsFilter, selectedDate])

  const allRange = useMemo(() => {
    if (allView === 'WEEK') return weekRange(debouncedAllAnchorDate)
    if (allView === 'MONTH') return monthRange(debouncedAllAnchorDate)
    return { from: undefined as string | undefined, to: undefined as string | undefined }
  }, [allView, debouncedAllAnchorDate])

  const qDay = useQuery({
    queryKey: ['cashbook-day', selectedDate],
    queryFn: () => getCashbookDay({ date: selectedDate }),
    enabled: recordsFilter === 'DAY',
  })

  const qDayPayments = useQuery({
    queryKey: ['cashbook-payments-day', selectedDate],
    queryFn: () => listPayments({ from_date: selectedDate, to_date: selectedDate, limit: 500 }),
    enabled: recordsFilter === 'DAY',
  })

  const qDayReturns = useQuery({
    queryKey: ['cashbook-returns-day', selectedDate],
    queryFn: () => listReturns({ from_date: selectedDate, to_date: selectedDate, limit: 500 }),
    enabled: recordsFilter === 'DAY',
  })

  const qDayExchanges = useQuery({
    queryKey: ['cashbook-exchanges-day', selectedDate],
    queryFn: () => listExchangeRecords({ from_date: selectedDate, to_date: selectedDate, limit: 500 }),
    enabled: recordsFilter === 'DAY',
  })

  const qAllCashbook = useQuery({
    queryKey: ['cashbook-all-entries', allView, allRange.from, allRange.to],
    queryFn: async () => {
      const out: any[] = []
      let offset = 0
      const limit = 500
      while (true) {
        const rows = await listCashbookEntries({ from_date: allRange.from, to_date: allRange.to, limit, offset })
        out.push(...(rows || []))
        if (!rows || rows.length < limit) break
        offset += limit
      }
      return out
    },
    enabled: recordsFilter === 'ALL',
  })

  const qAllPayments = useQuery({
    queryKey: ['cashbook-all-payments', allView, allRange.from, allRange.to],
    queryFn: async () => {
      const out: any[] = []
      let offset = 0
      const limit = 500
      while (true) {
        const rows = await listPayments({ from_date: allRange.from, to_date: allRange.to, limit, offset })
        out.push(...(rows || []))
        if (!rows || rows.length < limit) break
        offset += limit
      }
      return out
    },
    enabled: recordsFilter === 'ALL',
  })

  const qAllReturns = useQuery({
    queryKey: ['cashbook-all-returns', allView, allRange.from, allRange.to],
    queryFn: async () => {
      const out: any[] = []
      let offset = 0
      const limit = 500
      while (true) {
        const rows = await listReturns({ from_date: allRange.from, to_date: allRange.to, limit, offset })
        out.push(...(rows || []))
        if (!rows || rows.length < limit) break
        offset += limit
      }
      return out
    },
    enabled: recordsFilter === 'ALL',
  })

  const qAllExchanges = useQuery({
    queryKey: ['cashbook-all-exchanges', allView, allRange.from, allRange.to],
    queryFn: async () => {
      const out: any[] = []
      let offset = 0
      const limit = 500
      while (true) {
        const rows = await listExchangeRecords({ from_date: allRange.from, to_date: allRange.to, limit, offset })
        out.push(...(rows || []))
        if (!rows || rows.length < limit) break
        offset += limit
      }
      return out
    },
    enabled: recordsFilter === 'ALL',
  })

  const mCreate = useMutation({
    mutationFn: () =>
      createCashbookEntry({
        entry_type: entryType,
        amount: Number(amount),
        note: note.trim() || undefined,
        entry_date: entryDate,
      }),
    onSuccess: () => {
      setAmount('')
      setNote('')
      setSelectedDate(entryDate)
      qc.invalidateQueries({ queryKey: ['cashbook-day'] })
      qc.invalidateQueries({ queryKey: ['cashbook-all-entries'] })
      qc.invalidateQueries({ queryKey: ['dash-cashbook'] })
      qc.invalidateQueries({ queryKey: ['dash-cashbook-history'] })
      qc.invalidateQueries({ queryKey: ['dash-cashbook-history-summary'] })
    },
  })

  const mDelete = useMutation({
    mutationFn: (id: number) => deleteCashbookEntry(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cashbook-day', selectedDate] })
      qc.invalidateQueries({ queryKey: ['cashbook-all-entries'] })
      qc.invalidateQueries({ queryKey: ['dash-cashbook'] })
      qc.invalidateQueries({ queryKey: ['dash-cashbook-history'] })
      qc.invalidateQueries({ queryKey: ['dash-cashbook-history-summary'] })
    },
  })

  const day = qDay.data
  const canGoNext = selectedDate < today
  const canSave = Number(amount) > 0 && !!entryDate && !mCreate.isPending
  const canGoAllNext = allAnchorDate < today

  async function openBillDetail(billId: number) {
    if (!Number.isFinite(Number(billId)) || Number(billId) <= 0) return
    setBillOpen(true)
    setBillLoading(true)
    setBillDetail(null)
    try {
      const b = await getBill(Number(billId))
      setBillDetail(b)
    } catch {
      setBillDetail(null)
    } finally {
      setBillLoading(false)
    }
  }

  const billCashRowsDay = useMemo(() => {
    const payments = (qDayPayments.data || []) as any[]
    return payments
      .filter((p) => Number(p?.cash_amount || 0) > 0)
      .map((p) => ({
        id: `pay-${p.id}`,
        created_at: p.received_at,
        entry_type: 'RECEIPT',
        pill_type: p.mode === 'split' ? 'SPLIT' : 'RECEIPT',
        amount: Number(p.cash_amount || 0),
        bill_id: Number(p.bill_id || 0),
        note: `Cash payment for Bill #${p.bill_id}`,
        source: 'BILL' as const,
      }))
  }, [qDayPayments.data])

  const billCashRowsAll = useMemo(() => {
    const payments = (qAllPayments.data || []) as any[]
    return payments
      .filter((p) => Number(p?.cash_amount || 0) > 0)
      .map((p) => ({
        id: `pay-${p.id}`,
        created_at: p.received_at,
        entry_type: 'RECEIPT',
        pill_type: p.mode === 'split' ? 'SPLIT' : 'RECEIPT',
        amount: Number(p.cash_amount || 0),
        bill_id: Number(p.bill_id || 0),
        note: `Cash payment for Bill #${p.bill_id}`,
        source: 'BILL' as const,
      }))
  }, [qAllPayments.data])

  const returnCashRowsDay = useMemo(() => {
    const returns = (qDayReturns.data || []) as any[]
    const exchangeByReturnId = new Map<number, any>()
    for (const ex of (qDayExchanges.data || []) as any[]) {
      exchangeByReturnId.set(Number(ex.return_id), ex)
    }
    return returns
      .filter((r) => Number(r?.refund_cash || 0) > 0)
      .map((r) => ({
        id: `return-${r.id}`,
        created_at: r.date_time,
        entry_type: 'WITHDRAWAL',
        pill_type: exchangeByReturnId.has(Number(r.id)) ? 'RETURN' : undefined,
        amount: Number(r.refund_cash || 0),
        note: exchangeByReturnId.has(Number(r.id))
          ? `Cash refund in exchange #${exchangeByReturnId.get(Number(r.id))?.id ?? ''}`
          : `Cash return #${r.id}`,
        source: 'RETURN' as const,
      }))
  }, [qDayReturns.data, qDayExchanges.data])

  const returnCashRowsAll = useMemo(() => {
    const returns = (qAllReturns.data || []) as any[]
    const exchangeByReturnId = new Map<number, any>()
    for (const ex of (qAllExchanges.data || []) as any[]) {
      exchangeByReturnId.set(Number(ex.return_id), ex)
    }
    return returns
      .filter((r) => Number(r?.refund_cash || 0) > 0)
      .map((r) => ({
        id: `return-${r.id}`,
        created_at: r.date_time,
        entry_type: 'WITHDRAWAL',
        pill_type: exchangeByReturnId.has(Number(r.id)) ? 'RETURN' : undefined,
        amount: Number(r.refund_cash || 0),
        note: exchangeByReturnId.has(Number(r.id))
          ? `Cash refund in exchange #${exchangeByReturnId.get(Number(r.id))?.id ?? ''}`
          : `Cash return #${r.id}`,
        source: 'RETURN' as const,
      }))
  }, [qAllReturns.data, qAllExchanges.data])

  const exchangeCashInRowsDay = useMemo(() => {
    const exchanges = (qDayExchanges.data || []) as any[]
    return exchanges
      .filter((x) => Number(x?.payment_cash || 0) > 0)
      .map((x) => ({
        id: `exchange-in-${x.id}`,
        created_at: x.created_at,
        entry_type: 'RECEIPT',
        amount: Number(x.payment_cash || 0),
        note: `Cash received in exchange #${x.id}`,
        source: 'EXCHANGE' as const,
      }))
  }, [qDayExchanges.data])

  const exchangeCashInRowsAll = useMemo(() => {
    const exchanges = (qAllExchanges.data || []) as any[]
    return exchanges
      .filter((x) => Number(x?.payment_cash || 0) > 0)
      .map((x) => ({
        id: `exchange-in-${x.id}`,
        created_at: x.created_at,
        entry_type: 'RECEIPT',
        amount: Number(x.payment_cash || 0),
        note: `Cash received in exchange #${x.id}`,
        source: 'EXCHANGE' as const,
      }))
  }, [qAllExchanges.data])

  const manualRowsDay = useMemo(() => {
    const rows = (day?.entries || []) as any[]
    return rows.map((r) => ({ ...r, source: 'CASHBOOK' as const }))
  }, [day?.entries])

  const manualRowsAll = useMemo(() => {
    const rows = (qAllCashbook.data || []) as any[]
    return rows.map((r) => ({ ...r, source: 'CASHBOOK' as const }))
  }, [qAllCashbook.data])

  const visibleRows = useMemo(() => {
    const rows =
      recordsFilter === 'DAY'
        ? [
            {
              id: `opening-${selectedDate}`,
              created_at: `${selectedDate}T00:00:00`,
              entry_type: 'OPENING',
              amount: Number(day?.opening_balance || 0),
              note: 'Opening Balance',
              source: 'SYSTEM' as const,
            },
            ...manualRowsDay,
            ...billCashRowsDay,
            ...exchangeCashInRowsDay,
            ...returnCashRowsDay,
          ]
        : [...manualRowsAll, ...billCashRowsAll, ...exchangeCashInRowsAll, ...returnCashRowsAll]
    return rows.sort((a: any, b: any) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
  }, [recordsFilter, selectedDate, day?.opening_balance, manualRowsDay, billCashRowsDay, exchangeCashInRowsDay, returnCashRowsDay, manualRowsAll, billCashRowsAll, exchangeCashInRowsAll, returnCashRowsAll])

  const dayColorMap = useMemo(() => {
    if (recordsFilter !== 'ALL') return {} as Record<string, string>
    const palette = ['background.paper', 'grey.50']
    const dates = Array.from(new Set((visibleRows || []).map((r: any) => isoDate(r.created_at))))
    const out: Record<string, string> = {}
    dates.forEach((d, i) => {
      out[d] = palette[i % palette.length]
    })
    return out
  }, [recordsFilter, visibleRows])

  const computed = useMemo(() => {
    let receipts = 0
    let withdrawals = 0
    let expenses = 0
    for (const r of visibleRows as any[]) {
      const t = String(r.entry_type || '').toUpperCase()
      const amt = Number(r.amount || 0)
      if (t === 'OPENING') continue
      if (t === 'RECEIPT') receipts += amt
      else if (t === 'WITHDRAWAL') withdrawals += amt
      else expenses += amt
    }
    const cashOut = withdrawals + expenses
    const netChange = receipts - cashOut
    return { receipts, withdrawals, expenses, cashOut, netChange }
  }, [visibleRows])

  const totalsBottom = useMemo(() => {
    const opening = recordsFilter === 'DAY' ? Number(day?.opening_balance || 0) : 0
    const closing = opening + computed.netChange
    return { opening, closing }
  }, [recordsFilter, day?.opening_balance, computed.netChange])

  const panelSx = {
    border: '1px solid',
    borderColor: 'rgba(13,51,36,0.12)',
    bgcolor: 'background.paper',
    borderRadius: 2,
  }

  return (
    <Stack spacing={1.25}>
      <Box sx={{ ...panelSx, p: 1.5, background: 'linear-gradient(180deg, rgba(247,250,245,0.9) 0%, rgba(255,255,255,0.95) 100%)' }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }} flexWrap="wrap">
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            Cashbook
          </Typography>
          <TextField
            select
            size="small"
            label="View"
            value={recordsFilter}
            onChange={(e) => setRecordsFilter(e.target.value as 'DAY' | 'ALL')}
            sx={{ minWidth: 140 }}
          >
            <MenuItem value="DAY">Day</MenuItem>
            <MenuItem value="ALL">All</MenuItem>
          </TextField>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" sx={{ ml: { sm: 'auto' } }}>
            <Button size="small" variant="outlined" onClick={() => setSelectedDate(addDays(selectedDate, -1))}>
              Prev
            </Button>
            <Button size="small" variant="outlined" onClick={() => setSelectedDate(today)} disabled={selectedDate === today}>
              Today
            </Button>
            <Button
              size="small"
              variant="outlined"
              onClick={() => setSelectedDate(addDays(selectedDate, 1))}
              disabled={!canGoNext || recordsFilter === 'ALL'}
            >
              Next
            </Button>
          </Stack>
        </Stack>
        {recordsFilter === 'DAY' ? (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            {selectedDate} · Opening from previous closing
          </Typography>
        ) : (
          <Stack sx={{ mt: 1 }} spacing={1}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} flexWrap="wrap">
              <ToggleButtonGroup
                size="small"
                value={allView}
                exclusive
                onChange={(_, v) => v && setAllView(v)}
                sx={{ '& .MuiToggleButton-root': { px: 1.25, py: 0.25, fontSize: 12 } }}
              >
                <ToggleButton value="ALL">All</ToggleButton>
                <ToggleButton value="WEEK">Week</ToggleButton>
                <ToggleButton value="MONTH">Month</ToggleButton>
              </ToggleButtonGroup>
              {allView !== 'ALL' ? (
                <Stack direction="row" spacing={0.5} sx={{ ml: { sm: 'auto' } }}>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => setAllAnchorDate(allView === 'WEEK' ? addDays(allAnchorDate, -7) : addMonths(allAnchorDate, -1))}
                  >
                    Prev
                  </Button>
                  <Button size="small" variant="outlined" onClick={() => setAllAnchorDate(today)} disabled={allAnchorDate === today}>
                    Today
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => setAllAnchorDate(allView === 'WEEK' ? addDays(allAnchorDate, 7) : addMonths(allAnchorDate, 1))}
                    disabled={!canGoAllNext}
                  >
                    Next
                  </Button>
                </Stack>
              ) : null}
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {allView === 'ALL' ? 'Full history' : `${allRange.from} → ${allRange.to}`}
            </Typography>
          </Stack>
        )}
      </Box>

      <Box
        sx={{
          ...panelSx,
          px: 1.5,
          py: 1,
          bgcolor: 'rgba(31,107,74,0.05)',
        }}
      >
        <Stack direction="row" flexWrap="wrap" gap={1} columnGap={1} rowGap={0.5}>
          {recordsFilter === 'DAY' ? <Chip size="small" variant="outlined" label={`Opening ${money(day?.opening_balance)}`} /> : null}
          <Chip size="small" color="success" variant="outlined" label={`Receipts ${money(computed.receipts)}`} />
          <Chip size="small" color="error" variant="outlined" label={`Expenses ${money(computed.expenses)}`} />
          <Chip size="small" color="warning" variant="outlined" label={`Withdrawals ${money(computed.withdrawals)}`} />
          {recordsFilter === 'DAY' ? (
            <Chip
              size="small"
              color="primary"
              label={`Closing: Rs ${money(Number(day?.opening_balance || 0) + computed.netChange)}`}
              sx={{ fontWeight: 700 }}
            />
          ) : (
            <Chip size="small" color="primary" label={`Net ${money(computed.netChange)}`} sx={{ fontWeight: 700 }} />
          )}
        </Stack>
      </Box>

      <Box sx={{ ...panelSx, p: 1.5 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
          <TextField
            select
            label="Entry Type"
            value={entryType}
            onChange={(e) => setEntryType(e.target.value as CashbookType)}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="RECEIPT">Receipt (Cash In)</MenuItem>
            <MenuItem value="EXPENSE">Expense (Cash Out)</MenuItem>
            <MenuItem value="WITHDRAWAL">Withdrawal (Cash Out)</MenuItem>
          </TextField>
          <TextField
            label="Entry Date"
            type="date"
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            label="Amount"
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputProps={{ min: 0, step: '0.01' }}
          />
          <TextField
            label="Note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional details"
            sx={{ flex: 1 }}
          />
          <Button size="small" variant="contained" onClick={() => mCreate.mutate()} disabled={!canSave}>
            {mCreate.isPending ? 'Saving...' : 'Add'}
          </Button>
        </Stack>
        {mCreate.isError ? (
          <Alert severity="error" sx={{ mt: 1.5 }} variant="outlined">
            Failed to save entry. Please try again.
          </Alert>
        ) : null}
      </Box>

      <Box sx={{ ...panelSx, p: 0 }}>
        <Box sx={{ px: 1.5, py: 0.75, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'rgba(31,107,74,0.06)' }}>
          <Typography variant="caption" sx={{ fontWeight: 700 }}>
            {recordsFilter === 'DAY' ? 'Entries' : 'Register'}
          </Typography>
        </Box>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Date</TableCell>
                <TableCell>Time</TableCell>
                <TableCell>Note</TableCell>
                <TableCell align="right">Amount</TableCell>
                <TableCell>Source</TableCell>
                <TableCell align="right">Action</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(recordsFilter === 'DAY'
                ? qDay.isLoading || qDayPayments.isLoading || qDayReturns.isLoading || qDayExchanges.isLoading
                : qAllCashbook.isLoading || qAllPayments.isLoading || qAllReturns.isLoading || qAllExchanges.isLoading) ? (
                <TableRow>
                  <TableCell colSpan={6}>Loading...</TableCell>
                </TableRow>
              ) : visibleRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6}>
                    {recordsFilter === 'DAY' ? 'No entries for this day.' : 'No records found.'}
                  </TableCell>
                </TableRow>
              ) : (
                (visibleRows || []).map((row: any, idx: number) => {
                  const t = String(row.entry_type || '').toUpperCase()
                  const chipType = row.source === 'RETURN' ? 'RETURN' : String(row.pill_type || t).toUpperCase()
                  const isIn = t === 'RECEIPT'
                  const lbl = typeLabel(chipType)
                  const date = isoDate(row.created_at)
                  const prevDate = idx > 0 ? isoDate((visibleRows as any[])[idx - 1]?.created_at) : date
                  const isNewDay = recordsFilter === 'ALL' && idx > 0 && date !== prevDate
                  return (
                    <TableRow
                      key={row.id}
                      hover
                      sx={
                        recordsFilter === 'ALL'
                          ? {
                              bgcolor: dayColorMap[date],
                              ...(isNewDay ? { '& td': { borderTop: '2px solid rgba(0,0,0,0.65)' } } : {}),
                            }
                          : undefined
                      }
                    >
                      <TableCell>{isoDate(row.created_at)}</TableCell>
                      <TableCell>{isoTime(row.created_at)}</TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap">
                          <Typography
                            component="span"
                            variant="caption"
                            sx={{ color: lbl.color, fontWeight: 700, minWidth: 28, fontFamily: 'inherit' }}
                          >
                            [{lbl.text}]
                          </Typography>
                          {row.source === 'BILL' && Number(row.bill_id || 0) > 0 ? (
                            <Typography variant="body2">
                              Cash payment for{' '}
                              <Link component="button" onClick={() => openBillDetail(Number(row.bill_id))} underline="hover">
                                Bill #{row.bill_id}
                              </Link>
                            </Typography>
                          ) : (
                            <Typography variant="body2">{row.note || '-'}</Typography>
                          )}
                        </Stack>
                      </TableCell>
                      <TableCell
                        align="right"
                        sx={{
                          color: t === 'OPENING' ? 'text.primary' : isIn ? 'success.main' : 'error.main',
                          fontWeight: 700,
                        }}
                      >
                        {t === 'OPENING' ? '' : isIn ? '+' : '-'}Rs {money(row.amount)}
                      </TableCell>
                      <TableCell>{row.source === 'BILL' ? 'Bill' : row.source === 'RETURN' ? 'Return' : row.source === 'EXCHANGE' ? 'Exchange' : row.source === 'SYSTEM' ? 'System' : 'Cashbook'}</TableCell>
                      <TableCell align="right">
                        {row.source === 'CASHBOOK' ? (
                          <IconButton
                            size="small"
                            onClick={() => mDelete.mutate(row.id)}
                            disabled={mDelete.isPending}
                            color="error"
                          >
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        ) : (
                          '-'
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={3}>
                  <b>Totals</b>
                </TableCell>
                <TableCell align="right" sx={{ fontWeight: 700 }}>
                  +Rs {money(computed.receipts)} / -Rs {money(computed.cashOut)}
                </TableCell>
                <TableCell colSpan={2} sx={{ fontWeight: 700 }}>
                  Net: Rs {money(computed.netChange)}
                </TableCell>
              </TableRow>
              {recordsFilter === 'DAY' ? (
                <TableRow>
                  <TableCell colSpan={3}>
                    <b>Opening / Closing</b>
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700 }}>
                    Rs {money(totalsBottom.opening)} / Rs {money(totalsBottom.closing)}
                  </TableCell>
                  <TableCell colSpan={2} />
                </TableRow>
              ) : null}
            </TableFooter>
          </Table>
        </TableContainer>
      </Box>

      <Dialog open={billOpen} onClose={() => setBillOpen(false)} fullWidth maxWidth="md">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Bill Details
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
                  Date/Time: <b>{billDetail.date_time || billDetail.created_at || '-'}</b>
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
                    {(billDetail.items || []).map((it: any, idx: number) => {
                      const name = it.item_name || it.name || it.item?.name || `#${it.item_id}`
                      const qty = Number(it.quantity)
                      const mrp = Number(it.mrp)
                      return (
                        <tr key={idx}>
                          <td>{name}</td>
                          <td>{qty}</td>
                          <td>{money(mrp)}</td>
                          <td>{money(chargedLine(billDetail, mrp, qty))}</td>
                        </tr>
                      )
                    })}

                    {(billDetail.items || []).length === 0 && (
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
                  Total: <b>{money(billDetail.total_amount || 0)}</b>
                </Typography>
                <Typography>
                  Payment Mode: <b>{billDetail.payment_mode || '-'}</b>
                </Typography>
                <Typography>
                  Deleted: <b>{billDetail.is_deleted ? 'Yes' : 'No'}</b>
                </Typography>
                {billDetail.is_deleted ? (
                  <Typography>
                    Deleted At: <b>{billDetail.deleted_at || '-'}</b>
                  </Typography>
                ) : null}
                <Typography>
                  Payment Status: <b>{billDetail.payment_status || (billDetail.is_credit ? 'UNPAID' : 'PAID')}</b>
                </Typography>
                <Typography>
                  Paid Amount: <b>{money(billDetail.paid_amount || 0)}</b>
                </Typography>
                <Typography>
                  Pending Amount:{' '}
                  <b>{money(Math.max(0, Number(billDetail.total_amount || 0) - Number(billDetail.paid_amount || 0)))}</b>
                </Typography>
                {billDetail.notes ? (
                  <Typography sx={{ mt: 1 }}>
                    Notes: <i>{billDetail.notes}</i>
                  </Typography>
                ) : null}
                {!billDetail.is_deleted ? (
                  <Box sx={{ pt: 1 }}>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<EditIcon />}
                      onClick={() => setBillEditOpen(true)}
                    >
                      Edit Bill
                    </Button>
                  </Box>
                ) : null}
              </Stack>
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
          qc.invalidateQueries({ queryKey: ['cashbook-day', selectedDate] })
          qc.invalidateQueries({ queryKey: ['cashbook-all-entries'] })
          qc.invalidateQueries({ queryKey: ['cashbook-payments-day'] })
          qc.invalidateQueries({ queryKey: ['cashbook-all-payments'] })
        }}
      />
    </Stack>
  )
}
