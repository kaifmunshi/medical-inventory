// frontend/src/pages/Inventory/index.tsx

import {
  Box,
  Button,
  IconButton,
  Paper,
  Stack,
  TextField,
  Typography,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  FormControlLabel,
  Checkbox,
} from '@mui/material'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQueryClient, useMutation } from '@tanstack/react-query'

import {
  listItemsPage, // ✅ new paginated list
  createItem,
  updateItem,
  deleteItem,
  adjustStock,
} from '../../services/inventory'

import Loading from '../../components/ui/Loading'
import ItemForm from './ItemForm'
import type { ItemFormValues } from './ItemForm'
import EditIcon from '@mui/icons-material/Edit'
import DeleteIcon from '@mui/icons-material/Delete'
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline'
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown'
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp'
import AdjustStockDialog from '../../components/ui/AdjustStockDialog'
import { useToast } from '../../components/ui/Toaster'

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
  return `${name}__${brand}`
}

export default function Inventory() {
  const toast = useToast()

  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('') // ✅ debounce search input

  const [openForm, setOpenForm] = useState(false)
  const [editing, setEditing] = useState<any | null>(null)
  const [adjustId, setAdjustId] = useState<number | null>(null)
  const [adjustName, setAdjustName] = useState<string>('')

  // which item is pending delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null)

  // ✅ expanded groups state
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // ✅ Show/Hide out-of-stock items (default: hide)
  const [showOutOfStock, setShowOutOfStock] = useState(false)

  // ✅ Debounce typing to avoid calling API on every keystroke
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])

  // Keep UI clean on new search
  useEffect(() => {
    setExpanded({})
  }, [debouncedQ])

  const qc = useQueryClient()

  // ✅ pagination size (you can change to 100 later if you want)
  const LIMIT = 30

  // ✅ Infinite query (offset-based pagination)
  const {
    data,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['inventory-items', debouncedQ],
    initialPageParam: 0, // offset starts at 0
    queryFn: async ({ pageParam }) => {
      try {
        // pageParam is offset
        return await listItemsPage(debouncedQ, LIMIT, pageParam)
      } catch (err: any) {
        const msg =
          err?.response?.data?.detail ||
          err?.message ||
          'Failed to load inventory'
        toast.push(String(msg), 'error')
        throw err
      }
    },
    getNextPageParam: (lastPage) => lastPage.next_offset ?? undefined,
  })

  // ✅ Flatten pages into a single rows array
  const rows = useMemo(() => {
    return data?.pages.flatMap((p) => p.items) ?? []
  }, [data])

  // ✅ Filter rows for visibility (hide stock=0 by default)
  const visibleRows = useMemo(() => {
    if (showOutOfStock) return rows
    return rows.filter((x) => (Number(x.stock) || 0) > 0)
  }, [rows, showOutOfStock])

  // ✅ Group rows by (name + brand)
  const groups = useMemo(() => {
    const map = new Map<string, any[]>()

    for (const it of visibleRows) {
      const key = buildGroupKey(it)
      const arr = map.get(key) ?? []
      arr.push(it)
      map.set(key, arr)
    }

    const list = Array.from(map.entries()).map(([key, items]) => {
      // sort batches by expiry (earliest first). If expiry missing, push last.
      const sorted = [...items].sort((a, b) => {
        const da = toIsoDateOnly(a?.expiry_date)
        const db = toIsoDateOnly(b?.expiry_date)
        if (!da && !db) return 0
        if (!da) return 1
        if (!db) return -1
        return da.localeCompare(db)
      })

      const totalStock = sorted.reduce(
        (sum, x) => sum + (Number(x.stock) || 0),
        0
      )

      // rack label: if different across batches, show '-'
      const racks = new Set(sorted.map((x) => String(x.rack_number ?? 0)))
      const rackLabel = racks.size === 1 ? (sorted[0]?.rack_number ?? 0) : '-'

      // expiry label: earliest expiry for quick checking
      const earliestExpiryIso = toIsoDateOnly(sorted[0]?.expiry_date)
      const expiryLabel = earliestExpiryIso ? formatExpiry(earliestExpiryIso) : '-'

      // MRP: single or range
      const mrpNums = sorted
        .map((x) => Number(x.mrp))
        .filter((n) => Number.isFinite(n))

      let mrpLabel: string | number = '-'
      if (mrpNums.length > 0) {
        const min = Math.min(...mrpNums)
        const max = Math.max(...mrpNums)
        mrpLabel = min === max ? min : `${min}–${max}`
      }

      return {
        key,
        name: sorted[0]?.name,
        brand: sorted[0]?.brand,
        rackLabel,
        expiryLabel,
        mrpLabel,
        totalStock,
        count: sorted.length,
        items: sorted,
      }
    })

    // stable ordering: by name then brand
    list.sort((a, b) => {
      const an = String(a.name ?? '').toLowerCase()
      const bn = String(b.name ?? '').toLowerCase()
      if (an !== bn) return an.localeCompare(bn)
      const ab = String(a.brand ?? '').toLowerCase()
      const bb = String(b.brand ?? '').toLowerCase()
      return ab.localeCompare(bb)
    })

    return list
  }, [visibleRows])

  // ✅ Sentinel-based infinite scroll
  const loadMoreRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = loadMoreRef.current
    if (!el) return

    const obs = new IntersectionObserver(
      (entries) => {
        const first = entries[0]
        if (first.isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage()
        }
      },
      { root: null, rootMargin: '200px', threshold: 0 }
    )

    obs.observe(el)
    return () => obs.disconnect()
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])

  const mCreate = useMutation({
    mutationFn: (payload: ItemFormValues) => createItem(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory-items'] })
      qc.invalidateQueries({ queryKey: ['inventory-autocomplete'] })
      toast.push('Item created', 'success')
    },
    onError: (err: any) => {
      const msg =
        err?.response?.data?.detail || err?.message || 'Create failed'
      toast.push(String(msg), 'error')
    },
  })

  const mUpdate = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: ItemFormValues }) =>
      updateItem(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory-items'] })
      qc.invalidateQueries({ queryKey: ['inventory-autocomplete'] })
      toast.push('Item updated', 'success')
    },
    onError: (err: any) => {
      const msg =
        err?.response?.data?.detail || err?.message || 'Update failed'
      toast.push(String(msg), 'error')
    },
  })

  const mDelete = useMutation({
    mutationFn: (id: number) => deleteItem(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory-items'] })
      qc.invalidateQueries({ queryKey: ['inventory-autocomplete'] })
      toast.push('Item deleted', 'warning')
      setDeleteTarget(null)
    },
    onError: (err: any) => {
      const msg =
        err?.response?.data?.detail || err?.message || 'Delete failed'
      toast.push(String(msg), 'error')
    },
  })

  const mAdjust = useMutation({
    mutationFn: ({ id, delta }: { id: number; delta: number }) =>
      adjustStock(id, delta),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory-items'] })
      qc.invalidateQueries({ queryKey: ['inventory-autocomplete'] })
      toast.push('Stock adjusted', 'success')
    },
    onError: (err: any) => {
      const msg =
        err?.response?.data?.detail || err?.message || 'Adjust stock failed'
      toast.push(String(msg), 'error')
    },
  })

  function handleAdd() {
    setEditing(null)
    setOpenForm(true)
  }
  function handleEdit(row: any) {
    setEditing(row)
    setOpenForm(true)
  }
  function handleAdjust(row: any) {
    setAdjustId(row.id)
    setAdjustName(row.name)
  }

  function handleDeleteClick(row: any) {
    setDeleteTarget(row)
  }

  function handleConfirmDelete() {
    if (!deleteTarget) return
    mDelete.mutate(deleteTarget.id)
  }

  function handleCancelDelete() {
    setDeleteTarget(null)
  }

  function toggleGroup(key: string) {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <Stack gap={2}>
      <Typography variant="h5">Inventory</Typography>

      <Paper sx={{ p: 2 }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          gap={2}
          alignItems={{ sm: 'center' }}
        >
          <TextField
            label="Search (name/brand)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            fullWidth
          />

          <FormControlLabel
            control={
              <Checkbox
                checked={showOutOfStock}
                onChange={(e) => setShowOutOfStock(e.target.checked)}
              />
            }
            label="Show out of stock"
          />

          <Button variant="contained" onClick={handleAdd}>
            Add Item
          </Button>
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        {isLoading ? (
          <Loading />
        ) : (
          <>
            <Box component="div" sx={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Rack</th>
                    <th>Brand</th>
                    <th>Expiry</th>
                    <th>MRP</th>
                    <th>Stock</th>
                    <th style={{ width: 140 }}>Actions</th>
                  </tr>
                </thead>

                <tbody>
                  {groups.map((g) => {
                    const isOpen = !!expanded[g.key]
                    const isMulti = g.count > 1

                    return (
                      <Fragment key={g.key}>
                        {/* GROUP ROW */}
                        <tr
                          style={{ cursor: isMulti ? 'pointer' : 'default' }}
                          onClick={() => {
                            if (!isMulti) return
                            toggleGroup(g.key)
                          }}
                        >
                          <td>
                            <Stack direction="row" alignItems="center" gap={1}>
                              {isMulti && (
                                <IconButton
                                  size="small"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    toggleGroup(g.key)
                                  }}
                                >
                                  {isOpen ? (
                                    <KeyboardArrowUpIcon fontSize="small" />
                                  ) : (
                                    <KeyboardArrowDownIcon fontSize="small" />
                                  )}
                                </IconButton>
                              )}

                              <span>{g.name}</span>

                              {isMulti && (
                                <span
                                  style={{
                                    fontSize: 12,
                                    padding: '2px 8px',
                                    borderRadius: 999,
                                    border: '1px solid #ddd',
                                  }}
                                >
                                  {g.count} batches
                                </span>
                              )}
                            </Stack>
                          </td>

                          <td>{g.rackLabel}</td>
                          <td>{g.brand || '-'}</td>
                          <td>{g.expiryLabel}</td>
                          <td>{g.mrpLabel}</td>
                          <td>{g.totalStock}</td>

                          <td>
                            {/* For single batch, keep old actions */}
                            {!isMulti ? (
                              <Stack direction="row" gap={1}>
                                <Tooltip title="Edit">
                                  <IconButton
                                    size="small"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleEdit(g.items[0])
                                    }}
                                  >
                                    <EditIcon fontSize="small" />
                                  </IconButton>
                                </Tooltip>

                                <Tooltip title="Adjust Stock">
                                  <IconButton
                                    size="small"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleAdjust(g.items[0])
                                    }}
                                  >
                                    <AddCircleOutlineIcon fontSize="small" />
                                  </IconButton>
                                </Tooltip>

                                <Tooltip title="Delete">
                                  <IconButton
                                    size="small"
                                    color="error"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleDeleteClick(g.items[0])
                                    }}
                                    disabled={mDelete.isPending}
                                  >
                                    <DeleteIcon fontSize="small" />
                                  </IconButton>
                                </Tooltip>
                              </Stack>
                            ) : (
                              <Typography variant="body2" sx={{ opacity: 0.7 }}>
                                {isOpen ? 'Hide' : 'View'}
                              </Typography>
                            )}
                          </td>
                        </tr>

                        {/* EXPANDED BATCH ROWS */}
                        {isOpen &&
                          g.items.map((it: any) => (
                            <tr key={it.id} style={{ background: '#fafafa' }}>
                              <td style={{ paddingLeft: 24 }}>
                                <span style={{ opacity: 0.7 }}>↳</span> {it.name}
                              </td>
                              <td>{it.rack_number ?? 0}</td>
                              <td>{it.brand || '-'}</td>
                              <td>{formatExpiry(it.expiry_date)}</td>
                              <td>{it.mrp}</td>
                              <td>{it.stock}</td>
                              <td>
                                <Stack direction="row" gap={1}>
                                  <Tooltip title="Edit">
                                    <IconButton
                                      size="small"
                                      onClick={() => handleEdit(it)}
                                    >
                                      <EditIcon fontSize="small" />
                                    </IconButton>
                                  </Tooltip>

                                  <Tooltip title="Adjust Stock">
                                    <IconButton
                                      size="small"
                                      onClick={() => handleAdjust(it)}
                                    >
                                      <AddCircleOutlineIcon fontSize="small" />
                                    </IconButton>
                                  </Tooltip>

                                  <Tooltip title="Delete">
                                    <IconButton
                                      size="small"
                                      color="error"
                                      onClick={() => handleDeleteClick(it)}
                                      disabled={mDelete.isPending}
                                    >
                                      <DeleteIcon fontSize="small" />
                                    </IconButton>
                                  </Tooltip>
                                </Stack>
                              </td>
                            </tr>
                          ))}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </Box>

            {/* ✅ sentinel for loading next page */}
            <div ref={loadMoreRef} style={{ height: 1 }} />

            {isFetchingNextPage && (
              <Box sx={{ py: 2, textAlign: 'center' }}>
                <Typography variant="body2">Loading more...</Typography>
              </Box>
            )}

            {!hasNextPage && rows.length > 0 && (
              <Box sx={{ py: 2, textAlign: 'center' }}>
                <Typography variant="body2">End of list</Typography>
              </Box>
            )}
          </>
        )}
      </Paper>

      <ItemForm
        open={openForm}
        initial={editing}
        items={rows} // ✅ still pass existing items for suggestions
        onClose={() => setOpenForm(false)}
        onSubmit={(values) => {
          if (editing?.id) mUpdate.mutate({ id: editing.id, payload: values })
          else mCreate.mutate(values)
          setOpenForm(false)
        }}
      />

      <AdjustStockDialog
        open={adjustId != null}
        itemName={adjustName}
        onClose={() => {
          setAdjustId(null)
          setAdjustName('')
        }}
        onConfirm={(delta) => {
          if (adjustId != null) mAdjust.mutate({ id: adjustId, delta })
          setAdjustId(null)
          setAdjustName('')
        }}
      />

      {/* Delete confirmation dialog */}
      <Dialog
        open={Boolean(deleteTarget)}
        onClose={handleCancelDelete}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Delete Item</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2">
            {deleteTarget
              ? `Delete item "${deleteTarget.name}"? This action cannot be undone.`
              : ''}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCancelDelete}>Cancel</Button>
          <Button
            onClick={handleConfirmDelete}
            color="error"
            variant="contained"
            disabled={mDelete.isPending}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
