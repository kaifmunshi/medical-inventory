import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Link,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import EditIcon from '@mui/icons-material/Edit'
import { useSearchParams } from 'react-router-dom'
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
import { getBill, listPayments, type BillPaymentRow } from '../../services/billing'
import type { Customer, DebtorLedgerRow, OpenBill, Party, PartyReceipt, ReceiptBillAdjustment } from '../../lib/types'
import { useToast } from '../../components/ui/Toaster'
import BillEditDialog from '../../components/billing/BillEditDialog'
import BillPaymentsPanel from '../../components/billing/BillPaymentsPanel'

function money(n: number) {
  return Number(n || 0).toFixed(2)
}

export default function CustomerLedgerPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const today = new Date().toISOString().slice(0, 10)
  const [params, setParams] = useSearchParams()

  const [customerId, setCustomerId] = useState('')
  const [receiptOpen, setReceiptOpen] = useState(false)
  const [mode, setMode] = useState<'cash' | 'online' | 'split'>('cash')
  const [receiptAmount, setReceiptAmount] = useState('0')
  const [cashAmount, setCashAmount] = useState('0')
  const [onlineAmount, setOnlineAmount] = useState('0')
  const [paymentDate, setPaymentDate] = useState(today)
  const [note, setNote] = useState('')
  const [adjustmentDrafts, setAdjustmentDrafts] = useState<Record<number, string>>({})
  const [billOpen, setBillOpen] = useState(false)
  const [billLoading, setBillLoading] = useState(false)
  const [billDetail, setBillDetail] = useState<any | null>(null)
  const [billEditOpen, setBillEditOpen] = useState(false)

  const customersQ = useQuery<Customer[], Error>({
    queryKey: ['customer-ledger-customers'],
    queryFn: () => fetchCustomers(),
  })

  const partiesQ = useQuery<Party[], Error>({
    queryKey: ['customer-ledger-parties'],
    queryFn: () => fetchParties({ party_group: 'SUNDRY_DEBTOR', is_active: true }),
  })

  const selectedCustomer = useMemo(
    () => (customersQ.data || []).find((customer) => String(customer.id) === String(customerId || '')),
    [customersQ.data, customerId],
  )

  const selectedParty = useMemo(
    () =>
      (partiesQ.data || []).find((party) => {
        const selectedCustomerId = Number(selectedCustomer?.id || 0)
        const selectedCustomerName = String(selectedCustomer?.name || '').trim().toLowerCase()
        const legacyMatch = Number(party.legacy_customer_id || 0) > 0 && Number(party.legacy_customer_id) === selectedCustomerId
        const nameMatch = selectedCustomerName && String(party.name || '').trim().toLowerCase() === selectedCustomerName
        return legacyMatch || Boolean(nameMatch)
      }),
    [partiesQ.data, selectedCustomer],
  )

  useEffect(() => {
    const id = params.get('customer_id')
    if (id && customersQ.data) {
      const match = customersQ.data.find((customer) => String(customer.id) === id)
      if (match && customerId !== String(match.id)) {
        setCustomerId(String(match.id))
      }
    }
  }, [params, customersQ.data, customerId])

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

  const allPaymentsQ = useQuery<BillPaymentRow[], Error>({
    queryKey: ['customer-ledger-bill-payments', selectedParty?.id],
    queryFn: async () => {
      const out: BillPaymentRow[] = []
      let offset = 0
      const limit = 500
      while (true) {
        const rows = await listPayments({ limit, offset })
        out.push(...(rows || []))
        if (!rows || rows.length < limit) break
        offset += limit
      }
      return out
    },
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
      queryClient.invalidateQueries({ queryKey: ['customer-ledger-bill-payments'] })
      queryClient.invalidateQueries({ queryKey: ['credit-bills'] })
      setReceiptOpen(false)
      setMode('cash')
      setReceiptAmount('0')
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
  const receiptTotal = Number(receiptAmount || 0)
  const receiptCashAmount = mode === 'cash' ? receiptTotal : mode === 'online' ? 0 : Number(cashAmount || 0)
  const receiptOnlineAmount = mode === 'online' ? receiptTotal : mode === 'cash' ? 0 : Number(onlineAmount || 0)
  const onAccountAmount = Math.max(0, receiptTotal - adjustmentTotal)
  const openBillsForReceipt = useMemo(
    () =>
      [...openBills].sort((a, b) => {
        const byDate = String(a.bill_date || '').localeCompare(String(b.bill_date || ''))
        if (byDate !== 0) return byDate
        return Number(a.bill_id || 0) - Number(b.bill_id || 0)
      }),
    [openBills],
  )

  const adjustmentMap = useMemo(() => {
    const map = new Map<number, number>()
    for (const row of adjustments) {
      map.set(Number(row.receipt_id), (map.get(Number(row.receipt_id)) || 0) + Number(row.adjusted_amount || 0))
    }
    return map
  }, [adjustments])

  const adjustmentDetails = useMemo(() => {
    const map = new Map<number, ReceiptBillAdjustment[]>()
    for (const row of adjustments) {
      const receiptId = Number(row.receipt_id)
      const existing = map.get(receiptId) || []
      existing.push(row)
      map.set(receiptId, existing)
    }
    return map
  }, [adjustments])

  const receiptHistory = useMemo(() => {
    const billIds = new Set(ledgerRows.map((row) => Number(row.bill_id)))
    const partyReceiptRows = receipts.map((receipt) => {
      const lines = adjustmentDetails.get(Number(receipt.id)) || []
      const adjusted = adjustmentMap.get(Number(receipt.id)) || 0
      const allocation =
        lines.length > 0
          ? lines.map((line) => `Bill #${line.bill_id}: ${money(line.adjusted_amount)}`).join(', ')
          : Number(receipt.unallocated_amount || 0) > 0
            ? 'On account'
            : '-'
      return {
        id: `party-${receipt.id}`,
        receiptId: receipt.id,
        when: receipt.received_at,
        source: 'Customer receipt',
        mode: receipt.mode,
        cash: Number(receipt.cash_amount || 0),
        online: Number(receipt.online_amount || 0),
        total: Number(receipt.total_amount || 0),
        adjusted,
        onAccount: Number(receipt.unallocated_amount || 0),
        allocation,
        note: receipt.note || '',
      }
    })

    const directPaymentRows = ((allPaymentsQ.data || []) as any[])
      .filter((payment) => billIds.has(Number(payment.bill_id)))
      .filter((payment) => !/^party receipt #/i.test(String(payment.note || '').trim()))
      .map((payment) => {
        const cash = Number(payment.cash_amount || 0)
        const online = Number(payment.online_amount || 0)
        const total = cash + online
        return {
          id: `bill-payment-${payment.id}`,
          receiptId: payment.id,
          when: payment.received_at,
          source: 'Bill payment',
          mode: payment.mode,
          cash,
          online,
          total,
          adjusted: total,
          onAccount: 0,
          allocation: `Bill #${payment.bill_id}: ${money(total)}`,
          note: payment.note || '',
        }
      })

    return [...partyReceiptRows, ...directPaymentRows].sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')))
  }, [adjustmentDetails, adjustmentMap, allPaymentsQ.data, ledgerRows, receipts])
  const receiptHistoryTotal = receiptHistory.reduce((sum, row) => sum + Number(row.total || 0), 0)

  function openReceiptDialog() {
    setAdjustmentDrafts(
      Object.fromEntries(openBills.map((bill) => [Number(bill.bill_id), '0'])),
    )
    setMode('cash')
    setReceiptAmount('0')
    setCashAmount('0')
    setOnlineAmount('0')
    setPaymentDate(today)
    setNote('')
    setReceiptOpen(true)
  }

  function setDraft(billId: number, value: string) {
    setAdjustmentDrafts((prev) => ({ ...prev, [billId]: value }))
  }

  function setReceiptMode(next: 'cash' | 'online' | 'split') {
    setMode(next)
    const total = String(receiptAmount || '0')
    if (next === 'cash') {
      setCashAmount(total)
      setOnlineAmount('0')
    } else if (next === 'online') {
      setCashAmount('0')
      setOnlineAmount(total)
    } else {
      setCashAmount(total)
      setOnlineAmount('0')
    }
  }

  function handleReceiptAmountChange(raw: string) {
    setReceiptAmount(raw)
    if (mode === 'cash') {
      setCashAmount(raw)
      setOnlineAmount('0')
    } else if (mode === 'online') {
      setCashAmount('0')
      setOnlineAmount(raw)
    } else {
      setCashAmount(raw)
      setOnlineAmount('0')
    }
  }

  function setSplitCash(raw: string) {
    setCashAmount(raw)
    setReceiptAmount(String(Number(raw || 0) + Number(onlineAmount || 0)))
  }

  function setSplitOnline(raw: string) {
    setOnlineAmount(raw)
    setReceiptAmount(String(Number(cashAmount || 0) + Number(raw || 0)))
  }

  function fillBillAdjustmentOnFocus(bill: OpenBill) {
    const billId = Number(bill.bill_id)
    const current = Number(adjustmentDrafts[billId] || 0)
    if (current > 0) return
    const usedElsewhere = Object.entries(adjustmentDrafts).reduce((sum, [id, value]) => {
      return Number(id) === billId ? sum : sum + Number(value || 0)
    }, 0)
    const remaining = Math.max(0, receiptTotal - usedElsewhere)
    if (remaining <= 0) return
    setDraft(billId, String(Math.min(Number(bill.outstanding_amount || 0), remaining)))
  }

  function clampBillAdjustment(bill: OpenBill) {
    const billId = Number(bill.bill_id)
    const raw = Number(adjustmentDrafts[billId] || 0)
    if (!Number.isFinite(raw) || raw <= 0) {
      setDraft(billId, '0')
      return
    }
    setDraft(billId, String(Math.min(raw, Number(bill.outstanding_amount || 0))))
  }

  function fillAdjustmentsFromReceipt() {
    let remaining = receiptTotal
    const next: Record<number, string> = {}
    for (const bill of openBillsForReceipt) {
      const amount = Math.min(Number(bill.outstanding_amount || 0), Math.max(0, remaining))
      next[Number(bill.bill_id)] = amount > 0 ? String(amount) : '0'
      remaining = Math.max(0, remaining - amount)
    }
    setAdjustmentDrafts(next)
  }

  async function openBillDetail(billId: number) {
    if (!Number.isFinite(billId) || billId <= 0) return
    setBillOpen(true)
    setBillLoading(true)
    setBillDetail(null)
    try {
      const data = await getBill(billId)
      setBillDetail(data)
    } catch {
      setBillDetail(null)
    } finally {
      setBillLoading(false)
    }
  }

  function refreshLedgerQueries() {
    queryClient.invalidateQueries({ queryKey: ['customer-ledger'] })
    queryClient.invalidateQueries({ queryKey: ['customer-open-bills'] })
    queryClient.invalidateQueries({ queryKey: ['customer-receipts'] })
    queryClient.invalidateQueries({ queryKey: ['customer-receipt-adjustments'] })
    queryClient.invalidateQueries({ queryKey: ['customer-ledger-bill-payments'] })
    queryClient.invalidateQueries({ queryKey: ['credit-bills'] })
  }

  function renderBillRefs(text: string) {
    const raw = String(text || '-')
    if (raw === '-') return raw
    return raw.split(/(Bill #\d+)/g).map((part, index) => {
      const match = /^Bill #(\d+)$/.exec(part)
      if (!match) return part
      return (
        <Link
          key={`${part}-${index}`}
          component="button"
          underline="hover"
          onClick={() => openBillDetail(Number(match[1]))}
          sx={{ fontWeight: 600, verticalAlign: 'baseline' }}
        >
          {part}
        </Link>
      )
    })
  }

  function saveReceipt() {
    if (!selectedParty?.id) return
    receiptM.mutate({
      partyId: Number(selectedParty.id),
      payload: {
        mode,
        cash_amount: receiptCashAmount,
        online_amount: receiptOnlineAmount,
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
          value={customerId}
          onChange={(e) => {
            const nextId = String(e.target.value || '')
            setCustomerId(nextId)
            const newParams = new URLSearchParams(params)
            if (nextId) newParams.set('customer_id', nextId)
            else newParams.delete('customer_id')
            setParams(newParams, { replace: true })
          }}
          fullWidth
        >
          {(customersQ.data || []).map((customer) => (
            <MenuItem key={customer.id} value={String(customer.id)}>
              {[customer.name, customer.phone].filter(Boolean).join(' • ')}
            </MenuItem>
          ))}
        </TextField>
      </Paper>

      {selectedCustomer && (
        <Paper sx={{ p: 2 }}>
          <Stack direction={{ xs: 'column', md: 'row' }} gap={2} justifyContent="space-between" alignItems={{ md: 'center' }}>
            <div>
              <Typography fontWeight={700}>{selectedCustomer.name}</Typography>
              <Typography variant="body2" color="text.secondary">
                {[selectedCustomer.phone, selectedCustomer.address_line].filter(Boolean).join(' • ') || 'Customer master record'}
              </Typography>
            </div>
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} flexWrap="wrap" useFlexGap>
              <Chip color={totalOutstanding > 0 ? 'error' : 'success'} label={`Outstanding Rs ${money(totalOutstanding)}`} sx={{ fontWeight: 900 }} />
              <Chip color="primary" variant="outlined" label={`Open Bills ${openBills.length}`} sx={{ fontWeight: 800 }} />
              <Chip color="success" variant="outlined" label={`Receipts Rs ${money(receiptHistoryTotal)}`} sx={{ fontWeight: 800 }} />
            </Stack>
          </Stack>
        </Paper>
      )}

      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>Open Bills</Typography>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Bill</th>
                <th>Amount</th>
                <th>Outstanding</th>
                <th>Status</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {openBills.map((row) => (
                <tr key={row.bill_id} style={{ background: Number(row.outstanding_amount || 0) > 0 ? '#fff8e1' : undefined }}>
                  <td>
                    <Stack gap={0.25}>
                      <Link
                        component="button"
                        underline="hover"
                        onClick={() => openBillDetail(Number(row.bill_id))}
                        sx={{ fontWeight: 800 }}
                      >
                        Bill #{row.bill_id}
                      </Link>
                      <Typography variant="caption" color="text.secondary">{row.bill_date}</Typography>
                    </Stack>
                  </td>
                  <td>
                    <Stack gap={0.25}>
                      <Typography variant="body2" fontWeight={800}>Rs {money(row.total_amount)}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        Paid Rs {money(row.paid_amount)}{Number(row.writeoff_amount || 0) > 0 ? ` | Write-off Rs ${money(row.writeoff_amount)}` : ''}
                      </Typography>
                    </Stack>
                  </td>
                  <td><Typography fontWeight={900}>Rs {money(row.outstanding_amount)}</Typography></td>
                  <td>{statusChip(row.payment_status)}</td>
                  <td style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{row.notes || '-'}</td>
                </tr>
              ))}
              {openBills.length === 0 && (
                <tr>
                  <td colSpan={5}>
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
        <Typography variant="h6" sx={{ mb: 2 }}>Bill Ledger</Typography>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Bill</th>
                <th>Bill Value</th>
                <th>Settled</th>
                <th>Balance</th>
                <th>Status</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {ledgerRows.map((row) => (
                <tr key={row.bill_id} style={{ background: row.payment_status === 'PAID' ? '#f1f8e9' : row.payment_status === 'PARTIAL' ? '#fff8e1' : '#ffebee' }}>
                  <td>
                    <Stack gap={0.25}>
                      <Link
                        component="button"
                        underline="hover"
                        onClick={() => openBillDetail(Number(row.bill_id))}
                        sx={{ fontWeight: 800 }}
                      >
                        Bill #{row.bill_id}
                      </Link>
                      <Typography variant="caption" color="text.secondary">{row.bill_date}</Typography>
                    </Stack>
                  </td>
                  <td><Typography fontWeight={800}>Rs {money(row.total_amount)}</Typography></td>
                  <td>
                    <Stack gap={0.25}>
                      <Typography variant="body2">Paid Rs {money(row.paid_amount)}</Typography>
                      {Number(row.writeoff_amount || 0) > 0 ? (
                        <Typography variant="caption" color="text.secondary">Write-off Rs {money(row.writeoff_amount)}</Typography>
                      ) : null}
                    </Stack>
                  </td>
                  <td><Typography fontWeight={900}>Rs {money(row.outstanding_amount)}</Typography></td>
                  <td>{statusChip(row.payment_status)}</td>
                  <td style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{row.notes || '-'}</td>
                </tr>
              ))}
              {ledgerRows.length === 0 && (
                <tr>
                  <td colSpan={6}>
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
        <Typography variant="h6" sx={{ mb: 2 }}>Receipt History</Typography>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Receipt</th>
                <th>Mode</th>
                <th>Total</th>
                <th>Applied</th>
                <th>Allocation</th>
              </tr>
            </thead>
            <tbody>
              {receiptHistory.map((receipt) => {
                return (
                  <tr key={receipt.id} style={{ background: Number(receipt.onAccount || 0) > 0 ? '#e3f2fd' : '#f1f8e9' }}>
                    <td>
                      <Stack gap={0.25}>
                        <Typography fontWeight={800}>{receipt.source} #{receipt.receiptId}</Typography>
                        <Typography variant="caption" color="text.secondary">{receipt.when}</Typography>
                      </Stack>
                    </td>
                    <td>
                      <Stack gap={0.5}>
                        {modeChip(receipt.mode)}
                        <Typography variant="caption" color="text.secondary">
                          Cash Rs {money(receipt.cash)} | Online Rs {money(receipt.online)}
                        </Typography>
                      </Stack>
                    </td>
                    <td><Typography fontWeight={900}>Rs {money(receipt.total)}</Typography></td>
                    <td>
                      <Stack gap={0.25}>
                        <Typography fontWeight={800}>Rs {money(receipt.adjusted)}</Typography>
                        {Number(receipt.onAccount || 0) > 0 ? (
                          <Chip size="small" color="info" variant="outlined" label={`On account Rs ${money(receipt.onAccount)}`} sx={{ fontWeight: 700, alignSelf: 'flex-start' }} />
                        ) : null}
                      </Stack>
                    </td>
                    <td style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>
                      <Stack gap={0.5}>
                        <Typography variant="body2">{renderBillRefs(receipt.allocation)}</Typography>
                        {receipt.note ? <Typography variant="caption" color="text.secondary">{receipt.note}</Typography> : null}
                      </Stack>
                    </td>
                  </tr>
                )
              })}
              {receiptHistory.length === 0 && (
                <tr>
                  <td colSpan={5}>
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
              <TextField
                label="Receipt Amount"
                type="number"
                value={receiptAmount}
                onChange={(e) => handleReceiptAmountChange(e.target.value)}
                helperText="Enter total first, then focus bill rows to auto-fill."
                fullWidth
              />
              <TextField
                select
                label="Mode"
                value={mode}
                onChange={(e) => setReceiptMode(e.target.value as 'cash' | 'online' | 'split')}
                fullWidth
              >
                <MenuItem value="cash">Cash</MenuItem>
                <MenuItem value="online">Online</MenuItem>
                <MenuItem value="split">Split</MenuItem>
              </TextField>
              {mode === 'split' ? (
                <>
                  <TextField
                    label="Cash"
                    type="number"
                    value={cashAmount}
                    onChange={(e) => setSplitCash(e.target.value)}
                    fullWidth
                  />
                  <TextField
                    label="Online"
                    type="number"
                    value={onlineAmount}
                    onChange={(e) => setSplitOnline(e.target.value)}
                    fullWidth
                  />
                </>
              ) : null}
              <TextField label="Date" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} InputLabelProps={{ shrink: true }} fullWidth />
            </Stack>
            <TextField label="Note" value={note} onChange={(e) => setNote(e.target.value)} multiline minRows={2} fullWidth />

            <Stack direction={{ xs: 'column', md: 'row' }} gap={1} justifyContent="space-between" alignItems={{ md: 'center' }}>
              <Typography variant="h6">Bill Adjustments</Typography>
              <Button variant="outlined" onClick={fillAdjustmentsFromReceipt} disabled={receiptTotal <= 0 || openBillsForReceipt.length === 0}>
                Auto Fill
              </Button>
            </Stack>
            <Box sx={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Bill</th>
                    <th>Outstanding</th>
                    <th>Remaining Receipt</th>
                    <th>Adjust Now</th>
                  </tr>
                </thead>
                <tbody>
                  {openBillsForReceipt.map((bill) => {
                    const billId = Number(bill.bill_id)
                    const usedElsewhere = Object.entries(adjustmentDrafts).reduce((sum, [id, value]) => {
                      return Number(id) === billId ? sum : sum + Number(value || 0)
                    }, 0)
                    const remainingForThis = Math.max(0, receiptTotal - usedElsewhere)
                    return (
                    <tr key={bill.bill_id}>
                      <td>
                        <Stack gap={0.25}>
                          <Link
                            component="button"
                            underline="hover"
                            onClick={() => openBillDetail(Number(bill.bill_id))}
                            sx={{ fontWeight: 800 }}
                          >
                            Bill #{bill.bill_id}
                          </Link>
                          <Typography variant="caption" color="text.secondary">{bill.bill_date}</Typography>
                        </Stack>
                      </td>
                      <td><Typography fontWeight={800}>Rs {money(bill.outstanding_amount)}</Typography></td>
                      <td>Rs {money(remainingForThis)}</td>
                      <td>
                        <TextField
                          type="number"
                          value={adjustmentDrafts[Number(bill.bill_id)] ?? '0'}
                          onChange={(e) => setDraft(Number(bill.bill_id), e.target.value)}
                          onFocus={() => fillBillAdjustmentOnFocus(bill)}
                          onBlur={() => clampBillAdjustment(bill)}
                          helperText="Focus to fill"
                          sx={{ width: 150 }}
                        />
                      </td>
                    </tr>
                    )
                  })}
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
          <Button variant="contained" onClick={saveReceipt} disabled={receiptM.isPending || !selectedParty || receiptTotal <= 0 || adjustmentTotal > receiptTotal}>
            Save Receipt
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={billOpen} onClose={() => setBillOpen(false)} fullWidth maxWidth="md">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Bill Details {billDetail?.id ? `#${billDetail.id}` : ''}
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
                    {(billDetail.items || []).map((it: any, idx: number) => (
                      <tr key={idx}>
                        <td>{it.item_name || it.name || it.item?.name || `#${it.item_id}`}</td>
                        <td>{Number(it.quantity || 0)}</td>
                        <td>{money(it.mrp)}</td>
                        <td>{money(it.line_total)}</td>
                      </tr>
                    ))}
                    {(billDetail.items || []).length === 0 ? (
                      <tr>
                        <td colSpan={4}>
                          <Box p={2} color="text.secondary">
                            No items.
                          </Box>
                        </td>
                      </tr>
                    ) : null}
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
                  Payment Status: <b>{billDetail.payment_status || '-'}</b>
                </Typography>
                <Typography>
                  Paid Amount: <b>{money(billDetail.paid_amount || 0)}</b>
                </Typography>
                <Typography>
                  Pending Amount:{' '}
                  <b>{money(Math.max(0, Number(billDetail.total_amount || 0) - Number(billDetail.paid_amount || 0) - Number(billDetail.writeoff_amount || 0)))}</b>
                </Typography>
                {billDetail.notes ? (
                  <Typography sx={{ mt: 1 }}>
                    Notes: <i>{billDetail.notes}</i>
                  </Typography>
                ) : null}
                {!billDetail.is_deleted ? (
                  <Box sx={{ pt: 1 }}>
                    <Button size="small" variant="outlined" startIcon={<EditIcon />} onClick={() => setBillEditOpen(true)}>
                      Edit Bill
                    </Button>
                  </Box>
                ) : null}
              </Stack>

              <Divider />
              <BillPaymentsPanel
                bill={billDetail}
                onBillUpdated={async (updatedBill) => {
                  setBillDetail(updatedBill)
                  refreshLedgerQueries()
                }}
              />
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
          refreshLedgerQueries()
        }}
      />
    </Stack>
    )
  }

  function statusChip(status: string) {
    const normalized = String(status || 'UNPAID').toUpperCase()
    const color = normalized === 'PAID' ? 'success' : normalized === 'PARTIAL' ? 'warning' : 'error'
    return <Chip size="small" color={color as any} variant={normalized === 'PAID' ? 'filled' : 'outlined'} label={normalized} sx={{ fontWeight: 800 }} />
  }

  function modeChip(receiptMode: string) {
    const normalized = String(receiptMode || '').toUpperCase()
    const color = normalized === 'CASH' ? 'success' : normalized === 'ONLINE' ? 'primary' : 'secondary'
    return <Chip size="small" color={color as any} variant="outlined" label={normalized || '-'} sx={{ fontWeight: 800 }} />
  }
