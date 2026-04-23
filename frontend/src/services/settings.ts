import api from './api'
import type { AuditLog, FinancialYear } from '../lib/types'

export async function fetchFinancialYears(): Promise<FinancialYear[]> {
  const { data } = await api.get<FinancialYear[]>('/settings/financial-years')
  return data
}

export async function createFinancialYear(payload: {
  label: string
  start_date: string
  end_date: string
  is_active?: boolean
}): Promise<FinancialYear> {
  const { data } = await api.post<FinancialYear>('/settings/financial-years', payload)
  return data
}

export async function updateFinancialYear(
  yearId: number,
  payload: Partial<Pick<FinancialYear, 'label' | 'start_date' | 'end_date' | 'is_active' | 'is_locked'>>,
): Promise<FinancialYear> {
  const { data } = await api.patch<FinancialYear>(`/settings/financial-years/${yearId}`, payload)
  return data
}

export async function fetchAuditLogs(params?: {
  q?: string
  entity_type?: string
  limit?: number
  offset?: number
}): Promise<AuditLog[]> {
  const { data } = await api.get<AuditLog[]>('/settings/audit-logs', { params })
  return data
}
