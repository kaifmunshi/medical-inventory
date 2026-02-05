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
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Badge,
  Skeleton,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import SearchIcon from '@mui/icons-material/Search'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useTheme } from '@mui/material/styles'

import { listItemsPage, getItemLedger } from '../../services/inventory'

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

function groupKey(it: any) {
  const name = String(it?.name ?? '').trim().toLowerCase()
  const brand = String(it?.brand ?? '').trim().toLowerCase()
  return `${name}__${brand}`
}

export default function StockLedgerReport(props: {
  from: string
  to: string
  setExportFn: (fn: () => void) => void
  setExportDisabled: (v: boolean) => void
  setExtraControls: (node: React.ReactNode) => void
}) {
  const { from, to, setExportFn, setExportDisabled, setExtraControls } = props

  const LIMIT = 30
  const theme = useTheme()
  const isMobile = useMediaQuery(theme.breakpoints.down('md'))

  // list search
  const [itemSearch, setItemSearch] = useState('')
  const [debouncedItemSearch, setDebouncedItemSearch] = useState('')

  // selected batch
  const [pickedItem, setPickedItem] = useState<any | null>(null)

  // ledger filters
  const [ledgerReason, setLedgerReason] = useState<string>('') // empty = all

  // open/close ledger CARD (dialog)
  const [ledgerOpen, setLedgerOpen] = useState(false)

  // expand group
  const [expandedGroup, setExpandedGroup] = useState<string | false>(false)

  // list scroll ref for auto-load
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedItemSearch(itemSearch.trim()), 250)
    return () => clearTimeout(t)
  }, [itemSearch])

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
  const grouped = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string
        name: string
        brand: string
        totalStock: number
        count: number
        batches: any[]
        earliestExpiry: string
      }
    >()

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
          count: 1,
          batches: [it],
          earliestExpiry: expIso || '',
        })
      } else {
        existing.totalStock += stock
        existing.count += 1
        existing.batches.push(it)
        if (!existing.earliestExpiry) existing.earliestExpiry = expIso || ''
        else if (expIso && expIso < existing.earliestExpiry) existing.earliestExpiry = expIso
      }
    }

    const list = Array.from(map.values()).map((g) => {
      const batches = [...g.batches].sort((a, b) => {
        const da = toIsoDateOnly(a?.expiry_date)
        const db = toIsoDateOnly(b?.expiry_date)
        if (!da && !db) return 0
        if (!da) return 1
        if (!db) return -1
        return da.localeCompare(db)
      })
      return { ...g, batches }
    })

    list.sort((a, b) => {
      const an = a.name.toLowerCase()
      const bn = b.name.toLowerCase()
      if (an !== bn) return an.localeCompare(bn)
      return a.brand.toLowerCase().localeCompare(b.brand.toLowerCase())
    })

    return list
  }, [itemRows])

  // ✅ Ledger query (only when dialog open and item picked)
  const qLedger = useInfiniteQuery({
    queryKey: ['rpt-stock-ledger', pickedItem?.id, from, to, ledgerReason],
    enabled: !!pickedItem?.id && ledgerOpen,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      return await getItemLedger({
        item_id: Number(pickedItem.id),
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
    }))
  }, [ledgerRaw])

  // ✅ Header controls
  useEffect(() => {
    setExtraControls(
      <>
        <TextField
          select
          label="Reason"
          value={ledgerReason}
          onChange={(e) => setLedgerReason(e.target.value)}
          sx={{ width: 180 }}
        >
          <MenuItem value="">All</MenuItem>
          <MenuItem value="OPENING">OPENING</MenuItem>
          <MenuItem value="ADJUST">ADJUST</MenuItem>
          <MenuItem value="BILL">BILL</MenuItem>
          <MenuItem value="RETURN">RETURN</MenuItem>
          <MenuItem value="EXCHANGE_IN">EXCHANGE_IN</MenuItem>
          <MenuItem value="EXCHANGE_OUT">EXCHANGE_OUT</MenuItem>
        </TextField>

        {ledgerOpen && (
          <Button variant="outlined" onClick={() => setLedgerOpen(false)} sx={{ borderRadius: 999, fontWeight: 900 }}>
            Close
          </Button>
        )}
      </>
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerReason, ledgerOpen])

  // ✅ Export
  useEffect(() => {
    setExportDisabled(!(ledgerOpen && pickedItem?.id && detailRows.length > 0))
    setExportFn(() => () => {
      if (!pickedItem?.id) return
      const header = ['ID', 'TS', 'Delta', 'Reason', 'Ref Type', 'Ref ID', 'Before', 'After', 'Note']
      const body = detailRows.map((r: any) => [
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
      a.download = `stock-ledger_${pickedItem?.id ?? 'item'}_${from}_to_${to}.csv`
      a.click()
      URL.revokeObjectURL(url)
    })
  }, [setExportDisabled, setExportFn, detailRows, pickedItem?.id, from, to, ledgerOpen])

  const currentStock = qLedger.data?.pages?.[0]?.current_stock ?? pickedItem?.stock ?? '-'

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

  function openLedgerFor(item: any) {
    setPickedItem(item)
    setLedgerOpen(true)
  }

  // ✅ Auto-load list (no button)
  const maybeLoadMore = () => {
    if (!qItems.hasNextPage) return
    if (qItems.isFetchingNextPage) return
    const el = listRef.current
    if (!el) return
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 220
    if (nearBottom) qItems.fetchNextPage()
  }

  // ✅ Ledger “Card” content (inside a centered dialog)
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
      {/* header */}
      <Box sx={{ p: 2, pb: 1.5 }}>
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={1.5}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h6" sx={{ fontWeight: 950, lineHeight: 1.15 }} noWrap>
              {pickedItem?.name ?? 'Ledger'}
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              Brand: {pickedItem?.brand || '-'} • Exp: {formatExpiry(pickedItem?.expiry_date)} • #{pickedItem?.id ?? '-'}
            </Typography>
          </Box>

          <Stack direction="row" gap={1} alignItems="center">
            <Chip label={`Current Stock: ${String(currentStock)}`} sx={{ fontWeight: 950, borderRadius: 999 }} />
            <IconButton onClick={() => setLedgerOpen(false)} size="small">
              <CloseIcon />
            </IconButton>
          </Stack>
        </Stack>
      </Box>

      <Divider />

      {/* table */}
      <Box sx={{ p: 2 }}>
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
              {qLedger.isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={`sk-${i}`}>
                    <td colSpan={8}>
                      <Box py={0.75}>
                        <Skeleton variant="rounded" height={32} />
                      </Box>
                    </td>
                  </tr>
                ))
              ) : detailRows.length === 0 ? (
                <tr>
                  <td colSpan={8}>
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
                    <td>{reasonChip(r.reason)}</td>
                    <td>{r.ref_type ? `${r.ref_type}${r.ref_id ? ` #${r.ref_id}` : ''}` : '-'}</td>
                    <td>{r.before}</td>
                    <td>{r.after}</td>
                    <td>
                      {r.note ? (
                        <Tooltip title={r.note}>
                          <span style={{ cursor: 'help' }}>
                            {String(r.note).length > 26 ? `${String(r.note).slice(0, 26)}…` : r.note}
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
      {/* ✅ Ledger shown as CENTER CARD (dialog), not right drawer */}
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
        {/* keep title minimal (we have our own header inside card) */}
        <DialogTitle sx={{ p: isMobile ? 0 : 1.5 }} />
        <DialogContent sx={{ p: isMobile ? 0 : 1.5 }}>
          {LedgerCard}
        </DialogContent>
      </Dialog>

      {/* Main UI: Item list always visible */}
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
                const isOpen = expandedGroup === g.key

                return (
                  <Accordion
                    key={g.key}
                    expanded={isOpen}
                    onChange={() => setExpandedGroup((prev) => (prev === g.key ? false : g.key))}
                    disableGutters
                    sx={{
                      mb: 1,
                      borderRadius: 2,
                      overflow: 'hidden',
                      border: '1px solid',
                      borderColor: 'divider',
                      '&:before': { display: 'none' },
                    }}
                  >
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                      <Stack direction="row" justifyContent="space-between" width="100%" gap={1}>
                        <Stack sx={{ minWidth: 0 }}>
                          <Typography sx={{ fontWeight: 950 }} noWrap>
                            {g.name}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" noWrap>
                            Brand: {g.brand || '-'} • Earliest exp:{' '}
                            {g.earliestExpiry ? formatExpiry(g.earliestExpiry) : '-'}
                          </Typography>
                        </Stack>

                        <Stack direction="row" gap={1} alignItems="center">
                          <Chip
                            size="small"
                            label={`Total Stock: ${g.totalStock}`}
                            sx={{ fontWeight: 900, borderRadius: 999 }}
                          />
                          <Badge color="primary" badgeContent={g.count} sx={{ '& .MuiBadge-badge': { fontWeight: 900 } }}>
                            <Chip size="small" label="Batches" variant="outlined" sx={{ borderRadius: 999 }} />
                          </Badge>
                        </Stack>
                      </Stack>
                    </AccordionSummary>

                    <AccordionDetails sx={{ pt: 0 }}>
                      <Stack gap={1}>
                        {g.batches.map((it: any) => {
                          const stock = Number(it?.stock ?? 0)
                          const isOut = stock <= 0
                          const selected = pickedItem?.id === it.id

                          return (
                            <Paper
                              key={it.id}
                              sx={{
                                p: 1.25,
                                borderRadius: 2,
                                border: '1px solid',
                                borderColor: selected ? 'primary.main' : 'divider',
                                bgcolor: selected ? 'rgba(25,118,210,0.06)' : 'background.paper',
                              }}
                            >
                              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} justifyContent="space-between">
                                <Stack spacing={0.2}>
                                  <Typography sx={{ fontWeight: 900 }}>Exp: {formatExpiry(it.expiry_date)}</Typography>
                                  <Typography variant="caption" color="text.secondary">
                                    MRP: {it.mrp ?? '-'} • Rack: {it.rack_number ?? '-'} • #{it.id}
                                  </Typography>
                                </Stack>

                                <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                                  {/* ✅ 0 stock should be seen */}
                                  <Chip
                                    size="small"
                                    label={`Stock: ${stock}`}
                                    sx={{
                                      fontWeight: 900,
                                      borderRadius: 999,
                                      ...(isOut ? { bgcolor: 'rgba(0,0,0,0.06)' } : undefined),
                                    }}
                                  />
                                  <Button
                                    variant={selected ? 'contained' : 'outlined'}
                                    onClick={() => openLedgerFor(it)}
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
                      </Stack>
                    </AccordionDetails>
                  </Accordion>
                )
              })}

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