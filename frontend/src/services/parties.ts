import api from './api'
import type { DebtorLedgerRow, OpenBill, Party, PartyReceipt, ReceiptBillAdjustment } from '../lib/types'

export interface PartyPayload {
  name: string
  party_group: 'SUNDRY_DEBTOR' | 'SUNDRY_CREDITOR'
  phone?: string
  address_line?: string
  gst_number?: string
  notes?: string
  opening_balance?: number
  opening_balance_type?: 'DR' | 'CR'
}

export async function fetchParties(params?: {
  q?: string
  party_group?: 'SUNDRY_DEBTOR' | 'SUNDRY_CREDITOR'
  is_active?: boolean
}): Promise<Party[]> {
  const res = await api.get<Party[]>('/parties', { params })
  return res.data
}

export async function createParty(payload: PartyPayload): Promise<Party> {
  const res = await api.post<Party>('/parties', payload)
  return res.data
}

export async function updateParty(id: number, payload: Partial<PartyPayload> & { is_active?: boolean }): Promise<Party> {
  const res = await api.patch<Party>(`/parties/${id}`, payload)
  return res.data
}

export async function deleteParty(id: number): Promise<void> {
  await api.delete(`/parties/${id}`)
}

export async function fetchDebtorLedger(partyId: number): Promise<DebtorLedgerRow[]> {
  const res = await api.get<DebtorLedgerRow[]>(`/parties/${partyId}/debtor-ledger`)
  return res.data
}

export async function fetchOpenBills(partyId: number): Promise<OpenBill[]> {
  const res = await api.get<OpenBill[]>(`/parties/${partyId}/open-bills`)
  return res.data
}

export async function fetchPartyReceipts(partyId: number): Promise<PartyReceipt[]> {
  const res = await api.get<PartyReceipt[]>(`/parties/${partyId}/receipts`)
  return res.data
}

export async function fetchReceiptAdjustments(partyId: number): Promise<ReceiptBillAdjustment[]> {
  const res = await api.get<ReceiptBillAdjustment[]>(`/parties/${partyId}/receipt-adjustments`)
  return res.data
}

export async function createPartyReceipt(
  partyId: number,
  payload: {
    mode: 'cash' | 'online' | 'split'
    cash_amount?: number
    online_amount?: number
    note?: string
    payment_date?: string
    adjustments: Array<{ bill_id: number; amount: number }>
  },
): Promise<PartyReceipt> {
  const res = await api.post<PartyReceipt>(`/parties/${partyId}/receipts`, payload)
  return res.data
}

export async function deletePartyReceipt(partyId: number, receiptId: number): Promise<PartyReceipt> {
  const res = await api.delete<PartyReceipt>(`/parties/${partyId}/receipts/${receiptId}`)
  return res.data
}
