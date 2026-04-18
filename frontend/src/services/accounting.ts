import api from './api'
import type { Ledger, LedgerGroup, PostedVoucher } from '../lib/types'

export async function fetchLedgerGroups(): Promise<LedgerGroup[]> {
  const { data } = await api.get<LedgerGroup[]>('/vouchers/ledger-groups')
  return data
}

export async function fetchLedgers(params?: {
  q?: string
  group_id?: number
  party_id?: number
}): Promise<Ledger[]> {
  const { data } = await api.get<Ledger[]>('/vouchers/ledgers', { params })
  return data
}

export async function fetchPostedVouchers(params?: {
  voucher_type?: string
  source_type?: string
  from_date?: string
  to_date?: string
  limit?: number
  offset?: number
}): Promise<PostedVoucher[]> {
  const { data } = await api.get<PostedVoucher[]>('/vouchers/', { params })
  return data
}

export async function fetchPostedVoucher(voucherId: number): Promise<PostedVoucher> {
  const { data } = await api.get<PostedVoucher>(`/vouchers/${voucherId}`)
  return data
}
