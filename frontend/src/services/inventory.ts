import api from './api'
import type { Item } from '../lib/types'

export type ItemsPage = {
  items: Item[]
  total: number
  next_offset: number | null
}

export type StockMovementRow = {
  id: number
  ts: string
  delta: number
  reason: string
  ref_type?: string | null
  ref_id?: number | null
  note?: string | null
  actor?: string | null
  balance_after: number
  balance_before: number
}

export type StockLedgerPage = {
  item_id: number
  item_name: string
  current_stock: number
  items: StockMovementRow[]
  next_offset: number | null
}

// ✅ group ledger response (optional typing, helps UI)
export type StockMovementGroupRow = {
  id: number
  ts: string
  delta: number
  reason: string
  ref_type?: string | null
  ref_id?: number | null
  note?: string | null
  actor?: string | null

  item_id: number
  expiry_date?: string | null
  mrp?: number | null
  rack_number?: number | null

  balance_after: number
  balance_before: number
}

export type StockLedgerGroupPage = {
  key: string
  name: string
  brand?: string | null
  current_stock: number
  item_ids: number[]
  items: StockMovementGroupRow[]
  next_offset: number | null
}

export type InventoryGroupBatch = {
  id: number
  name: string
  brand?: string | null
  expiry_date?: string | null
  mrp: number
  stock: number
  rack_number: number
  created_at?: string | null
  updated_at?: string | null
  is_archived: boolean
}

export type InventoryGroupDetail = {
  key: string
  name: string
  brand?: string | null
  total_stock: number
  total_batch_count: number
  active_batch_count: number
  archived_batch_count: number
  earliest_expiry?: string | null
  latest_expiry?: string | null
  mrp_min?: number | null
  mrp_max?: number | null
  rack_numbers: number[]
  batches: InventoryGroupBatch[]
}

export type StockLedgerSummary = {
  key: string
  name: string
  brand?: string | null
  item_ids: number[]
  batch_id?: number | null
  from_date?: string | null
  to_date?: string | null
  opening_stock: number
  inward_qty: number
  outward_qty: number
  net_qty: number
  closing_stock: number
  current_stock: number
  ledger_balance_gap: number
  movement_count: number
  last_movement_ts?: string | null
  last_purchase_ts?: string | null
  last_sale_ts?: string | null
  last_adjustment_ts?: string | null
}

export type StockReconciliationEntry = {
  reason: string
  ref_type?: string | null
  ref_id?: number | null
  source_ts?: string | null
  note?: string | null
  expected_delta: number
  actual_delta: number
  missing_delta: number
  safe_to_apply: boolean
}

export type StockReconciliationRow = {
  item_id: number
  item_name: string
  brand?: string | null
  expiry_date?: string | null
  mrp: number
  rack_number: number
  is_archived: boolean
  current_stock: number
  ledger_delta_total: number
  net_gap: number
  deterministic_gap: number
  projected_ledger_total: number
  suggested_recon_delta: number
  status: string
  missing_entries: StockReconciliationEntry[]
}

export type StockReconciliationReport = {
  total_rows: number
  mismatched_rows: number
  deterministic_rows: number
  synthetic_rows: number
  items: StockReconciliationRow[]
}

export type StockReconciliationApplyResult = {
  applied_items: number
  deterministic_rows_inserted: number
  synthetic_rows_inserted: number
  total_delta_applied: number
}

export async function listItems(q: string = '', options?: { include_archived?: boolean; created_from?: string }): Promise<Item[]> {
  const params: Record<string, string | boolean> = {}
  if (q) params.q = q
  if (typeof options?.include_archived === 'boolean') params.include_archived = options.include_archived
  if (options?.created_from) params.created_from = options.created_from
  const { data } = await api.get('/inventory', { params })

  if (Array.isArray(data)) return data
  if (data && Array.isArray((data as any).items)) return (data as any).items
  return []
}

export async function listItemsPage(
  q: string = '',
  limit: number = 50,
  offset: number = 0,
  rackNumber?: number,
  filters?: { brand?: string; category_id?: number }
): Promise<ItemsPage> {
  const params: Record<string, string | number> = { q, limit, offset }
  if (typeof rackNumber === 'number' && Number.isFinite(rackNumber)) {
    params.rack_number = rackNumber
  }
  if (filters?.brand) params.brand = filters.brand
  if (typeof filters?.category_id === 'number') params.category_id = filters.category_id
  const { data } = await api.get('/inventory', { params })
  return data as ItemsPage
}

export async function getItem(id: number): Promise<Item> {
  const { data } = await api.get(`/inventory/${id}`)
  return data
}

export async function createItem(payload: Partial<Item>): Promise<Item> {
  const { data } = await api.post('/inventory', payload)
  return data
}

export async function updateItem(id: number, payload: Partial<Item>): Promise<Item> {
  const { data } = await api.patch(`/inventory/${id}`, payload)
  return data
}

export async function deleteItem(id: number): Promise<void> {
  await api.delete(`/inventory/${id}`)
}

export async function adjustStock(id: number, delta: number): Promise<Item> {
  const { data } = await api.post(`/inventory/${id}/adjust`, null, { params: { delta } })
  return data
}

// ✅ FIXED: use same axios base + correct backend route
export async function getGroupLedger(params: {
  name: string
  brand?: string | null
  from_date?: string
  to_date?: string
  reason?: string
  item_id?: number
  limit?: number
  offset?: number
}): Promise<StockLedgerGroupPage> {
  const { data } = await api.get('/inventory/ledger/group', {
    params: {
      name: params.name,
      brand: params.brand ?? '', // keep backend behavior
      from_date: params.from_date,
      to_date: params.to_date,
      reason: params.reason,
      item_id: params.item_id,
      limit: params.limit ?? 50,
      offset: params.offset ?? 0,
    },
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  })

  return data as StockLedgerGroupPage
}

export async function getItemGroup(params: {
  name: string
  brand?: string | null
}): Promise<InventoryGroupDetail> {
  const { data } = await api.get('/inventory/group', {
    params: {
      name: params.name,
      brand: params.brand ?? '',
    },
  })
  return data as InventoryGroupDetail
}

export async function getGroupLedgerSummary(params: {
  name: string
  brand?: string | null
  item_id?: number
  from_date?: string
  to_date?: string
}): Promise<StockLedgerSummary> {
  const { data } = await api.get('/inventory/group/summary', {
    params: {
      name: params.name,
      brand: params.brand ?? '',
      item_id: params.item_id,
      from_date: params.from_date,
      to_date: params.to_date,
    },
  })
  return data as StockLedgerSummary
}

export async function getItemLedger(params: {
  item_id: number
  from_date?: string
  to_date?: string
  reason?: string
  limit?: number
  offset?: number
}): Promise<StockLedgerPage> {
  const { item_id, ...rest } = params
  const { data } = await api.get(`/inventory/${item_id}/ledger`, { params: rest })
  return data as StockLedgerPage
}

export async function getStockLedgerReconciliation(params?: {
  q?: string
  item_ids?: number[]
  include_archived?: boolean
  include_balanced?: boolean
  limit?: number
  offset?: number
}): Promise<StockReconciliationReport> {
  const query = new URLSearchParams()
  if (params?.q) query.set('q', params.q)
  if (typeof params?.include_archived === 'boolean') query.set('include_archived', String(params.include_archived))
  if (typeof params?.include_balanced === 'boolean') query.set('include_balanced', String(params.include_balanced))
  if (typeof params?.limit === 'number') query.set('limit', String(params.limit))
  if (typeof params?.offset === 'number') query.set('offset', String(params.offset))
  for (const itemId of params?.item_ids || []) query.append('item_ids', String(itemId))

  const { data } = await api.get(`/inventory/ledger/reconciliation${query.toString() ? `?${query.toString()}` : ''}`)
  return data as StockReconciliationReport
}

export async function applyStockLedgerReconciliation(payload: {
  item_ids?: number[]
  q?: string
  include_archived?: boolean
  include_balanced?: boolean
  apply_synthetic?: boolean
}): Promise<StockReconciliationApplyResult> {
  const { data } = await api.post('/inventory/ledger/reconciliation/apply', payload)
  return data as StockReconciliationApplyResult
}
