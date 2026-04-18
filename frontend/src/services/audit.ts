import api from './api'

export interface StockAuditItem {
  id: number
  audit_id: number
  item_id: number
  system_stock: number
  physical_stock?: number | null
  item_name: string
  item_brand?: string | null
  item_rack?: number | null
  item_mrp: number
  item_expiry?: string | null
}

export interface StockAudit {
  id: number
  name: string
  status: 'DRAFT' | 'FINALIZED'
  created_at: string
  closed_at?: string | null
}

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

export async function getAuditItems(id: number): Promise<StockAuditItem[]> {
  const { data } = await api.get(`/audits/${id}/items`)
  return data
}

export async function updatePhysicalStock(auditId: number, itemId: number, physical_stock: number): Promise<void> {
  await api.patch(`/audits/${auditId}/items/${itemId}`, null, { params: { physical_stock } })
}

export async function finalizeAudit(auditId: number): Promise<StockAudit> {
  const { data } = await api.post(`/audits/${auditId}/finalize`)
  return data
}
