import { useMemo, useState } from 'react'
import {
  Box,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { useQuery } from '@tanstack/react-query'
import { fetchLedgerGroups, fetchLedgers, fetchPostedVoucher, fetchPostedVouchers } from '../../services/accounting'
import type { Ledger, LedgerGroup, PostedVoucher } from '../../lib/types'

function money(n: number | string | null | undefined) {
  return Number(n || 0).toFixed(2)
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10)
}

export default function AccountingPage() {
  const today = useMemo(() => todayYmd(), [])
  const [fromDate, setFromDate] = useState(today)
  const [toDate, setToDate] = useState(today)
  const [voucherType, setVoucherType] = useState('')
  const [selectedVoucherId, setSelectedVoucherId] = useState<number | null>(null)

  const groupsQ = useQuery<LedgerGroup[], Error>({
    queryKey: ['accounting-ledger-groups'],
    queryFn: () => fetchLedgerGroups(),
  })

  const ledgersQ = useQuery<Ledger[], Error>({
    queryKey: ['accounting-ledgers'],
    queryFn: () => fetchLedgers(),
  })

  const vouchersQ = useQuery<PostedVoucher[], Error>({
    queryKey: ['accounting-vouchers', fromDate, toDate, voucherType],
    queryFn: () =>
      fetchPostedVouchers({
        from_date: fromDate,
        to_date: toDate,
        voucher_type: voucherType || undefined,
        limit: 300,
      }),
  })

  const voucherDetailQ = useQuery<PostedVoucher, Error>({
    queryKey: ['accounting-voucher-detail', selectedVoucherId],
    queryFn: () => fetchPostedVoucher(Number(selectedVoucherId)),
    enabled: Boolean(selectedVoucherId),
  })

  const groupById = new Map((groupsQ.data || []).map((group) => [Number(group.id), group]))
  const vouchers = vouchersQ.data || []
  const voucherTypes = ['', ...Array.from(new Set(vouchers.map((voucher) => voucher.voucher_type))).sort()]

  return (
    <Stack gap={2}>
      <Typography variant="h5">Accounting Backbone</Typography>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} gap={2}>
          <TextField
            label="From"
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            label="To"
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            select
            label="Voucher Type"
            value={voucherType}
            onChange={(e) => setVoucherType(e.target.value)}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="">All</MenuItem>
            {voucherTypes.filter(Boolean).map((type) => (
              <MenuItem key={type} value={type}>{type}</MenuItem>
            ))}
          </TextField>
        </Stack>
      </Paper>

      <Stack direction={{ xs: 'column', xl: 'row' }} gap={2} alignItems="stretch">
        <Paper sx={{ p: 2, flex: 1 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>Posted Vouchers</Typography>
          <Box sx={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>No.</th>
                  <th>Type</th>
                  <th>Source</th>
                  <th>Amount</th>
                  <th>Narration</th>
                </tr>
              </thead>
              <tbody>
                {vouchers.map((voucher) => (
                  <tr
                    key={voucher.id}
                    onClick={() => setSelectedVoucherId(Number(voucher.id))}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>{voucher.voucher_date}</td>
                    <td>{voucher.voucher_no}</td>
                    <td>
                      <Chip size="small" label={voucher.voucher_type} variant={voucher.is_deleted ? 'outlined' : 'filled'} />
                    </td>
                    <td>{voucher.source_type} #{voucher.source_id}</td>
                    <td>{money(voucher.total_amount)}</td>
                    <td style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{voucher.narration || '-'}</td>
                  </tr>
                ))}
                {vouchers.length === 0 && (
                  <tr>
                    <td colSpan={6}>
                      <Box p={2} color="text.secondary">No posted vouchers found for this filter.</Box>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Box>
        </Paper>

        <Paper sx={{ p: 2, width: { xs: '100%', xl: 420 } }}>
          <Typography variant="h6" sx={{ mb: 2 }}>Ledgers</Typography>
          <Box sx={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Ledger</th>
                  <th>Group</th>
                  <th>Type</th>
                </tr>
              </thead>
              <tbody>
                {(ledgersQ.data || []).map((ledger) => {
                  const group = groupById.get(Number(ledger.group_id))
                  return (
                    <tr key={ledger.id}>
                      <td>{ledger.name}</td>
                      <td>{group?.name || ledger.group_id}</td>
                      <td>{ledger.is_system ? 'System' : 'Party'}</td>
                    </tr>
                  )
                })}
                {(ledgersQ.data || []).length === 0 && (
                  <tr>
                    <td colSpan={3}>
                      <Box p={2} color="text.secondary">No ledgers found yet.</Box>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Box>
        </Paper>
      </Stack>

      <Dialog open={Boolean(selectedVoucherId)} onClose={() => setSelectedVoucherId(null)} maxWidth="md" fullWidth>
        <DialogTitle>Voucher Detail</DialogTitle>
        <DialogContent dividers>
          {voucherDetailQ.data ? (
            <Stack gap={2}>
              <Typography>
                {voucherDetailQ.data.voucher_no} | {voucherDetailQ.data.voucher_type} | {voucherDetailQ.data.voucher_date}
              </Typography>
              <Typography color="text.secondary">{voucherDetailQ.data.narration || '-'}</Typography>
              <Box sx={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Ledger</th>
                      <th>DR/CR</th>
                      <th>Amount</th>
                      <th>Narration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {voucherDetailQ.data.entries.map((entry) => {
                      const ledger = (ledgersQ.data || []).find((row) => Number(row.id) === Number(entry.ledger_id))
                      return (
                        <tr key={entry.id}>
                          <td>{ledger?.name || entry.ledger_id}</td>
                          <td>{entry.entry_type}</td>
                          <td>{money(entry.amount)}</td>
                          <td>{entry.narration || '-'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </Box>
            </Stack>
          ) : (
            <Typography color="text.secondary">Loading voucher detail...</Typography>
          )}
        </DialogContent>
      </Dialog>
    </Stack>
  )
}
