// F:\medical-inventory\frontend\src\pages\Billing\index.tsx
import { useEffect, useMemo, useState } from 'react'
import { Box, Button, Paper, Stack, TextField, Typography, IconButton, MenuItem, Divider } from '@mui/material'
import { useMutation } from '@tanstack/react-query'
import DeleteIcon from '@mui/icons-material/Delete'
import AddIcon from '@mui/icons-material/Add'

import ItemPicker from '../../components/billing/ItemPicker'
import { createBill } from '../../services/billing'
import { computeTotals, validatePayments } from '../../lib/billing'
import { useToast } from '../../components/ui/Toaster'

interface CartRow { item_id:number; name:string; mrp:number; quantity:number; stock?:number }

export default function Billing() {
  const toast = useToast()

  const [rows, setRows] = useState<CartRow[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)

  const [discount, setDiscount] = useState(0)
  const [tax, setTax] = useState(0)

  const [mode, setMode] = useState<'cash'|'online'|'split'>('cash')
  const [cash, setCash] = useState<number|''>('')
  const [online, setOnline] = useState<number|''>('')

  const [notes, setNotes] = useState('')

  // Final amount override (what you actually charge)
  const [finalAmount, setFinalAmount] = useState<number>(0)

  const totals = useMemo(
    () => computeTotals(rows, Number(discount)||0, Number(tax)||0),
    [rows, discount, tax]
  )

  // keep finalAmount in sync initially, but preserve manual edits afterward
  useEffect(() => {
    setFinalAmount(prev => (prev === 0 ? totals.total : prev))
  }, [totals.total])

  // Quick rounding helpers (based on computed total)
  function roundNearest10(x:number){ return Math.round(x / 10) * 10 }
  function roundUp10(x:number){ return Math.ceil(x / 10) * 10 }
  function roundDown10(x:number){ return Math.floor(x / 10) * 10 }

  // Validate payments against the chosen final amount (not just computed)
  const chosenFinal = +Number(finalAmount || totals.total).toFixed(2)

  // NEW: effective discount % based on computed total vs final amount
  const effectiveDiscountPercent =
    totals.total > 0
      ? ((totals.total - chosenFinal) / totals.total) * 100
      : 0

  const paymentsOk = validatePayments(
    mode,
    chosenFinal,
    Number(cash || 0),
    Number(online || 0)
  )

  const mBill = useMutation({
    mutationFn: async () => {
      // Build payload as before, PLUS final_amount and payment alignment
      const payload: any = {
        items: rows.map(r => ({
          item_id: r.item_id,
          quantity: Number(r.quantity) || 1,
          mrp: Number(r.mrp) || 0
        })),
        discount_percent: Number(discount) || 0,
        tax_percent: Number(tax) || 0,
        payment_mode: mode,
        payment_cash: Number(cash || 0),
        payment_online: Number(online || 0),
        final_amount: chosenFinal,
        notes
      }

      // Auto-align payments for single-mode, and validate split strictly
      if (mode === 'cash') {
        payload.payment_cash = chosenFinal
        payload.payment_online = 0
      } else if (mode === 'online') {
        payload.payment_cash = 0
        payload.payment_online = chosenFinal
      } else {
        const sum = +(Number(payload.payment_cash || 0) + Number(payload.payment_online || 0)).toFixed(2)
        if (sum !== chosenFinal) {
          toast.push('Split amounts must equal Final Amount', 'error')
          throw new Error('Split amounts must equal Final Amount')
        }
      }

      return createBill(payload)
    },
    onSuccess: () => {
      // reset cart
      setRows([])
      setDiscount(0)
      setTax(0)
      setMode('cash')
      setCash('')
      setOnline('')
      setNotes('')
      setFinalAmount(0) // reset so it re-inits to computed next time
      toast.push('Bill created successfully','success')
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Failed to create bill'
      toast.push(`Bill failed: ${msg}`, 'error')   // ← was “Return failed”
    }
  })

  function addRow(it: any) {
    setRows(prev => {
      const idx = prev.findIndex(p => p.item_id === it.id)
      if (idx >= 0) {
        // bump quantity, clamp to stock if provided
        const next = prev.map((r, i) =>
          i === idx
            ? {
                ...r,
                quantity: Math.max(
                  1,
                  Math.min((r.stock ?? Number.POSITIVE_INFINITY) as number, r.quantity + 1)
                )
              }
            : r
        )
        toast.push('Quantity increased','info')
        return next
      }
      // new line item
      const next = [
        ...prev,
        { item_id: it.id, name: it.name, mrp: Number(it.mrp)||0, quantity: 1, stock: it.stock },
      ]
      toast.push('Item added to cart','success')
      return next
    })
  }

  function setQty(i: number, q: number) {
    const n = Number(q) || 1
    setRows(prev =>
      prev.map((r, idx) =>
        idx === i
          ? { ...r, quantity: Math.max(1, Math.min((r.stock ?? Number.POSITIVE_INFINITY) as number, n)) }
          : r
      )
    )
  }

  function removeRow(i: number) {
    setRows(prev => prev.filter((_, idx) => idx !== i))
    toast.push('Item removed','info')
  }

  return (
    <Stack gap={2}>
      <Typography variant="h5">Billing</Typography>

      <Paper sx={{ p:2 }}>
        <Stack direction="row" justifyContent="space-between" gap={2}>
          <Button startIcon={<AddIcon/>} variant="contained" onClick={()=>setPickerOpen(true)}>
            Add Item
          </Button>
          <Stack direction={{ xs:'column', md:'row' }} gap={2}>
            <TextField
              label="Discount %"
              type="number"
              value={discount}
              onChange={e=>setDiscount(Number(e.target.value||0))}
              sx={{ width:120 }}
            />
            <TextField
              label="Tax %"
              type="number"
              value={tax}
              onChange={e=>setTax(Number(e.target.value||0))}
              sx={{ width:120 }}
            />
          </Stack>
        </Stack>
      </Paper>

      <Paper sx={{ p:2 }}>
        <Box sx={{ overflowX:'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{minWidth:240}}>Item</th>
                <th>MRP</th>
                <th>Qty</th>
                <th>Line Total</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i)=> (
                <tr key={r.item_id}>
                  <td>{r.name}</td>
                  <td>{r.mrp}</td>
                  <td>
                    <TextField
                      type="number"
                      value={r.quantity}
                      onChange={e=>setQty(i, Number(e.target.value||1))}
                      inputProps={{ min:1 }}
                      sx={{ width:100 }}
                    />
                  </td>
                  <td>{(r.quantity * r.mrp).toFixed(2)}</td>
                  <td>
                    <IconButton color="error" onClick={()=>removeRow(i)}>
                      <DeleteIcon/>
                    </IconButton>
                  </td>
                </tr>
              ))}
              {rows.length===0 && (
                <tr>
                  <td colSpan={5}>
                    <Box p={2} color="text.secondary">
                      No items in cart. Click "Add Item" to start.
                    </Box>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Box>
      </Paper>

      <Paper sx={{ p:2 }}>
        <Stack
          direction={{ xs:'column', md:'row' }}
          gap={2}
          alignItems={{ md:'center' }}
          justifyContent="space-between"
        >
          <Stack direction={{ xs:'column', md:'row' }} gap={2}>
            <TextField
              select
              label="Payment Mode"
              value={mode}
              onChange={e=>setMode(e.target.value as any)}
              sx={{ width:160 }}
            >
              <MenuItem value="cash">Cash</MenuItem>
              <MenuItem value="online">Online</MenuItem>
              <MenuItem value="split">Split</MenuItem>
            </TextField>

            {(mode==='cash' || mode==='split') && (
              <TextField
                label="Cash Amount"
                type="number"
                value={cash}
                onChange={e=>setCash(e.target.value as any)}
                sx={{ width:160 }}
              />
            )}

            {(mode==='online' || mode==='split') && (
              <TextField
                label="Online Amount"
                type="number"
                value={online}
                onChange={e=>setOnline(e.target.value as any)}
                sx={{ width:160 }}
              />
            )}
          </Stack>

          <Divider flexItem orientation="vertical" sx={{ display:{ xs:'none', md:'block' }}} />

          {/* Existing totals (kept) */}
          <Stack gap={0.5} alignItems={{ md:'flex-end' }}>
            <Typography variant="body2" color="text.secondary">Subtotal: ₹{totals.subtotal.toFixed(2)}</Typography>
            <Typography variant="body2" color="text.secondary">Discount: ₹{totals.discount.toFixed(2)}</Typography>
            <Typography variant="body2" color="text.secondary">Tax: ₹{totals.tax.toFixed(2)}</Typography>
            <Typography variant="h6">Computed Total: ₹{totals.total.toFixed(2)}</Typography>

            {/* Final Amount you charge + quick rounders + effective % */}
            <Stack gap={0.5} alignItems={{ xs: 'flex-start', sm: 'flex-end' }} sx={{ mt: 1 }}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                alignItems="center"
                justifyContent="flex-end"
              >
                <TextField
                  label="Final Amount (you charge)"
                  type="number"
                  value={finalAmount}
                  onChange={(e) => setFinalAmount(Number(e.target.value || 0))}
                  inputProps={{ step: '0.01', min: 0 }}
                  sx={{ width: 220 }}
                />
                <Button size="small" onClick={() => setFinalAmount(roundNearest10(totals.total))}>
                  Round ±10
                </Button>
                <Button size="small" onClick={() => setFinalAmount(roundDown10(totals.total))}>
                  Round ↓10
                </Button>
                <Button size="small" onClick={() => setFinalAmount(roundUp10(totals.total))}>
                  Round ↑10
                </Button>
              </Stack>

              {/* NEW: show percentage w.r.t. computed total */}
              <Typography variant="caption" color="text.secondary">
               Discount Given: +{effectiveDiscountPercent.toFixed(2)}%
              </Typography>
            </Stack>
          </Stack>
        </Stack>

        <Box mt={2}>
          <TextField
            fullWidth
            multiline
            minRows={2}
            label="Notes"
            value={notes}
            onChange={e=>setNotes(e.target.value)}
          />
        </Box>

        <Box mt={2} textAlign="right">
          <Button
            variant="contained"
            disabled={rows.length===0 || !paymentsOk || mBill.isPending}
            onClick={()=>mBill.mutate()}
          >
            Create Bill
          </Button>
        </Box>
      </Paper>

      <ItemPicker open={pickerOpen} onClose={()=>setPickerOpen(false)} onPick={addRow} />
    </Stack>
  )
}
