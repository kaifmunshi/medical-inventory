// F:\medical-inventory\frontend\src\pages\Returns\index.tsx
import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { useMutation, useQuery } from '@tanstack/react-query'
import DeleteIcon from '@mui/icons-material/Delete'
import VisibilityIcon from '@mui/icons-material/Visibility'

import { findBill, createReturn, getReturnSummary, listReturns } from '../../services/returns'
import { fetchCustomers, getCustomerSummary } from '../../services/customers'
import { fetchDebtorLedger, fetchParty, fetchPartyReceipts } from '../../services/parties'
import { useToast } from '../../components/ui/Toaster'
import BillPickerDialog from '../../components/billing/BillPickerDialog'
import type { Customer, Party } from '../../lib/types'

type BillLine = {
  item_id: number
  name: string
  brand?: string | null
  soldQty: number
  mrp: number
  charged_unit_price?: number
  remaining_value?: number
}

type Row = {
  item_id: number
  name: string
  brand?: string | null
  qty: number
  max: number
  mrp: number
  charged_unit_price?: number
  remaining_value?: number
}

type RefundMode = 'cash' | 'online' | 'credit'
type PriorReturn = {
  refund_cash?: number
  refund_online?: number
  credit_amount?: number
  subtotal_return?: number
}
type CustomerBalanceAccount = Pick<Customer, 'name' | 'phone' | 'outstanding_amount' | 'advance_amount' | 'closing_balance' | 'closing_balance_type'> & {
  party_id?: number | null
}

// helpers
function round2(n: number) {
  return Math.round(n * 100) / 100
}
function round5Nearest(n: number) {
  return Math.round(n / 5) * 5
}
function clamp2(x: number) {
  return Math.round(x * 100) / 100
}
function money(n: number) {
  return clamp2(Number(n || 0)).toFixed(2)
}
function formatDateTime(v?: string | null) {
  const s = String(v || '').trim()
  if (!s) return '-'
  return s.replace('T', ' ').slice(0, 19)
}
function formatExpiry(exp?: string | null) {
  if (!exp) return '-'
  const s = String(exp)
  const iso = s.length > 10 ? s.slice(0, 10) : s
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${d}-${m}-${y}`
}
function signedOpeningBalance(party?: Party | null) {
  if (!party) return 0
  const amount = Number(party.opening_balance || 0)
  return party.opening_balance_type === 'CR' ? -amount : amount
}
function signedCustomerBalance(customer?: CustomerBalanceAccount | null) {
  if (!customer) return 0
  const amount = Number(customer.closing_balance || 0)
  return customer.closing_balance_type === 'CR' ? -amount : amount
}
function balanceLabel(value: number) {
  const signed = clamp2(value)
  if (Math.abs(signed) <= 0.0001) return `Rs ${money(0)} Settled`
  return `Rs ${money(Math.abs(signed))} ${signed < 0 ? 'CR' : 'DR'}`
}
function parseCustomerFromNotes(raw: string): Pick<Customer, 'name' | 'phone' | 'address_line'> | null {
  const first = String(String(raw || '').split(/\r?\n/)[0] || '').trim()
  const match = /^customer\s*:\s*(.+)$/i.exec(first)
  if (!match) return null
  const parts = String(match[1] || '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean)
  const name = String(parts[0] || '').trim()
  if (!name) return null
  return {
    name,
    phone: String(parts[1] || '').trim() || null,
    address_line: parts.slice(2).join(' | ').trim() || null,
  }
}

export default function Returns() {
  const toast = useToast()

  const [query, setQuery] = useState('')
  const [bill, setBill] = useState<any | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [priorReturns, setPriorReturns] = useState<PriorReturn[]>([])
  const [customerAccount, setCustomerAccount] = useState<CustomerBalanceAccount | null>(null)
  const [mode, setMode] = useState<RefundMode>('cash')
  const [billViewOpen, setBillViewOpen] = useState(false)

  const [billPickerOpen, setBillPickerOpen] = useState(false)

  const [finalRefund, setFinalRefund] = useState<number>(0)
  const [finalTouched, setFinalTouched] = useState<boolean>(false)

  const { refetch, isFetching } = useQuery({
    queryKey: ['bill', query],
    queryFn: () => findBill(query),
    enabled: false,
  })

  async function loadBalanceAccountForBill(b: any): Promise<CustomerBalanceAccount | null> {
    async function accountFromNotes() {
      const parsed = parseCustomerFromNotes(String(b.notes || ''))
      if (!parsed) return null
      const phoneDigits = String(parsed.phone || '').replace(/\D/g, '')
      const searchKey = phoneDigits || parsed.name
      const customers = await fetchCustomers({ q: searchKey, limit: 20 })
      const normalizedPhone = phoneDigits
      const normalizedName = String(parsed.name || '').trim().toLowerCase()
      const matched = customers.find((customer) => (
        normalizedPhone
          ? String(customer.phone || '').replace(/\D/g, '') === normalizedPhone
          : String(customer.name || '').trim().toLowerCase() === normalizedName
      )) || customers.find((customer) => String(customer.name || '').trim().toLowerCase() === normalizedName)
      if (matched?.id && Number(matched.id) > 0) {
        const customerSummary = await getCustomerSummary(Number(matched.id), { include_unlinked_notes: true })
        return customerSummary.customer
      }
      return null
    }

    if (Number(b.customer_id || 0) > 0) {
      const customerSummary = await getCustomerSummary(Number(b.customer_id), { include_unlinked_notes: false })
      return customerSummary.customer
    }

    if (Number(b.party_id || 0) <= 0) return accountFromNotes()
    const party = await fetchParty(Number(b.party_id))
    if (Number(party.legacy_customer_id || 0) > 0) {
      const customerSummary = await getCustomerSummary(Number(party.legacy_customer_id), { include_unlinked_notes: false })
      return customerSummary.customer
    }
    if (party.party_group !== 'SUNDRY_DEBTOR') return accountFromNotes()

    const [ledgerRows, receipts] = await Promise.all([
      fetchDebtorLedger(Number(party.id)),
      fetchPartyReceipts(Number(party.id)),
    ])
    const outstanding = clamp2(ledgerRows.reduce((sum, row) => sum + Number(row.outstanding_amount || 0), 0))
    const advance = clamp2(receipts
      .filter((receipt) => !receipt.is_deleted)
      .reduce((sum, receipt) => sum + Math.max(0, Number(receipt.unallocated_amount || 0)), 0))
    const closing = clamp2(signedOpeningBalance(party) + outstanding - advance)
    return {
      name: party.name,
      phone: party.phone,
      party_id: Number(party.id),
      outstanding_amount: outstanding,
      advance_amount: advance,
      closing_balance: Math.abs(closing),
      closing_balance_type: closing < -0.0001 ? 'CR' : 'DR',
    }
  }

  // proration context from saved bill (used only when partial)
  const proration = useMemo(() => {
    if (!bill) return { computedTotal: 0, finalTotal: 0, factor: 1 }

    const items = (bill.items || []) as any[]
    const sub = items.reduce((s, it) => s + Number(it.mrp) * Number(it.quantity), 0)
    const discAmt = (sub * Number(bill.discount_percent || 0)) / 100
    const afterDisc = sub - discAmt
    const taxAmt = (afterDisc * Number(bill.tax_percent || 0)) / 100
    const computedTotal = afterDisc + taxAmt

    const finalTotal = Number(bill.original_total_amount ?? bill.total_amount ?? computedTotal)
    const factor = computedTotal > 0 ? finalTotal / computedTotal : 1

    return { computedTotal, finalTotal, factor }
  }, [bill])

  const savedBillLineTotal = useMemo(() => {
    const items = (bill?.items || []) as any[]
    return items.reduce((sum, item) => sum + Number(item.line_total || 0), 0)
  }, [bill])

  // The saved bill line is the accounting source of truth for a partial return.
  const chargedLine = (itemId: number, mrp: number, qty: number, chargedUnitPrice?: number, remainingValue?: number, remainingQty?: number) => {
    if (!bill) return 0
    if (remainingValue != null && Number(remainingQty || 0) > 0) {
      return qty === Number(remainingQty)
        ? round2(Number(remainingValue))
        : round2(Number(remainingValue) * Number(qty) / Number(remainingQty))
    }
    if (chargedUnitPrice != null && Number.isFinite(Number(chargedUnitPrice))) {
      return round2(Number(chargedUnitPrice) * Number(qty))
    }
    const saved = (bill.items || []).find((item: any) => Number(item.item_id) === Number(itemId))
    const soldQty = Number(saved?.quantity || 0)
    const savedTotal = Number(saved?.line_total || 0)
    if (soldQty > 0 && savedTotal > 0) {
      const legacyTarget = Number(bill.original_total_amount ?? bill.total_amount ?? savedBillLineTotal)
      const legacyFactor = savedBillLineTotal > 0
        ? Math.min(1, legacyTarget / savedBillLineTotal)
        : 1
      return round2((savedTotal / soldQty) * Number(qty) * legacyFactor)
    }
    return round2(Number(mrp) * Number(qty) * proration.factor)
  }

  // refund computation (TOTAL)
  const refund = rows.reduce((s, r) => s + chargedLine(r.item_id, r.mrp, r.qty, r.charged_unit_price, r.remaining_value, r.max), 0)
  const computedRefund = clamp2(refund)

  const lineRefunds = useMemo(() => {
    if (!bill || rows.length === 0) return rows.map(() => 0)
    return rows.map(r => (r.qty > 0 ? chargedLine(r.item_id, r.mrp, r.qty, r.charged_unit_price, r.remaining_value, r.max) : 0))
  }, [bill, rows])

  const settlementPreview = useMemo(() => {
    const total = clamp2(Math.max(0, Number(finalRefund || 0)))
    const paidCash = clamp2(Math.max(0, Number(bill?.payment_cash || 0)))
    const paidOnline = clamp2(Math.max(0, Number(bill?.payment_online || 0)))
    const usedCash = clamp2(priorReturns.reduce((sum, row) => sum + Number(row.refund_cash || 0), 0))
    const usedOnline = clamp2(priorReturns.reduce((sum, row) => sum + Number(row.refund_online || 0), 0))
    const availableCash = clamp2(Math.max(0, paidCash - usedCash))
    const availableOnline = clamp2(Math.max(0, paidOnline - usedOnline))
    const outstanding = clamp2(Math.max(
      0,
      Number(bill?.total_amount || 0) - Number(bill?.paid_amount || 0) - Number(bill?.writeoff_amount || 0),
    ))
    const credit = clamp2(Math.min(total, outstanding))
    let remaining = clamp2(total - credit)
    let cash = 0
    let online = 0

    const takeCash = (requested?: number) => {
      if (remaining <= 0) return
      const target = requested == null ? remaining : Math.min(remaining, Math.max(0, requested))
      const taken = clamp2(Math.min(target, Math.max(0, availableCash - cash)))
      cash = clamp2(cash + taken)
      remaining = clamp2(remaining - taken)
    }
    const takeOnline = (requested?: number) => {
      if (remaining <= 0) return
      const target = requested == null ? remaining : Math.min(remaining, Math.max(0, requested))
      const taken = clamp2(Math.min(target, Math.max(0, availableOnline - online)))
      online = clamp2(online + taken)
      remaining = clamp2(remaining - taken)
    }

    if (mode === 'online') {
      takeOnline()
      takeCash()
    } else {
      takeCash()
      takeOnline()
    }

    return {
      total,
      outstanding,
      credit,
      cash,
      online,
      unresolved: remaining,
      availableCash,
      availableOnline,
      paidCash,
      paidOnline,
      usedCash,
      usedOnline,
    }
  }, [bill, finalRefund, mode, priorReturns])

  const billSummary = useMemo(() => {
    if (!bill) return { paid: 0, writeoff: 0, pending: 0, creditReturns: 0, originalTotal: 0 }
    const paid = clamp2(Number(bill.paid_amount || 0))
    const writeoff = clamp2(Number(bill.writeoff_amount || 0))
    const total = clamp2(Number(bill.total_amount || 0))
    return {
      paid,
      writeoff,
      pending: clamp2(Math.max(0, total - paid - writeoff)),
      creditReturns: clamp2(Number(bill.credit_return_total || 0)),
      originalTotal: clamp2(Number(bill.original_total_amount ?? total)),
    }
  }, [bill])

  const customerBalancePreview = useMemo(() => {
    const before = signedCustomerBalance(customerAccount)
    const creditImpact = clamp2(settlementPreview.credit)
    const after = clamp2(before - creditImpact)
    return {
      before,
      after,
      creditImpact,
      cashOut: settlementPreview.cash,
      onlineOut: settlementPreview.online,
      outstandingBefore: Number(customerAccount?.outstanding_amount || 0),
      advanceBefore: Number(customerAccount?.advance_amount || 0),
    }
  }, [customerAccount, settlementPreview])

  useEffect(() => {
    if (!finalTouched) setFinalRefund(clamp2(refund))
  }, [refund, finalTouched])

  // ---------- BILL LOADER (NO TOAST HERE) ----------
  type LoadResult = {
    ok: boolean
    billId?: number
    noItems?: boolean
    error?: string
  }

  async function loadBill(): Promise<LoadResult> {
    try {
      const res = await refetch()
      let b = res.data

      if (!b) {
        return { ok: false, error: 'No bill found' }
      }

      if (Array.isArray(b)) {
        if (b.length === 0) {
          return { ok: false, error: 'No bill found' }
        }
        if (b.length === 1) {
          b = b[0]
        } else {
          // let UI open picker; no state change yet
          setBillPickerOpen(true)
          return { ok: false, error: 'Multiple bills found' }
        }
      }

      if ((b as any).is_deleted) {
        return { ok: false, error: 'Deleted bill cannot be used for return' }
      }

      let remById: Record<number, number> = {}
      let summaryById: Record<number, any> = {}
      let billReturns: PriorReturn[] = []
      let account: CustomerBalanceAccount | null = null
      try {
        const summary = await getReturnSummary(Number(b.id))
        summaryById = Object.fromEntries((summary || []).map((s: any) => [Number(s.item_id), s]))
        remById = Object.fromEntries((summary || []).map((s: any) => [Number(s.item_id), Number(s.remaining)]))
        billReturns = await listReturns({ source_bill_id: Number(b.id), limit: 500 })
        account = await loadBalanceAccountForBill(b)
      } catch (e) {
        remById = {}
        summaryById = {}
        billReturns = []
        account = null
        console.error('getReturnSummary failed', e)
      }

      const lines: BillLine[] = (b.items || []).map((it: any): BillLine => {
        const itemId = Number(it.item_id)
        return {
          item_id: itemId,
          name: it.item_name || it.name || it.item?.name || `#${it.item_id}`,
          brand: it.brand || it.item_brand || it.item?.brand || summaryById[itemId]?.brand || null,
          soldQty: Number(it.quantity),
          mrp: Number(it.mrp),
          charged_unit_price: Number(summaryById[itemId]?.charged_unit_price ?? 0) || undefined,
          remaining_value: Number(summaryById[itemId]?.remaining_value ?? 0),
        }
      })

      setBill(b)
      setPriorReturns(billReturns)
      setCustomerAccount(account)
      setRows(
        lines.map((l): Row => {
          const remaining = remById[l.item_id] ?? l.soldQty
          return {
            item_id: l.item_id,
            name: l.name,
            brand: l.brand,
            qty: 0,
            max: remaining,
            mrp: l.mrp,
            charged_unit_price: l.charged_unit_price,
            remaining_value: l.remaining_value,
          }
        })
      )

      setFinalTouched(false)
      setFinalRefund(0)

      return {
        ok: true,
        billId: b.id,
        noItems: lines.length === 0,
      }
    } catch (err: any) {
      const msg =
        err?.response?.data?.detail ||
        err?.response?.data?.message ||
        err?.message ||
        'Failed to load bill'
      return { ok: false, error: String(msg) }
    }
  }

  // handler for the "Load Bill" button → decides toast
  const handleLoadClick = async () => {
    const res = await loadBill()
    if (!res.ok) {
      toast.push(res.error || 'Failed to load bill', 'error')
      return
    }
    if (res.noItems) {
      toast.push('Bill loaded (no items)', 'info')
    } else {
      toast.push(`Bill #${res.billId} loaded`, 'success')
    }
  }

  // ---------- CREATE RETURN ----------
  const mCreate = useMutation({
    mutationFn: () => {
      const amt = clamp2(finalRefund)
      const refund_cash = mode === 'cash' ? amt : 0
      const refund_online = mode === 'online' ? amt : 0

      return createReturn({
        source_bill_id: Number(bill!.id),
        items: rows
          .filter(r => r.qty > 0)
          .map(r => ({ item_id: r.item_id, quantity: r.qty })),
        refund_mode: mode,
        refund_cash,
        refund_online,
        notes: '',
      })
    },
    onSuccess: () => {
      toast.push('Sales return created', 'success')

      setRows(prev => prev.map(r => ({ ...r, qty: 0 })))
      setFinalRefund(0)
      setFinalTouched(false)

      void loadBill()
    },
    onError: (err: any) => {
      const msg =
        err?.response?.data?.detail ||
        err?.response?.data?.message ||
        err?.message ||
        'Unknown error'
      toast.push('Sales return failed: ' + msg, 'error')
    },
  })

  function setQty(i: number, q: number) {
    setRows(prev =>
      prev.map((r, idx) => {
        if (idx !== i) return r
        const val = Math.max(0, Math.min(Number(q) || 0, r.max))
        return { ...r, qty: val }
      })
    )
  }

  function handleSubmitReturn() {
    if (rows.every(r => r.qty === 0)) {
      toast.push('Enter at least one return quantity', 'warning')
      return
    }
    if (finalRefund < 0) {
      toast.push('Final refund cannot be negative', 'warning')
      return
    }
    if (mode !== 'credit' && Math.abs(clamp2(finalRefund) - computedRefund) > 5) {
      toast.push(`Final refund must be within ±₹5 of computed ₹${computedRefund.toFixed(2)}`, 'warning')
      return
    }
    if (!mCreate.isPending) mCreate.mutate()
  }

  function soldUnitPrice(row: Row) {
    return chargedLine(row.item_id, row.mrp, 1, row.charged_unit_price, row.remaining_value, row.max)
  }

  function discountPerUnit(row: Row) {
    return round2(Math.max(0, Number(row.mrp || 0) - soldUnitPrice(row)))
  }

  return (
    <Stack gap={2}>
      <Typography variant="h5">Sales Returns</Typography>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
          <TextField
            label="Bill ID"
            value={query}
            onChange={e => setQuery(e.target.value)}
            fullWidth
          />
          <Button variant="contained" onClick={handleLoadClick} disabled={!query || isFetching}>
            Load Bill
          </Button>
          <Button variant="outlined" onClick={() => setBillPickerOpen(true)}>
            Find Bill
          </Button>
        </Stack>
      </Paper>

      {bill && (
        <Paper sx={{ p: 2 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1} sx={{ mb: 1 }}>
            <Typography variant="subtitle1">
              Bill #{bill.id} — {rows.length} items
            </Typography>
            <Button
              size="small"
              variant="outlined"
              startIcon={<VisibilityIcon />}
              onClick={() => setBillViewOpen(true)}
            >
              View Bill
            </Button>
          </Stack>

          <Box sx={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Avail. to Return</th>
                  <th>Return Qty</th>
                  <th>MRP</th>
                  <th>Sold Price</th>
                  <th>Line Refund</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.item_id}>
                    <td>
                      <Stack gap={0.25}>
                        <Typography variant="body2">{r.name}</Typography>
                        {r.brand ? (
                          <Typography variant="caption" color="text.secondary">
                            {r.brand}
                          </Typography>
                        ) : null}
                      </Stack>
                    </td>
                    <td>{r.max}</td>
                    <td>
                      <TextField
                        type="number"
                        value={r.qty}
                        onChange={e => setQty(i, Number(e.target.value || 0))}
                        inputProps={{ min: 0, max: r.max }}
                        sx={{ width: 110 }}
                      />
                    </td>
                    <td>
                      <Stack gap={0}>
                        <Typography variant="body2">₹{Number(r.mrp || 0).toFixed(2)}</Typography>
                        {discountPerUnit(r) > 0 ? (
                          <Typography variant="caption" color="text.secondary">
                            -₹{discountPerUnit(r).toFixed(2)}
                          </Typography>
                        ) : null}
                      </Stack>
                    </td>
                    <td>₹{soldUnitPrice(r).toFixed(2)}</td>
                    <td>{(lineRefunds[i] ?? 0).toFixed(2)}</td>
                    <td>
                      <IconButton
                        onClick={() => {
                          setQty(i, 0)
                          toast.push('Cleared line', 'info')
                        }}
                      >
                        <DeleteIcon />
                      </IconButton>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7}>
                      <Box p={2}>No items.</Box>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Box>

          {/* Totals + Final Refund editor */}
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            justifyContent="space-between"
            mt={2}
            gap={2}
            alignItems="center"
          >
            <Stack direction="row" gap={2} alignItems="center" flexWrap="wrap">
              <TextField
                select
                label="Refund Mode"
                value={mode}
                onChange={e => setMode(e.target.value as RefundMode)}
                SelectProps={{ native: true }}
                sx={{ width: 180 }}
              >
                <option value="cash">Cash</option>
                <option value="online">Online</option>
                <option value="credit">Auto settle (credit first)</option>
              </TextField>

              <Typography sx={{ minWidth: 180 }}>Computed: ₹{refund.toFixed(2)}</Typography>

              <TextField
                label="Final Refund (₹)"
                type="number"
                sx={{ width: 180 }}
                value={finalRefund}
                onChange={e => {
                  setFinalTouched(true)
                  setFinalRefund(Number(e.target.value || 0))
                }}
                inputProps={{ step: 1 }}
              />

              <Button
                variant="outlined"
                onClick={() => {
                  setFinalTouched(true)
                  setFinalRefund(v => clamp2((v || 0) - 5))
                }}
              >
                -5
              </Button>
              <Button
                variant="outlined"
                onClick={() => {
                  setFinalTouched(true)
                  setFinalRefund(v => clamp2((v || 0) + 5))
                }}
              >
                +5
              </Button>
              <Button
                variant="outlined"
                onClick={() => {
                  setFinalTouched(true)
                  setFinalRefund(round5Nearest(refund))
                }}
              >
                Round to ₹5
              </Button>
              <Button
                variant="text"
                onClick={() => {
                  setFinalTouched(false)
                  setFinalRefund(clamp2(refund))
                }}
              >
                Reset
              </Button>
            </Stack>

            <Button
              variant="contained"
              disabled={mCreate.isPending}
              onClick={handleSubmitReturn}
            >
              Submit Return
            </Button>
          </Stack>

          <Box mt={2}>
            <Alert severity={settlementPreview.unresolved > 0 ? 'warning' : mode === 'cash' ? 'success' : 'info'}>
              <Stack gap={1}>
                <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
                  <Chip size="small" label={`Credit adjusted Rs ${money(settlementPreview.credit)}`} color={settlementPreview.credit > 0 ? 'warning' : 'default'} variant="outlined" />
                  <Chip size="small" label={`Cash to return Rs ${money(settlementPreview.cash)}`} color={settlementPreview.cash > 0 ? 'success' : 'default'} variant="outlined" />
                  <Chip size="small" label={`Online to return Rs ${money(settlementPreview.online)}`} color={settlementPreview.online > 0 ? 'info' : 'default'} variant="outlined" />
                </Stack>
                <Typography variant="body2">
                  {mode === 'cash'
                    ? `Cash available from this bill is Rs ${money(settlementPreview.availableCash)}. Any unpaid balance is adjusted before cash is returned.`
                    : mode === 'online'
                      ? `Online available from this bill is Rs ${money(settlementPreview.availableOnline)}. Any unpaid balance is adjusted before online refund.`
                      : `The system will adjust pending credit first, then return any balance from paid cash/online.`}
                </Typography>
                {settlementPreview.unresolved > 0 ? (
                  <Typography variant="body2" color="error">
                    Rs {money(settlementPreview.unresolved)} cannot be settled from this bill's remaining credit or paid amount.
                  </Typography>
                ) : null}
              </Stack>
            </Alert>
          </Box>

          <Box mt={2}>
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Stack gap={1}>
                <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1}>
                  <Typography variant="subtitle2">Customer Balance</Typography>
                  {customerAccount ? (
                    <Typography variant="body2" color="text.secondary">
                      {customerAccount.name}{customerAccount.phone ? ` | ${customerAccount.phone}` : ''}
                    </Typography>
                  ) : null}
                </Stack>

                {!customerAccount ? (
                  <Typography variant="body2" color="text.secondary">
                    No linked customer on this bill, so customer balance will not be shown here.
                  </Typography>
                ) : (
                  <>
                    <Stack direction="row" gap={1} flexWrap="wrap">
                      <Chip
                        size="small"
                        label={`Current ${balanceLabel(customerBalancePreview.before)}`}
                        color={customerBalancePreview.before > 0 ? 'error' : customerBalancePreview.before < 0 ? 'info' : 'success'}
                        variant="outlined"
                      />
                      <Chip
                        size="small"
                        label={`After return ${balanceLabel(customerBalancePreview.after)}`}
                        color={customerBalancePreview.after > 0 ? 'error' : customerBalancePreview.after < 0 ? 'info' : 'success'}
                        variant="outlined"
                      />
                      <Chip size="small" label={`Outstanding Rs ${money(customerBalancePreview.outstandingBefore)}`} variant="outlined" />
                      <Chip size="small" label={`Advance Rs ${money(customerBalancePreview.advanceBefore)}`} variant="outlined" />
                    </Stack>
                    <Typography variant="body2" color="text.secondary">
                      This return reduces customer receivable by Rs {money(customerBalancePreview.creditImpact)}.
                      Cash Rs {money(customerBalancePreview.cashOut)} and online Rs {money(customerBalancePreview.onlineOut)} are paid back directly, so they do not remain as customer credit balance.
                    </Typography>
                  </>
                )}
              </Stack>
            </Paper>
          </Box>
        </Paper>
      )}

      <BillPickerDialog
        open={billPickerOpen}
        onClose={() => setBillPickerOpen(false)}
        onPick={(b: any) => {
          setQuery(String(b.id))
          setTimeout(() => {
            handleLoadClick()
          }, 0)
        }}
      />

      <Dialog open={billViewOpen} onClose={() => setBillViewOpen(false)} fullWidth maxWidth="lg">
        <DialogTitle>Bill Details {bill?.id ? `#${bill.id}` : ''}</DialogTitle>
        <DialogContent dividers>
          {!bill ? (
            <Box p={2} color="text.secondary">No bill loaded.</Box>
          ) : (
            <Stack gap={2}>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} flexWrap="wrap">
                <Typography>Bill Date: <b>{formatDateTime(bill.date_time)}</b></Typography>
                <Typography>Mode: <b>{String(bill.payment_mode || '-').toUpperCase()}</b></Typography>
                <Typography>Status: <b>{bill.payment_status || (bill.is_credit ? 'PARTIAL' : 'PAID')}</b></Typography>
                {customerAccount ? <Typography>Customer: <b>{customerAccount.name}</b></Typography> : null}
              </Stack>

              <Box sx={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Qty</th>
                      <th>MRP</th>
                      <th>Sold Price</th>
                      <th>Line Total</th>
                      <th>Batch / Expiry</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(bill.items || []).map((it: any, idx: number) => {
                      const qty = Number(it.quantity || 0)
                      const line = clamp2(Number(it.line_total || 0))
                      const unit = qty > 0 ? clamp2(line / qty) : 0
                      return (
                        <tr key={`${it.item_id}-${idx}`}>
                          <td>
                            <Stack gap={0.25}>
                              <Typography variant="body2">{it.item_name || it.name || `#${it.item_id}`}</Typography>
                              {it.brand ? <Typography variant="caption" color="text.secondary">{it.brand}</Typography> : null}
                            </Stack>
                          </td>
                          <td>{qty}</td>
                          <td>₹{money(Number(it.mrp || 0))}</td>
                          <td>₹{money(unit)}</td>
                          <td>₹{money(line)}</td>
                          <td>#{it.batch_number || it.item_id || '-'} / {formatExpiry(it.expiry_date)}</td>
                        </tr>
                      )
                    })}
                    {(bill.items || []).length === 0 ? (
                      <tr>
                        <td colSpan={6}><Box p={2} color="text.secondary">No items.</Box></td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </Box>

              <Divider />

              <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} flexWrap="wrap">
                <Chip label={`Original Rs ${money(billSummary.originalTotal)}`} variant="outlined" />
                <Chip label={`Credit Returns Rs ${money(billSummary.creditReturns)}`} color={billSummary.creditReturns > 0 ? 'warning' : 'default'} variant="outlined" />
                <Chip label={`Current Total Rs ${money(Number(bill.total_amount || 0))}`} color="primary" variant="outlined" />
                <Chip label={`Paid Rs ${money(billSummary.paid)}`} color="success" variant="outlined" />
                {billSummary.writeoff > 0 ? <Chip label={`Write-off Rs ${money(billSummary.writeoff)}`} variant="outlined" /> : null}
                <Chip label={`Pending Rs ${money(billSummary.pending)}`} color={billSummary.pending > 0 ? 'warning' : 'success'} variant="outlined" />
              </Stack>

              {bill.notes ? <Typography>Notes: <i>{bill.notes}</i></Typography> : null}
              {customerAccount ? (
                <Paper variant="outlined" sx={{ p: 1.5 }}>
                  <Stack direction="row" gap={1} flexWrap="wrap">
                    <Chip
                      size="small"
                      label={`Customer Balance ${balanceLabel(signedCustomerBalance(customerAccount))}`}
                      color={signedCustomerBalance(customerAccount) > 0 ? 'error' : signedCustomerBalance(customerAccount) < 0 ? 'info' : 'success'}
                      variant="outlined"
                    />
                    <Chip size="small" label={`Outstanding Rs ${money(Number(customerAccount.outstanding_amount || 0))}`} variant="outlined" />
                    <Chip size="small" label={`Advance Rs ${money(Number(customerAccount.advance_amount || 0))}`} variant="outlined" />
                  </Stack>
                </Paper>
              ) : null}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBillViewOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
