// F:\medical-inventory\frontend\src\components\billing\ItemPicker.tsx
import { useEffect, useState } from 'react'
import {
  Box,
  CircularProgress,
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listItems } from '../../services/inventory'
import { openPack } from '../../services/lots'
import { useToast } from '../ui/Toaster'

export interface PickerItem {
  id: number
  name: string
  mrp: number
  stock: number
  brand?: string | null
  expiry_date?: string | null
  inventory_lot_id?: number | null
  opened_from_lot_id?: number | null
  is_loose_stock?: boolean
  stock_unit_label?: string | null
  parent_unit_name?: string | null
  child_unit_name?: string | null
  conversion_qty?: number | null
  loose_sale_enabled?: boolean
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

function buildGroupKey(it: any) {
  const name = String(it?.name ?? '').trim().toLowerCase()
  const brand = String(it?.brand ?? '').trim().toLowerCase()
  const kind = it?.is_loose_stock ? 'loose' : 'pack'
  if (it?.loose_sale_enabled || it?.is_loose_stock) return `${name}__${brand}__${kind}__${it?.id}`
  return `${name}__${brand}__${kind}`
}

function itemKindLabel(it: any) {
  return it?.is_loose_stock ? 'Loose' : 'Pack'
}

function itemUnitLabel(it: any) {
  return String(
    it?.stock_unit_label ||
    (it?.is_loose_stock ? it?.child_unit_name : it?.parent_unit_name) ||
    (it?.is_loose_stock ? 'Unit' : 'Pack')
  )
}

function canOpenForLoose(it: any) {
  return Boolean(
    it &&
    !it.is_loose_stock &&
    it.loose_sale_enabled &&
    (it.inventory_lot_id || it.id) &&
    Number(it.stock || 0) > 0
  )
}

function findOpenedLooseItem(rows: any[], parent: any, looseItemId?: number | null) {
  if (looseItemId) {
    const byId = rows.find((row) => Number(row?.id) === Number(looseItemId))
    if (byId) return byId
  }
  const nameKey = String(parent?.name || '').trim().toLowerCase()
  const brandKey = String(parent?.brand || '').trim().toLowerCase()
  return rows.find((row) => (
    Boolean(row?.is_loose_stock) &&
    Number(row?.stock || 0) > 0 &&
    String(row?.name || '').trim().toLowerCase() === nameKey &&
    String(row?.brand || '').trim().toLowerCase() === brandKey
  )) || null
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
  const queryClient = useQueryClient()
  const [q, setQ] = useState('')
  const [openDraftItem, setOpenDraftItem] = useState<PickerItem | null>(null)
  const [openDraftQty, setOpenDraftQty] = useState('1')

  const { data } = useQuery({
    queryKey: ['billing-items', q],
    queryFn: async () => {
      try {
        return await listItems(q)
      } catch (err: any) {
        const msg = err?.response?.data?.detail || err?.message || 'Failed to load items'
        toast.push(String(msg), 'error')
        throw err
      }
    },
  })

  const items = ((() => {
    const all = (data || []) as PickerItem[]
    const byGroup = new Map<string, PickerItem[]>()

    for (const it of all) {
      const key = buildGroupKey(it)
      const arr = byGroup.get(key) ?? []
      arr.push(it)
      byGroup.set(key, arr)
    }

    const out: PickerItem[] = []
    for (const group of byGroup.values()) {
      const sorted = [...group].sort((a, b) => {
        const da = toIsoDateOnly(a?.expiry_date)
        const db = toIsoDateOnly(b?.expiry_date)
        if (!da && !db) return 0
        if (!da) return 1
        if (!db) return -1
        return da.localeCompare(db)
      })
      const inStock = sorted.filter((x) => Number(x?.stock ?? 0) > 0)
      const visible = inStock.length > 0 ? inStock : sorted.slice(0, 1)
      out.push(...visible)
    }

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
    if (!open) {
      setQ('')
      setOpenDraftItem(null)
      setOpenDraftQty('1')
    }
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

  const mOpenParentPacks = useMutation({
    mutationFn: async ({ item, packs }: { item: PickerItem; packs: number }) => {
      if (!item.inventory_lot_id && !item.id) throw new Error('Parent item link is missing')
      const event = await openPack({
        lot_id: item.inventory_lot_id ? Number(item.inventory_lot_id) : undefined,
        item_id: item.inventory_lot_id ? undefined : Number(item.id),
        packs_opened: packs,
        note: 'Opened from billing for loose sale',
      })
      const freshRows = await listItems(String(item.name || ''))
      return {
        packs,
        parent: item,
        loose: findOpenedLooseItem(freshRows as any[], item, event.loose_item_id),
      }
    },
    onSuccess: ({ loose, packs }) => {
      queryClient.invalidateQueries({ queryKey: ['billing-items'] })
      queryClient.invalidateQueries({ queryKey: ['billing-grid-items'] })
      queryClient.invalidateQueries({ queryKey: ['lots'] })
      queryClient.invalidateQueries({ queryKey: ['pack-open-events'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
      queryClient.invalidateQueries({ queryKey: ['dash-inventory-stats'] })
      setOpenDraftItem(null)
      setOpenDraftQty('1')
      if (loose) {
        onPick(loose)
        toast.push(`Opened ${packs} parent unit(s) and added loose stock to the bill.`, 'success')
        onClose()
      } else {
        toast.push(`Opened ${packs} parent unit(s). Search again and select the loose row.`, 'success')
      }
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Could not open parent unit'
      toast.push(String(msg), 'error')
    },
  })

  function submitOpenDraft() {
    if (!openDraftItem) return
    const packs = Math.floor(Number(openDraftQty || 0))
    const stock = Number(openDraftItem.stock || 0)
    if (!Number.isFinite(packs) || packs <= 0) {
      toast.push('Enter a valid parent unit count', 'warning')
      return
    }
    if (packs > stock) {
      toast.push(`Only ${stock} ${itemUnitLabel(openDraftItem)} available to open.`, 'warning')
      return
    }
    mOpenParentPacks.mutate({ item: openDraftItem, packs })
  }

  return (
    <>
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
                disabled={Number(it.stock ?? 0) <= 0 || mOpenParentPacks.isPending}
                sx={{
                  bgcolor: Number(it.stock ?? 0) <= 0 ? 'rgba(244, 67, 54, 0.12)' : undefined,
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, width: '100%' }}>
                  <ListItemText
                    primary={`${it.name} — ${itemKindLabel(it)} — ₹${it.mrp}`}
                    secondary={`#${it.id} • Stock: ${it.stock} ${itemUnitLabel(it)}${it.brand ? ` • ${it.brand}` : ''} • Exp: ${formatExpiry(
                      it.expiry_date
                    )}${Number(it.stock ?? 0) <= 0 ? ' • Out of stock' : ''}`}
                  />
                  {canOpenForLoose(it) ? (
                    <Button
                      type="button"
                      size="small"
                      variant="outlined"
                      disabled={mOpenParentPacks.isPending}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                      }}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                      }}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setOpenDraftItem(it)
                        setOpenDraftQty('1')
                      }}
                      sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                    >
                      {mOpenParentPacks.isPending ? <CircularProgress size={16} /> : `Open ${itemUnitLabel(it)}`}
                    </Button>
                  ) : null}
                </Box>
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

      <Dialog open={Boolean(openDraftItem)} onClose={() => setOpenDraftItem(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Open {openDraftItem ? itemUnitLabel(openDraftItem) : 'Parent Unit'}</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 1 }}>
            <TextField
              autoFocus
              fullWidth
              label={`How many ${openDraftItem ? itemUnitLabel(openDraftItem) : 'parent units'}?`}
              type="number"
              value={openDraftQty}
              onChange={(e) => setOpenDraftQty(e.target.value)}
              inputProps={{ min: 1, max: Number(openDraftItem?.stock || 0), step: 1 }}
              helperText={
                openDraftItem
                  ? `Available ${itemUnitLabel(openDraftItem)}: ${Number(openDraftItem.stock || 0)}`
                  : ''
              }
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpenDraftItem(null)}>Cancel</Button>
          <Button variant="contained" onClick={submitOpenDraft} disabled={mOpenParentPacks.isPending}>
            {mOpenParentPacks.isPending ? 'Opening...' : 'Open'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
