// F:\medical-inventory\frontend\src\pages\Billing\index.tsx
import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Paper,
  Stack,
  TextField,
  Typography,
  IconButton,
  MenuItem,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  Chip,
} from '@mui/material'
import { useMutation } from '@tanstack/react-query'
import DeleteIcon from '@mui/icons-material/Delete'
import AddIcon from '@mui/icons-material/Add'
import PaymentsIcon from '@mui/icons-material/Payments'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'

import ItemPicker from '../../components/billing/ItemPicker'
import { createBill } from '../../services/billing'
import { computeTotals, validatePayments } from '../../lib/billing'
import { useToast } from '../../components/ui/Toaster'

interface CartRow {
  item_id: number
  name: string
  mrp: number
  quantity: number
  stock?: number
  expiry_date?: string | null
}

function formatExpiry(exp?: string | null) {
  if (!exp) return '-'
  const s = String(exp)
  const iso = s.length > 10 ? s.slice(0, 10) : s // "YYYY-MM-DD"
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${d}-${m}-${y}` // "DD-MM-YYYY"
}

// ✅ helper: parse numeric text safely (allows empty while typing)
function parseNumText(v: string): number | '' {
  const s = String(v ?? '').trim()
  if (!s) return ''
  const n = Number(s)
  return Number.isFinite(n) ? n : ''
}

// ✅ helper: prevent mouse-wheel changing numeric-like inputs
function blurOnWheel(e: any) {
  e.currentTarget.blur()
}

export default function Billing() {
  const toast = useToast()

  const [rows, setRows] = useState<CartRow[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)

  const [discount, setDiscount] = useState(0)
  const [tax, setTax] = useState(0)

  const [mode, setMode] = useState<'cash' | 'online' | 'split' | 'credit'>('cash')
  const [cash, setCash] = useState<number | ''>('')
  const [online, setOnline] = useState<number | ''>('')

  const [notes, setNotes] = useState('')

  // Final amount override (what you actually charge)
  const [finalAmount, setFinalAmount] = useState<number>(0)

  // ✅ Beautiful confirm dialog for CASH
  const [cashConfirmOpen, setCashConfirmOpen] = useState(false)

  const totals = useMemo(
    () => computeTotals(rows, Number(discount) || 0, Number(tax) || 0),
    [rows, discount, tax]
  )

  // keep finalAmount in sync initially, but preserve manual edits afterward
  useEffect(() => {
    setFinalAmount((prev) => (prev === 0 ? totals.total : prev))
  }, [totals.total])

  // Quick rounding helpers (based on computed total)
  function roundNearest10(x: number) {
    return Math.round(x / 10) * 10
  }
  function roundUp10(x: number) {
    return Math.ceil(x / 10) * 10
  }
  function roundDown10(x: number) {
    return Math.floor(x / 10) * 10
  }

  // Validate payments against the chosen final amount (not just computed)
  const chosenFinal = +Number(finalAmount || totals.total).toFixed(2)

  const effectiveDiscountPercent =
    totals.total > 0 ? ((totals.total - chosenFinal) / totals.total) * 100 : 0

  const paymentsOk = validatePayments(mode as any, chosenFinal, Number(cash || 0), Number(online || 0))

  // ✅ Notes compulsory for CREDIT
  const notesOkForCredit = mode !== 'credit' || notes.trim().length > 0

  const mBill = useMutation({
    mutationFn: async () => {
      // ✅ enforce notes for credit also on submit (backend safety)
      if (mode === 'credit' && notes.trim().length === 0) {
        toast.push('Notes are required for Credit bills', 'warning')
        throw new Error('Notes required for credit')
      }

      const payload: any = {
        items: rows.map((r) => ({
          item_id: r.item_id,
          quantity: Number(r.quantity) || 1,
          mrp: Number(r.mrp) || 0,
        })),
        discount_percent: Number(discount) || 0,
        tax_percent: Number(tax) || 0,
        payment_mode: mode,
        payment_cash: Number(cash || 0),
        payment_online: Number(online || 0),
        final_amount: chosenFinal,
        notes,
      }

      if (mode === 'credit') {
        payload.payment_cash = 0
        payload.payment_online = 0
      } else if (mode === 'cash') {
        payload.payment_cash = chosenFinal
        payload.payment_online = 0
      } else if (mode === 'online') {
        payload.payment_cash = 0
        payload.payment_online = chosenFinal
      } else {
        const sum = +(
          Number(payload.payment_cash || 0) + Number(payload.payment_online || 0)
        ).toFixed(2)
        if (sum !== chosenFinal) {
          toast.push('Split amounts must equal Final Amount', 'error')
          throw new Error('Split amounts must equal Final Amount')
        }
      }

      return createBill(payload)
    },
    onSuccess: () => {
      setRows([])
      setDiscount(0)
      setTax(0)
      setMode('cash')
      setCash('')
      setOnline('')
      setNotes('')
      setFinalAmount(0)
      toast.push('Bill created successfully', 'success')
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Failed to create bill'
      toast.push(`Bill failed: ${msg}`, 'error')
    },
  })

  function addRow(it: any) {
    const st = Number(it.stock ?? 0)
    if (st <= 0) {
      toast.push('Out of stock — cannot add this item', 'error')
      return
    }

    setRows((prev) => {
      const idx = prev.findIndex((p) => p.item_id === it.id)
      if (idx >= 0) {
        const next = prev.map((r, i) =>
          i === idx
            ? {
                ...r,
                quantity: Math.max(
                  1,
                  Math.min((r.stock ?? Number.POSITIVE_INFINITY) as number, r.quantity + 1)
                ),
              }
            : r
        )
        toast.push('Quantity increased', 'info')
        return next
      }

      const next = [
        ...prev,
        {
          item_id: it.id,
          name: it.name,
          mrp: Number(it.mrp) || 0,
          quantity: 1,
          stock: it.stock,
          expiry_date: it.expiry_date ?? null,
        },
      ]
      toast.push('Item added to cart', 'success')
      return next
    })
  }

  function setQty(i: number, q: number) {
    const n = Math.max(1, Number(q) || 1)
    setRows((prev) =>
      prev.map((r, idx) =>
        idx === i
          ? { ...r, quantity: Math.max(1, Math.min((r.stock ?? Number.POSITIVE_INFINITY) as number, n)) }
          : r
      )
    )
  }

  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i))
    toast.push('Item removed', 'info')
  }

  // ✅ submit handler with CASH confirm
  const handleCreateBill = () => {
    if (rows.length === 0 || !paymentsOk || mBill.isPending) return

    if (!notesOkForCredit) {
      toast.push('Please add Notes for Credit bill', 'warning')
      return
    }

    if (mode === 'cash') {
      setCashConfirmOpen(true)
      return
    }

    mBill.mutate()
  }

  const confirmCashAndSubmit = () => {
    setCashConfirmOpen(false)
    mBill.mutate()
  }

  // ✅ shared sx: removes number spinners (we'll apply to amount fields only)
  const noSpinnerSx = {
    '& input::-webkit-outer-spin-button, & input::-webkit-inner-spin-button': {
      WebkitAppearance: 'none',
      margin: 0,
    },
    '& input[type=number]': {
      MozAppearance: 'textfield',
    },
  } as const

  return (
    <Stack gap={2}>
      <Typography variant="h5">Billing</Typography>

      <Paper sx={{ p: 2 }}>
        <Stack direction="row" justifyContent="space-between" gap={2}>
          <Button startIcon={<AddIcon />} variant="contained" onClick={() => setPickerOpen(true)}>
            Add Item
          </Button>

          <Stack direction={{ xs: 'column', md: 'row' }} gap={2}>
            {/* ✅ Amount-style inputs => no wheel change + no spinners */}
            <TextField
              label="Discount %"
              type="text"
              value={String(discount)}
              onChange={(e) => setDiscount(Number(parseNumText(e.target.value) || 0))}
              onWheel={blurOnWheel}
              sx={{ width: 120, ...noSpinnerSx }}
              inputProps={{ inputMode: 'decimal', pattern: '[0-9]*[.,]?[0-9]*' }}
            />
            <TextField
              label="Tax %"
              type="text"
              value={String(tax)}
              onChange={(e) => setTax(Number(parseNumText(e.target.value) || 0))}
              onWheel={blurOnWheel}
              sx={{ width: 120, ...noSpinnerSx }}
              inputProps={{ inputMode: 'decimal', pattern: '[0-9]*[.,]?[0-9]*' }}
            />
          </Stack>
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ minWidth: 240 }}>Item</th>
                <th>MRP</th>
                <th style={{ minWidth: 120 }}>Expiry</th>
                <th>Qty</th>
                <th>Line Total</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.item_id}>
                  <td>{r.name}</td>
                  <td>{r.mrp}</td>
                  <td>{formatExpiry(r.expiry_date)}</td>
                  <td>
                    {/* ✅ QTY stays as number (spinners/wheel allowed) */}
                    <TextField
                      type="number"
                      value={r.quantity}
                      onChange={(e) => setQty(i, Number(e.target.value || 1))}
                      onFocus={(e) => e.target.select()}
                      inputProps={{ min: 1 }}
                      sx={{ width: 100 }}
                    />
                  </td>
                  <td>{(r.quantity * r.mrp).toFixed(2)}</td>
                  <td>
                    <IconButton color="error" onClick={() => removeRow(i)}>
                      <DeleteIcon />
                    </IconButton>
                  </td>
                </tr>
              ))}

              {rows.length === 0 && (
                <tr>
                  <td colSpan={6}>
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

      <Paper sx={{ p: 2 }}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          gap={2}
          alignItems={{ md: 'center' }}
          justifyContent="space-between"
        >
          <Stack direction={{ xs: 'column', md: 'row' }} gap={2}>
            <TextField
              select
              label="Payment Mode"
              value={mode}
              onChange={(e) => {
                const v = e.target.value as any
                setMode(v)
                if (v === 'credit') {
                  setCash('')
                  setOnline('')
                }
              }}
              sx={{ width: 160 }}
            >
              <MenuItem value="cash">Cash</MenuItem>
              <MenuItem value="online">Online</MenuItem>
              <MenuItem value="split">Split</MenuItem>
              <MenuItem value="credit">Credit</MenuItem>
            </TextField>

            {(mode === 'cash' || mode === 'split') && (
              <TextField
                label="Cash Amount"
                type="text"
                value={cash === '' ? '' : String(cash)}
                onChange={(e) => setCash(parseNumText(e.target.value) as any)}
                onWheel={blurOnWheel}
                sx={{ width: 160, ...noSpinnerSx }}
                inputProps={{ inputMode: 'decimal', pattern: '[0-9]*[.,]?[0-9]*' }}
              />
            )}

            {(mode === 'online' || mode === 'split') && (
              <TextField
                label="Online Amount"
                type="text"
                value={online === '' ? '' : String(online)}
                onChange={(e) => setOnline(parseNumText(e.target.value) as any)}
                onWheel={blurOnWheel}
                sx={{ width: 160, ...noSpinnerSx }}
                inputProps={{ inputMode: 'decimal', pattern: '[0-9]*[.,]?[0-9]*' }}
              />
            )}
          </Stack>

          <Divider flexItem orientation="vertical" sx={{ display: { xs: 'none', md: 'block' } }} />

          <Stack gap={0.5} alignItems={{ md: 'flex-end' }}>
            <Typography variant="body2" color="text.secondary">
              Subtotal: ₹{totals.subtotal.toFixed(2)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Discount: ₹{totals.discount.toFixed(2)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Tax: ₹{totals.tax.toFixed(2)}
            </Typography>
            <Typography variant="h6">Computed Total: ₹{totals.total.toFixed(2)}</Typography>

            <Stack gap={0.5} alignItems={{ xs: 'flex-start', sm: 'flex-end' }} sx={{ mt: 1 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="center" justifyContent="flex-end">
                <TextField
                  label="Final Amount (you charge)"
                  type="text"
                  value={String(finalAmount)}
                  onChange={(e) => {
                    const v = parseNumText(e.target.value)
                    setFinalAmount(Number(v || 0))
                  }}
                  onWheel={blurOnWheel}
                  sx={{ width: 220, ...noSpinnerSx }}
                  inputProps={{ inputMode: 'decimal', pattern: '[0-9]*[.,]?[0-9]*' }}
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
            label={mode === 'credit' ? 'Notes (Required for Credit)' : 'Notes'}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            required={mode === 'credit'}
            error={mode === 'credit' && notes.trim().length === 0}
            helperText={
              mode === 'credit'
                ? notes.trim().length === 0
                  ? 'Please enter customer name / phone / credit details'
                  : 'Credit notes saved in bill'
                : ''
            }
          />
        </Box>

        <Box mt={2} textAlign="right">
          <Button
            variant="contained"
            disabled={rows.length === 0 || !paymentsOk || mBill.isPending || !notesOkForCredit}
            onClick={handleCreateBill}
          >
            Create Bill
          </Button>
        </Box>
      </Paper>

      <ItemPicker open={pickerOpen} onClose={() => setPickerOpen(false)} onPick={addRow} />

      {/* Beautiful CASH confirmation dialog */}
      <Dialog
        open={cashConfirmOpen}
        onClose={() => setCashConfirmOpen(false)}
        maxWidth="xs"
        fullWidth
        PaperProps={{
          sx: {
            borderRadius: 3,
            p: 0.5,
          },
        }}
      >
        <DialogTitle sx={{ pb: 1 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
            <Stack direction="row" alignItems="center" gap={1}>
              <WarningAmberIcon color="warning" />
              <Typography variant="h6" sx={{ lineHeight: 1.2 }}>
                Confirm Cash Payment
              </Typography>
            </Stack>
            <Chip
              icon={<PaymentsIcon />}
              label={`₹${chosenFinal.toFixed(2)}`}
              variant="outlined"
              sx={{ fontWeight: 700 }}
            />
          </Stack>
        </DialogTitle>

        <DialogContent sx={{ pt: 0 }}>
          <Alert severity="warning" sx={{ borderRadius: 2 }}>
            Payment mode is set to <b>CASH</b>. This is a common mistake.
            <br />
            If this bill should be <b>Online</b> or <b>Credit</b>, press <b>Change Mode</b>.
          </Alert>

          <Stack mt={2} spacing={1}>
            <Typography variant="body2" color="text.secondary">
              Final Amount (you charge)
            </Typography>
            <Typography variant="h5" sx={{ fontWeight: 800 }}>
              ₹{chosenFinal.toFixed(2)}
            </Typography>
          </Stack>
        </DialogContent>

        <DialogActions sx={{ px: 2, pb: 2, pt: 1 }}>
          <Button variant="outlined" onClick={() => setCashConfirmOpen(false)} sx={{ borderRadius: 2 }}>
            Change Mode
          </Button>
          <Button
            variant="contained"
            onClick={confirmCashAndSubmit}
            sx={{ borderRadius: 2, fontWeight: 700 }}
            disabled={mBill.isPending}
          >
            Confirm & Create
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
