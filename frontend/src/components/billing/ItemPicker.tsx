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
  Stack,
  MenuItem,
} from '@mui/material'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listItemsPage } from '../../services/inventory'
import { openPack } from '../../services/lots'
import { fetchCategories } from '../../services/products'
import { PRODUCT_SEARCH_DEBOUNCE_MS, PRODUCT_SEARCH_MIN_CHARS, PRODUCT_SEARCH_PROMPT } from '../../lib/constants'
import { subscribeProductMasterChanged } from '../../lib/productMasterEvents'
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

function usesUnitSplit(it: any) {
  return Boolean(it?.loose_sale_enabled || it?.is_loose_stock)
}

function itemKindLabel(it: any) {
  if (!usesUnitSplit(it)) return ''
  return it?.is_loose_stock ? 'Loose' : 'Pack'
}

function itemUnitLabel(it: any) {
  if (!usesUnitSplit(it)) return ''
  return String(
    it?.stock_unit_label ||
    (it?.is_loose_stock ? it?.child_unit_name : it?.parent_unit_name) ||
    (it?.is_loose_stock ? 'Unit' : 'Pack')
  )
}

function itemStockText(it: any) {
  const unit = itemUnitLabel(it)
  return `${Number(it?.stock || 0)}${unit ? ` ${unit}` : ''}`
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
  const [categoryId, setCategoryId] = useState('')
  const [openDraftItem, setOpenDraftItem] = useState<PickerItem | null>(null)
  const [openDraftQty, setOpenDraftQty] = useState('1')
  const searchTerm = q.trim()
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('')
  const hasCategoryFilter = categoryId !== ''
  const hasReadySearchTerm = (
    searchTerm.length >= PRODUCT_SEARCH_MIN_CHARS &&
    debouncedSearchTerm.length >= PRODUCT_SEARCH_MIN_CHARS &&
    searchTerm === debouncedSearchTerm
  )
  const canSearchItems = open && (hasCategoryFilter || hasReadySearchTerm)
  const ITEM_PAGE_SIZE = 50
  const [pageOffset, setPageOffset] = useState(0)

  useEffect(() => {
    setPageOffset(0)
  }, [searchTerm, categoryId, open])

  useEffect(() => {
    return subscribeProductMasterChanged(() => {
      queryClient.invalidateQueries({ queryKey: ['billing-items'] })
      queryClient.invalidateQueries({ queryKey: ['billing-product-categories'] })
    })
  }, [queryClient])

  useEffect(() => {
    if (!open || searchTerm.length < PRODUCT_SEARCH_MIN_CHARS) {
      setDebouncedSearchTerm('')
      return undefined
    }
    const timer = window.setTimeout(() => {
      setDebouncedSearchTerm(searchTerm)
    }, PRODUCT_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [open, searchTerm])

  const { data: categories = [] } = useQuery({
    queryKey: ['billing-product-categories'],
    queryFn: () => fetchCategories({ active_only: true }),
    enabled: open,
    staleTime: 5 * 60_000,
  })

  const { data, isFetching } = useQuery({
    queryKey: ['billing-items', debouncedSearchTerm, categoryId, pageOffset],
    enabled: canSearchItems,
    queryFn: async ({ signal }) => {
      if (
        !open ||
        (!hasCategoryFilter && debouncedSearchTerm.length < PRODUCT_SEARCH_MIN_CHARS) ||
        (!hasCategoryFilter && searchTerm !== debouncedSearchTerm)
      ) {
        return { items: [], total: 0, next_offset: null }
      }
      try {
        return await listItemsPage(
          hasReadySearchTerm ? debouncedSearchTerm : '',
          ITEM_PAGE_SIZE,
          pageOffset,
          undefined,
          categoryId ? { category_id: Number(categoryId) } : undefined,
          { signal },
        )
      } catch (err: any) {
        if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') throw err
        const msg = err?.response?.data?.detail || err?.message || 'Failed to load items'
        toast.push(String(msg), 'error')
        throw err
      }
    },
    staleTime: 0,
    gcTime: 5 * 60_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    retry: false,
  })
  const rawItems = canSearchItems ? ((data?.items || []) as PickerItem[]) : []
  const totalItems = Number(data?.total || 0)
  const pageStart = rawItems.length > 0 ? pageOffset + 1 : 0
  const pageEnd = rawItems.length > 0 ? pageOffset + rawItems.length : 0
  const hasPrevPage = pageOffset > 0
  const hasNextPage = data?.next_offset != null

  const items = ((() => {
    const all = rawItems
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
      setCategoryId('')
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
      const freshPage = await listItemsPage(String(item.name || ''), ITEM_PAGE_SIZE, 0)
      return {
        packs,
        parent: item,
        loose: findOpenedLooseItem(freshPage.items as any[], item, event.loose_item_id),
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
      toast.push(`Only ${stock} ${itemUnitLabel(openDraftItem) || 'unit(s)'} available to open.`, 'warning')
      return
    }
    mOpenParentPacks.mutate({ item: openDraftItem, packs })
  }

  function renderPageControls() {
    if (!canSearchItems || totalItems <= ITEM_PAGE_SIZE) return null
    return (
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ py: 0.75 }}>
        <Box color="text.secondary" sx={{ fontSize: 13 }}>
          Showing {pageStart}-{pageEnd} of {totalItems}
        </Box>
        <Stack direction="row" gap={1}>
          <Button
            size="small"
            variant="outlined"
            disabled={!hasPrevPage || isFetching}
            onClick={() => setPageOffset((prev) => Math.max(0, prev - ITEM_PAGE_SIZE))}
          >
            Prev
          </Button>
          <Button
            size="small"
            variant="outlined"
            disabled={!hasNextPage || isFetching}
            onClick={() => setPageOffset(data?.next_offset ?? pageOffset + ITEM_PAGE_SIZE)}
          >
            Next
          </Button>
        </Stack>
      </Stack>
    )
  }

  return (
    <>
      <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
        <DialogTitle>Select Item</DialogTitle>
        <DialogContent>
          <Stack my={1} direction={{ xs: 'column', sm: 'row' }} gap={1}>
            <TextField
              fullWidth
              autoFocus
              placeholder="Search (name/brand)"
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setPageOffset(0)
              }}
            />
            <TextField
              select
              label="Category"
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value)
                setPageOffset(0)
              }}
              sx={{ minWidth: { xs: '100%', sm: 190 } }}
            >
              <MenuItem value="">All categories</MenuItem>
              {categories.map((category) => (
                <MenuItem key={category.id} value={String(category.id)}>
                  {category.name}
                </MenuItem>
              ))}
            </TextField>
          </Stack>

          {renderPageControls()}
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
                    primary={`${it.name}${itemKindLabel(it) ? ` — ${itemKindLabel(it)}` : ''} — ₹${it.mrp}`}
                    secondary={`#${it.id} • Stock: ${itemStockText(it)}${it.brand ? ` • ${it.brand}` : ''} • Exp: ${formatExpiry(
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
                {canSearchItems ? (isFetching ? 'Loading products...' : 'No items found.') : PRODUCT_SEARCH_PROMPT}
              </Box>
            )}
          </List>
          {renderPageControls()}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(openDraftItem)} onClose={() => setOpenDraftItem(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Open {openDraftItem ? itemUnitLabel(openDraftItem) || 'Parent Unit' : 'Parent Unit'}</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 1 }}>
            <TextField
              autoFocus
              fullWidth
              label={`How many ${openDraftItem ? itemUnitLabel(openDraftItem) || 'parent units' : 'parent units'}?`}
              type="number"
              value={openDraftQty}
              onChange={(e) => setOpenDraftQty(e.target.value)}
              inputProps={{ min: 1, max: Number(openDraftItem?.stock || 0), step: 1 }}
              helperText={
                openDraftItem
                  ? `Available ${itemUnitLabel(openDraftItem) || 'unit(s)'}: ${Number(openDraftItem.stock || 0)}`
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
