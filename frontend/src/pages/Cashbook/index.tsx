import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Chip,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableFooter,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createCashbookEntry,
  deleteCashbookEntry,
  getCashbookDay,
  listCashbookEntries,
  type CashbookType,
} from '../../services/cashbook'
import { listPayments } from '../../services/billing'
import { listReturns } from '../../services/returns'
import { toYMD } from '../../lib/date'

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

function typeChipProps(type: string) {
  const baseSx = { minWidth: 84, height: 24, fontWeight: 700, justifyContent: 'center' as const }
  const t = String(type || '').toUpperCase()
  if (t === 'OPENING') {
    return { label: 'Opening', sx: { ...baseSx, bgcolor: 'info.light', color: 'info.dark' } }
  }
  if (t === 'RETURN') {
    return { label: 'Return', sx: { ...baseSx, bgcolor: 'warning.light', color: 'warning.dark' } }
  }
  if (t === 'SPLIT') {
    return { label: 'Split', sx: { ...baseSx, bgcolor: '#9fe3b0', color: '#124b19' } }
  }
  if (t === 'RECEIPT') {
    return { label: 'Receipt', sx: { ...baseSx, bgcolor: 'success.light', color: 'success.dark' } }
  }
  if (t === 'WITHDRAWAL') {
    return { label: 'Withdrawal', sx: { ...baseSx, bgcolor: 'warning.light', color: 'warning.dark' } }
  }
  return { label: 'Expense', sx: { ...baseSx, bgcolor: 'error.light', color: 'error.dark' } }
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
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setDebouncedAllAnchorDate(allAnchorDate), 250)
    return () => clearTimeout(t)
  }, [allAnchorDate])

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

  const mCreate = useMutation({
    mutationFn: () =>
      createCashbookEntry({
        entry_type: entryType,
        amount: Number(amount),
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      setAmount('')
      setNote('')
      qc.invalidateQueries({ queryKey: ['cashbook-day', selectedDate] })
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
  const canSave = Number(amount) > 0 && !mCreate.isPending
  const canGoAllNext = allAnchorDate < today

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
        note: `Cash payment for bill #${p.bill_id}`,
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
        note: `Cash payment for bill #${p.bill_id}`,
        source: 'BILL' as const,
      }))
  }, [qAllPayments.data])

  const returnCashRowsDay = useMemo(() => {
    const returns = (qDayReturns.data || []) as any[]
    return returns
      .filter((r) => Number(r?.refund_cash || 0) > 0)
      .map((r) => ({
        id: `return-${r.id}`,
        created_at: r.date_time,
        entry_type: 'WITHDRAWAL',
        amount: Number(r.refund_cash || 0),
        note: `Cash return #${r.id}`,
        source: 'RETURN' as const,
      }))
  }, [qDayReturns.data])

  const returnCashRowsAll = useMemo(() => {
    const returns = (qAllReturns.data || []) as any[]
    return returns
      .filter((r) => Number(r?.refund_cash || 0) > 0)
      .map((r) => ({
        id: `return-${r.id}`,
        created_at: r.date_time,
        entry_type: 'WITHDRAWAL',
        amount: Number(r.refund_cash || 0),
        note: `Cash return #${r.id}`,
        source: 'RETURN' as const,
      }))
  }, [qAllReturns.data])

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
            ...returnCashRowsDay,
          ]
        : [...manualRowsAll, ...billCashRowsAll, ...returnCashRowsAll]
    return rows.sort((a: any, b: any) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
  }, [recordsFilter, selectedDate, day?.opening_balance, manualRowsDay, billCashRowsDay, returnCashRowsDay, manualRowsAll, billCashRowsAll, returnCashRowsAll])

  const dayColorMap = useMemo(() => {
    if (recordsFilter !== 'ALL') return {} as Record<string, string>
    const palette = ['#f6fbff', '#eef6ff']
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

  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            Cashbook
          </Typography>
          <TextField
            select
            size="small"
            label="Records"
            value={recordsFilter}
            onChange={(e) => setRecordsFilter(e.target.value as 'DAY' | 'ALL')}
            sx={{ minWidth: 150, ml: { sm: 'auto' } }}
          >
            <MenuItem value="DAY">Selected Day</MenuItem>
            <MenuItem value="ALL">All Records</MenuItem>
          </TextField>
          <Stack direction="row" spacing={1} sx={{ ml: { sm: 'auto' } }}>
            <Button variant="outlined" onClick={() => setSelectedDate(addDays(selectedDate, -1))}>
              Previous Day
            </Button>
            <Button variant="outlined" onClick={() => setSelectedDate(today)} disabled={selectedDate === today}>
              Today
            </Button>
            <Button
              variant="outlined"
              onClick={() => setSelectedDate(addDays(selectedDate, 1))}
              disabled={!canGoNext || recordsFilter === 'ALL'}
            >
              Next Day
            </Button>
          </Stack>
        </Stack>
        {recordsFilter === 'DAY' ? (
          <Stack sx={{ mt: 1 }} spacing={0.25}>
            <Typography variant="body2" sx={{ fontWeight: 700 }}>
              Date: {selectedDate}
            </Typography>
            <Typography variant="body2" sx={{ color: 'error.main' }}>
              Note : Opening balance is carried from previous day closing.
            </Typography>
          </Stack>
        ) : (
          <Stack sx={{ mt: 1 }} spacing={1}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} sx={{ width: '100%' }}>
              <Stack direction="row" spacing={1}>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => setAllView('ALL')}
                  sx={allView === 'ALL' ? { bgcolor: '#e9f2ff', borderColor: '#8bb5f8' } : undefined}
                >
                  All
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => setAllView('WEEK')}
                  sx={allView === 'WEEK' ? { bgcolor: '#e9f2ff', borderColor: '#8bb5f8' } : undefined}
                >
                  Week
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => setAllView('MONTH')}
                  sx={allView === 'MONTH' ? { bgcolor: '#e9f2ff', borderColor: '#8bb5f8' } : undefined}
                >
                  Month
                </Button>
              </Stack>
              {allView !== 'ALL' ? (
                <Stack direction="row" spacing={1} sx={{ ml: { sm: 'auto' }, justifyContent: { sm: 'flex-end' } }}>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => setAllAnchorDate(allView === 'WEEK' ? addDays(allAnchorDate, -7) : addMonths(allAnchorDate, -1))}
                >
                  Previous {allView === 'WEEK' ? 'Week' : 'Month'}
                </Button>
                <Button variant="outlined" size="small" onClick={() => setAllAnchorDate(today)} disabled={allAnchorDate === today}>
                  Today
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => setAllAnchorDate(allView === 'WEEK' ? addDays(allAnchorDate, 7) : addMonths(allAnchorDate, 1))}
                  disabled={!canGoAllNext}
                >
                  Next {allView === 'WEEK' ? 'Week' : 'Month'}
                </Button>
                </Stack>
              ) : null}
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {allView === 'ALL'
                ? 'Showing full cashbook history (all records).'
                : `Showing ${allView.toLowerCase()} view: ${allRange.from} to ${allRange.to}`}
            </Typography>
          </Stack>
        )}
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} flexWrap="wrap">
          {recordsFilter === 'DAY' ? <Chip label={`Opening: Rs ${money(day?.opening_balance)}`} /> : null}
          <Chip color="success" variant="outlined" label={`Receipts: Rs ${money(computed.receipts)}`} />
          <Chip color="error" variant="outlined" label={`Expenses: Rs ${money(computed.expenses)}`} />
          <Chip color="warning" variant="outlined" label={`Withdrawals: Rs ${money(computed.withdrawals)}`} />
          {recordsFilter === 'DAY' ? (
            <Chip
              color="primary"
              label={`Closing: Rs ${money(Number(day?.opening_balance || 0) + computed.netChange)}`}
              sx={{ fontWeight: 700 }}
            />
          ) : (
            <Chip color="primary" label={`Net: Rs ${money(computed.netChange)}`} sx={{ fontWeight: 700 }} />
          )}
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
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
          <Button variant="contained" onClick={() => mCreate.mutate()} disabled={!canSave}>
            {mCreate.isPending ? 'Saving...' : 'Add Entry'}
          </Button>
        </Stack>
        {mCreate.isError ? (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            Failed to save entry. Please try again.
          </Alert>
        ) : null}
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
          {recordsFilter === 'DAY' ? 'Day Entries' : 'All Records'}
        </Typography>
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
              {(recordsFilter === 'DAY' ? qDay.isLoading || qDayPayments.isLoading || qDayReturns.isLoading : qAllCashbook.isLoading || qAllPayments.isLoading || qAllReturns.isLoading) ? (
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
                  const chip = typeChipProps(chipType)
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
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                          <Chip size="small" label={chip.label} sx={{ borderRadius: 999, ...chip.sx }} />
                          <Typography variant="body2">{row.note || '-'}</Typography>
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
                      <TableCell>{row.source === 'BILL' ? 'Bill' : row.source === 'RETURN' ? 'Return' : row.source === 'SYSTEM' ? 'System' : 'Cashbook'}</TableCell>
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
      </Paper>
    </Stack>
  )
}
