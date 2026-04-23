// frontend/src/pages/Inventory/index.tsx

import {
  Box,
  Button,
  IconButton,
  InputAdornment,
  Paper,
  Stack,
  TextField,
  Typography,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Chip,
  useMediaQuery,
} from '@mui/material'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'

import {
  listItemsPage,
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
import CloseIcon from '@mui/icons-material/Close'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded'

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
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const isSm = useMediaQuery('(max-width:900px)')

  const [q, setQ] = useState(searchParams.get('q') || '')
  const [debouncedQ, setDebouncedQ] = useState('') // ✅ debounce search input
  const [rackQ, setRackQ] = useState(searchParams.get('rack') || '')
  const [debouncedRackQ, setDebouncedRackQ] = useState('')

  const [openForm, setOpenForm] = useState(false)
  const [editing, setEditing] = useState<any | null>(null)
  const [adjustId, setAdjustId] = useState<number | null>(null)
  const [adjustName, setAdjustName] = useState<string>('')

  // which item is pending delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null)
  const loadMoreRef = useRef<HTMLDivElement | null>(null)

  // ✅ Debounce typing to avoid calling API on every keystroke
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 600)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => {
    const t = setTimeout(() => setDebouncedRackQ(rackQ.trim()), 600)
    return () => clearTimeout(t)
  }, [rackQ])
  useEffect(() => {
    setQ(searchParams.get('q') || '')
    setRackQ(searchParams.get('rack') || '')
  }, [searchParams])

  const qc = useQueryClient()
  const LIMIT = 50

  // ✅ Infinite inventory query (loads 50 at a time)
  const {
    data,
    isLoading,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['inventory-items', debouncedQ, debouncedRackQ],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      try {
        const rackFilter =
          debouncedRackQ !== '' && /^\d+$/.test(debouncedRackQ)
            ? Number(debouncedRackQ)
            : undefined
        return await listItemsPage(debouncedQ, LIMIT, pageParam, rackFilter)
      } catch (err: any) {
        const msg = err?.response?.data?.detail || err?.message || 'Failed to load inventory'
        toast.push(String(msg), 'error')
        throw err
      }
    },
    getNextPageParam: (lastPage) => lastPage.next_offset ?? undefined,
  })

  const rows = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data])
  const hasFilters = q.trim() !== '' || rackQ.trim() !== ''

  useEffect(() => {
    const el = loadMoreRef.current
    if (!el) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return
        if (!hasNextPage || isFetchingNextPage) return
        void fetchNextPage()
      },
      { root: null, rootMargin: '0px 0px 120px 0px', threshold: 0 }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])

  // ✅ Group rows by (name + brand) ALWAYS (includes stock=0 batches)
  const groups = useMemo(() => {
    const map = new Map<string, any[]>()

    for (const it of rows) {
      const key = buildGroupKey(it)
      const arr = map.get(key) ?? []
      arr.push(it)
      map.set(key, arr)
    }

    const list = Array.from(map.entries()).map(([key, items]) => {
      const sorted = [...items].sort((a, b) => {
        const da = toIsoDateOnly(a?.expiry_date)
        const db = toIsoDateOnly(b?.expiry_date)
        if (!da && !db) return 0
        if (!da) return 1
        if (!db) return -1
        return da.localeCompare(db)
      })

      const totalStock = sorted.reduce((sum, x) => sum + (Number(x.stock) || 0), 0)
      const inStock = sorted.filter((x) => Number(x?.stock ?? 0) > 0)
      // UI rule:
      // - if any in-stock batch exists, hide zero-stock batches in table rows
      // - if all batches are zero, show exactly one batch row (earliest expiry)
      const displayItems = inStock.length > 0 ? inStock : sorted.slice(0, 1)

      const racks = new Set(displayItems.map((x) => String(x.rack_number ?? 0)))
      const rackLabel = racks.size === 1 ? (displayItems[0]?.rack_number ?? 0) : '-'

      const earliestExpiryIso = toIsoDateOnly(displayItems[0]?.expiry_date)
      const expiryLabel = earliestExpiryIso ? formatExpiry(earliestExpiryIso) : '-'

      // ✅ MRP label + show "batches" ONLY if MRP varies
      const mrpNums = displayItems.map((x) => Number(x.mrp)).filter((n) => Number.isFinite(n))

      let mrpLabel: string | number = '-'
      let hasMrpVariance = false

      if (mrpNums.length > 0) {
        const min = Math.min(...mrpNums)
        const max = Math.max(...mrpNums)
        hasMrpVariance = min !== max
        mrpLabel = min === max ? min : `${min}–${max}`
      }

      return {
        key,
        name: sorted[0]?.name,
        brand: sorted[0]?.brand,
        rackLabel,
        expiryLabel,
        mrpLabel,
        hasMrpVariance, // ✅ NEW
        totalStock,
        count: displayItems.length, // visible batch rows only
        totalBatchCount: sorted.length, // all batches
        items: sorted, // all batches (ledger)
        displayItems, // visible in table
      }
    })

    list.sort((a, b) => {
      const an = String(a.name ?? '').toLowerCase()
      const bn = String(b.name ?? '').toLowerCase()
      if (an !== bn) return an.localeCompare(bn)
      const ab = String(a.brand ?? '').toLowerCase()
      const bb = String(b.brand ?? '').toLowerCase()
      return ab.localeCompare(bb)
    })

    return list
  }, [rows])

  const mCreate = useMutation({
    mutationFn: (payload: ItemFormValues) => createItem(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory-items'] })
      qc.invalidateQueries({ queryKey: ['inventory-autocomplete'] })
      qc.invalidateQueries({ queryKey: ['dash-inventory'] })
      toast.push('Saved', 'success')
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Create failed'
      toast.push(String(msg), 'error')
    },
  })

  const mUpdate = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: ItemFormValues }) => {
      const { stock: _ignoredStock, ...safePayload } = payload
      return updateItem(id, safePayload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory-items'] })
      qc.invalidateQueries({ queryKey: ['inventory-autocomplete'] })
      qc.invalidateQueries({ queryKey: ['dash-inventory'] })
      toast.push('Item updated', 'success')
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Update failed'
      toast.push(String(msg), 'error')
    },
  })

  const mDelete = useMutation({
    mutationFn: (id: number) => deleteItem(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory-items'] })
      qc.invalidateQueries({ queryKey: ['inventory-autocomplete'] })
      qc.invalidateQueries({ queryKey: ['dash-inventory'] })
      toast.push('Batch archived', 'warning')
      setDeleteTarget(null)
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Archive failed'
      toast.push(String(msg), 'error')
    },
  })

  const mAdjust = useMutation({
    mutationFn: ({ id, delta }: { id: number; delta: number }) => adjustStock(id, delta),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory-items'] })
      qc.invalidateQueries({ queryKey: ['inventory-autocomplete'] })
      qc.invalidateQueries({ queryKey: ['dash-inventory'] })
      toast.push('Stock adjusted', 'success')
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Adjust stock failed'
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
  function openRelatedProduct(name?: string | null, brand?: string | null) {
    const params = new URLSearchParams()
    if (name) params.set('q', String(name))
    if (brand) params.set('brand', String(brand))
    navigate(`/products?${params.toString()}`)
  }

  function openStockCardForGroup(group: any) {
    const params = new URLSearchParams()
    params.set('name', String(group?.name || ''))
    if (group?.brand) params.set('brand', String(group.brand))
    params.set('tab', 'summary')
    navigate(`/inventory/stock-card?${params.toString()}`)
  }

  function openStockCardForBatch(group: any, item: any) {
    const params = new URLSearchParams()
    params.set('name', String(group?.name || ''))
    if (group?.brand) params.set('brand', String(group.brand))
    if (item?.id) params.set('batchId', String(item.id))
    params.set('tab', 'batch')
    navigate(`/inventory/stock-card?${params.toString()}`)
  }

  return (
    <Stack gap={2}>
      <Typography variant="h5">Inventory</Typography>

      <Paper
        sx={{
          p: { xs: 1.5, sm: 2 },
          borderRadius: 3,
          border: '1px solid rgba(20,92,59,0.14)',
          background: 'linear-gradient(180deg, #ffffff 0%, #f8fcfa 100%)',
        }}
      >
        <Stack direction={{ xs: 'column', md: 'row' }} gap={1.25} alignItems={{ md: 'center' }}>
          <TextField
            placeholder="Search by medicine name or brand"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            fullWidth
            size="small"
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchRoundedIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                </InputAdornment>
              ),
              endAdornment: q ? (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={() => setQ('')} edge="end">
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ) : undefined,
            }}
            sx={{
              '& .MuiOutlinedInput-root': {
                borderRadius: 2.5,
                background: '#fff',
                minHeight: 46,
              },
            }}
          />

          <TextField
            placeholder="Rack no."
            value={rackQ}
            onChange={(e) => setRackQ(e.target.value.replace(/[^\d]/g, ''))}
            type="text"
            size="small"
            inputProps={{ inputMode: 'numeric', pattern: '[0-9]*' }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <GridViewRoundedIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                </InputAdornment>
              ),
              endAdornment: rackQ ? (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={() => setRackQ('')} edge="end">
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ) : undefined,
            }}
            sx={{
              width: { xs: '100%', md: 180 },
              '& .MuiOutlinedInput-root': {
                borderRadius: 2.5,
                background: '#fff',
                minHeight: 46,
              },
            }}
          />

          <Button variant="contained" onClick={handleAdd} sx={{ minWidth: { md: 132 }, height: 46 }}>
            Add Item
          </Button>
        </Stack>

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          gap={0.75}
          justifyContent="space-between"
          alignItems={{ sm: 'center' }}
          sx={{ mt: 1.25 }}
        >
          <Typography variant="caption" color="text.secondary">
            Inventory is grouped by item (name + brand). Open Stock Card for a clean product ledger, batch ledger, and batch snapshot.
          </Typography>
          {hasFilters && (
            <Button
              size="small"
              onClick={() => {
                setQ('')
                setRackQ('')
              }}
              sx={{ alignSelf: { xs: 'flex-start', sm: 'center' } }}
            >
              Clear filters
            </Button>
          )}
        </Stack>
      </Paper>

      <Paper sx={{ p: 2 }}>
        {isLoading ? (
          <Loading />
        ) : (
          <>
            <Box
              component="div"
              sx={{
                overflowX: 'auto',
                '& .inventory-grid': {
                  borderCollapse: 'collapse',
                  minWidth: 980,
                },
                '& .inventory-grid thead th': {
                  borderBottom: '1px solid rgba(0,0,0,0.14)',
                  background: 'rgba(255,255,255,0.98)',
                },
                '& .inventory-grid tbody tr > td': {
                  background: '#fff',
                  borderBottom: '1px solid rgba(0,0,0,0.08)',
                },
                '& .inventory-grid tbody tr.parent-row > td': {
                  background: 'rgba(20,92,59,0.06)',
                  borderTop: '2px solid rgba(20,92,59,0.35)',
                  borderBottom: '1px solid rgba(20,92,59,0.20)',
                },
                '& .inventory-grid tbody tr.batch-row > td': {
                  background: 'rgba(255,255,255,0.98)',
                  borderBottom: '1px dashed rgba(20,92,59,0.22)',
                },
                '& .inventory-grid tbody tr.batch-row.out-row > td': {
                  background: 'rgba(244,67,54,0.08)',
                  borderBottom: '1px dashed rgba(211,47,47,0.32)',
                },
              }}
            >
              <table className="table inventory-grid">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Rack</th>
                    <th>Brand</th>
                    <th>Earliest Expiry</th>
                    <th>MRP</th>
                    <th>Total Stock</th>
                    <th style={{ width: 220 }}>Actions</th>
                  </tr>
                </thead>

                <tbody>
                  {groups.flatMap((g: any) => {
                    const isOut = Number(g.totalStock || 0) <= 0

                    const parentRow = (
                      <tr
                        key={g.key}
                        className="parent-row"
                        onDoubleClick={() => openStockCardForGroup(g)}
                        style={{
                          background: isOut ? 'rgba(244,67,54,0.10)' : undefined,
                          opacity: 1,
                          cursor: 'pointer',
                        }}
                      >
                        <td style={{ padding: isSm ? '10px 8px' : undefined }}>
                          <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
                            <span style={{ fontWeight: 700 }}>{g.name}</span>

                            {isOut && (
                              <Chip
                                size="small"
                                label="Out of stock"
                                variant="outlined"
                                sx={{ fontWeight: 800, borderRadius: 999 }}
                              />
                            )}

                            {/* ✅ ONLY show this chip when MRP differs across batches */}
                            {g.hasMrpVariance && (
                              <Chip
                                size="small"
                                label={`${g.count} MRPs`}
                                variant="outlined"
                                sx={{ fontWeight: 800, borderRadius: 999 }}
                              />
                            )}
                          </Stack>
                        </td>

                        <td>{g.rackLabel}</td>
                        <td>{g.brand || '-'}</td>
                        <td>{g.expiryLabel}</td>
                        <td>{g.mrpLabel}</td>

                        <td>
                          <Chip
                            size="small"
                            label={String(g.totalStock)}
                            sx={{ fontWeight: 900, borderRadius: 999 }}
                          />
                        </td>

                        <td>
                          <Stack direction="row" gap={1}>
                            <Tooltip title="Open Product Master">
                              <Button
                                size="small"
                                variant="outlined"
                                onClick={() => openRelatedProduct(g.name, g.brand)}
                                sx={{ minWidth: 0 }}
                              >
                                Product
                              </Button>
                            </Tooltip>
                            <Tooltip title="Open Stock Card">
                              <Button size="small" variant="outlined" onClick={() => openStockCardForGroup(g)}>
                                Stock Card
                              </Button>
                            </Tooltip>

                            <Tooltip title="Edit (earliest visible batch)">
                              <IconButton size="small" onClick={() => handleEdit(g.displayItems[0])}>
                                <EditIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>

                            <Tooltip title="Adjust Stock (earliest visible batch)">
                              <IconButton size="small" onClick={() => handleAdjust(g.displayItems[0])}>
                                <AddCircleOutlineIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>

                            <Tooltip title="Archive (earliest visible batch)">
                              <IconButton
                                size="small"
                                color="error"
                                onClick={() => handleDeleteClick(g.displayItems[0])}
                                disabled={mDelete.isPending}
                              >
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </Stack>
                        </td>
                      </tr>
                    )
                    const batchRows =
                      Number(g.displayItems?.length || 0) > 1
                        ? g.displayItems.map((it: any) => {
                            const batchOut = Number(it?.stock || 0) <= 0
                            return (
                              <tr
                                key={`${g.key}-batch-${it.id}`}
                                className={`batch-row${batchOut ? ' out-row' : ''}`}
                                onDoubleClick={() => openStockCardForBatch(g, it)}
                                style={{ cursor: 'pointer' }}
                              >
                                <td style={{ paddingLeft: isSm ? 8 : 24 }}>
                                  <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
                                    <span style={{ fontWeight: 600 }}>
                                      Batch #{it.id}
                                    </span>
                                    {batchOut && (
                                      <Chip size="small" label="Out of stock" variant="outlined" sx={{ borderRadius: 999 }} />
                                    )}
                                  </Stack>
                                </td>
                                <td>{it.rack_number ?? 0}</td>
                                <td>{g.brand || '-'}</td>
                                <td>{formatExpiry(it.expiry_date)}</td>
                                <td>{Number(it.mrp || 0)}</td>
                                <td>
                                  <Chip
                                    size="small"
                                    label={String(Number(it.stock || 0))}
                                    sx={{ fontWeight: 900, borderRadius: 999 }}
                                  />
                                </td>
                                <td>
                                  <Stack direction="row" gap={1}>
                                    <Tooltip title="Open Batch Stock Card">
                                      <Button size="small" variant="outlined" onClick={() => openStockCardForBatch(g, it)}>
                                        Stock Card
                                      </Button>
                                    </Tooltip>

                                    <Tooltip title="Edit this batch">
                                      <IconButton size="small" onClick={() => handleEdit(it)}>
                                        <EditIcon fontSize="small" />
                                      </IconButton>
                                    </Tooltip>

                                    <Tooltip title="Adjust stock">
                                      <IconButton size="small" onClick={() => handleAdjust(it)}>
                                        <AddCircleOutlineIcon fontSize="small" />
                                      </IconButton>
                                    </Tooltip>

                                    <Tooltip title="Archive this batch">
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
                            )
                          })
                        : []

                    return [parentRow, ...batchRows]
                  })}
                </tbody>
              </table>
            </Box>

            {!isFetching && rows.length === 0 && (
              <Box sx={{ py: 3, textAlign: 'center' }}>
                <Typography variant="body2" color="text.secondary">
                  No items found.
                </Typography>
              </Box>
            )}
            <Box ref={loadMoreRef} sx={{ height: 1 }} />
            {isFetchingNextPage && (
              <Typography variant="body2" color="text.secondary" sx={{ pt: 1, textAlign: 'center' }}>
                Loading more...
              </Typography>
            )}
          </>
        )}
      </Paper>

      <ItemForm
        open={openForm}
        initial={editing}
        items={rows}
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
      <Dialog open={Boolean(deleteTarget)} onClose={handleCancelDelete} maxWidth="xs" fullWidth>
        <DialogTitle>Archive Batch</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2">
            {deleteTarget
              ? `Archive batch "${deleteTarget.name}"? Only zero-stock batches can be archived, and the stock history is preserved.`
              : ''}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCancelDelete}>Cancel</Button>
          <Button onClick={handleConfirmDelete} color="warning" variant="contained" disabled={mDelete.isPending}>
            Archive
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
