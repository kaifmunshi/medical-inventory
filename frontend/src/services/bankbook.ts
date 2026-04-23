import api from './api'

export type BankbookType = 'RECEIPT' | 'WITHDRAWAL' | 'EXPENSE'
export type BankbookMode = 'UPI' | 'NEFT' | 'RTGS' | 'IMPS' | 'BANK_DEPOSIT'

export type BankbookCreate = {
  entry_type: BankbookType
  mode: BankbookMode
  amount: number
  txn_charges?: number
  note?: string
  entry_date?: string
}

export type BankbookSummary = {
  bank_out: number
  withdrawals: number
  expenses: number
  receipts: number
  charges: number
  net_change: number
  count: number
}

export type BankbookEntry = {
  id: number
  created_at: string
  entry_type: BankbookType
  mode: BankbookMode
  amount: number
  txn_charges: number
  note?: string | null
}

export type BankbookDay = {
  date: string
  opening_balance: number
  closing_balance: number
  summary: BankbookSummary
  entries: BankbookEntry[]
}

export async function createBankbookEntry(payload: BankbookCreate) {
  const { data } = await api.post('/bankbook/', payload)
  return data
}

export async function getBankbookSummary(params: { from_date?: string; to_date?: string }) {
  const { data } = await api.get<BankbookSummary>('/bankbook/summary', { params })
  return data
}

export async function getBankbookDay(params: { date: string }) {
  const { data } = await api.get<BankbookDay>('/bankbook/day', { params })
  return data
}

export async function listBankbookEntries(params: {
  from_date?: string
  to_date?: string
  limit?: number
  offset?: number
}) {
  const { data } = await api.get<BankbookEntry[]>('/bankbook/', { params })
  return data
}

export async function deleteBankbookEntry(entry_id: number) {
  const { data } = await api.delete(`/bankbook/entry/${entry_id}`)
  return data
}
