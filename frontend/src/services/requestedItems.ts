// frontend/src/services/requestedItems.ts
import api from './api'
import type { RequestedItem } from '../lib/types'

export interface RequestedItemCreatePayload {
  customer_name?: string
  mobile: string
  item_name: string
  notes?: string
}

export interface RequestedItemUpdatePayload {
  customer_name?: string
  mobile?: string
  item_name?: string
  notes?: string
  is_available?: boolean
}

export async function fetchRequestedItems(): Promise<RequestedItem[]> {
  const res = await api.get<RequestedItem[]>('/requested-items')
  return res.data
}

export async function createRequestedItem(
  payload: RequestedItemCreatePayload
): Promise<RequestedItem> {
  const res = await api.post<RequestedItem>('/requested-items', payload)
  return res.data
}

export async function updateRequestedItem(
  id: number,
  payload: RequestedItemUpdatePayload
): Promise<RequestedItem> {
  const res = await api.patch<RequestedItem>(`/requested-items/${id}`, payload)
  return res.data
}

export async function toggleRequestedItemAvailability(
  id: number,
  is_available: boolean
): Promise<RequestedItem> {
  return updateRequestedItem(id, { is_available })
}

// 👇 NEW – delete a row
export async function deleteRequestedItem(id: number): Promise<void> {
  await api.delete(`/requested-items/${id}`)
}
