import api from './api'
import type { AuditLog, PurchaseReturn } from '../lib/types'

export interface PurchaseReturnCreatePayload {
  purchase_id?: number
  party_id?: number
  return_date: string
  return_number?: string
  notes?: string
  rounding_adjustment?: number
  items: Array<{
    purchase_item_id?: number
    inventory_item_id?: number
    lot_id?: number
    quantity: number
    unit_cost?: number
    gst_percent?: number
  }>
}

export async function fetchPurchaseReturns(params?: {
  purchase_id?: number
  party_id?: number
  from_date?: string
  to_date?: string
  include_deleted?: boolean
  limit?: number
}): Promise<PurchaseReturn[]> {
  const response = await api.get<PurchaseReturn[]>('/purchase-returns', { params })
  return response.data
}

export async function fetchPurchaseReturnHistory(id: number): Promise<AuditLog[]> {
  const response = await api.get<AuditLog[]>(`/purchase-returns/${id}/history`)
  return response.data
}

export async function createPurchaseReturn(payload: PurchaseReturnCreatePayload): Promise<PurchaseReturn> {
  const response = await api.post<PurchaseReturn>('/purchase-returns', payload)
  return response.data
}

export async function updatePurchaseReturn(id: number, payload: PurchaseReturnCreatePayload): Promise<PurchaseReturn> {
  const response = await api.put<PurchaseReturn>(`/purchase-returns/${id}`, payload)
  return response.data
}

export async function cancelPurchaseReturn(id: number): Promise<PurchaseReturn> {
  const response = await api.post<PurchaseReturn>(`/purchase-returns/${id}/cancel`)
  return response.data
}
