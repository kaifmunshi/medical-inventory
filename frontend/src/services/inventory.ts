import api from './api'
import type { Item } from '../lib/types'



export async function listItems(q: string = ''): Promise<Item[]> {
const params = q ? { q } : undefined
const { data } = await api.get('/inventory/', { params })
return data
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
