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

export async function listItems(q: string = ''): Promise<Item[]> {
  const params = q ? { q } : undefined
  const { data } = await api.get('/inventory', { params }) // ✅ removed trailing /

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
  const { data } = await api.get('/inventory', { params }) // ✅ removed trailing /
  return data as ItemsPage
}

export async function getItem(id: number): Promise<Item> {
  const { data } = await api.get(`/inventory/${id}`) // ✅ removed trailing /
  return data
}

export async function createItem(payload: Partial<Item>): Promise<Item> {
  const { data } = await api.post('/inventory', payload) // ✅ removed trailing /
  return data
}

export async function updateItem(id: number, payload: Partial<Item>): Promise<Item> {
  const { data } = await api.patch(`/inventory/${id}`, payload) // ✅ removed trailing /
  return data
}

export async function deleteItem(id: number): Promise<void> {
  await api.delete(`/inventory/${id}`) // ✅ removed trailing /
}

export async function adjustStock(id: number, delta: number): Promise<Item> {
  const { data } = await api.post(`/inventory/${id}/adjust`, null, { params: { delta } })
  return data
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
