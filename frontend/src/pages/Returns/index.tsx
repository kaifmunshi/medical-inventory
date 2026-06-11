// F:\medical-inventory\frontend\src\pages\Returns\index.tsx
import { useEffect, useMemo, useState } from 'react'
import { Box, Button, Paper, Stack, TextField, Typography, IconButton } from '@mui/material'
import { useMutation, useQuery } from '@tanstack/react-query'
import DeleteIcon from '@mui/icons-material/Delete'

import { findBill, createReturn, getReturnSummary } from '../../services/returns'
import { useToast } from '../../components/ui/Toaster'
import BillPickerDialog from '../../components/billing/BillPickerDialog'

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

export default function Returns() {
  const toast = useToast()

  const [query, setQuery] = useState('')
  const [bill, setBill] = useState<any | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [mode, setMode] = useState<RefundMode>('cash')

  const [billPickerOpen, setBillPickerOpen] = useState(false)

  const [finalRefund, setFinalRefund] = useState<number>(0)
  const [finalTouched, setFinalTouched] = useState<boolean>(false)

  const { refetch, isFetching } = useQuery({
    queryKey: ['bill', query],
    queryFn: () => findBill(query),
    enabled: false,
  })

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
      try {
        const summary = await getReturnSummary(Number(b.id))
        summaryById = Object.fromEntries((summary || []).map((s: any) => [Number(s.item_id), s]))
        remById = Object.fromEntries((summary || []).map((s: any) => [Number(s.item_id), Number(s.remaining)]))
      } catch (e) {
        remById = {}
        summaryById = {}
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
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            Bill #{bill.id} — {rows.length} items
          </Typography>

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
                <option value="credit">Credit (adjust bill)</option>
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
    </Stack>
  )
}
