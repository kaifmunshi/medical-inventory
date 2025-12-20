// frontend\src\services\inventory.ts

import api from './api'
import type { Item } from '../lib/types'
export type ItemsPage = {
  items: Item[]
  total: number
  next_offset: number | null
}

export async function listItems(q: string = ''): Promise<Item[]> {
  const params = q ? { q } : undefined
  const { data } = await api.get('/inventory/', { params, })

  // ✅ backend may return Item[] OR { items: Item[] ... }
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
  const { data } = await api.get('/inventory/', { params })
  return data as ItemsPage
}


export async function getItem(id: number): Promise<Item> {
const { data } = await api.get(`/inventory/${id}/`)
return data
}


export async function createItem(payload: Partial<Item>): Promise<Item> {
const { data } = await api.post('/inventory/', payload)
return data
}


export async function updateItem(id: number, payload: Partial<Item>): Promise<Item> {
const { data } = await api.patch(`/inventory/${id}/`, payload)
return data
}


export async function deleteItem(id: number): Promise<void> {
await api.delete(`/inventory/${id}/`)
}

export async function adjustStock(id: number, delta: number): Promise<Item> {
  const { data } = await api.post(`/inventory/${id}/adjust`, null, { params: { delta } })
  return data
}
