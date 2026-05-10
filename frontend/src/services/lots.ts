import api from './api'
import type { InventoryLotBrowse, PackOpenEvent } from '../lib/types'

export async function fetchLots(params?: {
  q?: string
  product_id?: number
  rack_number?: number
  loose_only?: boolean
  openable_only?: boolean
}): Promise<InventoryLotBrowse[]> {
  const res = await api.get<InventoryLotBrowse[]>('/lots', { params })
  return res.data
}

export async function fetchPackOpenEvents(params?: { lot_id?: number }): Promise<PackOpenEvent[]> {
  const res = await api.get<PackOpenEvent[]>('/lots/open-events', { params })
  return res.data
}

export async function openPack(payload: { lot_id?: number; item_id?: number; packs_opened: number; note?: string }): Promise<PackOpenEvent> {
  const res = await api.post<PackOpenEvent>('/lots/open-pack', payload)
  return res.data
}

export async function closePack(payload: { lot_id?: number; item_id?: number; packs_closed: number; note?: string }): Promise<PackOpenEvent> {
  const res = await api.post<PackOpenEvent>('/lots/close-pack', payload)
  return res.data
}
