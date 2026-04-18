// src/pages/Returns/Exchange.tsx
import { useEffect, useMemo, useState } from 'react'
import { Box, Button, Paper, Stack, TextField, Typography, IconButton, MenuItem } from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import { useMutation, useQuery } from '@tanstack/react-query'
import { findBill, createExchange, getReturnSummary } from '../../services/returns'
import ItemPicker from '../../components/billing/ItemPicker'
import BillPickerDialog from '../../components/billing/BillPickerDialog'
import { useToast } from '../../components/ui/Toaster'

type RetRow = { item_id:number; name:string; qty:number; max:number; mrp:number; stock_unit?: string | null }
type AddRow = { item_id:number; name:string; qty:number; mrp:number }

function round2(n:number){ return Math.round(n*100)/100 }
function asString(x:any){
  if (typeof x === 'string') return x
  try { return JSON.stringify(x, null, 2) } catch { return String(x) }
}

export default function Exchange() {
  const toast = useToast()

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
  const [refundMode, setRefundMode] = useState<'cash' | 'online' | 'split'>('cash')
  const [refundCashSplit, setRefundCashSplit] = useState<number | ''>('')
  const [refundOnlineSplit, setRefundOnlineSplit] = useState<number | ''>('')

  const { refetch } = useQuery({
    queryKey: ['ex-bill', query],
    queryFn: () => findBill(query),
    enabled: false,
  })

  const clamp = (v:number, lo:number, hi:number) => Math.max(lo, Math.min(v, hi))
  const nameOf = (it:any) =>
    it?.item_name ?? it?.name ?? it?.item?.name ?? it?.item?.item_name ?? `#${it?.item_id ?? ''}`

  // ====== Load bill + remaining qty (like Returns) ======
  async function load() {
    const res = await refetch()
    const data = res.data
    if (!data) return

    if (Array.isArray(data)) { setBillPickerOpen(true); return }
    if (Boolean((data as any).is_deleted)) {
      toast.push('Deleted bill cannot be used for exchange', 'error')
      return
    }

    setBill(data)

    const lines = (data?.items || []) as any[]

    let remById: Record<number, number> = {}
    try {
      const summary = await getReturnSummary(Number(data.id))
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
        qty: 0,
        max: remaining,
        mrp,
        stock_unit: it.stock_unit ?? null,
      }
    })

    setRet(rows)
    setAdd([]) // clear added items when bill changes
    setExDiscount(0)
    setFinalOverride('')
    setPaymentMode('cash')
    setPaymentCashSplit('')
    setPaymentOnlineSplit('')
    setRefundMode('cash')
    setRefundCashSplit('')
    setRefundOnlineSplit('')
  }

  // ====== full/partial detection and proration context ======
  const isFullReturn = !!bill && ret.length > 0 && ret.every(r => r.qty === r.max)

  const pricing = useMemo(() => {
    if (!bill) return { factor: 1, disc: 0, tax: 0, final: 0, computed: 0 }
    const items = (bill.items || []) as any[]
    const sub = items.reduce((s, it) => s + Number(it.mrp) * Number(it.quantity), 0)
    const discAmt = sub * Number(bill.discount_percent || 0) / 100
    const afterDisc = sub - discAmt
    const taxAmt = afterDisc * Number(bill.tax_percent || 0) / 100
    const computed = afterDisc + taxAmt
    const final = Number(bill.total_amount ?? computed)
    const factor = computed > 0 ? final / computed : 1
    return {
      factor,
      disc: Number(bill.discount_percent || 0),
      tax: Number(bill.tax_percent || 0),
      final,
      computed
    }
  }, [bill])

  const chargedLine = (mrp:number, qty:number) => {
    const sub = Number(mrp) * Number(qty)
    const afterDisc = sub * (1 - pricing.disc/100)
    const afterTax  = afterDisc * (1 + pricing.tax/100)
    return round2(afterTax * pricing.factor)
  }

  const returnAmt = useMemo(() => {
    if (!bill) return 0
    return isFullReturn
      ? Number(pricing.final)
      : ret.reduce((s, r) => s + chargedLine(r.mrp, r.qty), 0)
  }, [bill, isFullReturn, pricing.final, ret])

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

  useEffect(() => {
    if (chosenDelta <= 0 || paymentMode !== 'split') return
    const c = Math.min(chosenAmountAbs, Math.max(0, round2(Number(paymentCashSplit || 0))))
    setPaymentCashSplit(c)
    setPaymentOnlineSplit(round2(Math.max(0, chosenAmountAbs - c)))
  }, [chosenDelta, chosenAmountAbs, paymentMode])

  useEffect(() => {
    if (chosenDelta >= 0 || refundMode !== 'split') return
    const c = Math.min(chosenAmountAbs, Math.max(0, round2(Number(refundCashSplit || 0))))
    setRefundCashSplit(c)
    setRefundOnlineSplit(round2(Math.max(0, chosenAmountAbs - c)))
  }, [chosenDelta, chosenAmountAbs, refundMode])

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
      payment_mode: paymentMode,
      payment_cash: 0,
      payment_online: 0,
      refund_cash: 0,
      refund_online: 0,
    }

    if (chosenDelta > 0) {
      // customer pays
      const payAbs = round2(chosenDelta)
      if (paymentMode === 'cash') {
        payload.payment_cash = payAbs
      } else if (paymentMode === 'online') {
        payload.payment_online = payAbs
      } else if (paymentMode === 'credit') {
        payload.payment_cash = 0
        payload.payment_online = 0
      } else {
        const c = round2(Number(paymentCashSplit || 0))
        const o = round2(Number(paymentOnlineSplit || 0))
        if (c < 0 || o < 0) throw new Error('Payment split amounts cannot be negative')
        if (round2(c + o) !== payAbs) {
          throw new Error(`Payment split mismatch. Cash + Online must equal ₹${payAbs.toFixed(2)}.`)
        }
        payload.payment_cash = c
        payload.payment_online = o
      }
    } else if (chosenDelta < 0) {
      // refund to customer
      const refundAbs = round2(-chosenDelta)
      if (refundMode === 'cash') {
        payload.refund_cash = refundAbs
      } else if (refundMode === 'online') {
        payload.refund_online = refundAbs
      } else {
        const c = round2(Number(refundCashSplit || 0))
        const o = round2(Number(refundOnlineSplit || 0))
        if (c < 0 || o < 0) throw new Error('Refund split amounts cannot be negative')
        if (round2(c + o) !== refundAbs) {
          throw new Error(`Refund split mismatch. Cash + Online must equal ₹${refundAbs.toFixed(2)}.`)
        }
        payload.refund_cash = c
        payload.refund_online = o
      }
    }

    console.log('Exchange payload →', payload)
    return payload
  }

  const mEx = useMutation({
    mutationFn: async () => createExchange(buildExchangePayload()),
    onSuccess: () => {
      toast.push('Exchange completed', 'success')
      setBill(null); setRet([]); setAdd([]); setQuery('')
      setExDiscount(0); setFinalOverride('')
      setPaymentMode('cash'); setPaymentCashSplit(''); setPaymentOnlineSplit('')
      setRefundMode('cash'); setRefundCashSplit(''); setRefundOnlineSplit('')
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

  return (
    <Stack gap={2}>
      <Typography variant="h5">Exchange</Typography>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
          <TextField label="Bill ID" value={query} onChange={(e) => setQuery(e.target.value)} fullWidth />
          <Button variant="contained" onClick={load} disabled={!query}>Load Bill</Button>
          <Button variant="outlined" onClick={() => setBillPickerOpen(true)}>Find Bill</Button>
        </Stack>
      </Paper>

      {bill && (
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            Return from Bill #{bill.id}
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
                      {r.name}
                      {r.stock_unit ? (
                        <Box color="text.secondary" sx={{ fontSize: 12 }}>
                          Sold as: {r.stock_unit}
                        </Box>
                      ) : null}
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
                      {isFullReturn
                        ? (r.qty ? Number(pricing.final).toFixed(2) : '0.00')
                        : chargedLine(r.mrp, r.qty).toFixed(2)
                      }
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
                      <td>{r.name}</td>
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
                        onChange={(e) => {
                          const raw = e.target.value
                          if (raw === '') {
                            setPaymentCashSplit('')
                            setPaymentOnlineSplit(chosenAmountAbs > 0 ? chosenAmountAbs : '')
                            return
                          }
                          const c = Math.min(chosenAmountAbs, Math.max(0, round2(Number(raw))))
                          setPaymentCashSplit(c)
                          setPaymentOnlineSplit(round2(Math.max(0, chosenAmountAbs - c)))
                        }}
                        sx={{ width: 160 }}
                        inputProps={{ min: 0, step: '0.01' }}
                      />
                      <TextField
                        size="small"
                        label="Payment Online"
                        type="number"
                        value={paymentOnlineSplit}
                        onChange={(e) => {
                          const raw = e.target.value
                          if (raw === '') {
                            setPaymentOnlineSplit('')
                            setPaymentCashSplit(chosenAmountAbs > 0 ? chosenAmountAbs : '')
                            return
                          }
                          const o = Math.min(chosenAmountAbs, Math.max(0, round2(Number(raw))))
                          setPaymentOnlineSplit(o)
                          setPaymentCashSplit(round2(Math.max(0, chosenAmountAbs - o)))
                        }}
                        sx={{ width: 160 }}
                        inputProps={{ min: 0, step: '0.01' }}
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
                      const mode = e.target.value as 'cash' | 'online' | 'split'
                      setRefundMode(mode)
                      if (mode !== 'split') {
                        setRefundCashSplit('')
                        setRefundOnlineSplit('')
                      }
                    }}
                    sx={{ width: 210 }}
                  >
                    <MenuItem value="cash">Cash</MenuItem>
                    <MenuItem value="online">Online</MenuItem>
                    <MenuItem value="split">Split</MenuItem>
                  </TextField>

                  {refundMode === 'split' && (
                    <>
                      <TextField
                        size="small"
                        label="Refund Cash"
                        type="number"
                        value={refundCashSplit}
                        onChange={(e) => {
                          const raw = e.target.value
                          if (raw === '') {
                            setRefundCashSplit('')
                            setRefundOnlineSplit(chosenAmountAbs > 0 ? chosenAmountAbs : '')
                            return
                          }
                          const c = Math.min(chosenAmountAbs, Math.max(0, round2(Number(raw))))
                          setRefundCashSplit(c)
                          setRefundOnlineSplit(round2(Math.max(0, chosenAmountAbs - c)))
                        }}
                        sx={{ width: 160 }}
                        inputProps={{ min: 0, step: '0.01' }}
                      />
                      <TextField
                        size="small"
                        label="Refund Online"
                        type="number"
                        value={refundOnlineSplit}
                        onChange={(e) => {
                          const raw = e.target.value
                          if (raw === '') {
                            setRefundOnlineSplit('')
                            setRefundCashSplit(chosenAmountAbs > 0 ? chosenAmountAbs : '')
                            return
                          }
                          const o = Math.min(chosenAmountAbs, Math.max(0, round2(Number(raw))))
                          setRefundOnlineSplit(o)
                          setRefundCashSplit(round2(Math.max(0, chosenAmountAbs - o)))
                        }}
                        sx={{ width: 160 }}
                        inputProps={{ min: 0, step: '0.01' }}
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
              disabled={(ret.every((r) => r.qty === 0) && add.length === 0) || mEx.isPending}
              onClick={() => mEx.mutate()}
            >
              {mEx.isPending ? 'Submitting…' : 'Submit Exchange'}
            </Button>
          </Box>
        </Paper>
      )}

      <ItemPicker
        open={picker}
        onClose={() => setPicker(false)}
        onPick={(it: any) => {
          setAdd((prev) => {
            const idx = prev.findIndex((p) => p.item_id === it.id)
            const mrp = Number(it.mrp) || 0
            if (idx >= 0) {
              const c = [...prev]
              c[idx] = { ...c[idx], qty: c[idx].qty + 1, mrp }
              return c
            }
            return [...prev, { item_id: it.id, name: it.name, mrp, qty: 1 }]
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
