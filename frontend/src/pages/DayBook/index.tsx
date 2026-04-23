import { useMemo, useState } from 'react'
import {
  Box,
  Checkbox,
  Chip,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { useQuery } from '@tanstack/react-query'
import { fetchVoucherDayBook } from '../../services/vouchers'
import type { VoucherDayBookRow } from '../../lib/types'

function money(n: number | string | null | undefined) {
  return Number(n || 0).toFixed(2)
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10)
}

function rowChipColor(type: VoucherDayBookRow['voucher_type']) {
  if (type === 'SALE') return 'success'
  if (type === 'PURCHASE') return 'primary'
  if (type === 'RECEIPT') return 'info'
  if (type === 'PAYMENT') return 'warning'
  if (type === 'RETURN') return 'secondary'
  if (type === 'WRITE_OFF') return 'error'
  return 'default'
}

const voucherTypes = [
  '',
  'SALE',
  'PURCHASE',
  'RECEIPT',
  'PAYMENT',
  'RETURN',
  'EXCHANGE',
  'EXPENSE',
  'WITHDRAWAL',
  'STOCK_JOURNAL',
  'WRITE_OFF',
]

export default function DayBookPage() {
  const today = useMemo(() => todayYmd(), [])
  const [fromDate, setFromDate] = useState(today)
  const [toDate, setToDate] = useState(today)
  const [voucherType, setVoucherType] = useState('')
  const [deletedFilter, setDeletedFilter] = useState<'active' | 'deleted' | 'all'>('active')
  const [query, setQuery] = useState('')
  const [includeStockJournal, setIncludeStockJournal] = useState(true)

  const dayBookQ = useQuery({
    queryKey: ['voucher-day-book', fromDate, toDate, voucherType, deletedFilter, query, includeStockJournal],
    queryFn: () =>
      fetchVoucherDayBook({
        from_date: fromDate,
        to_date: toDate,
        voucher_type: voucherType || undefined,
        deleted_filter: deletedFilter,
        q: query.trim() || undefined,
        include_stock_journal: includeStockJournal,
      }),
  })

  const rows = dayBookQ.data?.rows || []
  const summary = dayBookQ.data?.summary

  return (
    <Stack gap={2}>
      <Typography variant="h5">Day Book</Typography>

      <Paper sx={{ p: 2 }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: '1fr',
              sm: 'repeat(2, minmax(150px, 1fr))',
              lg: 'repeat(5, minmax(150px, 1fr))',
            },
            gap: 1.25,
            alignItems: 'start',
          }}
        >
          <TextField
            label="From"
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
            fullWidth
          />
          <TextField
            label="To"
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
            fullWidth
          />
          <TextField
            select
            label="Voucher Type"
            value={voucherType}
            onChange={(e) => setVoucherType(e.target.value)}
            fullWidth
          >
            <MenuItem value="">All</MenuItem>
            {voucherTypes.filter(Boolean).map((type) => (
              <MenuItem key={type} value={type}>{type}</MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label="Deleted"
            value={deletedFilter}
            onChange={(e) => setDeletedFilter(e.target.value as 'active' | 'deleted' | 'all')}
            fullWidth
          >
            <MenuItem value="active">Active</MenuItem>
            <MenuItem value="deleted">Deleted</MenuItem>
            <MenuItem value="all">All</MenuItem>
          </TextField>
          <TextField
            label="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Voucher no, party, notes"
            fullWidth
            sx={{ gridColumn: { xs: 'auto', lg: 'span 1' } }}
          />
        </Box>
        <Box sx={{ mt: 1, pt: 0.25 }}>
          <FormControlLabel
            control={
              <Checkbox
                checked={includeStockJournal}
                onChange={(e) => setIncludeStockJournal(e.target.checked)}
              />
            }
            label="Include stock journal events"
          />
        </Box>
      </Paper>

      {summary && (
        <Paper sx={{ p: 2 }}>
          <Stack direction={{ xs: 'column', md: 'row' }} gap={2} flexWrap="wrap">
            <Typography fontWeight={700}>Rows: {summary.total_rows}</Typography>
            <Typography>Sales: {money(summary.sales_total)}</Typography>
            <Typography>Purchases: {money(summary.purchase_total)}</Typography>
            <Typography>Receipts: {money(summary.receipt_total)}</Typography>
            <Typography>Payments: {money(summary.payment_total)}</Typography>
            <Typography>Returns: {money(summary.return_total)}</Typography>
            <Typography>Exchanges: {money(summary.exchange_total)}</Typography>
            <Typography>Expenses: {money(summary.expense_total)}</Typography>
            <Typography>Withdrawals: {money(summary.withdrawal_total)}</Typography>
            <Typography>Write-offs: {money(summary.writeoff_total)}</Typography>
            <Typography>Stock Journals: {summary.stock_journal_count}</Typography>
          </Stack>
        </Paper>
      )}

      <Paper sx={{ p: 2 }}>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Voucher</th>
                <th>Party</th>
                <th>Amount</th>
                <th>Cash</th>
                <th>Online</th>
                <th>Status</th>
                <th>Narration</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.source_type}-${row.source_id}`}>
                  <td style={{ minWidth: 154 }}>{String(row.ts || '').replace('T', ' ')}</td>
                  <td>
                    <Chip
                      size="small"
                      label={row.voucher_type}
                      color={rowChipColor(row.voucher_type)}
                      variant={row.is_deleted ? 'outlined' : 'filled'}
                    />
                  </td>
                  <td style={{ minWidth: 170 }}>
                    {row.voucher_no}
                    <Box component="span" sx={{ color: 'text.secondary', ml: 1 }}>
                      ({row.source_type})
                    </Box>
                  </td>
                  <td style={{ minWidth: 160 }}>{row.party_name || '-'}</td>
                  <td style={{ minWidth: 92 }}>{money(row.amount)}</td>
                  <td style={{ minWidth: 92 }}>{money(row.cash_amount)}</td>
                  <td style={{ minWidth: 92 }}>{money(row.online_amount)}</td>
                  <td style={{ minWidth: 112 }}>{row.status || (row.is_deleted ? 'DELETED' : '-')}</td>
                  <td style={{ whiteSpace: 'normal', wordBreak: 'break-word', minWidth: 240 }}>{row.narration || '-'}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <Box p={2} color="text.secondary">
                      {dayBookQ.isLoading ? 'Loading day book...' : 'No vouchers found for this filter.'}
                    </Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>
    </Stack>
  )
}
