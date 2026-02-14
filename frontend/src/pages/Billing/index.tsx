// F:\medical-inventory\frontend\src\pages\Billing\index.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
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
  Autocomplete,
  Tooltip,
} from '@mui/material'
import { useMutation, useQuery } from '@tanstack/react-query'
import DeleteIcon from '@mui/icons-material/Delete'
import AddIcon from '@mui/icons-material/Add'
import PaymentsIcon from '@mui/icons-material/Payments'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'

import ItemPicker from '../../components/billing/ItemPicker'
import { createBill } from '../../services/billing'
import { listItems } from '../../services/inventory'
import { useToast } from '../../components/ui/Toaster'

interface CartRow {
  item_id: number
  name: string
  mrp: number
  quantity: number
  custom_unit_price: number
  item_discount_percent: number
  stock?: number
  expiry_date?: string | null
  brand?: string | null
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

const GRID_INPUT_SX = {
  '& .MuiInputBase-root': {
    height: 38,
  },
} as const

// ✅ Helper: create initial empty rows
function createEmptyRows(count: number): CartRow[] {
  return Array.from({ length: count }, () => ({
    item_id: 0,
    name: '',
    mrp: 0,
    quantity: 0,
    custom_unit_price: 0,
    item_discount_percent: 0,
  }))
}

function emptyRow(): CartRow {
  return {
    item_id: 0,
    name: '',
    mrp: 0,
    quantity: 0,
    custom_unit_price: 0,
    item_discount_percent: 0,
  }
}

function normalizeRows(input: CartRow[]): CartRow[] {
  const out = [...input]
  while (out.length < 5) out.push(emptyRow())
  if (out.length >= 5 && out.every((r) => r.item_id > 0)) out.push(emptyRow())
  return out
}

export default function Billing() {
  const toast = useToast()

  const [rows, setRows] = useState<CartRow[]>(normalizeRows(createEmptyRows(5)))
  const [priceDraftByRow, setPriceDraftByRow] = useState<Record<number, string>>({})
  const [discountDraftByRow, setDiscountDraftByRow] = useState<Record<number, string>>({})
  const [stockErrorByRow, setStockErrorByRow] = useState<Record<number, string>>({})
  const [gridSearch, setGridSearch] = useState('')
  const [pendingQtyFocusRow, setPendingQtyFocusRow] = useState<number | null>(null)
  const qtyInputRefs = useRef<Record<number, HTMLInputElement | null>>({})
  const [pickerOpen, setPickerOpen] = useState(false)

  const [tax, setTax] = useState(0)

  const [mode, setMode] = useState<'cash' | 'online' | 'split' | 'credit'>('cash')
  const [splitCombination, setSplitCombination] = useState<'cash-online' | 'cash-credit' | 'online-credit'>(
    'cash-online'
  )
  const [cash, setCash] = useState<number | ''>('')
  const [online, setOnline] = useState<number | ''>('')

  const [notes, setNotes] = useState('')

  // ✅ Beautiful confirm dialog for CASH
  const [cashConfirmOpen, setCashConfirmOpen] = useState(false)
  const { data: inventoryItems = [] } = useQuery({
    queryKey: ['billing-grid-items', gridSearch],
    queryFn: () => listItems(gridSearch),
  })

  // ✅ Helper: count rows with actual items (item_id > 0)
  const filledRowCount = rows.filter((r) => r.item_id > 0).length
  const validLineCount = rows.filter((r) => r.item_id > 0 && Number(r.quantity) > 0).length

  function setStockError(i: number, msg?: string) {
    setStockErrorByRow((prev) => {
      const next = { ...prev }
      if (msg) next[i] = msg
      else delete next[i]
      return next
    })
  }

  useEffect(() => {
    if (pendingQtyFocusRow === null) return
    const input = qtyInputRefs.current[pendingQtyFocusRow]
    if (input) {
      input.focus()
      input.select()
      setPendingQtyFocusRow(null)
    }
  }, [pendingQtyFocusRow, rows])

  const totals = useMemo(() => {
    const subtotal = rows
      .filter((r) => Number(r.item_id) > 0)
      .reduce((s, r) => s + Number(r.quantity || 0) * Number(r.mrp || 0), 0)
    const lineTotal = rows
      .filter((r) => Number(r.item_id) > 0)
      .reduce((s, r) => s + Number(r.quantity || 0) * Number(r.custom_unit_price || 0), 0)
    const discount = Math.max(0, subtotal - lineTotal)
    const taxAmount = lineTotal * (Number(tax) || 0) / 100
    return {
      subtotal: Number(subtotal.toFixed(2)),
      discount: Number(discount.toFixed(2)),
      tax: Number(taxAmount.toFixed(2)),
      total: Number((lineTotal + taxAmount).toFixed(2)),
    }
  }, [rows, tax])

  const finalByRows = useMemo(
    () =>
      rows
        .filter((r) => Number(r.item_id) > 0)
        .reduce((s, r) => s + Number(r.quantity || 0) * Number(r.custom_unit_price || 0), 0),
    [rows]
  )

  const chosenFinal = Number(finalByRows.toFixed(2))
  const splitCreditAmount = Number(
    (
      splitCombination === 'cash-credit'
        ? chosenFinal - Number(cash || 0)
        : splitCombination === 'online-credit'
          ? chosenFinal - Number(online || 0)
          : 0
    ).toFixed(2)
  )
  const effectiveDiscountPercent = totals.subtotal > 0 ? ((totals.discount / totals.subtotal) * 100) : 0

  const paymentsOk = useMemo(() => {
    const c = Number(cash || 0)
    const o = Number(online || 0)
    if (mode === 'credit') return true
    if (mode === 'cash') return Number(c.toFixed(2)) === chosenFinal
    if (mode === 'online') return Number(o.toFixed(2)) === chosenFinal
    if (splitCombination === 'cash-online') {
      return Number((c + o).toFixed(2)) === chosenFinal
    }
    if (splitCombination === 'cash-credit') {
      return c >= 0 && c <= chosenFinal
    }
    if (splitCombination === 'online-credit') {
      return o >= 0 && o <= chosenFinal
    }
    return false
  }, [mode, cash, online, chosenFinal, splitCombination])

  // ✅ Notes compulsory for CREDIT
  const notesOkForCredit = mode !== 'credit' || notes.trim().length > 0

  const mBill = useMutation({
    mutationFn: async () => {
      // ✅ enforce notes for credit also on submit (backend safety)
      if (mode === 'credit' && notes.trim().length === 0) {
        toast.push(
          'Credit bill cannot be created without notes. Please add customer name/phone and credit details, then try again.',
          'warning'
        )
        throw new Error('Notes required for credit')
      }

      const payload: any = {
        items: rows
          .filter((r) => Number(r.item_id) > 0 && Number(r.quantity) > 0)
          .map((r) => ({
            item_id: r.item_id,
            quantity: Number(r.quantity) || 1,
            mrp: Number(r.mrp) || 0,
            custom_unit_price: Number(r.custom_unit_price || r.mrp || 0),
          })),
        discount_percent: 0,
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
        if (splitCombination === 'cash-online') {
          const sum = +(
            Number(payload.payment_cash || 0) + Number(payload.payment_online || 0)
          ).toFixed(2)
          if (sum !== chosenFinal) {
            toast.push(
              `Split payment mismatch. Cash + Online must equal Final Amount (₹${chosenFinal.toFixed(2)}).`,
              'error'
            )
            throw new Error('Split amounts must equal Final Amount')
          }
        } else if (splitCombination === 'cash-credit') {
          payload.payment_online = 0
          payload.payment_credit = Number((chosenFinal - Number(payload.payment_cash || 0)).toFixed(2))
          if (payload.payment_credit < 0) {
            toast.push('Cash amount cannot be greater than Final Amount.', 'error')
            throw new Error('Invalid split amounts')
          }
        } else {
          payload.payment_cash = 0
          payload.payment_credit = Number((chosenFinal - Number(payload.payment_online || 0)).toFixed(2))
          if (payload.payment_credit < 0) {
            toast.push('Online amount cannot be greater than Final Amount.', 'error')
            throw new Error('Invalid split amounts')
          }
        }
      }

      return createBill(payload)
    },
    onSuccess: () => {
      setRows(normalizeRows([]))
      setPriceDraftByRow({})
      setDiscountDraftByRow({})
      setStockErrorByRow({})
      setTax(0)
      setMode('cash')
      setSplitCombination('cash-online')
      setCash('')
      setOnline('')
      setNotes('')
      toast.push('Bill created successfully. Inventory and payment entries were updated.', 'success')
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Failed to create bill'
      toast.push(`Could not create bill. Reason: ${msg}`, 'error')
    },
  })

  function addRow(it: any) {
    const st = Number(it.stock ?? 0)
    if (st <= 0) {
      toast.push('This item is currently out of stock, so it cannot be added to the billing grid.', 'error')
      return
    }

    setRows((prev) => {
      const idx = prev.findIndex((p) => p.item_id === it.id)
      if (idx >= 0) {
        const next = prev.map((r, i) => {
          if (i !== idx) return r
          const nextQty = Number(r.quantity || 0) + 1
          const stock = Number(r.stock ?? Number.POSITIVE_INFINITY)
          if (nextQty > stock) {
            setStockError(
              idx,
              `Only ${stock} unit(s) available for ${r.name}. Quantity was reset to 0.`
            )
            toast.push(
              `Only ${stock} unit(s) are available for ${r.name}. Quantity was reset to 0. Enter a value from 0 to ${stock}.`,
              'warning'
            )
            return { ...r, quantity: 0 }
          }
          setStockError(idx)
          return { ...r, quantity: nextQty }
        })
        setPendingQtyFocusRow(idx)
        toast.push('Item already exists in the grid, so quantity was increased by 1.', 'info')
        return normalizeRows(next)
      }

      // ✅ Try to fill an empty row first
      const emptyIdx = prev.findIndex((p) => p.item_id === 0)
      if (emptyIdx >= 0) {
        const next = prev.map((r, i) =>
          i === emptyIdx
            ? {
                item_id: it.id,
                name: it.name,
                mrp: Number(it.mrp) || 0,
                quantity: 1,
                custom_unit_price: Number(it.mrp) || 0,
                item_discount_percent: 0,
                stock: it.stock,
                expiry_date: it.expiry_date ?? null,
                brand: it.brand ?? null,
              }
            : r
        )
        setStockError(emptyIdx)
        toast.push('Item added to an empty row in the billing grid.', 'info')
        return normalizeRows(next)
      }

      const next = [
        ...prev,
        {
          item_id: it.id,
          name: it.name,
          mrp: Number(it.mrp) || 0,
          quantity: 1,
          custom_unit_price: Number(it.mrp) || 0,
          item_discount_percent: 0,
          stock: it.stock,
          expiry_date: it.expiry_date ?? null,
          brand: it.brand ?? null,
        },
      ]
      setStockError(prev.length)
      toast.push('Item added successfully. A new billing row has been created for it.', 'success')
      return normalizeRows(next)
    })
  }

  function setQty(i: number, q: number) {
    setRows((prev) =>
      normalizeRows(
        prev.map((r, idx) => {
          if (idx !== i) return r
          if (Number(r.item_id) <= 0) return r
          const raw = Number.isFinite(Number(q)) ? Number(q) : 0
          const normalized = Math.max(0, Math.floor(raw))
          const stock = Number(r.stock ?? Number.POSITIVE_INFINITY)
          if (normalized > stock) {
            setStockError(
              i,
              `Only ${stock} unit(s) available for ${r.name}. Quantity was reset to 0.`
            )
            toast.push(
              `Only ${stock} unit(s) are available for ${r.name}. Quantity was reset to 0. Please enter between 0 and ${stock}.`,
              'warning'
            )
            return { ...r, quantity: 0 }
          }
          setStockError(i)
          return { ...r, quantity: normalized }
        })
      )
    )
  }

  function normalizeQtyOnBlur(i: number) {
    setRows((prev) =>
      normalizeRows(
        prev.map((r, idx) => {
          if (idx !== i) return r
          if (Number(r.item_id) <= 0) return r
          const qty = Math.max(0, Math.floor(Number(r.quantity || 0)))
          setStockError(i)
          return { ...r, quantity: qty }
        })
      )
    )
  }

  function removeRow(i: number) {
    setRows((prev) => normalizeRows(prev.map((r, idx) => (idx === i ? emptyRow() : r))))
    setStockError(i)
    toast.push('Row cleared successfully. You can now select another item in that row.', 'info')
  }

  function selectItemAtRow(i: number, it: any | null) {
    setRows((prev) => {
      if (!it) {
        setStockError(i)
        return normalizeRows(prev.map((r, idx) => (idx === i ? emptyRow() : r)))
      }
      const st = Number(it.stock ?? 0)
      if (st <= 0) {
        toast.push('This item is currently out of stock, so it cannot be selected here.', 'error')
        setStockError(i, `Selected item has no stock available.`)
        return prev
      }

      const dup = prev.findIndex((r, idx) => idx !== i && Number(r.item_id) === Number(it.id))
      if (dup >= 0) {
        const next = prev.map((r, idx) => {
          if (idx === dup) {
            const nextQty = Number(r.quantity || 0) + 1
            const stock = Number(r.stock ?? Number.POSITIVE_INFINITY)
            if (nextQty > stock) {
              setStockError(
                dup,
                `Only ${stock} unit(s) available for ${r.name}. Quantity was reset to 0.`
              )
              toast.push(
                `Only ${stock} unit(s) are available for ${r.name}. Quantity was reset to 0. Please enter between 0 and ${stock}.`,
                'warning'
              )
              return { ...r, quantity: 0 }
            }
            setStockError(dup)
            return {
              ...r,
              quantity: nextQty,
            }
          }
          if (idx === i) return emptyRow()
          return r
        })
        setStockError(i)
        setPendingQtyFocusRow(dup)
        toast.push('This item already exists in another row, so that row quantity was increased by 1.', 'info')
        return normalizeRows(next)
      }

      const next = prev.map((r, idx) =>
        idx === i
          ? {
              item_id: Number(it.id),
              name: String(it.name || ''),
              mrp: Number(it.mrp || 0),
              quantity: Number(r.quantity || 0) > 0 ? Number(r.quantity) : 1,
              custom_unit_price: Number(it.mrp || 0),
              item_discount_percent: 0,
              stock: Number(it.stock ?? 0),
              expiry_date: it.expiry_date ?? null,
              brand: it.brand ?? null,
            }
          : r
      )
      setStockError(i)
      return normalizeRows(next)
    })
  }

  function setCustomUnitPrice(i: number, v: number) {
    const n = Math.max(0, Number(v) || 0)
    setRows((prev) =>
      normalizeRows(
        prev.map((r, idx) => {
          if (idx !== i) return r
          const nextPrice = Number(n.toFixed(2))
          const mrp = Number(r.mrp || 0)
          const pct = mrp > 0 ? ((mrp - nextPrice) / mrp) * 100 : 0
          const safePct = Math.min(100, Math.max(0, pct))
          return {
            ...r,
            custom_unit_price: nextPrice,
            item_discount_percent: Number(safePct.toFixed(2)),
          }
        })
      )
    )
  }

  function handleCustomPriceChange(i: number, raw: string) {
    setPriceDraftByRow((prev) => ({ ...prev, [i]: raw }))
  }

  function commitCustomPrice(i: number) {
    if (Number(rows[i]?.item_id || 0) <= 0) return
    const raw = String(priceDraftByRow[i] ?? '').trim()
    if (raw === '') {
      setPriceDraftByRow((prev) => {
        const next = { ...prev }
        delete next[i]
        return next
      })
      return
    }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      setPriceDraftByRow((prev) => {
        const next = { ...prev }
        delete next[i]
        return next
      })
      return
    }
    const safe = Math.max(0, parsed)
    setCustomUnitPrice(i, safe)
    setPriceDraftByRow((prev) => {
      const next = { ...prev }
      delete next[i]
      return next
    })
  }

  function setItemDiscountPercent(i: number, v: number) {
    setRows((prev) =>
      normalizeRows(
        prev.map((r, idx) => {
          if (idx !== i) return r
          const mrp = Number(r.mrp || 0)
          const safePct = Math.min(100, Math.max(0, Number(v) || 0))
          const price = mrp > 0 ? mrp * (1 - safePct / 100) : 0
          return {
            ...r,
            item_discount_percent: Number(safePct.toFixed(2)),
            custom_unit_price: Number(price.toFixed(2)),
          }
        })
      )
    )
  }

  function handleRowDiscountChange(i: number, raw: string) {
    setDiscountDraftByRow((prev) => ({ ...prev, [i]: raw }))
  }

  function commitRowDiscount(i: number) {
    if (Number(rows[i]?.item_id || 0) <= 0) return
    const raw = String(discountDraftByRow[i] ?? '').trim()
    if (raw === '') {
      setDiscountDraftByRow((prev) => {
        const next = { ...prev }
        delete next[i]
        return next
      })
      return
    }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      setDiscountDraftByRow((prev) => {
        const next = { ...prev }
        delete next[i]
        return next
      })
      return
    }
    setItemDiscountPercent(i, parsed)
    setDiscountDraftByRow((prev) => {
      const next = { ...prev }
      delete next[i]
      return next
    })
  }

  // ✅ submit handler with CASH confirm
  const handleCreateBill = () => {
    if (validLineCount === 0 || !paymentsOk || mBill.isPending) return

    if (!notesOkForCredit) {
      toast.push(
        'Credit mode requires notes. Please add customer details and credit terms before creating the bill.',
        'warning'
      )
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
          <table className="table" style={{ tableLayout: 'fixed', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ width: '31%' }}>Item</th>
                <th style={{ width: '10%' }}>MRP</th>
                <th style={{ width: '13%' }}>Expiry</th>
                <th style={{ width: '8%' }}>Qty</th>
                <th style={{ width: '11%' }}>Custom Price</th>
                <th style={{ width: '11%' }}>Discount %</th>
                <th style={{ width: '10%' }}>Line Total</th>
                <th style={{ width: '6%' }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <Autocomplete
                      size="small"
                      options={inventoryItems}
                      value={
                        inventoryItems.find((it: any) => Number(it.id) === Number(r.item_id)) ||
                        (Number(r.item_id) > 0
                          ? {
                              id: r.item_id,
                              name: r.name,
                              brand: r.brand ?? '',
                              mrp: r.mrp,
                              stock: r.stock ?? 0,
                              expiry_date: r.expiry_date ?? null,
                            }
                          : null)
                      }
                      getOptionLabel={(it: any) => `${it?.name || ''}`}
                      isOptionEqualToValue={(a: any, b: any) => Number(a?.id) === Number(b?.id)}
                      filterOptions={(options) => options}
                      onInputChange={(_e, val, reason) => {
                        if (reason === 'input' || reason === 'clear') setGridSearch(val || '')
                      }}
                      onChange={(_e, val) => selectItemAtRow(i, val)}
                      ListboxProps={{ style: { maxHeight: 300 } }}
                      renderOption={(props, option: any) => (
                        <li {...props} key={`inv-opt-${option.id}`}>
                          <Stack sx={{ py: 0.5, width: '100%' }}>
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                              {option.name}
                              {option.brand ? ` (${option.brand})` : ''}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {option.brand ? `${option.brand} | ` : ''}MRP ₹{Number(option.mrp || 0).toFixed(2)} | Stock {Number(option.stock || 0)}
                            </Typography>
                          </Stack>
                        </li>
                      )}
                      sx={GRID_INPUT_SX}
                      renderInput={(params) => (
                        <TextField {...params} size="small" placeholder="Search medicine..." sx={GRID_INPUT_SX} />
                      )}
                    />
                  </td>
                  <td>{r.mrp}</td>
                  <td>{formatExpiry(r.expiry_date)}</td>
                  <td style={{ textAlign: 'center' }}>
                    <Tooltip
                      title={stockErrorByRow[i] || ''}
                      placement="top"
                      arrow
                      disableHoverListener={!stockErrorByRow[i]}
                    >
                      <span>
                        <TextField
                          size="small"
                          type="number"
                          value={Number(r.item_id) > 0 ? r.quantity : ''}
                          onChange={(e) => setQty(i, Number(e.target.value))}
                          onBlur={() => normalizeQtyOnBlur(i)}
                          onWheel={blurOnWheel}
                          onFocus={(e) => e.target.select()}
                          inputRef={(el) => {
                            qtyInputRefs.current[i] = el
                          }}
                          error={Boolean(stockErrorByRow[i])}
                          inputProps={{ min: 0, max: 9999, step: 1, inputMode: 'numeric' }}
                          sx={{ width: 72, ...GRID_INPUT_SX, ...noSpinnerSx }}
                          disabled={Number(r.item_id) <= 0}
                        />
                      </span>
                    </Tooltip>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <TextField
                      size="small"
                      type="text"
                      value={
                        Object.prototype.hasOwnProperty.call(priceDraftByRow, i)
                          ? priceDraftByRow[i]
                          : String(Number(r.custom_unit_price || 0).toFixed(2))
                      }
                      onChange={(e) => handleCustomPriceChange(i, e.target.value)}
                      onBlur={() => commitCustomPrice(i)}
                      onWheel={blurOnWheel}
                      onFocus={(e) => e.target.select()}
                      sx={{ width: 108, ...GRID_INPUT_SX, ...noSpinnerSx }}
                      inputProps={{ inputMode: 'decimal', pattern: '[0-9]*[.,]?[0-9]*' }}
                      disabled={Number(r.item_id) <= 0}
                    />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <TextField
                      size="small"
                      type="text"
                      value={
                        Object.prototype.hasOwnProperty.call(discountDraftByRow, i)
                          ? discountDraftByRow[i]
                          : String(Number(r.item_discount_percent || 0).toFixed(2))
                      }
                      onChange={(e) => handleRowDiscountChange(i, e.target.value)}
                      onBlur={() => commitRowDiscount(i)}
                      onWheel={blurOnWheel}
                      onFocus={(e) => e.target.select()}
                      sx={{ width: 96, ...GRID_INPUT_SX, ...noSpinnerSx }}
                      inputProps={{ inputMode: 'decimal', pattern: '[0-9]*[.,]?[0-9]*' }}
                      disabled={Number(r.item_id) <= 0}
                    />
                  </td>
                  <td>{(Number(r.quantity || 0) * Number(r.custom_unit_price || 0)).toFixed(2)}</td>
                  <td>
                    <IconButton color="error" onClick={() => removeRow(i)}>
                      <DeleteIcon />
                    </IconButton>
                  </td>
                </tr>
              ))}

              {filledRowCount === 0 && (
                <tr>
                  <td colSpan={8}>
                    <Box p={2} color="text.secondary">
                      No items in cart. Click "Add Item" to start filling rows.
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

            {mode === 'split' && (
              <TextField
                select
                label="Split Combination"
                value={splitCombination}
                onChange={(e) => {
                  const v = e.target.value as 'cash-online' | 'cash-credit' | 'online-credit'
                  setSplitCombination(v)
                  if (v === 'cash-online') return
                  if (v === 'cash-credit') setOnline('')
                  if (v === 'online-credit') setCash('')
                }}
                sx={{ width: 220 }}
              >
                <MenuItem value="cash-online">Cash + Online</MenuItem>
                <MenuItem value="cash-credit">Cash + Credit</MenuItem>
                <MenuItem value="online-credit">Online + Credit</MenuItem>
              </TextField>
            )}

            {(mode === 'cash' ||
              (mode === 'split' && splitCombination !== 'online-credit')) && (
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

            {(mode === 'online' ||
              (mode === 'split' && splitCombination !== 'cash-credit')) && (
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

            {mode === 'split' && (splitCombination === 'cash-credit' || splitCombination === 'online-credit') && (
              <TextField
                label="Credit Amount"
                type="text"
                value={Math.max(0, splitCreditAmount).toFixed(2)}
                sx={{ width: 160, ...noSpinnerSx }}
                inputProps={{ inputMode: 'decimal' }}
                disabled
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
            <Typography variant="body2" color="text.secondary">
              Final From Item Prices: ₹{finalByRows.toFixed(2)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Final Amount (sum of line totals): ₹{chosenFinal.toFixed(2)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Discount Given: +{effectiveDiscountPercent.toFixed(2)}%
            </Typography>
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
            disabled={validLineCount === 0 || !paymentsOk || mBill.isPending || !notesOkForCredit}
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
