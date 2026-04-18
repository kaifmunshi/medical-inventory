// F:\medical-inventory\frontend\src\components\billing\ItemPicker.tsx
import { useEffect, useState } from 'react'
import {
  Box,
  Dialog,
  DialogTitle,
  DialogContent,
  TextField,
  List,
  ListItemButton,
  ListItemText,
  DialogActions,
  Button,
} from '@mui/material'
import { useQuery } from '@tanstack/react-query'
import { fetchLots } from '../../services/lots'
import { useToast } from '../ui/Toaster'
import type { InventoryLotBrowse } from '../../lib/types'

export interface PickerItem {
  id: number
  lot_id?: number
  name: string
  mrp: number
  stock: number
  brand?: string | null
  expiry_date?: string | null
  unit_label?: string | null
}

function formatExpiry(exp?: string | null) {
  if (!exp) return '-'
  const s = String(exp)
  const iso = s.length > 10 ? s.slice(0, 10) : s // "YYYY-MM-DD"
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${d}-${m}-${y}` // "DD-MM-YYYY"
}

function toIsoDateOnly(exp?: string | null) {
  if (!exp) return ''
  const s = String(exp)
  return s.length > 10 ? s.slice(0, 10) : s
}

export default function ItemPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean
  onClose: () => void
  onPick: (it: PickerItem) => void
}) {
  const toast = useToast()
  const [q, setQ] = useState('')

  const { data } = useQuery({
    queryKey: ['billing-items', q],
    queryFn: async () => {
      try {
        return await fetchLots({ q })
      } catch (err: any) {
        const msg = err?.response?.data?.detail || err?.message || 'Failed to load items'
        toast.push(String(msg), 'error')
        throw err
      }
    },
  })

  const items = ((() => {
    const all = (data || []) as InventoryLotBrowse[]
    const out: PickerItem[] = all.map((lot) => ({
      id: Number(lot.legacy_item_id || 0),
      lot_id: Number(lot.id),
      name: lot.product_name,
      mrp: Number(lot.mrp || 0),
      stock: lot.opened_from_lot_id ? Number(lot.loose_qty || 0) : Number(lot.sealed_qty || 0),
      brand: lot.brand,
      expiry_date: lot.expiry_date,
      unit_label: lot.opened_from_lot_id ? (lot.child_unit_name || 'Loose') : (lot.parent_unit_name || 'Pack'),
    })).filter((it) => it.id > 0)

    out.sort((a, b) => {
      const an = String(a?.name ?? '').toLowerCase()
      const bn = String(b?.name ?? '').toLowerCase()
      if (an !== bn) return an.localeCompare(bn)
      const ab = String(a?.brand ?? '').toLowerCase()
      const bb = String(b?.brand ?? '').toLowerCase()
      if (ab !== bb) return ab.localeCompare(bb)
      const da = toIsoDateOnly(a?.expiry_date)
      const db = toIsoDateOnly(b?.expiry_date)
      if (!da && !db) return 0
      if (!da) return 1
      if (!db) return -1
      return da.localeCompare(db)
    })

    return out
  })()) as PickerItem[]

  useEffect(() => {
    if (!open) setQ('')
  }, [open])

  function handlePick(it: PickerItem) {
    // ✅ keep safety check (in case stale list / race condition)
    if (Number(it.stock ?? 0) <= 0) {
      toast.push('Out of stock', 'warning')
      return
    }
    onPick(it)
    toast.push('Item added', 'success')
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Select Item</DialogTitle>
      <DialogContent>
        <Box my={1}>
          <TextField
            fullWidth
            autoFocus
            placeholder="Search (name/brand)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </Box>

        <List>
          {items.map((it) => (
            <ListItemButton
              key={it.id}
              onClick={() => handlePick(it)}
              disabled={Number(it.stock ?? 0) <= 0}
              sx={{
                bgcolor: Number(it.stock ?? 0) <= 0 ? 'rgba(244, 67, 54, 0.12)' : undefined,
              }}
            >
              <ListItemText
                primary={`${it.name} — ₹${it.mrp}`}
                secondary={`Stock: ${it.stock}${it.unit_label ? ` ${it.unit_label}` : ''}${it.brand ? ` • ${it.brand}` : ''} • Exp: ${formatExpiry(
                  it.expiry_date
                )}${it.unit_label ? ` • ${it.unit_label}` : ''}${Number(it.stock ?? 0) <= 0 ? ' • Out of stock' : ''}`}
              />
            </ListItemButton>
          ))}

          {items.length === 0 && (
            <Box p={2} color="text.secondary">
              No items found.
            </Box>
          )}
        </List>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}
