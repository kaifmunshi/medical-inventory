// src/pages/Returns/Exchange.tsx
import { useMemo, useState } from 'react'
import { Box, Button, Paper, Stack, TextField, Typography, IconButton } from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import { useMutation, useQuery } from '@tanstack/react-query'
import { findBill, createExchange, getReturnSummary } from '../../services/returns'
import ItemPicker from '../../components/billing/ItemPicker'
import BillPickerDialog from '../../components/billing/BillPickerDialog'
import { useToast } from '../../components/ui/Toaster'

type RetRow = { item_id:number; name:string; qty:number; max:number; mrp:number }
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
      }
    })

    setRet(rows)
    setAdd([]) // clear added items when bill changes
    setExDiscount(0)
    setFinalOverride('')
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
      payment_mode: 'cash',   // for now everything is cash; can extend later
      payment_cash: 0,
      payment_online: 0,
      refund_cash: 0,
      refund_online: 0,
    }

    if (chosenDelta > 0) {
      // customer pays
      payload.payment_cash = round2(chosenDelta)
    } else if (chosenDelta < 0) {
      // refund to customer
      payload.refund_cash = round2(-chosenDelta)
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
                    <td>{r.name}</td>
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
