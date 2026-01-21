import api from './api'

export type CashbookType = 'WITHDRAWAL' | 'EXPENSE'

export type CashbookCreate = {
  entry_type: CashbookType
  amount: number
  note?: string
}

export type CashbookSummary = {
  cash_out: number
  withdrawals: number
  expenses: number
  count: number
}


export async function createCashbookEntry(payload: CashbookCreate) {
  const { data } = await api.post('/cashbook/', payload)
  return data
}

export async function getCashbookSummary(params: { from_date?: string; to_date?: string }) {
  const { data } = await api.get<CashbookSummary>('/cashbook/summary', { params })
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
export type CashbookEntry = {
  id: number
  created_at: string
  entry_type: 'WITHDRAWAL' | 'EXPENSE'
  amount: number
  note?: string | null
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
