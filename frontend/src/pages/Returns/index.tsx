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
  soldQty: number
  mrp: number
}

type Row = {
  item_id: number
  name: string
  qty: number
  max: number
  mrp: number
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

  // full vs partial return detection
  const isFullReturn = !!bill && rows.length > 0 && rows.every(r => r.qty === r.max)

  // proration context from saved bill (used only when partial)
  const proration = useMemo(() => {
    if (!bill) return { computedTotal: 0, finalTotal: 0, factor: 1 }

    const items = (bill.items || []) as any[]
    const sub = items.reduce((s, it) => s + Number(it.mrp) * Number(it.quantity), 0)
    const discAmt = (sub * Number(bill.discount_percent || 0)) / 100
    const afterDisc = sub - discAmt
    const taxAmt = (afterDisc * Number(bill.tax_percent || 0)) / 100
    const computedTotal = afterDisc + taxAmt

    const finalTotal = Number(bill.total_amount ?? computedTotal)
    const factor = computedTotal > 0 ? finalTotal / computedTotal : 1

    return { computedTotal, finalTotal, factor }
  }, [bill])

  // charged share for a line (partial only / also used for per-line display always)
  const chargedLine = (mrp: number, qty: number) => {
    if (!bill) return 0
    const sub = Number(mrp) * Number(qty)
    const afterDisc = sub * (1 - Number(bill.discount_percent || 0) / 100)
    const afterTax = afterDisc * (1 + Number(bill.tax_percent || 0) / 100)
    return round2(afterTax * proration.factor)
  }

  // refund computation (TOTAL)
  const refund = isFullReturn
    ? Number(proration.finalTotal)
    : rows.reduce((s, r) => s + chargedLine(r.mrp, r.qty), 0)

  // ✅ FIX: always compute per-line refund values (even for full return)
  // If full return, adjust last non-zero line so sum(lines) == finalTotal exactly.
  const lineRefunds = useMemo(() => {
    if (!bill || rows.length === 0) return rows.map(() => 0)

    const base = rows.map(r => (r.qty > 0 ? chargedLine(r.mrp, r.qty) : 0))

    if (!isFullReturn) return base

    const target = round2(Number(proration.finalTotal))
    const sum = round2(base.reduce((a, b) => a + b, 0))
    const diff = round2(target - sum)

    if (diff === 0) return base

    // add diff to the last non-zero line (so totals match exactly)
    const lastIdx = (() => {
      for (let i = base.length - 1; i >= 0; i--) {
        if (base[i] !== 0) return i
      }
      return -1
    })()

    if (lastIdx >= 0) {
      const copy = [...base]
      copy[lastIdx] = round2(copy[lastIdx] + diff)
      return copy
    }

    return base
  }, [bill, rows, isFullReturn, proration.finalTotal])

  useEffect(() => {
    if (!finalTouched) setFinalRefund(round5Nearest(refund))
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
      const b = res.data

      if (!b) {
        return { ok: false, error: 'No bill found' }
      }

      if (Array.isArray(b)) {
        // let UI open picker; no state change yet
        setBillPickerOpen(true)
        return { ok: false, error: 'Multiple bills found' }
      }

      if (Boolean((b as any).is_deleted)) {
        return { ok: false, error: 'Deleted bill cannot be used for return' }
      }

      const lines: BillLine[] = (b.items || []).map((it: any): BillLine => ({
        item_id: Number(it.item_id),
        name: it.item_name || it.name || it.item?.name || `#${it.item_id}`,
        soldQty: Number(it.quantity),
        mrp: Number(it.mrp),
      }))

      let remById: Record<number, number> = {}
      try {
        const summary = await getReturnSummary(Number(b.id))
        remById = Object.fromEntries((summary || []).map((s: any) => [Number(s.item_id), Number(s.remaining)]))
      } catch (e) {
        remById = {}
        console.error('getReturnSummary failed', e)
      }

      setBill(b)
      setRows(
        lines.map((l): Row => {
          const remaining = remById[l.item_id] ?? l.soldQty
          return {
            item_id: l.item_id,
            name: l.name,
            qty: 0,
            max: remaining,
            mrp: l.mrp,
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
      toast.push('Return created', 'success')

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
      toast.push('Return failed: ' + msg, 'error')
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

  return (
    <Stack gap={2}>
      <Typography variant="h5">Returns</Typography>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
          <TextField label="Bill ID" value={query} onChange={e => setQuery(e.target.value)} fullWidth />
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
                  <th>Line Refund</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.item_id}>
                    <td>{r.name}</td>
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
                    <td>{r.mrp}</td>
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
                    <td colSpan={6}>
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
                  setFinalRefund(round5Nearest(refund))
                }}
              >
                Reset
              </Button>
            </Stack>

            <Button
              variant="contained"
              disabled={rows.every(r => r.qty === 0) || mCreate.isPending}
              onClick={() => {
                if (rows.every(r => r.qty === 0)) {
                  toast.push('Enter at least one return quantity', 'warning')
                  return
                }
                if (finalRefund <= 0) {
                  toast.push('Final refund must be > 0', 'warning')
                  return
                }
                mCreate.mutate()
              }}
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
