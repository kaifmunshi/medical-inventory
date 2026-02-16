// frontend/src/services/cashbook.ts
import api from './api'

export type CashbookType = 'RECEIPT' | 'WITHDRAWAL' | 'EXPENSE'

export type CashbookCreate = {
  entry_type: CashbookType
  amount: number
  note?: string
}

export type CashbookSummary = {
  cash_out: number
  withdrawals: number
  expenses: number
  receipts: number
  net_change: number
  count: number
}

export type CashbookEntry = {
  id: number
  created_at: string
  entry_type: CashbookType
  amount: number
  note?: string | null
}

export async function createCashbookEntry(payload: CashbookCreate) {
  const { data } = await api.post('/cashbook/', payload)
  return data
}

export async function getCashbookSummary(params: { from_date?: string; to_date?: string }) {
  const { data } = await api.get<CashbookSummary>('/cashbook/summary', { params })
  return data
}

export type CashbookDay = {
  date: string
  opening_balance: number
  closing_balance: number
  summary: CashbookSummary
  entries: CashbookEntry[]
}

export async function getCashbookDay(params: { date: string }) {
  const { data } = await api.get<CashbookDay>('/cashbook/day', { params })
  return data
}

export async function listCashbookEntries(params: {
  from_date?: string
  to_date?: string
  limit?: number
  offset?: number
}) {
  const { data } = await api.get<CashbookEntry[]>('/cashbook/', { params })
  return data
}

export async function clearCashbookAll() {
  const { data } = await api.delete('/cashbook/clear')
  return data
}

export async function clearCashbookToday() {
  const { data } = await api.delete('/cashbook/clear-today')
  return data
}

// ✅ NEW: delete a particular entry
export async function deleteCashbookEntry(entry_id: number) {
  const { data } = await api.delete(`/cashbook/entry/${entry_id}`)
  return data
}

// ✅ NEW: delete last entry (safe default is "today" on backend if params not given)
export async function clearCashbookLast(params?: { from_date?: string; to_date?: string }) {
  const { data } = await api.delete('/cashbook/last', { params })
  return data
}
