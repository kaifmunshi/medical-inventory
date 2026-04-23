import api from './api'
import type { StockAudit, StockAuditItem } from '../lib/types'

export type { StockAuditItem } from '../lib/types'

export async function createAudit(name: string): Promise<StockAudit> {
  const { data } = await api.post('/audits/', { name })
  return data
}

export async function listAudits(): Promise<StockAudit[]> {
  const { data } = await api.get('/audits/')
  return data
}

export async function getAudit(id: number): Promise<StockAudit> {
  const { data } = await api.get(`/audits/${id}`)
  return data
}

export async function getAuditItems(id: number, rackNumber?: number | null): Promise<StockAuditItem[]> {
  const { data } = await api.get(`/audits/${id}/items`, {
    params: rackNumber === null || rackNumber === undefined ? undefined : { rack_number: rackNumber },
  })
  return data
}

export async function updatePhysicalStock(
  auditId: number,
  itemId: number,
  physical_stock: number
): Promise<void> {
  await api.patch(`/audits/${auditId}/items/${itemId}`, null, { params: { physical_stock } })
}

export async function finalizeAudit(auditId: number): Promise<StockAudit> {
  const { data } = await api.post(`/audits/${auditId}/finalize`)
  return data
}
