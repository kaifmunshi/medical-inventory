import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  Link,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import CallMergeIcon from '@mui/icons-material/CallMerge'
import CloseIcon from '@mui/icons-material/Close'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import BillEditDialog from '../../components/billing/BillEditDialog'
import BillPaymentsPanel from '../../components/billing/BillPaymentsPanel'
import { getBill, type Bill } from '../../services/billing'
import {
  clubPurchaseBatchToOpening,
  deleteManualStockAdjustment,
  deleteOpeningStockMovement,
  getGroupLedger,
  getGroupLedgerSummary,
  getItemGroup,
  getStockLedgerReconciliation,
} from '../../services/inventory'
import {
  createBrand,
  createCategory,
  createProduct,
  deleteProduct,
  fetchBrands,
  fetchCategories,
  fetchProducts,
  updateProduct,
  type ProductPayload,
} from '../../services/products'
import {
  notifyProductMasterChanged,
  subscribeProductMasterChanged,
} from '../../lib/productMasterEvents'
import { buildStockReportLink } from '../../lib/reportLinks'
import { formatLedgerNote } from '../../lib/stockLedger'
import { useToast } from '../../components/ui/Toaster'

type StockCardTab = 'ledger' | 'batches'
type LedgerScope = 'product' | 'batch'

const LEDGER_LIMIT = 60

function formatExpiry(exp?: string | null) {
  if (!exp) return '-'
  const s = String(exp)
  const iso = s.length > 10 ? s.slice(0, 10) : s
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${d}-${m}-${y}`
}

function formatDateOnly(value?: string | null) {
  const raw = String(value || '')
  if (!raw) return '-'
  try {
    return new Date(raw).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return formatExpiry(raw)
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

function unitStockLabel(qty: number, unit?: string | null) {
  return `${Number(qty || 0)} ${String(unit || 'Unit').trim() || 'Unit'}`
}

function movementUnitLabel(row: any, fallbackUnit?: string | null) {
  const direct = row?.stock_unit_label
  const inferred = row?.is_loose_stock ? row?.child_unit_name : row?.parent_unit_name
  return String(direct || inferred || fallbackUnit || 'Unit').trim() || 'Unit'
}

function stockBreakdownForUnits(batches: any[], fallbackTotal: number) {
  const visibleBatches = batches.filter((batch) => !batch.is_archived)
  const activeBatches = visibleBatches.filter((batch) => Number(batch.stock || 0) !== 0)
  const hasLoose = visibleBatches.some((batch) => Boolean(batch.is_loose_stock))
  if (!hasLoose) {
    return {
      hasLoose: false,
      fallbackTotal,
      packQty: fallbackTotal,
      looseQty: 0,
      packUnit: 'Stock',
      looseUnit: 'Unit',
      conversionQty: 0,
      equivalentQty: fallbackTotal,
    }
  }

  const packQty = activeBatches
    .filter((batch) => !batch.is_loose_stock)
    .reduce((sum, batch) => sum + Number(batch.stock || 0), 0)
  const looseQty = activeBatches
    .filter((batch) => batch.is_loose_stock)
    .reduce((sum, batch) => sum + Number(batch.stock || 0), 0)
  const firstPack = visibleBatches.find((batch) => !batch.is_loose_stock)
  const firstLoose = visibleBatches.find((batch) => batch.is_loose_stock)
  const packUnit = firstPack?.stock_unit_label || firstPack?.parent_unit_name || 'Pack'
  const looseUnit = firstLoose?.stock_unit_label || firstLoose?.child_unit_name || 'Unit'
  const conversionQty = Number(firstLoose?.conversion_qty || firstPack?.conversion_qty || 0)
  return {
    hasLoose: true,
    fallbackTotal,
    packQty,
    looseQty,
    packUnit,
    looseUnit,
    conversionQty,
    equivalentQty: conversionQty > 0 ? packQty * conversionQty + looseQty : fallbackTotal,
  }
}

function movementTone(delta: number) {
  if (delta > 0) return 'success.main'
  if (delta < 0) return 'error.main'
  return 'text.primary'
}

function money(n: number | string | undefined | null) {
  return Number(n || 0).toFixed(2)
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

function computeBillProration(bill: any) {
  const items = (bill?.items || []) as any[]
  const sub = items.reduce((sum: number, item: any) => sum + Number(item.mrp) * Number(item.quantity), 0)
  const discPct = Number(bill?.discount_percent || 0)
  const taxPct = Number(bill?.tax_percent || 0)
  const afterDisc = sub - (sub * discPct) / 100
  const computedTotal = afterDisc + (afterDisc * taxPct) / 100
  const finalTotal = bill?.total_amount !== undefined && bill?.total_amount !== null ? Number(bill.total_amount) : computedTotal
  const factor = computedTotal > 0 ? finalTotal / computedTotal : 1
  return { discPct, taxPct, factor }
}

function chargedLine(bill: any, item: any) {
  if (item?.line_total !== undefined && item?.line_total !== null) return round2(Number(item.line_total || 0))
  const { factor } = computeBillProration(bill)
  return round2(Number(item?.mrp || 0) * Number(item?.quantity || 0) * factor)
}

function reasonLabel(reason: string) {
  const key = String(reason || '').toUpperCase()
  const labels: Record<string, string> = {
    OPENING: 'Opening',
    INVENTORY_ADD: 'Inventory Add',
    PURCHASE: 'Purchase In',
    PURCHASE_LINK: 'Purchase Link',
    PURCHASE_LINK_REMOVED: 'Purchase Link Removed',
    PURCHASE_LINK_CANCEL: 'Purchase Link Cancel',
    PURCHASE_CANCEL: 'Purchase Cancel',
    SALE: 'Sale Out',
    BILL_DELETE: 'Sale Cancel',
    BILL_RECOVER: 'Sale Restore',
    RETURN: 'Sales Return In',
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

function duplicateRepairKey(row: any) {
  const reasonKey = String(row?.reason || '').toUpperCase()
  const refType = String(row?.ref_type || '').toUpperCase()
  const refId = Number(row?.ref_id || 0)
  const itemId = Number(row?.item_id || 0)
  if (!refId || !itemId || refType !== 'PURCHASE') return null
  if (reasonKey !== 'PURCHASE' && reasonKey !== 'PURCHASE_DUPLICATE_REPAIR' && reasonKey !== 'PURCHASE_EDIT') return null
  return `${refId}:${itemId}`
}

function dateOnly(value: any) {
  return String(value || '').slice(0, 10)
}

function dayGap(fromValue: any, toValue: any) {
  const from = new Date(dateOnly(fromValue))
  const to = new Date(dateOnly(toValue))
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null
  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000))
}

function canMergePurchaseLinkSource(row: any, link: any) {
  const reasonKey = String(row?.reason || '').toUpperCase()
  const gap = dayGap(link?.ts, row?.ts)
  return (
    Number(row?.item_id || 0) === Number(link?.item_id || 0) &&
    Number(row?.delta || 0) > 0 &&
    (reasonKey === 'OPENING' || reasonKey === 'INVENTORY_ADD') &&
    gap !== null &&
    gap >= 0 &&
    gap <= 2
  )
}

function visibleStockBalance(value: any, hiddenDelta: number) {
  const adjusted = Number(value || 0) - hiddenDelta
  return Object.is(adjusted, -0) ? 0 : adjusted
}

function stockMovementAsc(a: any, b: any) {
  const at = String(a?.ts || '')
  const bt = String(b?.ts || '')
  if (at !== bt) return at.localeCompare(bt)
  return Number(a?.id || 0) - Number(b?.id || 0)
}

function adjustVisibleBalances(rows: any[], visibleRows: any[], hiddenIds: Set<number>) {
  if (!hiddenIds.size) return visibleRows

  const adjustedById = new Map<number, any>()
  let hiddenDelta = 0

  ;[...rows].sort(stockMovementAsc).forEach((row) => {
    const id = Number(row?.id || 0)
    if (hiddenIds.has(id)) {
      hiddenDelta += Number(row?.delta || 0)
      return
    }
    adjustedById.set(id, {
      ...row,
      balance_before: visibleStockBalance(row?.balance_before, hiddenDelta),
      balance_after: visibleStockBalance(row?.balance_after, hiddenDelta),
    })
  })

  return visibleRows.map((row) => adjustedById.get(Number(row?.id || 0)) || row)
}

function visibleStockCardRows(rows: any[]) {
  const hiddenCorrectionKeys = new Set<string>()

  rows.forEach((row) => {
    if (String(row?.reason || '').toUpperCase() === 'PURCHASE_DUPLICATE_REPAIR') {
      const key = duplicateRepairKey(row)
      if (key) hiddenCorrectionKeys.add(key)
    }
  })

  const purchaseEditKeys = new Set<string>(
    rows
      .filter((row) => String(row?.reason || '').toUpperCase() === 'PURCHASE_EDIT')
      .map(duplicateRepairKey)
      .filter((key): key is string => Boolean(key))
  )
  purchaseEditKeys.forEach((key) => {
    const purchaseEditNet = rows
      .filter((row) => duplicateRepairKey(row) === key)
      .filter((row) => {
        const reasonKey = String(row?.reason || '').toUpperCase()
        return reasonKey === 'PURCHASE' || reasonKey === 'PURCHASE_EDIT'
      })
      .reduce((sum, row) => sum + Number(row?.delta || 0), 0)
    if (purchaseEditNet === 0) hiddenCorrectionKeys.add(key)
  })

  const hiddenRowIds = new Set<number>()
  const correctionFilteredRows = hiddenCorrectionKeys.size ? rows.filter((row) => {
    const reasonKey = String(row?.reason || '').toUpperCase()
    const key = duplicateRepairKey(row)
    if (!key || !hiddenCorrectionKeys.has(key)) return true
    const shouldHide = reasonKey === 'PURCHASE' || reasonKey === 'PURCHASE_DUPLICATE_REPAIR' || reasonKey === 'PURCHASE_EDIT'
    if (shouldHide) hiddenRowIds.add(Number(row?.id || 0))
    return !shouldHide
  }) : rows
  const balanceAdjustedRows = adjustVisibleBalances(rows, correctionFilteredRows, hiddenRowIds)

  const purchaseLinks = balanceAdjustedRows.filter(
    (row) => String(row?.reason || '').toUpperCase() === 'PURCHASE_LINK'
  )
  if (!purchaseLinks.length) return balanceAdjustedRows

  const sourceById = new Map<number, any>()
  const mergedLinkIds = new Set<number>()
  purchaseLinks.forEach((link) => {
    const source = balanceAdjustedRows.find((row) => canMergePurchaseLinkSource(row, link))
    if (!source) return
    sourceById.set(Number(source.id), {
      ...source,
      ts: link.ts || source.ts,
      reason: 'PURCHASE_LINK',
      ref_type: link.ref_type,
      ref_id: link.ref_id,
      note: null,
      actor: link.actor || source.actor,
      merged_purchase_link: true,
    })
    mergedLinkIds.add(Number(link.id))
  })

  if (!sourceById.size) return balanceAdjustedRows

  return balanceAdjustedRows
    .filter((row) => !mergedLinkIds.has(Number(row.id)))
    .map((row) => sourceById.get(Number(row.id)) || row)
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
          ? { bgcolor: 'rgba(46,125,50,0.14)', color: movementTone(delta) }
          : isNeg
            ? { bgcolor: 'rgba(211,47,47,0.14)', color: movementTone(delta) }
            : { bgcolor: 'rgba(0,0,0,0.08)' }),
      }}
    />
  )
}

function unitDeltaChip(delta: number, unit?: string | null) {
  const labelUnit = String(unit || 'Unit').trim() || 'Unit'
  const isPos = delta > 0
  const isNeg = delta < 0
  return (
    <Chip
      size="small"
      label={`${formatSigned(delta)} ${labelUnit}`}
      sx={{
        borderRadius: 999,
        fontWeight: 900,
        ...(isPos
          ? { bgcolor: 'rgba(46,125,50,0.14)', color: movementTone(delta) }
          : isNeg
            ? { bgcolor: 'rgba(211,47,47,0.14)', color: movementTone(delta) }
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

function findExactProduct(products: any[], name?: string, brand?: string, categoryId?: number | null) {
  const nameKey = String(name || '').trim().toLowerCase()
  const brandKey = String(brand || '').trim().toLowerCase()
  const hasCategory = categoryId !== undefined
  const categoryKey = Number(categoryId || 0)
  const matches = products.filter((product) => (
    String(product?.name || '').trim().toLowerCase() === nameKey
    && String(product?.brand || '').trim().toLowerCase() === brandKey
    && (!hasCategory || Number(product?.category_id || 0) === categoryKey)
  ))
  return matches.find((product) => product?.is_active !== false) || matches[0] || null
}

function inventoryReturnPath(raw?: string | null) {
  const value = String(raw || '').trim()
  return value.startsWith('/inventory') && !value.startsWith('//') ? value : '/inventory'
}

function canRemoveOpeningRow(row: any) {
  return (
    !row?.is_synthetic_opening &&
    String(row?.reason || '').toUpperCase() === 'OPENING' &&
    String(row?.ref_type || '').toUpperCase() === 'ITEM_CREATE' &&
    Number(row?.delta || 0) > 0 &&
    Number(row?.item_id || 0) > 0
  )
}

function canRemoveManualAdjustRow(row: any) {
  return (
    !row?.is_synthetic_opening &&
    String(row?.reason || '').toUpperCase() === 'ADJUST' &&
    String(row?.ref_type || '').toUpperCase() === 'MANUAL' &&
    Number(row?.delta || 0) !== 0 &&
    Number(row?.item_id || 0) > 0
  )
}

export default function StockCardPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useToast()
  const [searchParams] = useSearchParams()
  const name = (searchParams.get('name') || '').trim()
  const brand = (searchParams.get('brand') || '').trim()
  const requestedBatchId = Number(searchParams.get('batchId') || 0) || null
  const requestedTab = (searchParams.get('tab') || '').trim()
  const returnTo = inventoryReturnPath(searchParams.get('returnTo'))

  const [tab, setTab] = useState<StockCardTab>(
    requestedTab === 'batches' ? 'batches' : 'ledger'
  )
  const [ledgerScope, setLedgerScope] = useState<LedgerScope>(
    requestedTab === 'batch' || requestedBatchId ? 'batch' : 'product'
  )
  const [from, setFrom] = useState(() => toDateInput(30))
  const [to, setTo] = useState(() => toDateInput(0))
  const [reason, setReason] = useState('')

  useEffect(() => {
    return subscribeProductMasterChanged(() => {
      queryClient.invalidateQueries({ queryKey: ['stock-card-products'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-group'] })
      queryClient.invalidateQueries({ queryKey: ['stock-card-brands'] })
      queryClient.invalidateQueries({ queryKey: ['stock-card-categories'] })
    })
  }, [queryClient])
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(requestedBatchId)
  const [selectedMovementId, setSelectedMovementId] = useState<number | null>(null)
  const [billOpen, setBillOpen] = useState(false)
  const [billLoading, setBillLoading] = useState(false)
  const [billDetail, setBillDetail] = useState<Bill | null>(null)
  const [billEditOpen, setBillEditOpen] = useState(false)
  const [productOpen, setProductOpen] = useState(false)
  const [productId, setProductId] = useState<number | null>(null)
  const [productOrigin, setProductOrigin] = useState<{ id: number | null; name: string; brand: string } | null>(null)
  const [productBrandOpen, setProductBrandOpen] = useState(false)
  const [productCategoryOpen, setProductCategoryOpen] = useState(false)
  const [productBrandName, setProductBrandName] = useState('')
  const [productCategoryName, setProductCategoryName] = useState('')
  const [clubOpen, setClubOpen] = useState(false)
  const [clubSourceBatch, setClubSourceBatch] = useState<any | null>(null)
  const [clubTargetBatchId, setClubTargetBatchId] = useState<number | ''>('')
  const [clubAdoptPurchaseDetails, setClubAdoptPurchaseDetails] = useState(false)
  const [productForm, setProductForm] = useState<ProductPayload>({
    name: '',
    brand: '',
    category_id: undefined,
    default_rack_number: 0,
    printed_price: 0,
    loose_sale_enabled: false,
    parent_unit_name: '',
    child_unit_name: '',
    default_conversion_qty: undefined,
  })

  const groupQ = useQuery({
    queryKey: ['inventory-group', name, brand],
    queryFn: () => getItemGroup({ name, brand }),
    enabled: !!name,
  })

  const batches = groupQ.data?.batches || []
  const clubTargetOptions = useMemo(
    () => batches.filter((batch) => Number(batch.id) !== Number(clubSourceBatch?.id || 0)),
    [batches, clubSourceBatch?.id],
  )
  const brandsQ = useQuery({
    queryKey: ['stock-card-brands'],
    queryFn: () => fetchBrands({ active_only: true }),
    enabled: productOpen,
  })
  const categoriesQ = useQuery({
    queryKey: ['stock-card-categories'],
    queryFn: () => fetchCategories({ active_only: true }),
    enabled: productOpen,
  })
  const productsQ = useQuery({
    queryKey: ['stock-card-products', name],
    queryFn: () => fetchProducts({ q: name, active_only: true, limit: 2000 }),
    enabled: false,
  })
  const productMatch = useMemo(() => {
    const nameKey = name.trim().toLowerCase()
    const brandKey = brand.trim().toLowerCase()
    return (productsQ.data || []).find((product) => (
      String(product.name || '').trim().toLowerCase() === nameKey
      && String(product.brand || '').trim().toLowerCase() === brandKey
    )) || null
  }, [brand, name, productsQ.data])
  const stockBreakdown = useMemo(
    () => stockBreakdownForUnits(batches, Number(groupQ.data?.total_stock || 0)),
    [batches, groupQ.data?.total_stock],
  )
  const stockCardProductId = useMemo(() => {
    const batchProductId = batches.find((batch) => Number(batch.product_id || 0) > 0)?.product_id
    if (batchProductId) return Number(batchProductId)
    return productMatch?.id ? Number(productMatch.id) : null
  }, [batches, productMatch?.id])
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
  const visibleProductRows = useMemo(() => visibleStockCardRows(productRows), [productRows])
  const visibleBatchRows = useMemo(() => visibleStockCardRows(batchRows), [batchRows])

  function inferredOpeningRow(summary: any, batch?: any | null) {
    const opening = Number(summary?.opening_stock || 0)
    if (!summary || opening === 0) return null
    if (reason && reason !== 'OPENING') return null
    return {
      id: batch?.id ? -Number(batch.id) : -999999,
      ts: summary.from_date ? `${summary.from_date}T00:00:00` : '',
      delta: opening,
      reason: 'OPENING',
      ref_type: null,
      ref_id: null,
      note: summary.from_date
        ? 'Opening balance for selected period'
        : 'Opening stock carried before recorded create/purchase movements',
      actor: 'system',
      item_id: batch?.id || 0,
      expiry_date: batch?.expiry_date || null,
      mrp: batch?.mrp ?? null,
      rack_number: batch?.rack_number ?? null,
      balance_before: 0,
      balance_after: opening,
      is_synthetic_opening: true,
    }
  }

  const productRowsWithOpening = useMemo(() => {
    const opening = inferredOpeningRow(productSummaryQ.data, null)
    if (!opening || productLedgerQ.hasNextPage) return visibleProductRows
    return [...visibleProductRows, opening]
  }, [visibleProductRows, productSummaryQ.data, productLedgerQ.hasNextPage, reason])

  const batchRowsWithOpening = useMemo(() => {
    const opening = inferredOpeningRow(batchSummaryQ.data, currentBatch)
    if (!opening || batchLedgerQ.hasNextPage) return visibleBatchRows
    return [...visibleBatchRows, opening]
  }, [visibleBatchRows, batchSummaryQ.data, currentBatch, batchLedgerQ.hasNextPage, reason])

  const activeRows = ledgerScope === 'batch' ? batchRowsWithOpening : productRowsWithOpening

  useEffect(() => {
    if (!activeRows.length) {
      setSelectedMovementId(null)
      return
    }
    if (!selectedMovementId || !activeRows.some((row) => Number(row.id) === Number(selectedMovementId))) {
      setSelectedMovementId(Number(activeRows[0].id))
    }
  }, [activeRows, ledgerScope, selectedMovementId])

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
  const looseStockEnabled = Boolean(
    productMatch?.loose_sale_enabled ||
    stockBreakdown.hasLoose ||
    batches.some((batch) => Boolean(batch.loose_sale_enabled))
  )

  function openLooseStockPage() {
    const params = new URLSearchParams()
    if (stockCardProductId) params.set('product_id', String(stockCardProductId))
    if (name) params.set('q', name)
    params.set('filter', 'all')
    navigate(`/loose-stock?${params.toString()}`)
  }

  const mSaveProduct = useMutation({
    mutationFn: async () => {
      const payload: ProductPayload = {
        ...productForm,
        name: productForm.name.trim(),
        brand: productForm.brand?.trim() || undefined,
        category_id: productForm.category_id || undefined,
        default_rack_number: Number(productForm.default_rack_number || 0),
        printed_price: Number(productForm.printed_price || 0),
        parent_unit_name: productForm.loose_sale_enabled ? productForm.parent_unit_name?.trim() || 'Pack' : undefined,
        child_unit_name: productForm.loose_sale_enabled ? productForm.child_unit_name?.trim() || 'Unit' : undefined,
        default_conversion_qty: productForm.loose_sale_enabled ? Number(productForm.default_conversion_qty || 1) : undefined,
      }
      let targetId = productId || productOrigin?.id || null
      if (!targetId) {
        const originName = productOrigin?.name || payload.name
        const originBrand = productOrigin?.brand ?? (payload.brand || '')
        const knownOriginMatch = findExactProduct(productsQ.data || [], originName, originBrand, payload.category_id ?? null)
        const freshOriginMatch = knownOriginMatch || findExactProduct(
          await fetchProducts({ q: originName, active_only: false, limit: 1000 }),
          originName,
          originBrand,
          payload.category_id ?? null,
        )
        const knownPayloadMatch = freshOriginMatch || findExactProduct(productsQ.data || [], payload.name, payload.brand, payload.category_id ?? null)
        const freshPayloadMatch = knownPayloadMatch || findExactProduct(
          await fetchProducts({ q: payload.name, active_only: false, limit: 1000 }),
          payload.name,
          payload.brand,
          payload.category_id ?? null,
        )
        targetId = freshPayloadMatch?.id ? Number(freshPayloadMatch.id) : null
      }
      return targetId ? updateProduct(targetId, payload) : createProduct(payload)
    },
    onSuccess: (savedProduct) => {
      setProductId(Number(savedProduct.id))
      setProductOrigin({
        id: Number(savedProduct.id),
        name: savedProduct.name,
        brand: savedProduct.brand || '',
      })
      setProductForm({
        name: savedProduct.name,
        brand: savedProduct.brand || '',
        category_id: savedProduct.category_id || undefined,
        default_rack_number: savedProduct.default_rack_number ?? 0,
        printed_price: savedProduct.printed_price ?? 0,
        loose_sale_enabled: Boolean(savedProduct.loose_sale_enabled),
        parent_unit_name: savedProduct.parent_unit_name || '',
        child_unit_name: savedProduct.child_unit_name || '',
        default_conversion_qty: savedProduct.default_conversion_qty || undefined,
      })
      setProductOpen(false)
      queryClient.invalidateQueries({ queryKey: ['stock-card-products'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-group'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-products-master'] })
      queryClient.invalidateQueries({ queryKey: ['lots'] })
      queryClient.invalidateQueries({ queryKey: ['products-master'] })
      queryClient.invalidateQueries({ queryKey: ['billing-items'] })
      queryClient.invalidateQueries({ queryKey: ['billing-product-categories'] })
      notifyProductMasterChanged()
      toast.push('Product master saved', 'success')
    },
    onError: (err: any) => {
      toast.push(String(err?.message || 'Product save failed'), 'error')
    },
  })

  function saveProductMaster() {
    if (mSaveProduct.isPending || mDeleteProduct.isPending) return
    if (!productForm.name.trim()) {
      toast.push('Product name is required', 'warning')
      return
    }
    mSaveProduct.mutate()
  }

  const mDeleteProduct = useMutation({
    mutationFn: (id: number) => deleteProduct(id),
    onSuccess: () => {
      setProductOpen(false)
      setProductId(null)
      setProductOrigin(null)
      queryClient.invalidateQueries({ queryKey: ['stock-card-products'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-group'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
      queryClient.invalidateQueries({ queryKey: ['inventory-products-master'] })
      queryClient.invalidateQueries({ queryKey: ['products-master'] })
      queryClient.invalidateQueries({ queryKey: ['lots'] })
      queryClient.invalidateQueries({ queryKey: ['billing-items'] })
      queryClient.invalidateQueries({ queryKey: ['billing-product-categories'] })
      notifyProductMasterChanged()
      toast.push('Product deleted', 'success')
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || err?.message || 'Product delete failed'
      toast.push(String(msg), 'error')
    },
  })

  const mCreateProductBrand = useMutation({
    mutationFn: createBrand,
    onSuccess: (brandRow) => {
      setProductForm((prev) => ({ ...prev, brand: brandRow.name }))
      setProductBrandName('')
      setProductBrandOpen(false)
      queryClient.invalidateQueries({ queryKey: ['stock-card-brands'] })
      queryClient.invalidateQueries({ queryKey: ['brand-master'] })
      notifyProductMasterChanged()
      toast.push('Brand added', 'success')
    },
    onError: (err: any) => {
      toast.push(String(err?.message || 'Failed to add brand'), 'error')
    },
  })

  const mCreateProductCategory = useMutation({
    mutationFn: createCategory,
    onSuccess: (category) => {
      setProductForm((prev) => ({ ...prev, category_id: Number(category.id) }))
      setProductCategoryName('')
      setProductCategoryOpen(false)
      queryClient.invalidateQueries({ queryKey: ['stock-card-categories'] })
      queryClient.invalidateQueries({ queryKey: ['product-categories-master'] })
      queryClient.invalidateQueries({ queryKey: ['billing-product-categories'] })
      notifyProductMasterChanged()
      toast.push('Category added', 'success')
    },
    onError: (err: any) => {
      toast.push(String(err?.message || 'Failed to add category'), 'error')
    },
  })

  function setProductLooseSaleEnabled(next: boolean) {
    if (!next && productForm.loose_sale_enabled) {
      const ok = window.confirm(
        'Disable loose stock for this product? New parent units cannot be opened after this, but existing loose stock, bills, returns, and ledgers will remain usable.'
      )
      if (!ok) return
    }
    setProductForm((prev) => ({ ...prev, loose_sale_enabled: next }))
  }

  async function openProductMaster() {
    const batch = currentBatch || batches[0]
    let product = null
    try {
      product = findExactProduct(
        await fetchProducts({ q: name, active_only: false, limit: 1000 }),
        name,
        brand,
        (batch as any)?.category_id ?? null,
      )
    } catch {
      product = productMatch
    }
    const linkedProductId =
      Number(batch?.product_id || 0) ||
      Number(stockCardProductId || 0) ||
      Number(product?.id || 0) ||
      null
    setProductId(linkedProductId)
    setProductOrigin({ id: linkedProductId, name, brand })
    setProductForm({
      name,
      brand,
      category_id: product?.category_id || undefined,
      default_rack_number: product?.default_rack_number ?? Number(batch?.rack_number || 0),
      printed_price: product?.printed_price ?? Number(batch?.mrp || 0),
      loose_sale_enabled: Boolean(product?.loose_sale_enabled),
      parent_unit_name: product?.parent_unit_name || '',
      child_unit_name: product?.child_unit_name || '',
      default_conversion_qty: product?.default_conversion_qty || undefined,
    })
    setProductOpen(true)
  }

  async function openBillDetail(billId: number) {
    if (!Number.isFinite(Number(billId)) || Number(billId) <= 0) return
    setBillOpen(true)
    setBillLoading(true)
    setBillDetail(null)
    try {
      const bill = await getBill(Number(billId))
      setBillDetail(bill)
    } catch {
      setBillDetail(null)
    } finally {
      setBillLoading(false)
    }
  }

  function refreshLedgerAfterBillChange(updatedBill?: Bill | null) {
    if (updatedBill) setBillDetail(updatedBill)
    queryClient.invalidateQueries({ queryKey: ['stock-card-product-ledger'] })
    queryClient.invalidateQueries({ queryKey: ['stock-card-batch-ledger'] })
    queryClient.invalidateQueries({ queryKey: ['inventory-group-summary'] })
    queryClient.invalidateQueries({ queryKey: ['inventory-group'] })
    queryClient.invalidateQueries({ queryKey: ['inventory-dashboard-stats'] })
  }

  const mDeleteOpening = useMutation({
    mutationFn: (movementId: number) => deleteOpeningStockMovement(movementId),
    onSuccess: (result) => {
      setSelectedMovementId(null)
      refreshLedgerAfterBillChange()
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
      queryClient.invalidateQueries({ queryKey: ['lots'] })
      toast.push(`Removed opening stock ${Number(result?.removed_qty || 0)}`, 'success')
    },
    onError: (err: any) => {
      toast.push(String(err?.message || 'Opening stock could not be removed'), 'error')
    },
  })

  const mDeleteManualAdjust = useMutation({
    mutationFn: (movementId: number) => deleteManualStockAdjustment(movementId),
    onSuccess: (result) => {
      setSelectedMovementId(null)
      refreshLedgerAfterBillChange()
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
      queryClient.invalidateQueries({ queryKey: ['lots'] })
      toast.push(`Deleted manual adjustment ${formatSigned(Number(result?.reversed_delta || 0))}`, 'success')
    },
    onError: (err: any) => {
      toast.push(String(err?.message || 'Manual stock adjustment could not be deleted'), 'error')
    },
  })

  const mClubOpening = useMutation({
    mutationFn: () => {
      if (!clubSourceBatch || !clubTargetBatchId) throw new Error('Select the OP batch to keep')
      return clubPurchaseBatchToOpening({
        source_item_id: Number(clubSourceBatch.id),
        target_item_id: Number(clubTargetBatchId),
        adopt_purchase_details: clubAdoptPurchaseDetails,
      })
    },
    onSuccess: (result) => {
      setClubOpen(false)
      setClubSourceBatch(null)
      setClubTargetBatchId('')
      setClubAdoptPurchaseDetails(false)
      setSelectedBatchId(Number(result.target_item_id))
      refreshLedgerAfterBillChange()
      queryClient.invalidateQueries({ queryKey: ['inventory-items'] })
      queryClient.invalidateQueries({ queryKey: ['lots'] })
      queryClient.invalidateQueries({ queryKey: ['purchases'] })
      toast.push(`Clubbed batch #${result.source_item_id} into #${result.target_item_id}`, 'success')
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail || err?.message || 'Batch could not be clubbed'
      toast.push(String(detail), 'error')
    },
  })

  function openClubDialog(batch: any) {
    const fallbackTarget = batches.find((row) => Number(row.id) !== Number(batch.id))
    setClubSourceBatch(batch)
    setClubTargetBatchId(fallbackTarget?.id ? Number(fallbackTarget.id) : '')
    setClubAdoptPurchaseDetails(false)
    setClubOpen(true)
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
    setLedgerScope('batch')
    setTab('ledger')
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

  function ledgerSourceLink(row: any) {
    const refId = Number(row.ref_id || 0) || null
    const refType = String(row.ref_type || '').toUpperCase()
    const reasonKey = String(row.reason || '').toUpperCase()
    if (!refId) return null
    if (refType === 'BILL') {
      return { kind: 'bill' as const, id: refId }
    }
    if (refType === 'PURCHASE') {
      return { kind: 'purchase' as const, id: refId }
    }
    if (refType === 'EXCHANGE' && reasonKey === 'EXCHANGE_OUT') {
      return { kind: 'bill' as const, id: refId }
    }
    return null
  }

  function renderLedgerTable(rows: any[], loading: boolean, hasMore: boolean, onLoadMore: () => void, loadingMore: boolean) {
    const mixedProductUnits = ledgerScope === 'product' && stockBreakdown.hasLoose

    const balanceCell = (row: any, value: number, tone: string) => {
      if (mixedProductUnits) {
        return (
          <Tooltip title="Product view mixes pack and loose stock; use Batch view for exact running balance." arrow>
            <Typography sx={{ color: 'text.secondary', fontWeight: 800, display: 'inline-flex' }}>
              Mixed
            </Typography>
          </Tooltip>
        )
      }

      const unit = ledgerScope === 'batch' ? movementUnitLabel(row, currentBatch?.stock_unit_label) : null
      return (
        <Typography sx={{ color: tone, fontWeight: 800 }}>
          {unit ? unitStockLabel(value, unit) : Number(value || 0)}
        </Typography>
      )
    }

    return (
      <Paper variant="outlined" sx={{ borderRadius: 2.5, overflow: 'hidden' }}>
        <Box sx={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Batch</th>
                <th>Particulars</th>
                <th>Op Bal</th>
                <th>Qty</th>
                <th>Cl Bal</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 8 }).map((_, index) => (
                  <tr key={`sk-${index}`}>
                    <td colSpan={7}>
                      <Box py={0.75}>
                        <Skeleton variant="rounded" height={34} />
                      </Box>
                    </td>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <Box p={2} color="text.secondary">
                      No ledger rows for the selected range.
                    </Box>
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const selected = Number(row.id) === Number(selectedMovementId)
                  const formattedNote = row.merged_purchase_link ? '' : formatLedgerNote(row.note)
                  const refLabel = row.ref_type ? `${row.ref_type}${row.ref_id ? ` #${row.ref_id}` : ''}` : ''
                  const sourceLink = ledgerSourceLink(row)
                  const delta = Number(row.delta || 0)
                  const tone = movementTone(delta)
                  const removableOpening = canRemoveOpeningRow(row)
                  const removableManualAdjust = canRemoveManualAdjustRow(row)
                  const rowUnit = movementUnitLabel(row, currentBatch?.stock_unit_label)
                  return (
                    <tr
                      key={`row-${row.id}`}
                      onClick={() => setSelectedMovementId(Number(row.id))}
                      style={{
                        cursor: 'pointer',
                        background: selected ? 'rgba(20,92,59,0.08)' : undefined,
                      }}
                    >
                      <td>
                        <Typography sx={{ fontWeight: 800 }}>
                          {row.is_synthetic_opening ? 'Opening' : formatDateOnly(row.ts)}
                        </Typography>
                      </td>
                      <td>
                        <Stack gap={0.2}>
                          <Stack direction="row" gap={0.6} alignItems="center" flexWrap="wrap">
                            <Typography sx={{ fontWeight: 800 }}>
                              {Number(row.item_id || 0) > 0 ? `#${row.item_id}` : 'Product'}
                            </Typography>
                            {stockBreakdown.hasLoose && Number(row.item_id || 0) > 0 ? (
                              <Chip
                                size="small"
                                label={row.is_loose_stock ? 'Loose' : 'Pack'}
                                variant="outlined"
                                sx={{ height: 20, fontSize: 11, fontWeight: 800 }}
                              />
                            ) : null}
                          </Stack>
                          <Typography variant="caption" color="text.secondary">
                            Exp {formatExpiry(row.expiry_date)} • MRP {row.mrp ?? '-'}
                          </Typography>
                        </Stack>
                      </td>
                      <td style={{ maxWidth: 340, whiteSpace: 'normal', wordBreak: 'break-word' }}>
                        <Stack gap={0.2}>
                          <Typography sx={{ fontWeight: 800 }}>{reasonLabel(row.reason)}</Typography>
                          {refLabel || formattedNote ? (
                            <Typography variant="caption" color="text.secondary" component="div">
                              {sourceLink && refLabel ? (
                                <Link
                                  component="button"
                                  underline="hover"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    if (sourceLink.kind === 'bill') openBillDetail(sourceLink.id)
                                    else navigate(`/purchases?purchase_id=${sourceLink.id}`)
                                  }}
                                  sx={{
                                    border: 0,
                                    p: 0,
                                    font: 'inherit',
                                    fontWeight: 800,
                                    verticalAlign: 'baseline',
                                  }}
                                >
                                  {refLabel}
                                </Link>
                              ) : (
                                refLabel
                              )}
                              {refLabel && formattedNote ? ' | ' : ''}
                              {formattedNote || ''}
                            </Typography>
                          ) : null}
                        </Stack>
                      </td>
                      <td>{balanceCell(row, Number(row.balance_before || 0), tone)}</td>
                      <td>{mixedProductUnits || ledgerScope === 'batch' ? unitDeltaChip(delta, rowUnit) : deltaChip(delta)}</td>
                      <td>{balanceCell(row, Number(row.balance_after || 0), tone)}</td>
                      <td>
                        {removableOpening ? (
                          <Tooltip title="Remove opening only when this batch has no sales or other stock movements" arrow>
                            <span>
                              <IconButton
                                size="small"
                                color="error"
                                disabled={mDeleteOpening.isPending}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  const ok = window.confirm(
                                    `Remove opening stock ${delta} from batch #${row.item_id}? This is only allowed when the batch has no sales or other movements.`
                                  )
                                  if (ok) mDeleteOpening.mutate(Number(row.id))
                                }}
                              >
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        ) : removableManualAdjust ? (
                          <Tooltip title="Delete this manual stock adjustment" arrow>
                            <span>
                              <IconButton
                                size="small"
                                color="error"
                                disabled={mDeleteManualAdjust.isPending}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  const ok = window.confirm(
                                    `Delete manual stock adjustment ${formatSigned(delta)} from batch #${row.item_id}? Stock will be reversed by ${formatSigned(-delta)}.`
                                  )
                                  if (ok) mDeleteManualAdjust.mutate(Number(row.id))
                                }}
                              >
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        ) : null}
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
  const ledgerSummary = ledgerScope === 'batch' ? batchSummaryQ.data : productSummaryQ.data
  const ledgerSummaryLoading = ledgerScope === 'batch' ? batchSummaryQ.isLoading : productSummaryQ.isLoading
  const ledgerRows = ledgerScope === 'batch' ? batchRowsWithOpening : productRowsWithOpening
  const ledgerLoading = ledgerScope === 'batch' ? batchLedgerQ.isLoading : productLedgerQ.isLoading
  const ledgerHasMore = ledgerScope === 'batch' ? Boolean(batchLedgerQ.hasNextPage) : Boolean(productLedgerQ.hasNextPage)
  const ledgerLoadingMore = ledgerScope === 'batch' ? batchLedgerQ.isFetchingNextPage : productLedgerQ.isFetchingNextPage
  const loadMoreLedger = ledgerScope === 'batch' ? () => batchLedgerQ.fetchNextPage() : () => productLedgerQ.fetchNextPage()
  const mixedLedgerSummary = ledgerScope === 'product' && stockBreakdown.hasLoose
  const ledgerSummaryUnit = ledgerScope === 'batch' && currentBatch ? movementUnitLabel(currentBatch, currentBatch.stock_unit_label) : null
  const ledgerSummaryQty = (value?: number | null) => {
    if (value == null) return '-'
    return ledgerSummaryUnit ? unitStockLabel(Number(value || 0), ledgerSummaryUnit) : Number(value || 0)
  }

  return (
    <>
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
              <Button size="small" startIcon={<ArrowBackIcon />} variant="outlined" onClick={() => navigate(returnTo)}>
                Inventory
              </Button>
              <Button size="small" startIcon={<Inventory2OutlinedIcon />} variant="outlined" onClick={openProductMaster}>
                Edit Product
              </Button>
              {looseStockEnabled ? (
                <Button size="small" startIcon={<Inventory2OutlinedIcon />} variant="outlined" onClick={openLooseStockPage}>
                  Loose Stock
                </Button>
              ) : null}
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
            {stockBreakdown.hasLoose ? (
              <>
                {summaryMetric(
                  `${stockBreakdown.packUnit} Stock`,
                  String(stockBreakdown.packQty),
                  unitStockLabel(stockBreakdown.packQty, stockBreakdown.packUnit)
                )}
                {summaryMetric(
                  `${stockBreakdown.looseUnit} Stock`,
                  String(stockBreakdown.looseQty),
                  unitStockLabel(stockBreakdown.looseQty, stockBreakdown.looseUnit)
                )}
                {stockBreakdown.conversionQty > 0 ? summaryMetric(
                  'Equivalent',
                  unitStockLabel(stockBreakdown.equivalentQty, stockBreakdown.looseUnit),
                  `${stockBreakdown.packQty} ${stockBreakdown.packUnit} x ${stockBreakdown.conversionQty} + ${stockBreakdown.looseQty} ${stockBreakdown.looseUnit}`
                ) : null}
              </>
            ) : (
              summaryMetric('Stock', String(groupQ.data.total_stock))
            )}
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
              <MenuItem value="INVENTORY_ADD">Inventory Add</MenuItem>
              <MenuItem value="OPENING">Opening</MenuItem>
              <MenuItem value="PURCHASE">Purchase</MenuItem>
              <MenuItem value="PURCHASE_CANCEL">Purchase Cancel</MenuItem>
              <MenuItem value="SALE">Sale</MenuItem>
              <MenuItem value="BILL_DELETE">Sale Cancel</MenuItem>
              <MenuItem value="BILL_RECOVER">Sale Restore</MenuItem>
              <MenuItem value="RETURN">Sales Return</MenuItem>
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
          onChange={(_, value) => value && setTab(value)}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ minHeight: 44, '& .MuiTab-root': { minHeight: 44 } }}
        >
          <Tab value="ledger" icon={<ReceiptLongIcon fontSize="small" />} iconPosition="start" label="Ledger" />
          <Tab value="batches" icon={<Inventory2OutlinedIcon fontSize="small" />} iconPosition="start" label="Batches" />
        </Tabs>
      </Paper>

      {tab === 'ledger' ? (
        <Stack direction={{ xs: 'column', xl: 'row' }} gap={1.5}>
          <Stack gap={2} sx={{ flex: 1 }}>
            <Paper sx={{ p: 1.5, borderRadius: 2.5 }}>
              <Stack direction={{ xs: 'column', md: 'row' }} gap={1.5} justifyContent="space-between">
                <Box>
                  <Typography variant="subtitle1" sx={{ fontWeight: 900 }}>
                    Stock Ledger
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {ledgerScope === 'batch'
                      ? 'Selected batch movement with opening and closing balance.'
                      : `Combined movement across all batches for ${groupQ.data.name}.`}
                  </Typography>
                </Box>
                <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} alignItems={{ xs: 'stretch', sm: 'center' }}>
                  <ToggleButtonGroup
                    size="small"
                    exclusive
                    value={ledgerScope}
                    onChange={(_, value: LedgerScope | null) => {
                      if (value) setLedgerScope(value)
                    }}
                  >
                    <ToggleButton value="product">Product</ToggleButton>
                    <ToggleButton value="batch">Batch</ToggleButton>
                  </ToggleButtonGroup>
                  {ledgerScope === 'batch' ? (
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
                          #{batch.id} • Exp {formatExpiry(batch.expiry_date)} • MRP {batch.mrp} • Stock {unitStockLabel(Number(batch.stock || 0), batch.stock_unit_label)}
                        </MenuItem>
                      ))}
                    </TextField>
                  ) : null}
                </Stack>
              </Stack>

              <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 1.25 }}>
                {ledgerSummaryLoading ? (
                  Array.from({ length: 5 }).map((_, index) => <Skeleton key={`ls-${index}`} variant="rounded" height={24} width={96} />)
                ) : (
                  <>
                    <Chip size="small" label={`Opening ${mixedLedgerSummary ? 'Mixed' : ledgerSummaryQty(ledgerSummary?.opening_stock)}`} />
                    <Chip size="small" label={`Inward ${mixedLedgerSummary ? 'Mixed' : ledgerSummaryQty(ledgerSummary?.inward_qty)}`} variant="outlined" />
                    <Chip size="small" label={`Outward ${mixedLedgerSummary ? 'Mixed' : ledgerSummaryQty(ledgerSummary?.outward_qty)}`} variant="outlined" />
                    <Chip size="small" label={`Closing ${mixedLedgerSummary ? 'Mixed' : ledgerSummaryQty(ledgerSummary?.closing_stock)}`} color="primary" />
                    <Chip size="small" label={`Movements ${ledgerSummary?.movement_count ?? 0}`} variant="outlined" />
                  </>
                )}
                <Tooltip
                  title={
                    mixedLedgerSummary
                      ? 'Gap is hidden here because product view mixes pack and loose stock.'
                      : `Gap = current stock (${ledgerSummary?.current_stock ?? '-'}) - total ledger movement balance.`
                  }
                  arrow
                >
                  <Chip size="small" label={mixedLedgerSummary ? 'Gap Mixed' : `Gap ${formatSigned(ledgerSummary?.ledger_balance_gap ?? 0)}`} variant="outlined" />
                </Tooltip>
              </Stack>
            </Paper>

            {renderLedgerTable(
              ledgerRows,
              ledgerLoading,
              ledgerHasMore,
              loadMoreLedger,
              ledgerLoadingMore
            )}
          </Stack>
          {/* Movement Inspector intentionally hidden; source links now live in ledger rows. */}
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
                      <td>
                        <Chip
                          size="small"
                          label={unitStockLabel(Number(batch.stock || 0), batch.stock_unit_label)}
                          color={Number(batch.stock || 0) > 0 ? 'success' : 'default'}
                          variant="outlined"
                        />
                      </td>
                      <td>{batch.rack_number || 0}</td>
                      <td>
                        <Stack direction="row" gap={1} flexWrap="wrap">
                          {statusChip(batch.is_loose_stock ? 'Loose' : 'Pack', batch.is_loose_stock ? 'info' : 'default')}
                          {statusChip(Number(batch.stock || 0) > 0 ? 'In Stock' : 'Zero Stock', Number(batch.stock || 0) > 0 ? 'success' : 'default')}
                          {days != null && days <= 90 ? statusChip('Near Expiry', 'warning') : null}
                        </Stack>
                      </td>
                      <td>
                        <Stack direction="row" gap={1} flexWrap="wrap">
                          <Button size="small" variant="outlined" onClick={() => openBatch(Number(batch.id))}>
                            Batch Ledger
                          </Button>
                          <Button
                            size="small"
                            color="warning"
                            variant="outlined"
                            startIcon={<CallMergeIcon fontSize="small" />}
                            onClick={() => openClubDialog(batch)}
                          >
                            Club
                          </Button>
                          <Button size="small" onClick={openProductMaster}>
                            Edit Product
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

    <Dialog
      open={clubOpen}
      onClose={() => {
        if (!mClubOpening.isPending) setClubOpen(false)
      }}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>Club Purchase Batch</DialogTitle>
      <DialogContent dividers>
        <Stack gap={2} sx={{ pt: 1 }}>
          <Alert severity="warning">Validated repair. The selected batch becomes the purchase batch and the source batch is archived.</Alert>
          <Stack direction={{ xs: 'column', sm: 'row' }} gap={1}>
            <TextField
              label="Source batch"
              value={clubSourceBatch ? `#${clubSourceBatch.id} | Stock ${Number(clubSourceBatch.stock || 0)} | MRP ${clubSourceBatch.mrp}` : ''}
              fullWidth
              InputProps={{ readOnly: true }}
            />
            <TextField
              select
              label="Batch to keep"
              value={clubTargetBatchId}
              onChange={(e) => setClubTargetBatchId(e.target.value ? Number(e.target.value) : '')}
              fullWidth
            >
              <MenuItem value="">Select batch</MenuItem>
              {clubTargetOptions.map((batch) => (
                <MenuItem key={`club-target-${batch.id}`} value={Number(batch.id)}>
                  #{batch.id} | Stock {Number(batch.stock || 0)} | MRP {batch.mrp} | Exp {formatExpiry(batch.expiry_date)}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          <FormControlLabel
            control={
              <Switch
                checked={clubAdoptPurchaseDetails}
                onChange={(e) => setClubAdoptPurchaseDetails(e.target.checked)}
              />
            }
            label="Use purchase expiry/MRP on kept batch"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button
          onClick={() => {
            setClubOpen(false)
            setClubSourceBatch(null)
            setClubTargetBatchId('')
          }}
          disabled={mClubOpening.isPending}
        >
          Cancel
        </Button>
        <Button
          color="warning"
          variant="contained"
          onClick={() => mClubOpening.mutate()}
          disabled={!clubSourceBatch || !clubTargetBatchId || mClubOpening.isPending}
        >
          {mClubOpening.isPending ? 'Clubbing...' : 'Club & Archive Source'}
        </Button>
      </DialogActions>
    </Dialog>

    <Dialog open={productOpen} onClose={() => setProductOpen(false)} fullWidth maxWidth="sm">
      <DialogTitle>{productId ? 'Edit Product' : 'Add Product Master'}</DialogTitle>
      <DialogContent dividers>
        <Stack gap={2} sx={{ pt: 1 }}>
          <TextField
            label="Product Name"
            value={productForm.name}
            onChange={(e) => setProductForm((prev) => ({ ...prev, name: e.target.value }))}
            fullWidth
          />
          <Stack direction={{ xs: 'column', sm: 'row' }} gap={1}>
            <TextField
              select
              label="Brand"
              value={productForm.brand || ''}
              onChange={(e) => setProductForm((prev) => ({ ...prev, brand: e.target.value }))}
              fullWidth
            >
              <MenuItem value="">No Brand</MenuItem>
              {(brandsQ.data || []).map((brandRow) => (
                <MenuItem key={brandRow.id} value={brandRow.name}>
                  {brandRow.name}
                </MenuItem>
              ))}
            </TextField>
            <Button variant="outlined" onClick={() => setProductBrandOpen(true)} sx={{ whiteSpace: 'nowrap', height: 40 }}>
              New Brand
            </Button>
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} gap={1}>
            <TextField
              select
              label="Category"
              value={productForm.category_id ? String(productForm.category_id) : ''}
              onChange={(e) => setProductForm((prev) => ({ ...prev, category_id: e.target.value ? Number(e.target.value) : undefined }))}
              fullWidth
            >
              <MenuItem value="">No Category</MenuItem>
              {(categoriesQ.data || []).map((category) => (
                <MenuItem key={category.id} value={String(category.id)}>
                  {category.name}
                </MenuItem>
              ))}
            </TextField>
            <Button variant="outlined" onClick={() => setProductCategoryOpen(true)} sx={{ whiteSpace: 'nowrap', height: 40 }}>
              New Category
            </Button>
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
            <TextField
              label="Default Rack"
              type="number"
              value={productForm.default_rack_number ?? 0}
              onChange={(e) => setProductForm((prev) => ({ ...prev, default_rack_number: Number(e.target.value || 0) }))}
              fullWidth
            />
            <TextField
              label="Printed Price"
              type="number"
              value={productForm.printed_price ?? 0}
              onChange={(e) => setProductForm((prev) => ({ ...prev, printed_price: Number(e.target.value || 0) }))}
              fullWidth
            />
          </Stack>
          <FormControlLabel
            control={
              <Switch
                checked={Boolean(productForm.loose_sale_enabled)}
                onChange={(e) => setProductLooseSaleEnabled(e.target.checked)}
              />
            }
            label="Enable loose stock"
          />
          {productForm.loose_sale_enabled ? (
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
              <TextField
                label="Parent Unit"
                value={productForm.parent_unit_name || ''}
                onChange={(e) => setProductForm((prev) => ({ ...prev, parent_unit_name: e.target.value }))}
                placeholder="Strip"
                fullWidth
              />
              <TextField
                label="Loose Unit"
                value={productForm.child_unit_name || ''}
                onChange={(e) => setProductForm((prev) => ({ ...prev, child_unit_name: e.target.value }))}
                placeholder="Tablet"
                fullWidth
              />
              <TextField
                label="Units per Parent"
                type="number"
                value={productForm.default_conversion_qty ?? ''}
                onChange={(e) => setProductForm((prev) => ({ ...prev, default_conversion_qty: e.target.value ? Number(e.target.value) : undefined }))}
                inputProps={{ min: 1, step: 1 }}
                fullWidth
              />
            </Stack>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        {productId ? (
          <Button
            color="error"
            startIcon={<DeleteIcon />}
            disabled={mDeleteProduct.isPending || mSaveProduct.isPending}
            onClick={() => {
              const ok = window.confirm(`Delete product master "${productForm.name.trim()}" only if it has no stock or purchase links. If this duplicate came from a purchase, use Merge from Manage Product instead.`)
              if (ok) mDeleteProduct.mutate(Number(productId))
            }}
          >
            Delete
          </Button>
        ) : null}
        <Box sx={{ flex: 1 }} />
        <Button onClick={() => setProductOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={saveProductMaster}
            disabled={mSaveProduct.isPending || mDeleteProduct.isPending}
          >
          {mSaveProduct.isPending ? 'Saving...' : 'Save Product'}
        </Button>
      </DialogActions>
    </Dialog>

    <Dialog open={productBrandOpen} onClose={() => setProductBrandOpen(false)} fullWidth maxWidth="xs">
      <DialogTitle>Add Brand</DialogTitle>
      <DialogContent dividers>
        <TextField
          label="Brand Name"
          value={productBrandName}
          onChange={(e) => setProductBrandName(e.target.value)}
          autoFocus
          fullWidth
          sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setProductBrandOpen(false)}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => {
            const nextName = productBrandName.trim()
            if (!nextName) return toast.push('Brand name is required', 'error')
            mCreateProductBrand.mutate(nextName)
          }}
          disabled={mCreateProductBrand.isPending}
        >
          Save Brand
        </Button>
      </DialogActions>
    </Dialog>

    <Dialog open={productCategoryOpen} onClose={() => setProductCategoryOpen(false)} fullWidth maxWidth="xs">
      <DialogTitle>Add Category</DialogTitle>
      <DialogContent dividers>
        <TextField
          label="Category Name"
          value={productCategoryName}
          onChange={(e) => setProductCategoryName(e.target.value)}
          autoFocus
          fullWidth
          sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setProductCategoryOpen(false)}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => {
            const nextName = productCategoryName.trim()
            if (!nextName) return toast.push('Category name is required', 'error')
            mCreateProductCategory.mutate(nextName)
          }}
          disabled={mCreateProductCategory.isPending}
        >
          Save Category
        </Button>
      </DialogActions>
    </Dialog>

    <Dialog open={billOpen} onClose={() => setBillOpen(false)} fullWidth maxWidth="md">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        Bill Details {billDetail?.id ? `#${billDetail.id}` : ''}
        <IconButton onClick={() => setBillOpen(false)} size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {billLoading ? (
          <Typography color="text.secondary">Loading...</Typography>
        ) : !billDetail ? (
          <Typography color="error">Failed to load bill details.</Typography>
        ) : (
          <Stack gap={2}>
            <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1}>
              <Typography variant="subtitle1">
                ID: <b>{billDetail.id}</b>
              </Typography>
              <Typography variant="subtitle1">
                Date/Time: <b>{billDetail.date_time || '-'}</b>
              </Typography>
            </Stack>

            <Divider />

            <Box sx={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ minWidth: 220 }}>Item</th>
                    <th>Qty</th>
                    <th>MRP</th>
                    <th>SP</th>
                    <th>Line Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(billDetail.items || []).map((item: any, index: number) => {
                    const itemName = item.item_name || item.name || item.item?.name || `#${item.item_id}`
                    const qty = Number(item.quantity || 0)
                    const mrp = Number(item.mrp || 0)
                    const lineTotal = chargedLine(billDetail, item)
                    return (
                      <tr key={`bill-item-${index}`}>
                        <td>
                          <Stack gap={0.25}>
                            <Typography variant="body2">{itemName}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              {[String(item.category_name || '').trim() ? `Category: ${String(item.category_name).trim()}` : '', `Brand: ${String(item.brand || '').trim() || '-'}`].filter(Boolean).join(' · ')}
                            </Typography>
                          </Stack>
                        </td>
                        <td>{qty}</td>
                        <td>{money(mrp)}</td>
                        <td>{money(qty > 0 ? lineTotal / qty : 0)}</td>
                        <td>{money(lineTotal)}</td>
                      </tr>
                    )
                  })}
                  {(billDetail.items || []).length === 0 ? (
                    <tr>
                      <td colSpan={5}>
                        <Box p={2} color="text.secondary">No items.</Box>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </Box>

            <Stack gap={0.5} sx={{ ml: 'auto', maxWidth: 420 }}>
              <Typography>Total: <b>{money(billDetail.total_amount || 0)}</b></Typography>
              <Typography>Payment Mode: <b>{billDetail.payment_mode || '-'}</b></Typography>
              <Typography>Payment Status: <b>{billDetail.payment_status || (billDetail.is_credit ? 'UNPAID' : 'PAID')}</b></Typography>
              <Typography>Paid Amount: <b>{money(billDetail.paid_amount || 0)}</b></Typography>
              <Typography>
                Pending Amount:{' '}
                <b>{money(Math.max(0, Number(billDetail.total_amount || 0) - Number(billDetail.paid_amount || 0) - Number(billDetail.writeoff_amount || 0)))}</b>
              </Typography>
              {billDetail.notes ? (
                <Typography sx={{ mt: 1 }}>
                  Notes: <i>{billDetail.notes}</i>
                </Typography>
              ) : null}
              <Box sx={{ pt: 1 }}>
                <Button size="small" variant="outlined" startIcon={<EditIcon />} onClick={() => setBillEditOpen(true)}>
                  Edit Bill
                </Button>
              </Box>
            </Stack>

            <Divider />
            <BillPaymentsPanel bill={billDetail} onBillUpdated={refreshLedgerAfterBillChange} />
          </Stack>
        )}
      </DialogContent>
    </Dialog>

    <BillEditDialog
      open={billEditOpen}
      bill={billDetail}
      onClose={() => setBillEditOpen(false)}
      onSaved={refreshLedgerAfterBillChange}
    />
    </>
  )
}
