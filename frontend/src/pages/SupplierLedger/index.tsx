import { useState } from 'react'
import { Box, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material'
import { useQuery } from '@tanstack/react-query'
import { fetchParties } from '../../services/parties'
import { fetchSupplierLedger, fetchSupplierLedgerSummary } from '../../services/purchases'
import type { Party, PurchaseLedgerRow } from '../../lib/types'

function money(n: number) {
  return Number(n || 0).toFixed(2)
}

export default function SupplierLedgerPage() {
  const [partyId, setPartyId] = useState<number | null>(null)

  const suppliersQ = useQuery<Party[], Error>({
    queryKey: ['suppliers-ledger-select'],
    queryFn: () => fetchParties({ party_group: 'SUNDRY_CREDITOR', is_active: true }),
  })

  const summaryQ = useQuery({
    queryKey: ['supplier-ledger-summary-page', partyId],
    queryFn: () => fetchSupplierLedgerSummary(Number(partyId)),
    enabled: Boolean(partyId),
  })

  const ledgerQ = useQuery<PurchaseLedgerRow[], Error>({
    queryKey: ['supplier-ledger-page', partyId],
    queryFn: () => fetchSupplierLedger(Number(partyId)),
    enabled: Boolean(partyId),
  })

  const suppliers = suppliersQ.data || []
  const rows = ledgerQ.data || []

  return (
    <Stack gap={2}>
      <Typography variant="h5">Supplier Ledger</Typography>

      <Paper sx={{ p: 2 }}>
        <TextField
          select
          label="Supplier"
          value={partyId ?? ''}
          onChange={(e) => setPartyId(e.target.value ? Number(e.target.value) : null)}
          fullWidth
        >
          {suppliers.map((supplier) => (
            <MenuItem key={supplier.id} value={supplier.id}>{supplier.name}</MenuItem>
          ))}
        </TextField>
      </Paper>

      {partyId && summaryQ.data && (
        <Paper sx={{ p: 2 }}>
          <Stack direction={{ xs: 'column', md: 'row' }} gap={3}>
            <Typography>Total Purchases: {money(summaryQ.data.total_purchases)}</Typography>
            <Typography>Total Paid: {money(summaryQ.data.total_paid)}</Typography>
            <Typography>Total Write-off: {money(summaryQ.data.total_writeoff)}</Typography>
            <Typography fontWeight={700}>Outstanding: {money(summaryQ.data.outstanding_amount)}</Typography>
          </Stack>
        </Paper>
      )}

      <Paper sx={{ p: 2 }}>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Date</th>
                <th>Total</th>
                <th>Paid</th>
                <th>Write-off</th>
                <th>Outstanding</th>
                <th>Status</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.purchase_id}>
                  <td>{row.invoice_number}</td>
                  <td>{row.invoice_date}</td>
                  <td>{money(row.total_amount)}</td>
                  <td>{money(row.paid_amount)}</td>
                  <td>{money(row.writeoff_amount)}</td>
                  <td>{money(row.outstanding_amount)}</td>
                  <td>{row.payment_status}</td>
                  <td style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{row.notes || '-'}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <Box p={2} color="text.secondary">
                      {partyId ? 'No purchase ledger rows for this supplier yet.' : 'Select a supplier to view the ledger.'}
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
