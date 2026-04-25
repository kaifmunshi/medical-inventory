import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import SummarizeOutlinedIcon from '@mui/icons-material/SummarizeOutlined'
import ViewStreamOutlinedIcon from '@mui/icons-material/ViewStreamOutlined'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getAudit } from '../../services/audit'
import { getBill } from '../../services/billing'
import {
  getGroupLedger,
  getGroupLedgerSummary,
  getItemGroup,
  getStockLedgerReconciliation,
} from '../../services/inventory'
import { fetchPurchase } from '../../services/purchases'
import { getExchangeByReturn, getReturn } from '../../services/returns'
import { buildSalesReportLink, buildStockReportLink } from '../../lib/reportLinks'
import { formatLedgerNote } from '../../lib/stockLedger'

type StockCardTab = 'summary' | 'product' | 'batch' | 'batches'

const LEDGER_LIMIT = 60

function formatExpiry(exp?: string | null) {
  if (!exp) return '-'
  const s = String(exp)
  const iso = s.length > 10 ? s.slice(0, 10) : s
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${d}-${m}-${y}`
}

function formatDateTime(value?: string | null) {
  const raw = String(value || '')
  if (!raw) return '-'
  try {
    return new Date(raw).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    })
  } catch {
    return raw
  }
}

function toDateInput(daysAgo = 0) {
  const date = new Date()
  date.setDate(date.getDate() - daysAgo)
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

function formatSigned(value: number) {
  return `${value > 0 ? '+' : ''}${value}`
}

function reasonLabel(reason: string) {
  const key = String(reason || '').toUpperCase()
  const labels: Record<string, string> = {
    OPENING: 'Opening',
    PURCHASE: 'Purchase In',
    PURCHASE_CANCEL: 'Purchase Cancel',
    SALE: 'Sale Out',
    BILL_DELETE: 'Sale Cancel',
    BILL_RECOVER: 'Sale Restore',
    RETURN: 'Return In',
    EXCHANGE_IN: 'Exchange Return',
    EXCHANGE_OUT: 'Exchange Sale',
    ADJUST: 'Stock Adjust',
    PACK_OPEN_IN: 'Pack Open In',
    PACK_OPEN_OUT: 'Pack Open Out',
    RECON_ADJUST: 'Recon Adjust',
    BILL: 'Bill',
  }
  return labels[key] || key || '-'
}

function deltaChip(delta: number) {
  const isPos = delta > 0
  const isNeg = delta < 0
  return (
    <Chip
      size="small"
      label={formatSigned(delta)}
      sx={{
        borderRadius: 999,
        fontWeight: 900,
        ...(isPos
          ? { bgcolor: 'rgba(46,125,50,0.14)', color: 'success.main' }
          : isNeg
            ? { bgcolor: 'rgba(211,47,47,0.14)', color: 'error.main' }
            : { bgcolor: 'rgba(0,0,0,0.08)' }),
      }}
    />
  )
}

function statusChip(label: string, tone: 'success' | 'warning' | 'error' | 'default' | 'info' = 'default') {
  const palette =
    tone === 'success'
      ? { bgcolor: 'rgba(46,125,50,0.14)', color: 'success.main' }
      : tone === 'warning'
        ? { bgcolor: 'rgba(237,108,2,0.14)', color: 'warning.dark' }
        : tone === 'error'
          ? { bgcolor: 'rgba(211,47,47,0.14)', color: 'error.main' }
          : tone === 'info'
            ? { bgcolor: 'rgba(25,118,210,0.12)', color: 'primary.main' }
            : { bgcolor: 'rgba(0,0,0,0.08)', color: 'text.primary' }
  return <Chip size="small" label={label} sx={{ borderRadius: 999, fontWeight: 900, ...palette }} />
}

function daysUntilExpiry(expiry?: string | null) {
  if (!expiry) return null
  const raw = String(expiry).slice(0, 10)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const exp = new Date(raw)
  if (Number.isNaN(exp.getTime())) return null
  exp.setHours(0, 0, 0, 0)
  return Math.round((exp.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
}

function buildProductSearch(name: string, brand?: string | null) {
  const params = new URLSearchParams()
  params.set('q', name)
  if (brand) params.set('brand', brand)
  return `/products?${params.toString()}`
}

export default function StockCardPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const name = (searchParams.get('name') || '').trim()
  const brand = (searchParams.get('brand') || '').trim()
  const requestedBatchId = Number(searchParams.get('batchId') || 0) || null
  const requestedTab = (searchParams.get('tab') || '').trim() as StockCardTab

  const [tab, setTab] = useState<StockCardTab>(
    requestedTab === 'product' || requestedTab === 'batch' || requestedTab === 'batches' || requestedTab === 'summary'
      ? requestedTab
      : requestedBatchId
        ? 'batch'
        : 'summary'
  )
  const [from, setFrom] = useState(() => toDateInput(30))
  const [to, setTo] = useState(() => toDateInput(0))
  const [reason, setReason] = useState('')
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(requestedBatchId)
  const [selectedMovementId, setSelectedMovementId] = useState<number | null>(null)

  const groupQ = useQuery({
    queryKey: ['inventory-group', name, brand],
    queryFn: () => getItemGroup({ name, brand }),
    enabled: !!name,
  })

  const batches = groupQ.data?.batches || []
  const currentBatch = useMemo(() => {
    if (!batches.length) return null
    const byParam = selectedBatchId ? batches.find((batch) => Number(batch.id) === Number(selectedBatchId)) : null
    if (byParam) return byParam
    return batches.find((batch) => Number(batch.stock || 0) > 0) || batches[0]
  }, [batches, selectedBatchId])

  useEffect(() => {
    if (!currentBatch) return
    if (selectedBatchId !== Number(currentBatch.id)) setSelectedBatchId(Number(currentBatch.id))
  }, [currentBatch, selectedBatchId])

  const productSummaryQ = useQuery({
    queryKey: ['inventory-group-summary', name, brand, 'product', from, to],
    queryFn: () =>
      getGroupLedgerSummary({
        name,
        brand,
        from_date: from || undefined,
        to_date: to || undefined,
      }),
    enabled: !!name,
  })

  const batchSummaryQ = useQuery({
    queryKey: ['inventory-group-summary', name, brand, currentBatch?.id, from, to],
    queryFn: () =>
      getGroupLedgerSummary({
        name,
        brand,
        item_id: currentBatch?.id,
        from_date: from || undefined,
        to_date: to || undefined,
      }),
    enabled: !!name && !!currentBatch?.id,
  })

  const productLedgerQ = useInfiniteQuery({
    queryKey: ['stock-card-product-ledger', name, brand, from, to, reason],
    queryFn: ({ pageParam }) =>
      getGroupLedger({
        name,
        brand,
        from_date: from || undefined,
        to_date: to || undefined,
        reason: reason || undefined,
        limit: LEDGER_LIMIT,
        offset: Number(pageParam || 0),
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage?.next_offset ?? undefined,
    enabled: !!name,
  })

  const batchLedgerQ = useInfiniteQuery({
    queryKey: ['stock-card-batch-ledger', name, brand, currentBatch?.id, from, to, reason],
    queryFn: ({ pageParam }) =>
      getGroupLedger({
        name,
        brand,
        item_id: currentBatch?.id || undefined,
        from_date: from || undefined,
        to_date: to || undefined,
        reason: reason || undefined,
        limit: LEDGER_LIMIT,
        offset: Number(pageParam || 0),
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage?.next_offset ?? undefined,
    enabled: !!name && !!currentBatch?.id,
  })

  const reconQ = useQuery({
    queryKey: ['stock-card-reconciliation', groupQ.data?.key, groupQ.data?.batches?.length],
    queryFn: () =>
      getStockLedgerReconciliation({
        item_ids: (groupQ.data?.batches || []).map((batch) => Number(batch.id)),
        include_archived: true,
        include_balanced: false,
        limit: 1000,
      }),
    enabled: !!groupQ.data?.batches?.length,
  })

  const productRows = useMemo(
    () => ((productLedgerQ.data?.pages || []).flatMap((page) => page.items) as any[]) || [],
    [productLedgerQ.data]
  )
  const batchRows = useMemo(
    () => ((batchLedgerQ.data?.pages || []).flatMap((page) => page.items) as any[]) || [],
    [batchLedgerQ.data]
  )

  const productRowsWithOpening = useMemo(() => {
    if (!from || productSummaryQ.isLoading) return productRows
    const opening = Number(productSummaryQ.data?.opening_stock || 0)
    return [
      ...productRows,
      {
        id: -1,
        ts: `${from}T00:00:00`,
        delta: opening,
        reason: 'OPENING',
        ref_type: null,
        ref_id: null,
        note: `Opening stock at ${from}`,
        item_id: 0,
        expiry_date: null,
        mrp: null,
        rack_number: null,
        balance_before: 0,
        balance_after: opening,
      },
    ]
  }, [from, productRows, productSummaryQ.data?.opening_stock, productSummaryQ.isLoading])

  const batchRowsWithOpening = useMemo(() => {
    if (!from || batchSummaryQ.isLoading || !currentBatch?.id) return batchRows
    const opening = Number(batchSummaryQ.data?.opening_stock || 0)
    return [
      ...batchRows,
      {
        id: -2,
        ts: `${from}T00:00:00`,
        delta: opening,
        reason: 'OPENING',
        ref_type: null,
        ref_id: null,
        note: `Opening stock at ${from}`,
        item_id: Number(currentBatch.id),
        expiry_date: currentBatch.expiry_date,
        mrp: currentBatch.mrp,
        rack_number: currentBatch.rack_number,
        balance_before: 0,
        balance_after: opening,
      },
    ]
  }, [batchRows, batchSummaryQ.data?.opening_stock, batchSummaryQ.isLoading, currentBatch, from])

  const activeRows = tab === 'batch' ? batchRowsWithOpening : productRowsWithOpening

  useEffect(() => {
    if (!activeRows.length) {
      setSelectedMovementId(null)
      return
    }
    if (!selectedMovementId || !activeRows.some((row) => Number(row.id) === Number(selectedMovementId))) {
      setSelectedMovementId(Number(activeRows[0].id))
    }
  }, [activeRows, selectedMovementId, tab])

  const selectedMovement = useMemo(
    () => activeRows.find((row) => Number(row.id) === Number(selectedMovementId)) || null,
    [activeRows, selectedMovementId]
  )

  const sourceSpec = useMemo(() => {
    if (!selectedMovement?.ref_id) return { kind: null as null | string, id: null as number | null }
    const reasonKey = String(selectedMovement.reason || '').toUpperCase()
    const refType = String(selectedMovement.ref_type || '').toUpperCase()
    const refId = Number(selectedMovement.ref_id || 0) || null
    if (refType === 'BILL' && refId) return { kind: 'bill', id: refId }
    if (refType === 'PURCHASE' && refId) return { kind: 'purchase', id: refId }
    if (refType === 'RETURN' && refId) return { kind: 'return', id: refId }
    if (refType === 'AUDIT' && refId) return { kind: 'audit', id: refId }
    if (refType === 'EXCHANGE' && reasonKey === 'EXCHANGE_IN' && refId) return { kind: 'exchange', id: refId }
    if (refType === 'EXCHANGE' && reasonKey === 'EXCHANGE_OUT' && refId) return { kind: 'bill', id: refId }
    return { kind: null as null | string, id: null as number | null }
  }, [selectedMovement])

  const sourceQ = useQuery({
    queryKey: ['stock-card-source', sourceSpec.kind, sourceSpec.id],
    enabled: !!sourceSpec.kind && !!sourceSpec.id,
    queryFn: async () => {
      if (!sourceSpec.kind || !sourceSpec.id) return null
      if (sourceSpec.kind === 'bill') return getBill(sourceSpec.id)
      if (sourceSpec.kind === 'purchase') return fetchPurchase(sourceSpec.id)
      if (sourceSpec.kind === 'return') return getReturn(sourceSpec.id)
      if (sourceSpec.kind === 'audit') return getAudit(sourceSpec.id)
      if (sourceSpec.kind === 'exchange') return getExchangeByReturn(sourceSpec.id)
      return null
    },
  })

  const nearExpiryCount = useMemo(
    () => batches.filter((batch) => Number(batch.stock || 0) > 0 && (daysUntilExpiry(batch.expiry_date) ?? 9999) <= 90).length,
    [batches]
  )

  const mrpRange = useMemo(() => {
    if (!groupQ.data) return '-'
    if (groupQ.data.mrp_min == null && groupQ.data.mrp_max == null) return '-'
    if (groupQ.data.mrp_min === groupQ.data.mrp_max) return String(groupQ.data.mrp_min ?? '-')
    return `${groupQ.data.mrp_min ?? '-'} - ${groupQ.data.mrp_max ?? '-'}`
  }, [groupQ.data])

  const reconRows = reconQ.data?.items || []
  const blockedReconCount = reconRows.reduce(
    (sum, row) => sum + row.missing_entries.filter((entry) => !entry.safe_to_apply && entry.missing_delta !== 0).length,
    0,
  )

  const stockReportLink = buildStockReportLink({
    q: name,
    name,
    brand,
    from,
    to,
    reason,
    openLedger: true,
  })

  function openProductMaster() {
    navigate(buildProductSearch(name, brand || undefined))
  }

  function openSourcePage() {
    if (!selectedMovement) return
    const refId = Number(selectedMovement.ref_id || 0) || null
    const refType = String(selectedMovement.ref_type || '').toUpperCase()
    const reasonKey = String(selectedMovement.reason || '').toUpperCase()
    if (refType === 'BILL' && refId) {
      navigate(
        buildSalesReportLink({
          billId: refId,
          from: '2000-01-01',
          to: '2099-12-31',
        })
      )
      return
    }
    if (refType === 'PURCHASE') {
      navigate('/purchases')
      return
    }
    if (refType === 'RETURN' || refType === 'EXCHANGE') {
      navigate('/returns')
      return
    }
    if (refType === 'AUDIT') {
      navigate('/stock-audit')
    }
    if (reasonKey === 'RECON_ADJUST') {
      navigate(
        buildStockReportLink({
          q: name,
          name,
          brand,
          from,
          to,
          openReconcile: true,
        })
      )
    }
  }

  function quickRange(days: number | 'all') {
    if (days === 'all') {
      setFrom('')
      setTo('')
      return
    }
    setFrom(toDateInput(days))
    setTo(toDateInput(0))
  }

  function openBatch(batchId: number) {
    setSelectedBatchId(batchId)
    setTab('batch')
  }

  function summaryMetric(label: string, value: string, helper?: string) {
    const tile = (
      <Paper
        variant="outlined"
        sx={{
          p: 1.15,
          borderRadius: 2.5,
          minWidth: 118,
          flex: '1 1 135px',
          background: 'rgba(255,255,255,0.92)',
        }}
      >
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="subtitle1" sx={{ fontWeight: 900, lineHeight: 1.15, mt: 0.2 }}>
          {value}
        </Typography>
        {helper ? (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
            {helper}
          </Typography>
        ) : null}
      </Paper>
    )
    return helper ? (
      <Tooltip title={helper} arrow>
        {tile}
      </Tooltip>
    ) : tile
  }

  function renderSourceDetails() {
    if (!selectedMovement) {
      return (
        <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2.5 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
            Movement Inspector
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
            Select a movement row to inspect its source and impact.
          </Typography>
        </Paper>
      )
    }

    const sourceData: any = sourceQ.data
    const movementNote = formatLedgerNote(selectedMovement.note)

    return (
      <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2.5, position: 'sticky', top: 12 }}>
        <Stack gap={1.2}>
          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 900 }}>
              Movement Inspector
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Row #{selectedMovement.id} • {reasonLabel(selectedMovement.reason)}
            </Typography>
          </Box>

          <Stack direction="row" gap={1} flexWrap="wrap">
            {deltaChip(Number(selectedMovement.delta || 0))}
            <Chip
              size="small"
              label={`Batch #${selectedMovement.item_id}`}
              variant="outlined"
              sx={{ borderRadius: 999, fontWeight: 800 }}
            />
            <Chip
              size="small"
              label={formatDateTime(selectedMovement.ts)}
              variant="outlined"
              sx={{ borderRadius: 999, fontWeight: 800 }}
            />
          </Stack>

          <Paper variant="outlined" sx={{ p: 1, borderRadius: 2, bgcolor: 'rgba(15,23,42,0.02)' }}>
            <Typography variant="caption" color="text.secondary">
              Before / After
            </Typography>
            <Typography sx={{ fontWeight: 900, mt: 0.25 }}>
              {selectedMovement.balance_before} {'->'} {selectedMovement.balance_after}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              Ref: {selectedMovement.ref_type ? `${selectedMovement.ref_type}${selectedMovement.ref_id ? ` #${selectedMovement.ref_id}` : ''}` : '-'}
            </Typography>
            {movementNote ? (
              <Typography variant="body2" sx={{ mt: 0.7 }}>
                {movementNote}
              </Typography>
            ) : null}
          </Paper>

          <Stack direction={{ xs: 'column', sm: 'row' }} gap={1}>
            <Button
              variant="outlined"
              onClick={() => openBatch(Number(selectedMovement.item_id))}
              startIcon={<ViewStreamOutlinedIcon />}
              size="small"
            >
              View Batch Ledger
            </Button>
            <Button variant="outlined" onClick={openSourcePage} startIcon={<OpenInNewIcon />} size="small">
              Open Source Page
            </Button>
          </Stack>

          <Divider />

          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 900 }}>
              Source Snapshot
            </Typography>
            {sourceQ.isLoading ? (
              <Stack gap={1} sx={{ mt: 1 }}>
                <Skeleton variant="rounded" height={32} />
                <Skeleton variant="rounded" height={32} />
                <Skeleton variant="rounded" height={32} />
              </Stack>
            ) : sourceQ.isError ? (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                Source details could not be loaded for this row.
              </Typography>
            ) : sourceSpec.kind === 'bill' && sourceData ? (
              <Stack gap={0.8} sx={{ mt: 1 }}>
                <Typography variant="body2">Bill #{sourceData.id}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {formatDateTime(sourceData.date_time)} • {sourceData.payment_mode || '-'}
                </Typography>
                <Typography variant="body2">Total: Rs {Number(sourceData.total_amount || 0).toFixed(2)}</Typography>
                <Typography variant="body2" color="text.secondary">
                  Status: {sourceData.payment_status || '-'} {sourceData.is_deleted ? '• Deleted' : ''}
                </Typography>
              </Stack>
            ) : sourceSpec.kind === 'purchase' && sourceData ? (
              <Stack gap={0.8} sx={{ mt: 1 }}>
                <Typography variant="body2">Purchase #{sourceData.id}</Typography>
                <Typography variant="body2" color="text.secondary">
                  Invoice: {sourceData.invoice_number || '-'} • {formatDateTime(sourceData.created_at)}
                </Typography>
                <Typography variant="body2">Total: Rs {Number(sourceData.total_amount || 0).toFixed(2)}</Typography>
                <Typography variant="body2" color="text.secondary">
                  Status: {sourceData.payment_status || '-'}
                </Typography>
              </Stack>
            ) : sourceSpec.kind === 'return' && sourceData ? (
              <Stack gap={0.8} sx={{ mt: 1 }}>
                <Typography variant="body2">Return #{sourceData.id}</Typography>
                <Typography variant="body2" color="text.secondary">
                  Source Bill #{sourceData.source_bill_id} • {formatDateTime(sourceData.date_time || sourceData.created_at)}
                </Typography>
                <Typography variant="body2">
                  Refund: Rs {Number(sourceData.refund_cash || 0).toFixed(2)} cash / Rs {Number(sourceData.refund_online || 0).toFixed(2)} online
                </Typography>
              </Stack>
            ) : sourceSpec.kind === 'exchange' && sourceData ? (
              <Stack gap={0.8} sx={{ mt: 1 }}>
                <Typography variant="body2">Exchange #{sourceData.id}</Typography>
                <Typography variant="body2" color="text.secondary">
                  Source Bill #{sourceData.source_bill_id || '-'} • New Bill #{sourceData.new_bill_id || '-'}
                </Typography>
                <Typography variant="body2">Net Due: Rs {Number(sourceData.net_due || 0).toFixed(2)}</Typography>
              </Stack>
            ) : sourceSpec.kind === 'audit' && sourceData ? (
              <Stack gap={0.8} sx={{ mt: 1 }}>
                <Typography variant="body2">{sourceData.name || `Audit #${sourceData.id}`}</Typography>
                <Typography variant="body2" color="text.secondary">
                  Status: {sourceData.status || '-'} • Closed: {formatDateTime(sourceData.closed_at)}
                </Typography>
              </Stack>
            ) : (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                This movement does not have a richer source snapshot.
              </Typography>
            )}
          </Box>
        </Stack>
      </Paper>
    )
  }

  function renderLedgerTable(rows: any[], loading: boolean, hasMore: boolean, onLoadMore: () => void, loadingMore: boolean) {
    return (
      <Paper variant="outlined" sx={{ borderRadius: 2.5, overflow: 'hidden' }}>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>TS</th>
                <th>Batch</th>
                <th>Delta</th>
                <th>Reason</th>
                <th>Ref</th>
                <th>Before</th>
                <th>After</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 8 }).map((_, index) => (
                  <tr key={`sk-${index}`}>
                    <td colSpan={8}>
                      <Box py={0.75}>
                        <Skeleton variant="rounded" height={34} />
                      </Box>
                    </td>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <Box p={2} color="text.secondary">
                      No ledger rows for the selected range.
                    </Box>
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const selected = Number(row.id) === Number(selectedMovementId)
                  const formattedNote = formatLedgerNote(row.note)
                  return (
                    <tr
                      key={`row-${row.id}`}
                      onClick={() => setSelectedMovementId(Number(row.id))}
                      style={{
                        cursor: 'pointer',
                        background: selected ? 'rgba(20,92,59,0.08)' : undefined,
                      }}
                    >
                      <td>{formatDateTime(row.ts)}</td>
                      <td>
                        <Stack gap={0.2}>
                          <Typography sx={{ fontWeight: 800 }}>
                            {Number(row.item_id || 0) > 0 ? `#${row.item_id}` : 'Product'}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            Exp {formatExpiry(row.expiry_date)} • MRP {row.mrp ?? '-'}
                          </Typography>
                        </Stack>
                      </td>
                      <td>{deltaChip(Number(row.delta || 0))}</td>
                      <td>{statusChip(reasonLabel(row.reason), 'info')}</td>
                      <td>{row.ref_type ? `${row.ref_type}${row.ref_id ? ` #${row.ref_id}` : ''}` : '-'}</td>
                      <td>{row.balance_before}</td>
                      <td>{row.balance_after}</td>
                      <td style={{ maxWidth: 240, whiteSpace: 'normal', wordBreak: 'break-word' }}>
                        {formattedNote || '-'}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </Box>
        {hasMore ? (
          <Box p={1.5} textAlign="center">
            <Button variant="outlined" onClick={onLoadMore} disabled={loadingMore} size="small">
              {loadingMore ? 'Loading…' : 'Load More'}
            </Button>
          </Box>
        ) : null}
      </Paper>
    )
  }

  if (!name) {
    return (
      <Alert severity="warning">
        Stock card needs a product name. Open it from Inventory to keep the context intact.
      </Alert>
    )
  }

  if (groupQ.isLoading) {
    return (
      <Stack gap={2}>
        <Skeleton variant="rounded" height={120} />
        <Skeleton variant="rounded" height={300} />
      </Stack>
    )
  }

  if (groupQ.isError || !groupQ.data) {
    return (
      <Alert severity="error">
        Failed to load the stock card for {name}.
      </Alert>
    )
  }

  const expiryDays = daysUntilExpiry(groupQ.data.earliest_expiry)

  return (
    <Stack gap={1.5}>
      <Paper
        sx={{
          p: { xs: 1.35, md: 1.5 },
          borderRadius: 3,
          border: '1px solid rgba(15,23,42,0.08)',
          background: 'linear-gradient(180deg, #ffffff 0%, #f8fbfa 100%)',
        }}
      >
        <Stack gap={1.15}>
          <Stack direction={{ xs: 'column', lg: 'row' }} justifyContent="space-between" gap={1.5}>
            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ letterSpacing: 1 }}>
                STOCK CARD
              </Typography>
              <Typography variant="h5" sx={{ fontWeight: 900, lineHeight: 1.1, mt: 0.15 }}>
                {groupQ.data.name}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.35 }}>
                Brand {groupQ.data.brand || '-'} • {groupQ.data.total_batch_count} batches • Racks{' '}
                {groupQ.data.rack_numbers.length ? groupQ.data.rack_numbers.join(', ') : '0'}
              </Typography>
            </Box>

            <Stack direction="row" gap={1} flexWrap="wrap" justifyContent="flex-start">
              <Button size="small" startIcon={<ArrowBackIcon />} variant="outlined" onClick={() => navigate('/inventory')}>
                Inventory
              </Button>
              <Button size="small" startIcon={<Inventory2OutlinedIcon />} variant="outlined" onClick={openProductMaster}>
                Product
              </Button>
              <Button size="small" startIcon={<OpenInNewIcon />} variant="outlined" onClick={() => navigate(stockReportLink)}>
                Stock Report
              </Button>
            </Stack>
          </Stack>

          <Stack direction="row" gap={0.75} flexWrap="wrap">
            {reconRows.length === 0
              ? statusChip('Ledger Balanced', 'success')
              : statusChip(`Reconcile ${reconRows.length}`, 'warning')}
            {nearExpiryCount > 0 ? statusChip(`Near Expiry ${nearExpiryCount}`, 'warning') : statusChip('Expiry OK', 'success')}
            {groupQ.data.mrp_min !== groupQ.data.mrp_max ? statusChip('Multiple MRP', 'info') : statusChip('Single MRP', 'default')}
            {blockedReconCount > 0 ? statusChip(`Blocked ${blockedReconCount}`, 'error') : null}
          </Stack>

          <Stack direction="row" gap={1} flexWrap="wrap">
            {summaryMetric('Stock', String(groupQ.data.total_stock))}
            {summaryMetric('MRP', mrpRange)}
            {summaryMetric(
              'Expiry',
              formatExpiry(groupQ.data.earliest_expiry),
              expiryDays != null ? `${expiryDays} days left` : undefined
            )}
            {summaryMetric(
              'Batches',
              `${groupQ.data.active_batch_count} / ${groupQ.data.total_batch_count}`,
              'In-stock batches / total batches'
            )}
          </Stack>
        </Stack>
      </Paper>

      <Paper sx={{ p: 1.25, borderRadius: 2.5 }}>
        <Stack direction={{ xs: 'column', lg: 'row' }} gap={1.25} justifyContent="space-between">
          <Stack direction={{ xs: 'column', md: 'row' }} gap={1.25} flexWrap="wrap">
            <TextField
              label="From"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              InputLabelProps={{ shrink: true }}
              size="small"
              sx={{ minWidth: 165 }}
            />
            <TextField
              label="To"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              InputLabelProps={{ shrink: true }}
              size="small"
              sx={{ minWidth: 165 }}
            />
            <TextField
              select
              label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              size="small"
              sx={{ minWidth: 180 }}
            >
              <MenuItem value="">All</MenuItem>
              <MenuItem value="OPENING">Opening</MenuItem>
              <MenuItem value="PURCHASE">Purchase</MenuItem>
              <MenuItem value="PURCHASE_CANCEL">Purchase Cancel</MenuItem>
              <MenuItem value="SALE">Sale</MenuItem>
              <MenuItem value="BILL_DELETE">Sale Cancel</MenuItem>
              <MenuItem value="BILL_RECOVER">Sale Restore</MenuItem>
              <MenuItem value="RETURN">Return</MenuItem>
              <MenuItem value="EXCHANGE_IN">Exchange Return</MenuItem>
              <MenuItem value="EXCHANGE_OUT">Exchange Sale</MenuItem>
              <MenuItem value="ADJUST">Adjust</MenuItem>
              <MenuItem value="PACK_OPEN_IN">Pack Open In</MenuItem>
              <MenuItem value="PACK_OPEN_OUT">Pack Open Out</MenuItem>
              <MenuItem value="RECON_ADJUST">Recon Adjust</MenuItem>
            </TextField>
          </Stack>

          <Stack direction="row" gap={1} flexWrap="wrap">
            <Button variant="outlined" onClick={() => quickRange(30)} size="small">30D</Button>
            <Button variant="outlined" onClick={() => quickRange(90)} size="small">90D</Button>
            <Button variant="outlined" onClick={() => quickRange('all')} size="small">All Time</Button>
          </Stack>
        </Stack>
      </Paper>

      <Paper sx={{ borderRadius: 2.5, overflow: 'hidden' }}>
        <Tabs
          value={tab}
          onChange={(_, value) => setTab(value)}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ minHeight: 44, '& .MuiTab-root': { minHeight: 44 } }}
        >
          <Tab value="summary" icon={<SummarizeOutlinedIcon fontSize="small" />} iconPosition="start" label="Summary" />
          <Tab value="product" icon={<ReceiptLongIcon fontSize="small" />} iconPosition="start" label="Product Ledger" />
          <Tab value="batch" icon={<ViewStreamOutlinedIcon fontSize="small" />} iconPosition="start" label="Batch Ledger" />
          <Tab value="batches" icon={<Inventory2OutlinedIcon fontSize="small" />} iconPosition="start" label="Batches" />
        </Tabs>
      </Paper>

      {tab === 'summary' ? (
        <Stack gap={1.5}>
          <Stack direction="row" gap={1.25} flexWrap="wrap">
            {summaryMetric(
              'Opening Stock',
              String(productSummaryQ.data?.opening_stock ?? '-'),
              from ? `At ${formatExpiry(from)}` : 'Start of full history'
            )}
            {summaryMetric('Inward Qty', String(productSummaryQ.data?.inward_qty ?? '-'), 'Purchases, returns, positive adjustments')}
            {summaryMetric('Outward Qty', String(productSummaryQ.data?.outward_qty ?? '-'), 'Sales, exchange out, negative adjustments')}
            {summaryMetric('Closing Stock', String(productSummaryQ.data?.closing_stock ?? '-'), to ? `At ${formatExpiry(to)}` : 'Latest ledger close')}
            {summaryMetric(
              'Ledger Gap',
              formatSigned(productSummaryQ.data?.ledger_balance_gap ?? 0),
              `Gap = current stock (${productSummaryQ.data?.current_stock ?? '-'}) - total ledger movement balance. 0 means ledger matches stock.`
            )}
          </Stack>

          <Stack direction={{ xs: 'column', xl: 'row' }} gap={1.5}>
            <Paper sx={{ p: 1.5, borderRadius: 2.5, flex: 1 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 900 }}>
                Product Summary
              </Typography>
              <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 1 }}>
                {productSummaryQ.isLoading ? (
                  Array.from({ length: 5 }).map((_, index) => <Skeleton key={`ps-${index}`} variant="rounded" height={28} width={110} />)
                ) : (
                  <>
                    <Chip size="small" label={`Movements: ${productSummaryQ.data?.movement_count ?? 0}`} />
                    <Chip size="small" label={`Last Movement: ${formatDateTime(productSummaryQ.data?.last_movement_ts)}`} variant="outlined" />
                    <Chip size="small" label={`Last Purchase: ${formatDateTime(productSummaryQ.data?.last_purchase_ts)}`} variant="outlined" />
                    <Chip size="small" label={`Last Sale: ${formatDateTime(productSummaryQ.data?.last_sale_ts)}`} variant="outlined" />
                    <Chip size="small" label={`Last Adjust: ${formatDateTime(productSummaryQ.data?.last_adjustment_ts)}`} variant="outlined" />
                  </>
                )}
              </Stack>

              <Divider sx={{ my: 2 }} />

              <Typography variant="subtitle2" sx={{ fontWeight: 900, mb: 1 }}>
                Recent Product Movements
              </Typography>
              {renderLedgerTable(
                productRowsWithOpening.slice(0, 6),
                productLedgerQ.isLoading,
                productLedgerQ.hasNextPage,
                () => productLedgerQ.fetchNextPage(),
                productLedgerQ.isFetchingNextPage
              )}
            </Paper>

            <Stack gap={1.5} sx={{ width: { xs: '100%', xl: 360 } }}>
              <Paper sx={{ p: 1.5, borderRadius: 2.5 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 900 }}>
                  Focus Batch
                </Typography>
                {currentBatch ? (
                  <Stack gap={0.85} sx={{ mt: 1 }}>
                    <Typography variant="body1" sx={{ fontWeight: 800 }}>
                      Batch #{currentBatch.id}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      Exp {formatExpiry(currentBatch.expiry_date)} • MRP {currentBatch.mrp} • Rack {currentBatch.rack_number}
                    </Typography>
                    <Stack direction="row" gap={1} flexWrap="wrap">
                      <Chip size="small" label={`Stock ${currentBatch.stock}`} />
                      <Tooltip
                        title={`Gap = current batch stock (${batchSummaryQ.data?.current_stock ?? '-'}) - total ledger movement balance for this batch.`}
                        arrow
                      >
                        <Chip size="small" label={`Batch Gap ${formatSigned(batchSummaryQ.data?.ledger_balance_gap ?? 0)}`} variant="outlined" />
                      </Tooltip>
                    </Stack>
                    <Button variant="outlined" onClick={() => setTab('batch')} size="small">
                      Open Batch Ledger
                    </Button>
                  </Stack>
                ) : (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    No batch is available for inspection.
                  </Typography>
                )}
              </Paper>

              {renderSourceDetails()}
            </Stack>
          </Stack>
        </Stack>
      ) : null}

      {tab === 'product' ? (
        <Stack direction={{ xs: 'column', xl: 'row' }} gap={1.5}>
          <Stack gap={2} sx={{ flex: 1 }}>
            <Paper sx={{ p: 1.5, borderRadius: 2.5 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 900 }}>
                Product Ledger
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Combined view across all batches for {groupQ.data.name}.
              </Typography>
              <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 1.25 }}>
                <Chip size="small" label={`Opening ${productSummaryQ.data?.opening_stock ?? '-'}`} />
                <Chip size="small" label={`Inward ${productSummaryQ.data?.inward_qty ?? '-'}`} variant="outlined" />
                <Chip size="small" label={`Outward ${productSummaryQ.data?.outward_qty ?? '-'}`} variant="outlined" />
                <Chip size="small" label={`Closing ${productSummaryQ.data?.closing_stock ?? '-'}`} color="primary" />
              </Stack>
            </Paper>

            {renderLedgerTable(
              productRowsWithOpening,
              productLedgerQ.isLoading,
              Boolean(productLedgerQ.hasNextPage),
              () => productLedgerQ.fetchNextPage(),
              productLedgerQ.isFetchingNextPage
            )}
          </Stack>

          <Box sx={{ width: { xs: '100%', xl: 340 } }}>{renderSourceDetails()}</Box>
        </Stack>
      ) : null}

      {tab === 'batch' ? (
        <Stack direction={{ xs: 'column', xl: 'row' }} gap={1.5}>
          <Stack gap={2} sx={{ flex: 1 }}>
            <Paper sx={{ p: 1.5, borderRadius: 2.5 }}>
              <Stack direction={{ xs: 'column', md: 'row' }} gap={1.5} justifyContent="space-between">
                <Box>
                  <Typography variant="subtitle1" sx={{ fontWeight: 900 }}>
                    Batch Ledger
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    One batch at a time. No product totals mixed into the row view.
                  </Typography>
                </Box>
                <TextField
                  select
                  size="small"
                  label="Batch"
                  value={currentBatch?.id || ''}
                  onChange={(e) => setSelectedBatchId(Number(e.target.value) || null)}
                  sx={{ minWidth: 260 }}
                >
                  {batches.map((batch) => (
                    <MenuItem key={batch.id} value={batch.id}>
                      #{batch.id} • Exp {formatExpiry(batch.expiry_date)} • MRP {batch.mrp} • Stock {batch.stock}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>

              <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 1.25 }}>
                <Chip size="small" label={`Opening ${batchSummaryQ.data?.opening_stock ?? '-'}`} />
                <Chip size="small" label={`Inward ${batchSummaryQ.data?.inward_qty ?? '-'}`} variant="outlined" />
                <Chip size="small" label={`Outward ${batchSummaryQ.data?.outward_qty ?? '-'}`} variant="outlined" />
                <Chip size="small" label={`Closing ${batchSummaryQ.data?.closing_stock ?? '-'}`} color="primary" />
                <Tooltip
                  title={`Gap = current batch stock (${batchSummaryQ.data?.current_stock ?? '-'}) - total ledger movement balance for this batch.`}
                  arrow
                >
                  <Chip size="small" label={`Gap ${formatSigned(batchSummaryQ.data?.ledger_balance_gap ?? 0)}`} variant="outlined" />
                </Tooltip>
              </Stack>
            </Paper>

            {renderLedgerTable(
              batchRowsWithOpening,
              batchLedgerQ.isLoading,
              Boolean(batchLedgerQ.hasNextPage),
              () => batchLedgerQ.fetchNextPage(),
              batchLedgerQ.isFetchingNextPage
            )}
          </Stack>

          <Box sx={{ width: { xs: '100%', xl: 340 } }}>{renderSourceDetails()}</Box>
        </Stack>
      ) : null}

      {tab === 'batches' ? (
        <Paper sx={{ p: 1.5, borderRadius: 2.5 }}>
          <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1} sx={{ mb: 1.5 }}>
            <Box>
              <Typography variant="subtitle1" sx={{ fontWeight: 900 }}>
                Batches
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Clean snapshot of expiry, MRP, stock, rack, and quick drilldown.
              </Typography>
            </Box>
            <Stack direction="row" gap={1} flexWrap="wrap">
              <Chip size="small" label={`Total ${groupQ.data.total_batch_count}`} />
              <Chip size="small" label={`In stock ${groupQ.data.active_batch_count}`} variant="outlined" />
            </Stack>
          </Stack>

          <Box sx={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Batch</th>
                  <th>Expiry</th>
                  <th>MRP</th>
                  <th>Stock</th>
                  <th>Rack</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => {
                  const days = daysUntilExpiry(batch.expiry_date)
                  return (
                    <tr key={`batch-${batch.id}`}>
                      <td>#{batch.id}</td>
                      <td>
                        <Stack gap={0.2}>
                          <Typography>{formatExpiry(batch.expiry_date)}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {days == null ? '-' : `${days} days`}
                          </Typography>
                        </Stack>
                      </td>
                      <td>{batch.mrp}</td>
                      <td>{deltaChip(Number(batch.stock || 0))}</td>
                      <td>{batch.rack_number || 0}</td>
                      <td>
                        <Stack direction="row" gap={1} flexWrap="wrap">
                          {statusChip(Number(batch.stock || 0) > 0 ? 'In Stock' : 'Zero Stock', Number(batch.stock || 0) > 0 ? 'success' : 'default')}
                          {days != null && days <= 90 ? statusChip('Near Expiry', 'warning') : null}
                        </Stack>
                      </td>
                      <td>
                        <Stack direction="row" gap={1}>
                          <Button size="small" variant="outlined" onClick={() => openBatch(Number(batch.id))}>
                            Batch Ledger
                          </Button>
                          <Button size="small" onClick={openProductMaster}>
                            Product
                          </Button>
                        </Stack>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Box>
        </Paper>
      ) : null}
    </Stack>
  )
}
