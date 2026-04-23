import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchCustomers } from '../../services/customers'
import {
  createPartyReceipt,
  fetchDebtorLedger,
  fetchOpenBills,
  fetchParties,
  fetchPartyReceipts,
  fetchReceiptAdjustments,
} from '../../services/parties'
import type { Customer, DebtorLedgerRow, OpenBill, Party, PartyReceipt, ReceiptBillAdjustment } from '../../lib/types'
import { useToast } from '../../components/ui/Toaster'
import { buildSalesReportLink } from '../../lib/reportLinks'

function money(n: number) {
  return Number(n || 0).toFixed(2)
}

export default function CustomerLedgerPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const today = new Date().toISOString().slice(0, 10)
  const [params, setParams] = useSearchParams()

  const [customerName, setCustomerName] = useState('')
  const [receiptOpen, setReceiptOpen] = useState(false)
  const [mode, setMode] = useState<'cash' | 'online' | 'split'>('cash')
  const [cashAmount, setCashAmount] = useState('0')
  const [onlineAmount, setOnlineAmount] = useState('0')
  const [paymentDate, setPaymentDate] = useState(today)
  const [note, setNote] = useState('')
  const [adjustmentDrafts, setAdjustmentDrafts] = useState<Record<number, string>>({})

  const customersQ = useQuery<Customer[], Error>({
    queryKey: ['customer-ledger-customers'],
    queryFn: () => fetchCustomers(),
  })

  const partiesQ = useQuery<Party[], Error>({
    queryKey: ['customer-ledger-parties'],
    queryFn: () => fetchParties({ party_group: 'SUNDRY_DEBTOR', is_active: true }),
  })

  const selectedParty = (partiesQ.data || []).find(
    (party) => {
      const matchName = String(party.name || '').trim().toLowerCase() === String(customerName || '').trim().toLowerCase()
      const matchId = params.get('customer_id') === String(party.id)
      return matchName || matchId
    }
  )

  useEffect(() => {
    const id = params.get('customer_id')
    if (id && partiesQ.data) {
      const match = partiesQ.data.find((p) => String(p.id) === id)
      if (match && customerName !== match.name) {
        setCustomerName(match.name || '')
      }
    }
  }, [params, partiesQ.data, customerName])

  const ledgerQ = useQuery<DebtorLedgerRow[], Error>({
    queryKey: ['customer-ledger', selectedParty?.id],
    queryFn: () => fetchDebtorLedger(Number(selectedParty?.id)),
    enabled: Boolean(selectedParty?.id),
  })

  const openBillsQ = useQuery<OpenBill[], Error>({
    queryKey: ['customer-open-bills', selectedParty?.id],
    queryFn: () => fetchOpenBills(Number(selectedParty?.id)),
    enabled: Boolean(selectedParty?.id),
  })

  const receiptsQ = useQuery<PartyReceipt[], Error>({
    queryKey: ['customer-receipts', selectedParty?.id],
    queryFn: () => fetchPartyReceipts(Number(selectedParty?.id)),
    enabled: Boolean(selectedParty?.id),
  })

  const receiptAdjustmentsQ = useQuery<ReceiptBillAdjustment[], Error>({
    queryKey: ['customer-receipt-adjustments', selectedParty?.id],
    queryFn: () => fetchReceiptAdjustments(Number(selectedParty?.id)),
    enabled: Boolean(selectedParty?.id),
  })

  const receiptM = useMutation({
    mutationFn: ({
      partyId,
      payload,
    }: {
      partyId: number
      payload: {
        mode: 'cash' | 'online' | 'split'
        cash_amount?: number
        online_amount?: number
        note?: string
        payment_date?: string
        adjustments: Array<{ bill_id: number; amount: number }>
      }
    }) => createPartyReceipt(partyId, payload),
    onSuccess: () => {
      toast.push('Receipt recorded and bill adjustments posted', 'success')
      queryClient.invalidateQueries({ queryKey: ['customer-ledger'] })
      queryClient.invalidateQueries({ queryKey: ['customer-open-bills'] })
      queryClient.invalidateQueries({ queryKey: ['customer-receipts'] })
      queryClient.invalidateQueries({ queryKey: ['customer-receipt-adjustments'] })
      queryClient.invalidateQueries({ queryKey: ['credit-bills'] })
      setReceiptOpen(false)
      setMode('cash')
      setCashAmount('0')
      setOnlineAmount('0')
      setPaymentDate(today)
      setNote('')
      setAdjustmentDrafts({})
    },
    onError: (err: any) => toast.push(String(err?.message || 'Failed to record receipt'), 'error'),
  })

  const ledgerRows = ledgerQ.data || []
  const openBills = openBillsQ.data || []
  const receipts = receiptsQ.data || []
  const adjustments = receiptAdjustmentsQ.data || []
  const totalOutstanding = ledgerRows.reduce((sum, row) => sum + Number(row.outstanding_amount || 0), 0)
  const adjustmentTotal = Object.values(adjustmentDrafts).reduce((sum, value) => sum + Number(value || 0), 0)
  const receiptTotal = Number(cashAmount || 0) + Number(onlineAmount || 0)
  const onAccountAmount = Math.max(0, receiptTotal - adjustmentTotal)

  const adjustmentMap = useMemo(() => {
    const map = new Map<number, number>()
    for (const row of adjustments) {
      map.set(Number(row.receipt_id), (map.get(Number(row.receipt_id)) || 0) + Number(row.adjusted_amount || 0))
    }
    return map
  }, [adjustments])

  function openReceiptDialog() {
    setAdjustmentDrafts(
      Object.fromEntries(openBills.map((bill) => [Number(bill.bill_id), '0'])),
    )
    setReceiptOpen(true)
  }

  function setDraft(billId: number, value: string) {
    setAdjustmentDrafts((prev) => ({ ...prev, [billId]: value }))
  }

  function saveReceipt() {
    if (!selectedParty?.id) return
    receiptM.mutate({
      partyId: Number(selectedParty.id),
      payload: {
        mode,
        cash_amount: Number(cashAmount || 0),
        online_amount: Number(onlineAmount || 0),
        payment_date: paymentDate,
        note: note.trim() || undefined,
        adjustments: openBills
          .map((bill) => ({
            bill_id: Number(bill.bill_id),
            amount: Number(adjustmentDrafts[Number(bill.bill_id)] || 0),
          }))
          .filter((adj) => adj.amount > 0),
      },
    })
  }

  return (
    <Stack gap={2}>
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={2}>
        <Typography variant="h5">Customer Ledger</Typography>
        <Button variant="contained" onClick={openReceiptDialog} disabled={!selectedParty}>
          Record Receipt
        </Button>
      </Stack>

      <Paper sx={{ p: 2 }}>
        <TextField
          select
          label="Customer"
          value={customerName}
          onChange={(e) => {
            setCustomerName(e.target.value)
            if (params.has('customer_id')) {
              const newParams = new URLSearchParams(params)
              newParams.delete('customer_id')
              setParams(newParams, { replace: true })
            }
          }}
          fullWidth
        >
          {(customersQ.data || []).map((customer) => (
            <MenuItem key={customer.id} value={customer.name}>{customer.name}</MenuItem>
          ))}
        </TextField>
      </Paper>

      {selectedParty && (
        <Paper sx={{ p: 2 }}>
          <Typography fontWeight={700}>Outstanding: {money(totalOutstanding)}</Typography>
        </Paper>
      )}

      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>Open Bills</Typography>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Bill ID</th>
                <th>Date</th>
                <th>Total</th>
                <th>Paid</th>
                <th>Outstanding</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {openBills.map((row) => (
                <tr key={row.bill_id}>
                  <td>
                    <Link
                      to={buildSalesReportLink({
                        billId: row.bill_id,
                        from: '2000-01-01',
                        to: '2099-12-31',
                      })}
                      style={{ color: '#1976d2', fontWeight: 600, textDecoration: 'none' }}
                    >
                      {row.bill_id}
                    </Link>
                  </td>
                  <td>{row.bill_date}</td>
                  <td>{money(row.total_amount)}</td>
                  <td>{money(row.paid_amount)}</td>
                  <td>{money(row.outstanding_amount)}</td>
                  <td>{row.payment_status}</td>
                </tr>
              ))}
              {openBills.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <Box p={2} color="text.secondary">
                      {selectedParty ? 'No open bills for this customer.' : 'Select a customer to view open bills.'}
                    </Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>Debtor Ledger</Typography>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Bill ID</th>
                <th>Date</th>
                <th>Total</th>
                <th>Paid</th>
                <th>Outstanding</th>
                <th>Status</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {ledgerRows.map((row) => (
                <tr key={row.bill_id}>
                  <td>
                    <Link
                      to={buildSalesReportLink({
                        billId: row.bill_id,
                        from: '2000-01-01',
                        to: '2099-12-31',
                      })}
                      style={{ color: '#1976d2', fontWeight: 600, textDecoration: 'none' }}
                    >
                      {row.bill_id}
                    </Link>
                  </td>
                  <td>{row.bill_date}</td>
                  <td>{money(row.total_amount)}</td>
                  <td>{money(row.paid_amount)}</td>
                  <td>{money(row.outstanding_amount)}</td>
                  <td>{row.payment_status}</td>
                  <td style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{row.notes || '-'}</td>
                </tr>
              ))}
              {ledgerRows.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <Box p={2} color="text.secondary">
                      {selectedParty ? 'No debtor ledger rows for this customer yet.' : 'Select a customer to view the ledger.'}
                    </Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>Receipts</Typography>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Receipt ID</th>
                <th>When</th>
                <th>Mode</th>
                <th>Total</th>
                <th>Adjusted</th>
                <th>On Account</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((receipt) => (
                <tr key={receipt.id}>
                  <td>{receipt.id}</td>
                  <td>{receipt.received_at}</td>
                  <td>{receipt.mode}</td>
                  <td>{money(receipt.total_amount)}</td>
                  <td>{money(adjustmentMap.get(Number(receipt.id)) || 0)}</td>
                  <td>{money(receipt.unallocated_amount)}</td>
                  <td>{receipt.note || '-'}</td>
                </tr>
              ))}
              {receipts.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <Box p={2} color="text.secondary">
                      {selectedParty ? 'No receipts recorded for this customer yet.' : 'Select a customer to view receipts.'}
                    </Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Dialog open={receiptOpen} onClose={() => setReceiptOpen(false)} fullWidth maxWidth="lg">
        <DialogTitle>Record Receipt</DialogTitle>
        <DialogContent dividers>
          <Stack gap={2}>
            <Stack direction={{ xs: 'column', md: 'row' }} gap={2}>
              <TextField select label="Mode" value={mode} onChange={(e) => setMode(e.target.value as 'cash' | 'online' | 'split')} fullWidth>
                <MenuItem value="cash">Cash</MenuItem>
                <MenuItem value="online">Online</MenuItem>
                <MenuItem value="split">Split</MenuItem>
              </TextField>
              <TextField label="Cash Amount" type="number" value={cashAmount} onChange={(e) => setCashAmount(e.target.value)} fullWidth />
              <TextField label="Online Amount" type="number" value={onlineAmount} onChange={(e) => setOnlineAmount(e.target.value)} fullWidth />
              <TextField label="Date" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} InputLabelProps={{ shrink: true }} fullWidth />
            </Stack>
            <TextField label="Note" value={note} onChange={(e) => setNote(e.target.value)} multiline minRows={2} fullWidth />

            <Typography variant="h6">Bill Adjustments</Typography>
            <Box sx={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Bill ID</th>
                    <th>Date</th>
                    <th>Outstanding</th>
                    <th>Adjust Now</th>
                  </tr>
                </thead>
                <tbody>
                  {openBills.map((bill) => (
                    <tr key={bill.bill_id}>
                      <td>{bill.bill_id}</td>
                      <td>{bill.bill_date}</td>
                      <td>{money(bill.outstanding_amount)}</td>
                      <td>
                        <TextField
                          type="number"
                          value={adjustmentDrafts[Number(bill.bill_id)] ?? '0'}
                          onChange={(e) => setDraft(Number(bill.bill_id), e.target.value)}
                          sx={{ width: 140 }}
                        />
                      </td>
                    </tr>
                  ))}
                  {openBills.length === 0 && (
                    <tr>
                      <td colSpan={4}>
                        <Box p={2} color="text.secondary">No open bills to adjust.</Box>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Box>

            <Stack direction={{ xs: 'column', md: 'row' }} gap={3}>
              <Typography>Receipt Total: {money(receiptTotal)}</Typography>
              <Typography>Adjusted Total: {money(adjustmentTotal)}</Typography>
              <Typography fontWeight={700}>On Account: {money(onAccountAmount)}</Typography>
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReceiptOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveReceipt} disabled={receiptM.isPending || !selectedParty}>
            Save Receipt
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
