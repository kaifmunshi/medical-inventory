// frontend/src/pages/Reports/StockLedgerReport.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
  Dialog,
  DialogTitle,
  DialogContent,
  Tooltip,
  Skeleton,
  FormControlLabel,
  Switch,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import SearchIcon from '@mui/icons-material/Search'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTheme } from '@mui/material/styles'

import {
  applyStockLedgerReconciliation,
  getGroupLedger,
  getStockLedgerReconciliation,
  listItemsPage,
} from '../../services/inventory'
import { useToast } from '../../components/ui/Toaster'
import { formatLedgerNote } from '../../lib/stockLedger'

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

function formatExpiry(exp?: string | null) {
  if (!exp) return '-'
  const s = String(exp)
  const iso = s.length > 10 ? s.slice(0, 10) : s
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${d}-${m}-${y}`
}

function toIsoDateOnly(exp?: string | null) {
  if (!exp) return ''
  const s = String(exp)
  return s.length > 10 ? s.slice(0, 10) : s
}

function formatSigned(value: number) {
  return `${value > 0 ? '+' : ''}${value}`
}

function groupKey(it: any) {
  const name = String(it?.name ?? '').trim().toLowerCase()
  const brand = String(it?.brand ?? '').trim().toLowerCase()
  return `${name}__${brand}`
}

type GroupRow = {
  key: string
  name: string
  brand: string
  totalStock: number
  count: number // ✅ only non-zero batches count
  batches: any[] // ✅ all batches
  nonZeroBatches: any[] // ✅ stock > 0 batches
  earliestExpiry: string
}

export default function StockLedgerReport(props: {
  from: string
  to: string
  initialSearch?: string
  initialReason?: string
  focusName?: string
  focusBrand?: string
  autoOpenLedger?: boolean
  autoOpenReconcile?: boolean
  setExportFn: (fn: () => void) => void
  setExportDisabled: (v: boolean) => void
  setExtraControls: (node: React.ReactNode) => void
}) {
  const {
    from,
    to,
    initialSearch,
    initialReason,
    focusName,
    focusBrand,
    autoOpenLedger,
    autoOpenReconcile,
    setExportFn,
    setExportDisabled,
    setExtraControls,
  } = props

  const LIMIT = 30
  const theme = useTheme()
  const isMobile = useMediaQuery(theme.breakpoints.down('md'))
  const toast = useToast()
  const queryClient = useQueryClient()

  // list search
  const [itemSearch, setItemSearch] = useState('')
  const [debouncedItemSearch, setDebouncedItemSearch] = useState('')

  // ✅ hide out-of-stock groups by default
  const [showOutOfStock, setShowOutOfStock] = useState(false)

  // selected group
  const [pickedGroup, setPickedGroup] = useState<GroupRow | null>(null)

  // ledger filters
  const [ledgerReason, setLedgerReason] = useState<string>('') // empty = all
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [reconOpen, setReconOpen] = useState(false)
  const [reconShowBalanced, setReconShowBalanced] = useState(false)

  const listRef = useRef<HTMLDivElement | null>(null)
  const autoOpenedLedgerKeyRef = useRef('')

  useEffect(() => {
    const t = setTimeout(() => setDebouncedItemSearch(itemSearch.trim()), 250)
    return () => clearTimeout(t)
  }, [itemSearch])

  useEffect(() => {
    const nextSearch = String(initialSearch || '').trim()
    setItemSearch(nextSearch)
    setDebouncedItemSearch(nextSearch)
  }, [initialSearch])

  useEffect(() => {
    setLedgerReason(String(initialReason || '').trim())
  }, [initialReason])

  useEffect(() => {
    if (autoOpenReconcile) setReconOpen(true)
  }, [autoOpenReconcile])

  // ✅ Items list
  const qItems = useInfiniteQuery({
    queryKey: ['rpt-stock-items-page', debouncedItemSearch],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      return await listItemsPage(debouncedItemSearch, LIMIT, pageParam)
    },
    getNextPageParam: (lastPage: any) => lastPage?.next_offset ?? undefined,
  })

  const itemRows = useMemo(() => {
    const pages: any[] = ((qItems.data as any)?.pages ?? []) as any[]
    const rows: any[] = []
    for (const p of pages) if (p && Array.isArray(p.items)) rows.push(...p.items)
    return rows
  }, [qItems.data])

  // ✅ Group items by (name+brand)
  const groupedAll = useMemo<GroupRow[]>(() => {
    const map = new Map<string, GroupRow>()

    for (const it of itemRows) {
      const key = groupKey(it)
      const name = String(it?.name ?? '')
      const brand = String(it?.brand ?? '')
      const stock = Number(it?.stock ?? 0)
      const expIso = toIsoDateOnly(it?.expiry_date)

      const existing = map.get(key)
      if (!existing) {
        map.set(key, {
          key,
          name,
          brand,
          totalStock: stock,
          count: stock > 0 ? 1 : 0,
          batches: [it],
          nonZeroBatches: stock > 0 ? [it] : [],
          earliestExpiry: expIso || '',
        })
      } else {
        existing.totalStock += stock
        existing.batches.push(it)

        if (stock > 0) {
          existing.count += 1
          existing.nonZeroBatches.push(it)
        }

        if (!existing.earliestExpiry) existing.earliestExpiry = expIso || ''
        else if (expIso && expIso < existing.earliestExpiry) existing.earliestExpiry = expIso
      }
    }

    const sortByExp = (a: any, b: any) => {
      const da = toIsoDateOnly(a?.expiry_date)
      const db = toIsoDateOnly(b?.expiry_date)
      if (!da && !db) return 0
      if (!da) return 1
      if (!db) return -1
      return da.localeCompare(db)
    }

    const list = Array.from(map.values()).map((g) => ({
      ...g,
      batches: [...g.batches].sort(sortByExp),
      nonZeroBatches: [...g.nonZeroBatches].sort(sortByExp),
    }))

    list.sort((a, b) => {
      const an = a.name.toLowerCase()
      const bn = b.name.toLowerCase()
      if (an !== bn) return an.localeCompare(bn)
      return a.brand.toLowerCase().localeCompare(b.brand.toLowerCase())
    })

    return list
  }, [itemRows])

  const outCount = useMemo(
    () => groupedAll.filter((g) => Number(g.totalStock || 0) <= 0).length,
    [groupedAll]
  )

  const grouped = useMemo(() => {
    if (showOutOfStock) return groupedAll
    return groupedAll.filter((g) => Number(g.totalStock || 0) > 0)
  }, [groupedAll, showOutOfStock])

  useEffect(() => {
    if (!autoOpenLedger || !focusName) return
    const focusNameKey = focusName.trim().toLowerCase()
    const focusBrandKey = String(focusBrand || '').trim().toLowerCase()
    const match = groupedAll.find(
      (group) =>
        group.name.trim().toLowerCase() === focusNameKey &&
        group.brand.trim().toLowerCase() === focusBrandKey,
    )
    if (!match) return
    if (autoOpenedLedgerKeyRef.current === match.key) return

    autoOpenedLedgerKeyRef.current = match.key
    setPickedGroup((prev) => (prev?.key === match.key ? prev : match))
    setLedgerOpen(true)
  }, [autoOpenLedger, focusBrand, focusName, groupedAll])

  // ✅ Ledger query (GROUP)
  const qLedger = useInfiniteQuery({
    queryKey: ['rpt-stock-ledger-group', pickedGroup?.key, from, to, ledgerReason],
    enabled: !!pickedGroup?.key && ledgerOpen,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      if (!pickedGroup) throw new Error('No group')
      return await getGroupLedger({
        name: pickedGroup.name,
        brand: pickedGroup.brand ?? '',
        from_date: from,
        to_date: to,
        reason: ledgerReason ? ledgerReason : undefined,
        limit: LIMIT,
        offset: pageParam,
      })
    },
    getNextPageParam: (lastPage: any) => lastPage?.next_offset ?? undefined,
  })

  const ledgerRaw = useMemo(() => {
    const pages: any[] = ((qLedger.data as any)?.pages ?? []) as any[]
    const rows: any[] = []
    for (const p of pages) if (p && Array.isArray(p.items)) rows.push(...p.items)
    return rows
  }, [qLedger.data])

  const detailRows = useMemo(() => {
    return ledgerRaw.map((m: any) => ({
      id: m.id,
      ts: m.ts,
      delta: Number(m.delta || 0),
      reason: m.reason || '',
      ref_type: m.ref_type || '',
      ref_id: m.ref_id ?? '',
      note: m.note || '',
      before: Number(m.balance_before ?? 0),
      after: Number(m.balance_after ?? 0),

      item_id: m.item_id,
      expiry_date: m.expiry_date ?? null,
      mrp: m.mrp ?? null,
      rack_number: m.rack_number ?? null,
    }))
  }, [ledgerRaw])

  const reconQ = useQuery({
    queryKey: ['stock-ledger-reconciliation', debouncedItemSearch, reconShowBalanced],
    queryFn: () =>
      getStockLedgerReconciliation({
        q: debouncedItemSearch || undefined,
        include_archived: true,
        include_balanced: reconShowBalanced,
        limit: 200,
        offset: 0,
      }),
    enabled: reconOpen,
  })

  const applyReconM = useMutation({
    mutationFn: ({ applySynthetic }: { applySynthetic: boolean }) =>
      applyStockLedgerReconciliation({
        q: debouncedItemSearch || undefined,
        include_archived: true,
        include_balanced: reconShowBalanced,
        apply_synthetic: applySynthetic,
      }),
    onSuccess: (res, vars) => {
      toast.push(
        vars.applySynthetic
          ? `Repaired ${res.applied_items} item rows. Added ${res.deterministic_rows_inserted} source backfills and ${res.synthetic_rows_inserted} reconciliation rows.`
          : `Added ${res.deterministic_rows_inserted} deterministic source backfills.`,
        'success',
      )
      queryClient.invalidateQueries({ queryKey: ['stock-ledger-reconciliation'] })
      queryClient.invalidateQueries({ queryKey: ['rpt-stock-ledger-group'] })
      queryClient.invalidateQueries({ queryKey: ['rpt-stock-items-page'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-ledger-group'] })
    },
    onError: (err: any) => {
      toast.push(String(err?.response?.data?.detail || err?.message || 'Failed to apply reconciliation'), 'error')
    },
  })

  // ✅ Header controls (Reports top bar)
  useEffect(() => {
    setExtraControls(
      <>
        <FormControlLabel
          sx={{ ml: 0, userSelect: 'none' }}
          control={<Switch checked={showOutOfStock} onChange={(e) => setShowOutOfStock(e.target.checked)} />}
          label={
            <Stack direction="row" gap={1} alignItems="center">
              <span>Show out-of-stock</span>
              <Chip size="small" label={`${outCount}`} variant="outlined" sx={{ borderRadius: 999, fontWeight: 900 }} />
            </Stack>
          }
        />

        <TextField
          select
          label="Reason"
          value={ledgerReason}
          onChange={(e) => setLedgerReason(e.target.value)}
          sx={{ width: 180 }}
        >
          <MenuItem value="">All</MenuItem>

          {/* ✅ include these two so user can filter properly */}
          <MenuItem value="PURCHASE">PURCHASE</MenuItem>
          <MenuItem value="PURCHASE_CANCEL">PURCHASE_CANCEL</MenuItem>
          <MenuItem value="SALE">SALE</MenuItem>

          <MenuItem value="OPENING">OPENING</MenuItem>
          <MenuItem value="ADJUST">ADJUST</MenuItem>
          <MenuItem value="BILL">BILL</MenuItem>
          <MenuItem value="BILL_DELETE">BILL_DELETE</MenuItem>
          <MenuItem value="BILL_RECOVER">BILL_RECOVER</MenuItem>
          <MenuItem value="RETURN">RETURN</MenuItem>
          <MenuItem value="EXCHANGE_IN">EXCHANGE_IN</MenuItem>
          <MenuItem value="EXCHANGE_OUT">EXCHANGE_OUT</MenuItem>
          <MenuItem value="PACK_OPEN_IN">PACK_OPEN_IN</MenuItem>
          <MenuItem value="PACK_OPEN_OUT">PACK_OPEN_OUT</MenuItem>
          <MenuItem value="RECON_ADJUST">RECON_ADJUST</MenuItem>
        </TextField>

        <Button
          variant={reconOpen ? 'contained' : 'outlined'}
          color="warning"
          onClick={() => setReconOpen(true)}
          sx={{ borderRadius: 999, fontWeight: 900 }}
        >
          Reconcile Ledger
          {reconQ.data?.mismatched_rows ? ` (${reconQ.data.mismatched_rows})` : ''}
        </Button>

        {reconOpen && (
          <Button variant="outlined" onClick={() => setReconOpen(false)} sx={{ borderRadius: 999, fontWeight: 900 }}>
            Close Reconcile
          </Button>
        )}

        {ledgerOpen && (
          <Button variant="outlined" onClick={() => setLedgerOpen(false)} sx={{ borderRadius: 999, fontWeight: 900 }}>
            Close
          </Button>
        )}
      </>
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerReason, ledgerOpen, outCount, reconOpen, reconQ.data?.mismatched_rows, showOutOfStock])

  // ✅ Export (include batch details)
  useEffect(() => {
    setExportDisabled(!(ledgerOpen && pickedGroup?.key && detailRows.length > 0))
    setExportFn(() => () => {
      if (!pickedGroup?.key) return
      const header = [
        'ID',
        'TS',
        'Delta',
        'Reason',
        'Batch Item ID',
        'Expiry',
        'MRP',
        'Rack',
        'Ref Type',
        'Ref ID',
        'Before',
        'After',
        'Note',
      ]
      const body = detailRows.map((r: any) => [
        String(r.id),
        String(r.ts),
        String(r.delta),
        String(displayReason(r)), // ✅ export the corrected label
        String(r.item_id ?? ''),
        String(r.expiry_date ?? ''),
        String(r.mrp ?? ''),
        String(r.rack_number ?? ''),
        String(r.ref_type ?? ''),
        String(r.ref_id ?? ''),
        String(r.before ?? ''),
        String(r.after ?? ''),
        String(formatLedgerNote(r.note) || ''),
      ])
      const csv = toCSV([header, ...body])
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `stock-ledger_${pickedGroup.name}_${pickedGroup.brand || 'no-brand'}_${from}_to_${to}.csv`
      a.click()
      URL.revokeObjectURL(url)
    })
  }, [
    setExportDisabled,
    setExportFn,
    detailRows,
    pickedGroup?.key,
    pickedGroup?.name,
    pickedGroup?.brand,
    from,
    to,
    ledgerOpen,
  ])

  const currentStock = qLedger.data?.pages?.[0]?.current_stock ?? pickedGroup?.totalStock ?? '-'
  const reconRows = reconQ.data?.items ?? []
  const reconSafeCount = reconQ.data?.deterministic_rows ?? 0
  const reconSyntheticCount = reconQ.data?.synthetic_rows ?? 0
  const reconBlockedCount = reconRows.reduce(
    (sum, row) => sum + row.missing_entries.filter((entry) => !entry.safe_to_apply && entry.missing_delta !== 0).length,
    0,
  )

  const deltaChip = (delta: number) => {
    const isPos = delta > 0
    const isNeg = delta < 0
    const label = `${delta > 0 ? '+' : ''}${delta}`
    return (
      <Chip
        size="small"
        label={label}
        sx={{
          fontWeight: 900,
          borderRadius: 999,
          ...(isPos
            ? { bgcolor: 'rgba(46,125,50,0.14)', color: 'success.main' }
            : isNeg
              ? { bgcolor: 'rgba(211,47,47,0.14)', color: 'error.main' }
              : { bgcolor: 'rgba(0,0,0,0.08)' }),
        }}
      />
    )
  }

  const reasonChip = (reason: string) => (
    <Chip size="small" label={reason || '-'} variant="outlined" sx={{ borderRadius: 999, fontWeight: 800 }} />
  )

  const statusChip = (status: string) => {
    const palette =
      status === 'BALANCED'
        ? { bgcolor: 'rgba(46,125,50,0.14)', color: 'success.main' }
        : status === 'DETERMINISTIC_ONLY'
          ? { bgcolor: 'rgba(25,118,210,0.12)', color: 'primary.main' }
          : status === 'RECON_ONLY'
            ? { bgcolor: 'rgba(211,47,47,0.14)', color: 'error.main' }
            : { bgcolor: 'rgba(237,108,2,0.14)', color: 'warning.dark' }
    return <Chip size="small" label={status} sx={{ borderRadius: 999, fontWeight: 900, ...palette }} />
  }

  function displayReason(r: any) {
    // Show exact backend reason to avoid hiding real ledger events.
    return r?.reason || ''
  }

  function openLedgerForGroup(g: GroupRow) {
    setPickedGroup(g)
    setLedgerOpen(true)
  }

  // ✅ Auto-load list
  const maybeLoadMore = () => {
    if (!qItems.hasNextPage) return
    if (qItems.isFetchingNextPage) return
    const el = listRef.current
    if (!el) return
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 220
    if (nearBottom) qItems.fetchNextPage()
  }

  // ✅ Only non-zero batches for the picked group (used in ledger header chips)
  const nonZeroBatches = useMemo(() => {
    return (pickedGroup?.nonZeroBatches ?? []).filter((b: any) => Number(b?.stock ?? 0) > 0)
  }, [pickedGroup])

  const LedgerCard = (
    <Paper
      elevation={0}
      sx={{
        borderRadius: 3,
        border: '1px solid',
        borderColor: 'divider',
        overflow: 'hidden',
      }}
    >
      <Box sx={{ p: 2, pb: 1.5 }}>
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={1.5}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h6" sx={{ fontWeight: 950, lineHeight: 1.15 }} noWrap>
              {pickedGroup?.name ?? 'Ledger'}
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              Brand: {pickedGroup?.brand || '-'} • Batches: {pickedGroup?.count ?? 0}
            </Typography>
          </Box>

          <Stack direction="row" gap={1} alignItems="center">
            <Chip label={`Current Stock: ${String(currentStock)}`} sx={{ fontWeight: 950, borderRadius: 999 }} />
            <IconButton onClick={() => setLedgerOpen(false)} size="small">
              <CloseIcon />
            </IconButton>
          </Stack>
        </Stack>

        {/* ✅ Show batch chips (ONLY stock>0) */}
        {nonZeroBatches.length > 0 && (
          <Box mt={1.25}>
            <Stack direction="row" gap={1} flexWrap="wrap">
              {nonZeroBatches.slice(0, 8).map((b: any) => (
                <Chip
                  key={b.id}
                  size="small"
                  variant="outlined"
                  sx={{ borderRadius: 999 }}
                  label={`#${b.id} • Exp ${formatExpiry(b.expiry_date)} • MRP ${b.mrp} • Stock ${b.stock}`}
                />
              ))}
              {nonZeroBatches.length > 8 && (
                <Chip size="small" sx={{ borderRadius: 999 }} label={`+${nonZeroBatches.length - 8} more`} />
              )}
            </Stack>
          </Box>
        )}
      </Box>

      <Divider />

      <Box sx={{ p: 2 }}>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>TS</th>
                <th>Delta</th>
                <th>Reason</th>
                <th>Batch</th>
                <th>Ref</th>
                <th>Before</th>
                <th>After</th>
                <th>Note</th>
              </tr>
            </thead>

            <tbody>
              {qLedger.isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={`sk-${i}`}>
                    <td colSpan={9}>
                      <Box py={0.75}>
                        <Skeleton variant="rounded" height={32} />
                      </Box>
                    </td>
                  </tr>
                ))
              ) : detailRows.length === 0 ? (
                <tr>
                  <td colSpan={9}>
                    <Box p={2} color="text.secondary">
                      No ledger rows for this date range.
                    </Box>
                  </td>
                </tr>
              ) : (
                detailRows.map((r: any) => (
                  <tr key={`m-${r.id}`}>
                    <td>{r.id}</td>
                    <td>{r.ts}</td>
                    <td>{deltaChip(r.delta)}</td>
                    <td>{reasonChip(displayReason(r))}</td>

                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontWeight: 800 }}>#{r.item_id}</span>
                        <span style={{ fontSize: 12, opacity: 0.8 }}>
                          Exp: {formatExpiry(r.expiry_date)} • MRP: {r.mrp ?? '-'} • Rack: {r.rack_number ?? '-'}
                        </span>
                      </div>
                    </td>

                    <td>{r.ref_type ? `${r.ref_type}${r.ref_id ? ` #${r.ref_id}` : ''}` : '-'}</td>
                    <td>{r.before}</td>
                    <td>{r.after}</td>
                    <td>
                      {r.note ? (
                        <Tooltip title={formatLedgerNote(r.note)}>
                          <span style={{ cursor: 'help' }}>
                            {(() => {
                              const note = formatLedgerNote(r.note)
                              return note.length > 26 ? `${note.slice(0, 26)}…` : note
                            })()}
                          </span>
                        </Tooltip>
                      ) : (
                        '-'
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Box>

        {qLedger.isError && (
          <Box sx={{ pt: 1.5, textAlign: 'center' }}>
            <Typography variant="body2" color="error">
              Failed to load ledger.
            </Typography>
          </Box>
        )}

        {qLedger.hasNextPage && (
          <Box mt={2} textAlign="center">
            <Button
              variant="outlined"
              onClick={() => qLedger.fetchNextPage()}
              disabled={qLedger.isFetchingNextPage}
              sx={{ borderRadius: 999, fontWeight: 950, px: 3 }}
            >
              {qLedger.isFetchingNextPage ? 'Loading…' : `Load more (${LIMIT})`}
            </Button>
          </Box>
        )}
      </Box>
    </Paper>
  )

  return (
    <>
      <Dialog
        open={reconOpen}
        onClose={() => setReconOpen(false)}
        fullWidth
        maxWidth="xl"
        fullScreen={isMobile}
        PaperProps={{
          sx: {
            borderRadius: isMobile ? 0 : 4,
          },
        }}
      >
        <DialogTitle sx={{ pb: 1 }}>
          <Stack direction={{ xs: 'column', md: 'row' }} gap={1.5} justifyContent="space-between">
            <Box>
              <Typography variant="h6" sx={{ fontWeight: 950 }}>
                Stock Ledger Reconciliation
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Using the current search filter: {debouncedItemSearch || 'all items'}
              </Typography>
            </Box>

            <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
              <Chip label={`Rows: ${reconQ.data?.total_rows ?? 0}`} sx={{ borderRadius: 999, fontWeight: 900 }} />
              <Chip
                label={`Safe backfills: ${reconSafeCount}`}
                sx={{ borderRadius: 999, fontWeight: 900, bgcolor: 'rgba(25,118,210,0.10)', color: 'primary.main' }}
              />
              <Chip
                label={`Synthetic fills: ${reconSyntheticCount}`}
                sx={{ borderRadius: 999, fontWeight: 900, bgcolor: 'rgba(211,47,47,0.10)', color: 'error.main' }}
              />
              <Chip
                label={`Blocked gaps: ${reconBlockedCount}`}
                sx={{ borderRadius: 999, fontWeight: 900, bgcolor: 'rgba(237,108,2,0.12)', color: 'warning.dark' }}
              />
            </Stack>
          </Stack>
        </DialogTitle>

        <DialogContent sx={{ pt: 1 }}>
          <Stack gap={2}>
            <Stack direction={{ xs: 'column', md: 'row' }} gap={1.5} justifyContent="space-between">
              <FormControlLabel
                sx={{ m: 0 }}
                control={
                  <Switch checked={reconShowBalanced} onChange={(e) => setReconShowBalanced(e.target.checked)} />
                }
                label="Include balanced rows"
              />

              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} justifyContent="flex-end">
                <Button
                  variant="outlined"
                  onClick={() => applyReconM.mutate({ applySynthetic: false })}
                  disabled={applyReconM.isPending || reconSafeCount === 0}
                  sx={{ borderRadius: 999, fontWeight: 900 }}
                >
                  {applyReconM.isPending ? 'Applying…' : 'Apply Deterministic Only'}
                </Button>
                <Button
                  variant="contained"
                  color="warning"
                  onClick={() => applyReconM.mutate({ applySynthetic: true })}
                  disabled={applyReconM.isPending || reconRows.length === 0}
                  sx={{ borderRadius: 999, fontWeight: 900 }}
                >
                  {applyReconM.isPending ? 'Applying…' : 'Apply Full Repair'}
                </Button>
              </Stack>
            </Stack>

            <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 3, bgcolor: 'rgba(15,23,42,0.02)' }}>
              <Typography variant="body2" color="text.secondary">
                Deterministic backfills recreate missing rows from source documents. Full repair also inserts
                `RECON_ADJUST` rows where the old history cannot be rebuilt exactly.
              </Typography>
            </Paper>

            <Box sx={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Status</th>
                    <th>Current</th>
                    <th>Ledger</th>
                    <th>Deterministic</th>
                    <th>Recon</th>
                    <th>Missing Entries</th>
                  </tr>
                </thead>

                <tbody>
                  {reconQ.isLoading ? (
                    Array.from({ length: 8 }).map((_, i) => (
                      <tr key={`recon-sk-${i}`}>
                        <td colSpan={7}>
                          <Box py={0.75}>
                            <Skeleton variant="rounded" height={44} />
                          </Box>
                        </td>
                      </tr>
                    ))
                  ) : reconRows.length === 0 ? (
                    <tr>
                      <td colSpan={7}>
                        <Box p={2} color="text.secondary">
                          No reconciliation gaps found for this filter.
                        </Box>
                      </td>
                    </tr>
                  ) : (
                    reconRows.map((row) => (
                      <tr key={`recon-${row.item_id}`}>
                        <td>
                          <Stack gap={0.25}>
                            <Typography sx={{ fontWeight: 900 }}>{row.item_name}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              #{row.item_id} • Brand: {row.brand || '-'} • Exp: {formatExpiry(row.expiry_date)} • MRP:{' '}
                              {row.mrp} • Rack: {row.rack_number || 0}
                              {row.is_archived ? ' • Archived' : ''}
                            </Typography>
                          </Stack>
                        </td>
                        <td>{statusChip(row.status)}</td>
                        <td>{deltaChip(row.current_stock)}</td>
                        <td>{deltaChip(row.ledger_delta_total)}</td>
                        <td>{deltaChip(row.deterministic_gap)}</td>
                        <td>{deltaChip(row.suggested_recon_delta)}</td>
                        <td>
                          {row.missing_entries.length === 0 ? (
                            <Typography variant="caption" color="text.secondary">
                              No source gaps
                            </Typography>
                          ) : (
                            <Stack gap={1} sx={{ minWidth: 320, py: 0.5 }}>
                              {row.missing_entries.map((entry, index) => (
                                <Paper
                                  key={`${row.item_id}-${entry.reason}-${entry.ref_type || 'na'}-${entry.ref_id ?? 'na'}-${index}`}
                                  variant="outlined"
                                  sx={{
                                    p: 1,
                                    borderRadius: 2,
                                    bgcolor: entry.safe_to_apply
                                      ? 'rgba(25,118,210,0.06)'
                                      : 'rgba(237,108,2,0.08)',
                                  }}
                                >
                                  <Stack direction="row" gap={0.75} flexWrap="wrap" alignItems="center" sx={{ mb: 0.5 }}>
                                    {reasonChip(entry.reason)}
                                    <Chip
                                      size="small"
                                      label={entry.safe_to_apply ? 'Safe backfill' : 'Needs recon'}
                                      sx={{
                                        borderRadius: 999,
                                        fontWeight: 800,
                                        bgcolor: entry.safe_to_apply
                                          ? 'rgba(25,118,210,0.12)'
                                          : 'rgba(237,108,2,0.14)',
                                        color: entry.safe_to_apply ? 'primary.main' : 'warning.dark',
                                      }}
                                    />
                                    {deltaChip(entry.missing_delta)}
                                    <Typography variant="caption" color="text.secondary">
                                      Expected {formatSigned(entry.expected_delta)} vs actual {formatSigned(entry.actual_delta)}
                                    </Typography>
                                  </Stack>
                                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                                    {entry.ref_type ? `${entry.ref_type}${entry.ref_id ? ` #${entry.ref_id}` : ''}` : 'No ref'}
                                    {entry.source_ts ? ` • ${entry.source_ts}` : ''}
                                  </Typography>
                                  {entry.note && (
                                    <Typography variant="caption" sx={{ display: 'block', mt: 0.25 }}>
                                      {entry.note}
                                    </Typography>
                                  )}
                                </Paper>
                              ))}
                            </Stack>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </Box>

            {reconQ.isError && (
              <Typography variant="body2" color="error">
                Failed to load reconciliation report.
              </Typography>
            )}

            <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} justifyContent="space-between">
              <Typography variant="body2" color="text.secondary">
                Search from the left panel narrows this report too, so you can reconcile one product family at a time.
              </Typography>
              <Button variant="outlined" onClick={() => setReconOpen(false)} sx={{ borderRadius: 999, fontWeight: 900 }}>
                Close
              </Button>
            </Stack>
          </Stack>
        </DialogContent>
      </Dialog>

      <Dialog
        open={ledgerOpen}
        onClose={() => setLedgerOpen(false)}
        fullWidth
        maxWidth="lg"
        fullScreen={isMobile}
        PaperProps={{
          sx: {
            borderRadius: isMobile ? 0 : 4,
            bgcolor: 'transparent',
            boxShadow: 'none',
          },
        }}
      >
        <DialogTitle sx={{ p: isMobile ? 0 : 1.5 }} />
        <DialogContent sx={{ p: isMobile ? 0 : 1.5 }}>{LedgerCard}</DialogContent>
      </Dialog>

      <Stack gap={2}>
        <Paper sx={{ p: 2, borderRadius: 3 }}>
          <Stack direction={{ xs: 'column', md: 'row' }} gap={1.5} alignItems={{ md: 'center' }}>
            <TextField
              size="small"
              label="Search name / brand"
              value={itemSearch}
              onChange={(e) => setItemSearch(e.target.value)}
              fullWidth
              InputProps={{
                startAdornment: <SearchIcon fontSize="small" style={{ marginRight: 8, opacity: 0.7 }} />,
              }}
            />

            <Chip
              label={`Loaded: ${itemRows.length}`}
              variant="outlined"
              sx={{ borderRadius: 999, fontWeight: 900, alignSelf: { xs: 'flex-start', md: 'center' } }}
            />
          </Stack>
        </Paper>

        <Paper sx={{ p: 2, borderRadius: 3 }}>
          <Typography sx={{ fontWeight: 950, mb: 1 }}>Items</Typography>

          <Box
            ref={listRef}
            onScroll={maybeLoadMore}
            sx={{
              maxHeight: '70vh',
              overflow: 'auto',
              pr: 0.5,
              position: 'relative',
            }}
          >
            {qItems.isLoading && (
              <Stack gap={1}>
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} variant="rounded" height={68} />
                ))}
              </Stack>
            )}

            {!qItems.isLoading && grouped.length === 0 && (
              <Box p={2} color="text.secondary">
                No items found.
              </Box>
            )}

            {!qItems.isLoading &&
              grouped.map((g) => {
                const selected = pickedGroup?.key === g.key
                const isOut = Number(g.totalStock || 0) <= 0

                return (
                  <Paper
                    key={g.key}
                    sx={{
                      mb: 1,
                      p: 1.5,
                      borderRadius: 2,
                      border: '1px solid',
                      borderColor: selected ? 'primary.main' : 'divider',
                      bgcolor: selected
                        ? 'rgba(25,118,210,0.06)'
                        : isOut
                          ? 'rgba(0,0,0,0.03)'
                          : 'background.paper',
                      opacity: isOut ? 0.8 : 1,
                    }}
                  >
                    <Stack
                      direction={{ xs: 'column', sm: 'row' }}
                      gap={1}
                      justifyContent="space-between"
                      alignItems={{ sm: 'center' }}
                    >
                      <Stack sx={{ minWidth: 0 }}>
                        <Typography sx={{ fontWeight: 950 }} noWrap>
                          {g.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" noWrap>
                          Brand: {g.brand || '-'} • Earliest exp: {g.earliestExpiry ? formatExpiry(g.earliestExpiry) : '-'}
                        </Typography>
                      </Stack>

                      <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" justifyContent="flex-end">
                        <Chip
                          size="small"
                          label={`Total Stock: ${g.totalStock}`}
                          sx={{ fontWeight: 900, borderRadius: 999 }}
                        />

                        <Button
                          variant={selected ? 'contained' : 'outlined'}
                          onClick={() => openLedgerForGroup(g)}
                          sx={{ borderRadius: 999, fontWeight: 950 }}
                        >
                          View Ledger
                        </Button>
                      </Stack>
                    </Stack>
                  </Paper>
                )
              })}

            {qItems.isFetchingNextPage && (
              <Stack gap={1} sx={{ mt: 1 }}>
                {Array.from({ length: 2 }).map((_, i) => (
                  <Skeleton key={`np-${i}`} variant="rounded" height={62} />
                ))}
              </Stack>
            )}

            {qItems.hasNextPage && !qItems.isFetchingNextPage && (
              <Box sx={{ py: 1.5, textAlign: 'center', color: 'text.secondary', fontSize: 12 }}>
                Scroll down to load more…
              </Box>
            )}

            {!qItems.hasNextPage && itemRows.length > 0 && (
              <Box sx={{ py: 1.5, textAlign: 'center', color: 'text.secondary', fontSize: 12 }}>
                End of list.
              </Box>
            )}
          </Box>
        </Paper>
      </Stack>
    </>
  )
}
