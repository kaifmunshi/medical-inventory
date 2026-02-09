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

export async function listItems(q: string = ''): Promise<Item[]> {
  const params = q ? { q } : undefined
  const { data } = await api.get('/inventory', { params })

  if (Array.isArray(data)) return data
  if (data && Array.isArray((data as any).items)) return (data as any).items
  return []
}

export async function listItemsPage(
  q: string = '',
  limit: number = 50,
  offset: number = 0
): Promise<ItemsPage> {
  const params = { q, limit, offset }
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