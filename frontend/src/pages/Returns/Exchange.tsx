// src/pages/Returns/Exchange.tsx
import { useEffect, useMemo, useState } from 'react'
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Paper, Stack, TextField, Typography, IconButton, MenuItem } from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { findBill, createExchange, getReturnSummary, listExchangeRecords, updateExchangeSettlement, type ExchangeRecord } from '../../services/returns'
import { useSearchParams } from 'react-router-dom'
import ItemPicker from '../../components/billing/ItemPicker'
import BillPickerDialog from '../../components/billing/BillPickerDialog'
import { useToast } from '../../components/ui/Toaster'

type RetRow = { item_id:number; name:string; brand?: string | null; qty:number; max:number; mrp:number; charged_unit_price?: number; remaining_value?: number }
type AddRow = { item_id:number; name:string; brand?: string | null; qty:number; mrp:number }

function round2(n:number){ return Math.round(n*100)/100 }
function asString(x:any){
  if (typeof x === 'string') return x
  try { return JSON.stringify(x, null, 2) } catch { return String(x) }
}

export default function Exchange() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const today = new Date().toLocaleDateString('en-CA')

  const [query, setQuery] = useState('')
  const [bill, setBill] = useState<any | null>(null)

  const [ret, setRet]   = useState<RetRow[]>([])
  const [add, setAdd]   = useState<AddRow[]>([])
  const [picker, setPicker] = useState(false)
  const [billPickerOpen, setBillPickerOpen] = useState(false)

  // Exchange discount on NEW items + final amount override
  const [exDiscount, setExDiscount] = useState(0)
  const [finalOverride, setFinalOverride] = useState<number | ''>('') // abs amount
  const [paymentMode, setPaymentMode] = useState<'cash' | 'online' | 'split' | 'credit'>('cash')
  const [paymentCashSplit, setPaymentCashSplit] = useState<number | ''>('')
  const [paymentOnlineSplit, setPaymentOnlineSplit] = useState<number | ''>('')
  const [paymentCreditSplit, setPaymentCreditSplit] = useState<number | ''>('')
  const [refundMode, setRefundMode] = useState<'cash' | 'online' | 'split' | 'credit'>('cash')
  const [exchangeDate, setExchangeDate] = useState(today)
  const [refundCashSplit, setRefundCashSplit] = useState<number | ''>('')
  const [refundOnlineSplit, setRefundOnlineSplit] = useState<number | ''>('')
  const [refundCreditSplit, setRefundCreditSplit] = useState<number | ''>('')
  const [historySearch, setHistorySearch] = useState('')
  const [historyFrom, setHistoryFrom] = useState('')
  const [historyTo, setHistoryTo] = useState('')
  const [historySettlement, setHistorySettlement] = useState<'all' | 'cash' | 'online' | 'split' | 'credit'>('all')
  const [editExchange, setEditExchange] = useState<ExchangeRecord | null>(null)
  const [editDate, setEditDate] = useState('')
  const [editCash, setEditCash] = useState<number | ''>('')
  const [editOnline, setEditOnline] = useState<number | ''>('')
  const [editCredit, setEditCredit] = useState<number | ''>('')

  const { refetch } = useQuery({
    queryKey: ['ex-bill', query],
    queryFn: () => findBill(query),
    enabled: false,
  })

  const history = useQuery({
    queryKey: ['exchange-history'],
    queryFn: async () => {
      const all = []
      const limit = 1000
      for (let offset = 0; ; offset += limit) {
        const page = await listExchangeRecords({ limit, offset })
        all.push(...page)
        if (page.length < limit) return all
      }
    },
  })

  const filteredHistory = useMemo(() => {
    const search = historySearch.trim().toLowerCase().replace(/^#/, '')
    return (history.data || []).filter((row) => {
      const date = String(row.created_at || '').slice(0, 10)
      if (historyFrom && date < historyFrom) return false
      if (historyTo && date > historyTo) return false
      if (historySettlement !== 'all' && row.payment_mode !== historySettlement) return false
      if (!search) return true
      return [row.id, row.source_bill_id, row.return_id, row.new_bill_id]
        .some((value) => value != null && String(value).toLowerCase().includes(search))
    })
  }, [history.data, historyFrom, historySearch, historySettlement, historyTo])

  const historyFiltersActive = Boolean(
    historySearch || historyFrom || historyTo || historySettlement !== 'all'
  )

  function openExchangeEditor(row: ExchangeRecord) {
    const refundSide = Number(row.net_due || 0) < 0
    setEditExchange(row)
    setEditDate(String(row.created_at || '').slice(0, 10))
    setEditCash(refundSide ? Number(row.refund_cash || 0) : Number(row.payment_cash || 0))
    setEditOnline(refundSide ? Number(row.refund_online || 0) : Number(row.payment_online || 0))
    setEditCredit(refundSide ? Number(row.refund_credit || 0) : Number(row.payment_credit || 0))
  }

  useEffect(() => {
    const editId = Number(searchParams.get('edit') || 0)
    if (!editId || !history.data || editExchange) return
    const row = history.data.find((item) => Number(item.id) === editId)
    if (row) openExchangeEditor(row)
  }, [history.data, searchParams, editExchange])

  const editMutation = useMutation({
    mutationFn: async () => {
      if (!editExchange) throw new Error('No exchange selected')
      const refundSide = Number(editExchange.net_due || 0) < 0
      const cash = round2(Number(editCash || 0))
      const online = round2(Number(editOnline || 0))
      const credit = round2(Number(editCredit || 0))
      const expected = round2(Math.abs(Number(editExchange.net_due || 0)))
      if (round2(cash + online + credit) !== expected) {
        throw new Error(`Cash + Online + Credit must equal ₹${expected.toFixed(2)}`)
      }
      return updateExchangeSettlement(editExchange.id, {
        exchange_date: editDate,
        payment_cash: refundSide ? 0 : cash,
        payment_online: refundSide ? 0 : online,
        payment_credit: refundSide ? 0 : credit,
        refund_cash: refundSide ? cash : 0,
        refund_online: refundSide ? online : 0,
        refund_credit: refundSide ? credit : 0,
      })
    },
    onSuccess: () => {
      toast.push('Exchange settlement updated', 'success')
      setEditExchange(null)
      setSearchParams({}, { replace: true })
      queryClient.invalidateQueries({ queryKey: ['exchange-history'] })
      queryClient.invalidateQueries({ queryKey: ['customer-returns'] })
      queryClient.invalidateQueries({ queryKey: ['bankbook'] })
      queryClient.invalidateQueries({ queryKey: ['cashbook'] })
    },
    onError: (error: any) => toast.push(String(error?.response?.data?.detail || error?.message || 'Exchange update failed'), 'error'),
  })

  const clamp = (v:number, lo:number, hi:number) => Math.max(lo, Math.min(v, hi))
  const nameOf = (it:any) =>
    it?.item_name ?? it?.name ?? it?.item?.name ?? it?.item?.item_name ?? `#${it?.item_id ?? ''}`
  const brandOf = (it:any) => it?.brand ?? it?.item_brand ?? it?.item?.brand ?? null

  // ====== Load bill + remaining qty (like Returns) ======
  async function load() {
    const res = await refetch()
    let data = res.data
    if (!data) return

    if (Array.isArray(data)) {
      if (data.length === 0) {
        toast.push('No bill found', 'error')
        return
      }
      if (data.length === 1) {
        data = data[0]
      } else {
        setBillPickerOpen(true)
        return
      }
    }
    if ((data as any).is_deleted) {
      toast.push('Deleted bill cannot be used for exchange', 'error')
      return
    }

    setBill(data)

    const lines = (data?.items || []) as any[]

    let remById: Record<number, number> = {}
    let summaryById: Record<number, any> = {}
    try {
      const summary = await getReturnSummary(Number(data.id))
      summaryById = Object.fromEntries(
        (summary || []).map((s: any) => [Number(s.item_id), s])
      )
      remById = Object.fromEntries(
        (summary || []).map((s: any) => [Number(s.item_id), Number(s.remaining)])
      )
    } catch (e) {
      console.error('getReturnSummary failed (Exchange)', e)
      remById = {}
    }

    const rows: RetRow[] = lines.map((it:any) => {
      const item_id = Number(it.item_id)
      const mrp = Number(it.mrp ?? 0)
      const soldQty = Number(it.quantity ?? 0)
      const remaining = remById[item_id] ?? soldQty
      return {
        item_id,
        name: nameOf(it),
        brand: brandOf(it) || summaryById[item_id]?.brand || null,
        qty: 0,
        max: remaining,
        mrp,
        charged_unit_price: Number(summaryById[item_id]?.charged_unit_price ?? 0) || undefined,
        remaining_value: Number(summaryById[item_id]?.remaining_value ?? 0),
      }
    })

    setRet(rows)
    setAdd([]) // clear added items when bill changes
    setExDiscount(0)
    setFinalOverride('')
    setPaymentMode('cash')
    setPaymentCashSplit('')
    setPaymentOnlineSplit('')
    setPaymentCreditSplit('')
    setRefundMode('cash')
    setRefundCashSplit('')
    setRefundOnlineSplit('')
    setRefundCreditSplit('')
  }

  // ====== return pricing context ======
  const pricing = useMemo(() => {
    if (!bill) return { factor: 1, disc: 0, tax: 0, final: 0, computed: 0 }
    const items = (bill.items || []) as any[]
    const sub = items.reduce((s, it) => s + Number(it.mrp) * Number(it.quantity), 0)
    const discAmt = sub * Number(bill.discount_percent || 0) / 100
    const afterDisc = sub - discAmt
    const taxAmt = afterDisc * Number(bill.tax_percent || 0) / 100
    const computed = afterDisc + taxAmt
    const final = Number(bill.original_total_amount ?? bill.total_amount ?? computed)
    const factor = computed > 0 ? final / computed : 1
    return {
      factor,
      disc: Number(bill.discount_percent || 0),
      tax: Number(bill.tax_percent || 0),
      final,
      computed
    }
  }, [bill])

  const savedBillLineTotal = useMemo(
    () => (bill?.items || []).reduce((sum: number, item: any) => sum + Number(item.line_total || 0), 0),
    [bill]
  )

  const chargedLine = (itemId:number, mrp:number, qty:number, chargedUnitPrice?:number, remainingValue?:number, remainingQty?:number) => {
    if (remainingValue != null && Number(remainingQty || 0) > 0) {
      return qty === Number(remainingQty)
        ? round2(Number(remainingValue))
        : round2(Number(remainingValue) * Number(qty) / Number(remainingQty))
    }
    if (chargedUnitPrice != null && Number.isFinite(Number(chargedUnitPrice))) {
      return round2(Number(chargedUnitPrice) * Number(qty))
    }
    const saved = (bill?.items || []).find((item: any) => Number(item.item_id) === Number(itemId))
    const soldQty = Number(saved?.quantity || 0)
    const savedTotal = Number(saved?.line_total || 0)
    if (soldQty > 0 && savedTotal > 0) {
      const legacyFactor = savedBillLineTotal > 0 ? Math.min(1, Number(pricing.final || savedBillLineTotal) / savedBillLineTotal) : 1
      return round2((savedTotal / soldQty) * Number(qty) * legacyFactor)
    }
    return round2(Number(mrp) * Number(qty) * pricing.factor)
  }

  const returnAmt = useMemo(() => {
    if (!bill) return 0
    return ret.reduce((s, r) => s + chargedLine(r.item_id, r.mrp, r.qty, r.charged_unit_price, r.remaining_value, r.max), 0)
  }, [bill, ret])

  const newAmt = useMemo(
    () => add.reduce((s, r) => s + r.qty * r.mrp, 0),
    [add]
  )

  // ---------- EXCHANGE MATH (FE + BE must match) ----------

  // Base difference (no extra exchange discount)
  const baseDiff = newAmt - returnAmt // +ve = customer pays

  // Discount applies ONLY on new items
  const discountedNew = newAmt * (1 - (Number(exDiscount) || 0) / 100)

  // Auto delta = theoretical_net on backend
  const autoDelta = discountedNew - returnAmt        // +ve => customer pays, -ve => refund
  const autoAmountAbs = round2(Math.abs(autoDelta))

  // What we *show/edit* in the final amount box
  const chosenAmountAbs =
    finalOverride === '' ? autoAmountAbs : round2(Number(finalOverride) || 0)

  // Decide sign for final amount (customer pays vs refund)
  const sign = autoDelta !== 0
    ? (autoDelta > 0 ? 1 : -1)
    : (baseDiff >= 0 ? 1 : -1)

  // This is the final net_due we want (with sign)
  const chosenDelta = sign * chosenAmountAbs

  // NEW: rounding_adjustment = final - theoretical
  const roundingAdjustment = round2(chosenDelta - autoDelta)   // NEW

  // -------------------------------------------------------

  function buildExchangePayload() {
    if (!bill) throw new Error('No bill loaded')

    const payload: any = {
      source_bill_id: Number(bill.id),
      return_items: ret
        .filter((r) => r.qty > 0)
        .map((r) => ({ item_id: r.item_id, quantity: r.qty })),
      new_items: add.map((a) => ({
        item_id: a.item_id,
        quantity: a.qty,
      })),
      discount_percent: Number(exDiscount) || 0,  // extra discount on NEW items

      // NEW: tell backend how much we rounded
      rounding_adjustment: roundingAdjustment,    // 🔴 IMPORTANT

      notes: '',
      exchange_date: exchangeDate,
      payment_mode: chosenDelta < 0 ? refundMode : paymentMode,
      payment_cash: 0,
      payment_online: 0,
      payment_credit: 0,
      refund_cash: 0,
      refund_online: 0,
      refund_credit: 0,
    }

    if (chosenDelta > 0) {
      // customer pays
      const payAbs = round2(chosenDelta)
      if (paymentMode === 'cash') {
        payload.payment_cash = payAbs
      } else if (paymentMode === 'online') {
        payload.payment_online = payAbs
      } else if (paymentMode === 'credit') {
        payload.payment_credit = payAbs
      } else {
        const c = round2(Number(paymentCashSplit || 0))
        const o = round2(Number(paymentOnlineSplit || 0))
        const cr = round2(Number(paymentCreditSplit || 0))
        if (c < 0 || o < 0 || cr < 0) throw new Error('Payment split amounts cannot be negative')
        if (round2(c + o + cr) !== payAbs) {
          throw new Error(`Payment split mismatch. Cash + Online + Credit must equal ₹${payAbs.toFixed(2)}.`)
        }
        payload.payment_cash = c
        payload.payment_online = o
        payload.payment_credit = cr
      }
    } else if (chosenDelta < 0) {
      // refund to customer
      const refundAbs = round2(-chosenDelta)
      if (refundMode === 'credit') {
        payload.refund_credit = refundAbs
      } else if (refundMode === 'cash') {
        payload.refund_cash = refundAbs
      } else if (refundMode === 'online') {
        payload.refund_online = refundAbs
      } else {
        const c = round2(Number(refundCashSplit || 0))
        const o = round2(Number(refundOnlineSplit || 0))
        const cr = round2(Number(refundCreditSplit || 0))
        if (c < 0 || o < 0 || cr < 0) throw new Error('Refund split amounts cannot be negative')
        if (round2(c + o + cr) !== refundAbs) {
          throw new Error(`Refund split mismatch. Cash + Online + Credit must equal ₹${refundAbs.toFixed(2)}.`)
        }
        payload.refund_cash = c
        payload.refund_online = o
        payload.refund_credit = cr
      }
    }
    return payload
  }

  const mEx = useMutation({
    mutationFn: async () => createExchange(buildExchangePayload()),
    onSuccess: () => {
      toast.push('Exchange completed', 'success')
      setBill(null); setRet([]); setAdd([]); setQuery('')
      setExDiscount(0); setFinalOverride('')
      setPaymentMode('cash'); setPaymentCashSplit(''); setPaymentOnlineSplit('')
      setPaymentCreditSplit('')
      setRefundMode('cash'); setRefundCashSplit(''); setRefundOnlineSplit(''); setRefundCreditSplit('')
      queryClient.invalidateQueries({ queryKey: ['exchange-history'] })
    },
    onError: (err: any) => {
      const d = err?.response?.data
      let msg = err?.message || 'Failed to create exchange'

      if (d?.detail) {
        if (Array.isArray(d.detail)) {
          msg = d.detail.map((e:any) =>
            [ ...(e.loc || []), e.msg ].filter(Boolean).join(' → ')
          ).join('\n')
        } else if (typeof d.detail === 'string') {
          msg = d.detail
        } else {
          msg = asString(d.detail)
        }
      } else if (d) {
        msg = asString(d)
      }

      console.error('Exchange error (full):', err)
      console.error('Exchange error response:', d)
      toast.push(msg, 'error')
    },
  })

  function submitExchange() {
    if (ret.every((r) => r.qty === 0) && add.length === 0) {
      toast.push('Enter at least one return quantity or add one exchange item', 'warning')
      return
    }
    if (!mEx.isPending) mEx.mutate()
  }

  return (
    <Stack gap={2}>
      <Typography variant="h5">Exchange</Typography>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
          <TextField label="Bill Number" value={query} onChange={(e) => setQuery(e.target.value)} fullWidth />
          <Button variant="contained" onClick={load} disabled={!query}>Load Bill</Button>
          <Button variant="outlined" onClick={() => setBillPickerOpen(true)}>Find Bill</Button>
          <TextField
            label="Exchange Date"
            type="date"
            value={exchangeDate}
            onChange={(e) => setExchangeDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
            inputProps={{ max: today }}
            sx={{ minWidth: 180 }}
          />
        </Stack>
      </Paper>

      {bill && (
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            Return from Bill #{bill.bill_number || bill.id}
          </Typography>

          <Box sx={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Avail. to Exchange</th>
                  <th>Return Qty</th>
                  <th>MRP</th>
                  <th>Return Value</th>
                </tr>
              </thead>
              <tbody>
                {ret.map((r, i) => (
                  <tr key={`${r.item_id}-${i}`}>
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
                        onChange={(e) =>
                          setRet((prev) =>
                            prev.map((x, idx) =>
                              idx === i ? { ...x, qty: clamp(Number(e.target.value || 0), 0, r.max) } : x
                            )
                          )
                        }
                        inputProps={{ min: 0, max: r.max }} sx={{ width: 110 }}
                      />
                    </td>
                    <td>{r.mrp}</td>
                    <td>
                      {chargedLine(r.item_id, r.mrp, r.qty, r.charged_unit_price, r.remaining_value, r.max).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Box>

          <Box mt={3}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="subtitle1">Add New Items</Typography>
              <Button onClick={() => setPicker(true)} variant="outlined">Add Item</Button>
            </Stack>

            <Box sx={{ overflowX: 'auto', mt: 1 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>MRP</th>
                    <th>Qty</th>
                    <th>Line</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {add.map((r, i) => (
                    <tr key={`${r.item_id}-${i}`}>
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
                      <td>{r.mrp}</td>
                      <td>
                        <TextField
                          type="number"
                          value={r.qty}
                          onChange={(e) =>
                            setAdd((prev) =>
                              prev.map((x, idx) =>
                                idx === i ? { ...x, qty: Math.max(1, Number(e.target.value || 1)) } : x
                              )
                            )
                          }
                          sx={{ width: 110 }}
                        />
                      </td>
                      <td>{(r.qty * r.mrp).toFixed(2)}</td>
                      <td>
                        <IconButton
                          aria-label="Remove item"
                          onClick={() =>
                            setAdd(prev => prev.filter((_, idx) => idx !== i))
                          }
                          sx={{ color: 'red' }}
                        >
                          <DeleteIcon />
                        </IconButton>
                      </td>
                    </tr>
                  ))}
                  {add.length === 0 && (
                    <tr><td colSpan={5}><Box p={2}>No new items.</Box></td></tr>
                  )}
                </tbody>
              </table>
            </Box>
          </Box>

          {/* Summary + discount + final amount */}
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            justifyContent="space-between"
            mt={2}
            gap={2}
          >
            <Typography>
              Return Value: ₹{returnAmt.toFixed(2)} | New Items: ₹{newAmt.toFixed(2)}
            </Typography>

            <Stack alignItems={{ xs: 'flex-start', md: 'flex-end' }} gap={0.75}>
              <Typography variant="body2" color="text.secondary">
                Base {baseDiff >= 0 ? 'Customer Pays' : 'Refund'} (no extra discount): ₹{Math.abs(baseDiff).toFixed(2)}
              </Typography>

              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                alignItems="center"
                justifyContent="flex-end"
              >
                <TextField
                  size="small"
                  label="Exchange Discount % (on new items)"
                  type="number"
                  value={exDiscount}
                  onChange={(e) => setExDiscount(Number(e.target.value || 0))}
                  sx={{ width: 210 }}
                />
                <TextField
                  size="small"
                  label={sign >= 0 ? 'Final Amount Customer Pays' : 'Final Refund Amount'}
                  type="number"
                  value={chosenAmountAbs}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === '') {
                      setFinalOverride('')
                    } else {
                      setFinalOverride(Number(v) || 0)
                    }
                  }}
                  sx={{ width: 210 }}
                  inputProps={{ min: 0, step: '0.01' }}
                />
              </Stack>

              {chosenDelta > 0 && (
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={1}
                  alignItems="center"
                  justifyContent="flex-end"
                >
                  <TextField
                    select
                    size="small"
                    label="Payment Mode"
                    value={paymentMode}
                    onChange={(e) => {
                      const mode = e.target.value as 'cash' | 'online' | 'split' | 'credit'
                      setPaymentMode(mode)
                      if (mode !== 'split') {
                        setPaymentCashSplit('')
                        setPaymentOnlineSplit('')
                        setPaymentCreditSplit('')
                      }
                    }}
                    sx={{ width: 210 }}
                  >
                    <MenuItem value="cash">Cash</MenuItem>
                    <MenuItem value="online">Online</MenuItem>
                    <MenuItem value="split">Split</MenuItem>
                    <MenuItem value="credit">Credit</MenuItem>
                  </TextField>

                  {paymentMode === 'split' && (
                    <>
                      <TextField
                        size="small"
                        label="Payment Cash"
                        type="number"
                        value={paymentCashSplit}
                        onChange={(e) => setPaymentCashSplit(e.target.value === '' ? '' : Math.max(0, round2(Number(e.target.value))))}
                        sx={{ width: 160 }}
                        inputProps={{ min: 0, step: '0.01' }}
                      />
                      <TextField
                        size="small"
                        label="Payment Online"
                        type="number"
                        value={paymentOnlineSplit}
                        onChange={(e) => setPaymentOnlineSplit(e.target.value === '' ? '' : Math.max(0, round2(Number(e.target.value))))}
                        sx={{ width: 160 }}
                        inputProps={{ min: 0, step: '0.01' }}
                      />
                      <TextField
                        size="small" label="Payment Credit" type="number"
                        value={paymentCreditSplit}
                        onChange={(e) => setPaymentCreditSplit(e.target.value === '' ? '' : Math.max(0, round2(Number(e.target.value))))}
                        sx={{ width: 160 }} inputProps={{ min: 0, step: '0.01' }}
                      />
                    </>
                  )}
                </Stack>
              )}

              {chosenDelta < 0 && (
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={1}
                  alignItems="center"
                  justifyContent="flex-end"
                >
                  <TextField
                    select
                    size="small"
                    label="Refund Mode"
                    value={refundMode}
                    onChange={(e) => {
                      const mode = e.target.value as 'cash' | 'online' | 'split' | 'credit'
                      setRefundMode(mode)
                      if (mode !== 'split') {
                        setRefundCashSplit('')
                        setRefundOnlineSplit('')
                        setRefundCreditSplit('')
                      }
                    }}
                    sx={{ width: 210 }}
                  >
                    <MenuItem value="cash">Cash</MenuItem>
                    <MenuItem value="online">Online</MenuItem>
                    <MenuItem value="split">Split</MenuItem>
                    <MenuItem value="credit">Credit (customer balance)</MenuItem>
                  </TextField>

                  {refundMode === 'split' && (
                    <>
                      <TextField
                        size="small"
                        label="Refund Cash"
                        type="number"
                        value={refundCashSplit}
                        onChange={(e) => setRefundCashSplit(e.target.value === '' ? '' : Math.max(0, round2(Number(e.target.value))))}
                        sx={{ width: 160 }}
                        inputProps={{ min: 0, step: '0.01' }}
                      />
                      <TextField
                        size="small"
                        label="Refund Online"
                        type="number"
                        value={refundOnlineSplit}
                        onChange={(e) => setRefundOnlineSplit(e.target.value === '' ? '' : Math.max(0, round2(Number(e.target.value))))}
                        sx={{ width: 160 }}
                        inputProps={{ min: 0, step: '0.01' }}
                      />
                      <TextField
                        size="small" label="Refund Credit" type="number"
                        value={refundCreditSplit}
                        onChange={(e) => setRefundCreditSplit(e.target.value === '' ? '' : Math.max(0, round2(Number(e.target.value))))}
                        sx={{ width: 160 }} inputProps={{ min: 0, step: '0.01' }}
                      />
                    </>
                  )}
                </Stack>
              )}

              <Typography variant="h6">
                {chosenDelta >= 0
                  ? `Customer Pays: ₹${chosenAmountAbs.toFixed(2)}`
                  : `Refund to Customer: ₹${chosenAmountAbs.toFixed(2)}`
                }
              </Typography>
            </Stack>
          </Stack>

          <Box textAlign="right" mt={2}>
            <Button
              variant="contained"
              disabled={mEx.isPending}
              onClick={submitExchange}
            >
              {mEx.isPending ? 'Submitting…' : 'Submit Exchange'}
            </Button>
          </Box>
        </Paper>
      )}

      <Paper sx={{ p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
          <Typography variant="h6">Exchange History</Typography>
          <Typography variant="body2" color="text.secondary">
            {historyFiltersActive
              ? `${filteredHistory.length} of ${history.data?.length || 0}`
              : history.data?.length || 0}{' '}
            record{filteredHistory.length === 1 ? '' : 's'}
          </Typography>
        </Stack>
        <Stack direction={{ xs: 'column', md: 'row' }} gap={1.5} mb={2}>
          <TextField
            size="small"
            label="Search IDs"
            placeholder="Exchange, source bill, return or new bill"
            value={historySearch}
            onChange={(e) => setHistorySearch(e.target.value)}
            sx={{ minWidth: 280, flexGrow: 1 }}
          />
          <TextField
            size="small"
            label="From"
            type="date"
            value={historyFrom}
            onChange={(e) => setHistoryFrom(e.target.value)}
            InputLabelProps={{ shrink: true }}
            inputProps={{ max: historyTo || undefined }}
            sx={{ minWidth: 155 }}
          />
          <TextField
            size="small"
            label="To"
            type="date"
            value={historyTo}
            onChange={(e) => setHistoryTo(e.target.value)}
            InputLabelProps={{ shrink: true }}
            inputProps={{ min: historyFrom || undefined }}
            sx={{ minWidth: 155 }}
          />
          <TextField
            select
            size="small"
            label="Settlement"
            value={historySettlement}
            onChange={(e) => setHistorySettlement(e.target.value as typeof historySettlement)}
            sx={{ minWidth: 155 }}
          >
            <MenuItem value="all">All</MenuItem>
            <MenuItem value="cash">Cash</MenuItem>
            <MenuItem value="online">Online</MenuItem>
            <MenuItem value="split">Split</MenuItem>
            <MenuItem value="credit">Credit</MenuItem>
          </TextField>
          <Button
            variant="outlined"
            disabled={!historyFiltersActive}
            onClick={() => {
              setHistorySearch('')
              setHistoryFrom('')
              setHistoryTo('')
              setHistorySettlement('all')
            }}
          >
            Clear
          </Button>
        </Stack>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th><th>Exchange</th><th>Source Bill</th><th>Return</th><th>New Bill</th>
                <th>Settlement</th><th>Customer Pays / (Credit)</th><th>Refund / (Credit)</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filteredHistory.map((row) => {
                const credit = row.payment_mode === 'credit'
                const payable = Number(row.net_due || 0) > 0 ? Number(row.net_due) : 0
                const refundable = Number(row.net_due || 0) < 0 ? Math.abs(Number(row.net_due)) : 0
                return (
                  <tr key={row.id}>
                    <td>{String(row.created_at || '').slice(0, 10)}</td>
                    <td>#{row.id}</td>
                    <td>{row.source_bill_id ? `#${row.source_bill_id}` : '—'}</td>
                    <td>#{row.return_id}</td>
                    <td>#{row.new_bill_id}</td>
                    <td>{credit ? 'Credit' : row.payment_mode}</td>
                    <td>{payable ? `₹${payable.toFixed(2)}${credit ? ' credit' : ''}` : '—'}</td>
                    <td>{refundable ? `₹${refundable.toFixed(2)}${credit ? ' credit' : ''}` : '—'}</td>
                    <td>
                      <IconButton aria-label={`Edit exchange ${row.id}`} onClick={() => openExchangeEditor(row)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </td>
                  </tr>
                )
              })}
              {!history.isLoading && filteredHistory.length === 0 && (
                <tr><td colSpan={9}><Box p={2}>{historyFiltersActive ? 'No exchanges match these filters.' : 'No exchange records yet.'}</Box></td></tr>
              )}
              {history.isLoading && <tr><td colSpan={9}><Box p={2}>Loading history…</Box></td></tr>}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Dialog open={Boolean(editExchange)} onClose={() => !editMutation.isPending && setEditExchange(null)} fullWidth maxWidth="sm">
        <DialogTitle>Edit Exchange #{editExchange?.id}</DialogTitle>
        <DialogContent>
          <Stack gap={2} mt={1}>
            <Typography color="text.secondary">
              Items and quantities are locked. This safely changes only the date and settlement allocation.
            </Typography>
            <TextField
              label="Exchange Date" type="date" value={editDate}
              onChange={(e) => setEditDate(e.target.value)} InputLabelProps={{ shrink: true }}
              inputProps={{ max: today }} fullWidth
            />
            <Typography fontWeight={700}>
              {Number(editExchange?.net_due || 0) < 0 ? 'Customer receives' : 'Customer pays'}: ₹{Math.abs(Number(editExchange?.net_due || 0)).toFixed(2)}
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5}>
              <TextField label="Cash" type="number" value={editCash} onChange={(e) => setEditCash(e.target.value === '' ? '' : Number(e.target.value))} inputProps={{ min: 0, step: '0.01' }} fullWidth />
              <TextField label="Online" type="number" value={editOnline} onChange={(e) => setEditOnline(e.target.value === '' ? '' : Number(e.target.value))} inputProps={{ min: 0, step: '0.01' }} fullWidth />
              <TextField label="Credit" type="number" value={editCredit} onChange={(e) => setEditCredit(e.target.value === '' ? '' : Number(e.target.value))} inputProps={{ min: 0, step: '0.01' }} fullWidth />
            </Stack>
            <Typography variant="body2" color={round2(Number(editCash || 0) + Number(editOnline || 0) + Number(editCredit || 0)) === round2(Math.abs(Number(editExchange?.net_due || 0))) ? 'success.main' : 'error.main'}>
              Allocated ₹{round2(Number(editCash || 0) + Number(editOnline || 0) + Number(editCredit || 0)).toFixed(2)} of ₹{Math.abs(Number(editExchange?.net_due || 0)).toFixed(2)}
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditExchange(null)} disabled={editMutation.isPending}>Cancel</Button>
          <Button variant="contained" onClick={() => editMutation.mutate()} disabled={editMutation.isPending || !editDate}>
            {editMutation.isPending ? 'Saving…' : 'Save Exchange'}
          </Button>
        </DialogActions>
      </Dialog>

      <ItemPicker
        open={picker}
        onClose={() => setPicker(false)}
        onPick={(it: any) => {
          setAdd((prev) => {
            const idx = prev.findIndex((p) => p.item_id === it.id)
            const mrp = Number(it.mrp) || 0
            if (idx >= 0) {
              const c = [...prev]
              c[idx] = { ...c[idx], qty: c[idx].qty + 1, mrp, brand: it.brand ?? c[idx].brand ?? null }
              return c
            }
            return [...prev, { item_id: it.id, name: it.name, brand: it.brand || null, mrp, qty: 1 }]
          })
        }}
      />

      <BillPickerDialog
        open={billPickerOpen}
        onClose={() => setBillPickerOpen(false)}
        onPick={(b: any) => {
          setBillPickerOpen(false)
          setQuery(String(b.id))
          setTimeout(() => load(), 0)
        }}
      />
    </Stack>
  )
}
