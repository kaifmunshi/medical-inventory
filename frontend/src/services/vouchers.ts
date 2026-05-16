import api from './api'
import type { Ledger, LedgerGroup, PostedVoucher, VoucherDayBook } from '../lib/types'

export type JournalLinePayload = {
  ledger_id: number
  entry_type: 'DR' | 'CR'
  amount: number
  narration?: string
}

export type JournalVoucherPayload = {
  voucher_date?: string
  voucher_no?: string
  narration?: string
  entries: JournalLinePayload[]
}

export async function fetchVoucherDayBook(params: {
  from_date?: string
  to_date?: string
  voucher_type?: string
  q?: string
  deleted_filter?: 'active' | 'deleted' | 'all'
  include_stock_journal?: boolean
}): Promise<VoucherDayBook> {
  const { data } = await api.get<VoucherDayBook>('/vouchers/daybook', { params })
  return data
}

export async function listLedgers(params?: {
  q?: string
  group_id?: number
  party_id?: number
}): Promise<Ledger[]> {
  const { data } = await api.get<Ledger[]>('/vouchers/ledgers', { params })
  return data
}

export async function listLedgerGroups(): Promise<LedgerGroup[]> {
  const { data } = await api.get<LedgerGroup[]>('/vouchers/ledger-groups')
  return data
}

export async function createLedger(payload: { name: string; group_id: number }): Promise<Ledger> {
  const { data } = await api.post<Ledger>('/vouchers/ledgers', payload)
  return data
}

export async function listJournalVouchers(params?: {
  from_date?: string
  to_date?: string
  q?: string
  deleted_filter?: 'active' | 'deleted' | 'all'
  limit?: number
  offset?: number
}): Promise<PostedVoucher[]> {
  const { data } = await api.get<PostedVoucher[]>('/vouchers/journals', { params })
  return data
}

export async function createJournalVoucher(payload: JournalVoucherPayload): Promise<PostedVoucher> {
  const { data } = await api.post<PostedVoucher>('/vouchers/journals', payload)
  return data
}

export async function updateJournalVoucher(id: number, payload: JournalVoucherPayload): Promise<PostedVoucher> {
  const { data } = await api.patch<PostedVoucher>(`/vouchers/journals/${id}`, payload)
  return data
}

export async function deleteJournalVoucher(id: number): Promise<PostedVoucher> {
  const { data } = await api.delete<PostedVoucher>(`/vouchers/journals/${id}`)
  return data
}

export async function restoreJournalVoucher(id: number): Promise<PostedVoucher> {
  const { data } = await api.post<PostedVoucher>(`/vouchers/journals/${id}/restore`)
  return data
}
