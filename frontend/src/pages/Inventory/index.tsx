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
  Divider,
  MenuItem,
} from '@mui/material'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQueryClient, useMutation } from '@tanstack/react-query'

import {
  listItemsPage,
  createItem,
  updateItem,
  deleteItem,
  adjustStock,
  getItemLedger,
} from '../../services/inventory'

import Loading from '../../components/ui/Loading'
import ItemForm from './ItemForm'
import type { ItemFormValues } from './ItemForm'
import EditIcon from '@mui/icons-material/Edit'
import DeleteIcon from '@mui/icons-material/Delete'
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
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

// ✅ tiny helper for default dates + CSV
function pad2(n: number) {
  return n < 10 ? `0${n}` : String(n)
}
function toISODate(d: Date) {
  const y = d.getFullYear()
  const m = pad2(d.getMonth() + 1)
  const day = pad2(d.getDate())
  return `${y}-${m}-${day}`
}
function toCSV(rows: string[][]) {
  return rows
    .map((r) =>
      r
        .map((cell) => {
          const s = String(cell ?? '')
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        })
        .join(',')
    )
    .join('\n')
}

export default function Inventory() {
  const toast = useToast()
  const isSm = useMediaQuery('(max-width:900px)')
  const isXs = useMediaQuery('(max-width:600px)')

  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('') // ✅ debounce search input
  const [rackQ, setRackQ] = useState('')
  const [debouncedRackQ, setDebouncedRackQ] = useState('')

  const [openForm, setOpenForm] = useState(false)
  const [editing, setEditing] = useState<any | null>(null)
  const [adjustId, setAdjustId] = useState<number | null>(null)
  const [adjustName, setAdjustName] = useState<string>('')

  // which item is pending delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null)
  // ✅ LEDGER DIALOG STATE (GROUP-BASED)
  const [ledgerOpen, setLedgerOpen] = useState(false)

  // group context (name+brand)
  const [ledgerGroup, setLedgerGroup] = useState<null | {
    key: string
    name: string
    brand: string
    items: any[]
    totalStock: number
    expiryLabel: string
    rackLabel: string | number
    mrpLabel: string | number
  }>(null)

  // selected batch inside that group
  const [ledgerItem, setLedgerItem] = useState<any | null>(null)

  const [ledgerFrom, setLedgerFrom] = useState('')
  const [ledgerTo, setLedgerTo] = useState('')
  const [ledgerReason, setLedgerReason] = useState<string>('') // empty = all
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

      const racks = new Set(sorted.map((x) => String(x.rack_number ?? 0)))
      const rackLabel = racks.size === 1 ? (sorted[0]?.rack_number ?? 0) : '-'

      const earliestExpiryIso = toIsoDateOnly(sorted[0]?.expiry_date)
      const expiryLabel = earliestExpiryIso ? formatExpiry(earliestExpiryIso) : '-'

      // ✅ MRP label + show "batches" ONLY if MRP varies
      const mrpNums = sorted.map((x) => Number(x.mrp)).filter((n) => Number.isFinite(n))

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
        count: sorted.length,
        items: sorted, // batches, including 0 stock
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
    mutationFn: ({ id, payload }: { id: number; payload: ItemFormValues }) => updateItem(id, payload),
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
      toast.push('Item deleted', 'warning')
      setDeleteTarget(null)
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Delete failed'
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

  // ✅ Open ledger dialog for GROUP (name+brand), then user can pick expiry batch inside
  function openLedgerForGroup(g: any) {
    const now = new Date()
    const past = new Date()
    past.setDate(now.getDate() - 30)

    setLedgerGroup(g)
    setLedgerItem(g?.items?.[0] ?? null) // default: earliest expiry batch
    setLedgerFrom(toISODate(past))
    setLedgerTo(toISODate(now))
    setLedgerReason('')
    setLedgerOpen(true)
  }
  function openLedgerForBatch(g: any, item: any) {
    const now = new Date()
    const past = new Date()
    past.setDate(now.getDate() - 30)

    setLedgerGroup(g)
    setLedgerItem(item ?? g?.items?.[0] ?? null)
    setLedgerFrom(toISODate(past))
    setLedgerTo(toISODate(now))
    setLedgerReason('')
    setLedgerOpen(true)
  }

  const LEDGER_LIMIT = 50

  const qLedger = useInfiniteQuery({
    queryKey: ['inventory-ledger', ledgerItem?.id, ledgerFrom, ledgerTo, ledgerReason],
    enabled: ledgerOpen && !!ledgerItem?.id && !!ledgerFrom && !!ledgerTo,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      return await getItemLedger({
        item_id: Number(ledgerItem.id),
        from_date: ledgerFrom,
        to_date: ledgerTo,
        reason: ledgerReason ? ledgerReason : undefined,
        limit: LEDGER_LIMIT,
        offset: pageParam,
      })
    },
    getNextPageParam: (lastPage: any) => lastPage?.next_offset ?? undefined,
  })

  const ledgerRows = useMemo(() => {
    const pages: any[] = ((qLedger.data as any)?.pages ?? []) as any[]
    const out: any[] = []
    for (const p of pages) if (p && Array.isArray(p.items)) out.push(...p.items)
    return out
  }, [qLedger.data])

  const ledgerDetail = useMemo(() => {
    return ledgerRows.map((m: any) => ({
      id: m.id,
      ts: m.ts,
      delta: Number(m.delta || 0),
      reason: m.reason || '',
      ref_type: m.ref_type || '',
      ref_id: m.ref_id ?? '',
      note: m.note || '',
      before: Number(m.balance_before ?? 0),
      after: Number(m.balance_after ?? 0),
    }))
  }, [ledgerRows])

  const ledgerCurrentStock = qLedger.data?.pages?.[0]?.current_stock ?? ledgerItem?.stock ?? '-'

  function exportLedgerCSV() {
    const header = ['ID', 'TS', 'Delta', 'Reason', 'Ref Type', 'Ref ID', 'Before', 'After', 'Note']
    const body = ledgerDetail.map((r: any) => [
      String(r.id),
      String(r.ts),
      String(r.delta),
      String(r.reason),
      String(r.ref_type ?? ''),
      String(r.ref_id ?? ''),
      String(r.before ?? ''),
      String(r.after ?? ''),
      String(r.note ?? ''),
    ])

    const csv = toCSV([header, ...body])
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `stock-ledger_item-${ledgerItem?.id ?? 'item'}_${ledgerFrom}_to_${ledgerTo}.csv`
    a.click()
    URL.revokeObjectURL(url)
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
            Inventory is grouped by item (name + brand). Batch rows below show each MRP/expiry for direct editing.
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
                        style={{
                          background: isOut ? '#fafafa' : undefined,
                          opacity: isOut ? 0.75 : 1,
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
                            <Tooltip title="Ledger (batch-wise expiry)">
                              <IconButton
                                size="small"
                                onClick={() => openLedgerForGroup(g)}
                                sx={{
                                  border: '1px solid',
                                  borderColor: 'divider',
                                  borderRadius: 2,
                                }}
                              >
                                <ReceiptLongIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>

                            <Tooltip title="Edit (earliest batch)">
                              <IconButton size="small" onClick={() => handleEdit(g.items[0])}>
                                <EditIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>

                            <Tooltip title="Adjust Stock (pick batch in Ledger)">
                              <IconButton size="small" onClick={() => openLedgerForGroup(g)}>
                                <AddCircleOutlineIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>

                            <Tooltip title="Delete (earliest batch)">
                              <IconButton
                                size="small"
                                color="error"
                                onClick={() => handleDeleteClick(g.items[0])}
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
                      Number(g.count || 0) > 1
                        ? g.items.map((it: any) => {
                            const batchOut = Number(it?.stock || 0) <= 0
                            return (
                              <tr
                                key={`${g.key}-batch-${it.id}`}
                                className={`batch-row${batchOut ? ' out-row' : ''}`}
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
                                    <Tooltip title="Ledger (this batch)">
                                      <IconButton
                                        size="small"
                                        onClick={() => openLedgerForBatch(g, it)}
                                        sx={{
                                          border: '1px solid',
                                          borderColor: 'divider',
                                          borderRadius: 2,
                                        }}
                                      >
                                        <ReceiptLongIcon fontSize="small" />
                                      </IconButton>
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

                                    <Tooltip title="Delete this batch">
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
        <DialogTitle>Delete Item</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2">
            {deleteTarget ? `Delete item "${deleteTarget.name}"? This action cannot be undone.` : ''}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCancelDelete}>Cancel</Button>
          <Button onClick={handleConfirmDelete} color="error" variant="contained" disabled={mDelete.isPending}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* ✅ GROUP LEDGER DIALOG (batch selector + ledger) */}
      <Dialog
        open={ledgerOpen}
        onClose={() => setLedgerOpen(false)}
        fullWidth
        maxWidth="lg"
        fullScreen={isXs}
      >
        <DialogTitle
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2,
          }}
        >
          <Stack spacing={0.3} sx={{ minWidth: 0 }}>
            <Typography variant="h6" sx={{ fontWeight: 900, lineHeight: 1.1 }} noWrap>
              Stock Ledger
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              {ledgerGroup ? `${ledgerGroup.name} (${ledgerGroup.brand || '-'})` : ''}
            </Typography>
          </Stack>

          <IconButton onClick={() => setLedgerOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>

        <DialogContent dividers>
          <Stack gap={2}>
            <Paper
              variant="outlined"
              sx={{
                p: 1.5,
                borderRadius: 2,
                background: '#fbfffd',
              }}
            >
              <Stack gap={1.25}>
                <Stack
                  direction={{ xs: 'column', md: 'row' }}
                  gap={1.25}
                  alignItems={{ md: 'center' }}
                  justifyContent="space-between"
                >
                  <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
                    <Chip
                      label={`Total Stock: ${String(ledgerGroup?.totalStock ?? '-')}`}
                      sx={{ fontWeight: 900, borderRadius: 999 }}
                    />
                    <Chip
                      label={`Selected Batch Stock: ${String(ledgerCurrentStock)}`}
                      variant="outlined"
                      sx={{ fontWeight: 900, borderRadius: 999 }}
                    />
                    {ledgerItem?.expiry_date && (
                      <Chip
                        label={`Exp: ${formatExpiry(ledgerItem.expiry_date)}`}
                        variant="outlined"
                        sx={{ fontWeight: 800, borderRadius: 999 }}
                      />
                    )}
                    {ledgerItem?.mrp != null && (
                      <Chip
                        label={`MRP: ${ledgerItem.mrp}`}
                        variant="outlined"
                        sx={{ fontWeight: 800, borderRadius: 999 }}
                      />
                    )}
                    {ledgerItem?.id != null && (
                      <Chip
                        label={`Batch ID: #${ledgerItem.id}`}
                        variant="outlined"
                        sx={{ fontWeight: 800, borderRadius: 999 }}
                      />
                    )}
                  </Stack>

                  <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.2} alignItems={{ sm: 'center' }}>
                    <TextField
                      label="From"
                      type="date"
                      value={ledgerFrom}
                      onChange={(e) => setLedgerFrom(e.target.value)}
                      InputLabelProps={{ shrink: true }}
                      size="small"
                      sx={{ width: 165 }}
                    />
                    <TextField
                      label="To"
                      type="date"
                      value={ledgerTo}
                      onChange={(e) => setLedgerTo(e.target.value)}
                      InputLabelProps={{ shrink: true }}
                      size="small"
                      sx={{ width: 165 }}
                    />
                    <TextField
                      select
                      label="Reason"
                      value={ledgerReason}
                      onChange={(e) => setLedgerReason(e.target.value)}
                      size="small"
                      sx={{ width: 170 }}
                    >
                      <MenuItem value="">All</MenuItem>
                      <MenuItem value="OPENING">OPENING</MenuItem>
                      <MenuItem value="ADJUST">ADJUST</MenuItem>
                      <MenuItem value="BILL">BILL</MenuItem>
                      <MenuItem value="RETURN">RETURN</MenuItem>
                      <MenuItem value="EXCHANGE_IN">EXCHANGE_IN</MenuItem>
                      <MenuItem value="EXCHANGE_OUT">EXCHANGE_OUT</MenuItem>
                    </TextField>

                    <Button
                      variant="contained"
                      onClick={exportLedgerCSV}
                      disabled={ledgerDetail.length === 0}
                      sx={{ fontWeight: 900, borderRadius: 999, px: 2 }}
                    >
                      Export CSV
                    </Button>
                  </Stack>
                </Stack>

                <Divider />

                <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
                  <Typography variant="body2" sx={{ fontWeight: 900, mr: 0.5 }}>
                    Batches:
                  </Typography>

                  {(ledgerGroup?.items ?? []).map((it: any) => {
                    const stock = Number(it?.stock ?? 0)
                    const selected = ledgerItem?.id === it.id
                    const label = `${formatExpiry(it.expiry_date)} • Stock ${stock}`
                    return (
                      <Chip
                        key={`b-${it.id}`}
                        label={label}
                        clickable
                        onClick={() => setLedgerItem(it)}
                        color={selected ? 'primary' : undefined}
                        variant={selected ? 'filled' : 'outlined'}
                        sx={{
                          fontWeight: 900,
                          borderRadius: 999,
                          opacity: stock <= 0 ? 0.7 : 1,
                        }}
                      />
                    )
                  })}
                </Stack>
              </Stack>
            </Paper>

            <Box sx={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>TS</th>
                    <th>Delta</th>
                    <th>Reason</th>
                    <th>Ref</th>
                    <th>Before</th>
                    <th>After</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {qLedger.isLoading && (
                    <tr>
                      <td colSpan={8}>
                        <Box p={2} color="text.secondary">
                          Loading…
                        </Box>
                      </td>
                    </tr>
                  )}

                  {!qLedger.isLoading && ledgerDetail.length === 0 && (
                    <tr>
                      <td colSpan={8}>
                        <Box p={2} color="text.secondary">
                          No ledger rows for this date range.
                        </Box>
                      </td>
                    </tr>
                  )}

                  {ledgerDetail.map((r: any) => (
                    <tr key={`lg-${r.id}`}>
                      <td>{r.id}</td>
                      <td>{r.ts}</td>
                      <td style={{ fontWeight: 900 }}>{r.delta}</td>
                      <td>{r.reason}</td>
                      <td>{r.ref_type ? `${r.ref_type}${r.ref_id ? ` #${r.ref_id}` : ''}` : '-'}</td>
                      <td>{r.before}</td>
                      <td>{r.after}</td>
                      <td>{r.note || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Box>

            {qLedger.isError && (
              <Box sx={{ py: 2, textAlign: 'center' }}>
                <Typography variant="body2" color="error">
                  Failed to load ledger.
                </Typography>
              </Box>
            )}
          </Stack>
        </DialogContent>

        <DialogActions sx={{ justifyContent: 'space-between' }}>
          <Button onClick={() => setLedgerOpen(false)} variant="outlined">
            Close
          </Button>

          <Stack direction="row" gap={1} alignItems="center">
            <Typography variant="body2" color="text.secondary">
              Rows: {ledgerDetail.length}
            </Typography>

            <Button
              variant="contained"
              onClick={() => qLedger.fetchNextPage()}
              disabled={!qLedger.hasNextPage || qLedger.isFetchingNextPage}
              sx={{ fontWeight: 900, borderRadius: 999, px: 2 }}
            >
              {qLedger.isFetchingNextPage ? 'Loading…' : qLedger.hasNextPage ? 'Load more' : 'No more'}
            </Button>
          </Stack>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
