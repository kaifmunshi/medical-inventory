import api from './api'
import type { Purchase, PurchaseItemPayload, PurchaseLedgerRow, PurchasePaymentPayload, SupplierLedgerSummary } from '../lib/types'

export interface PurchaseCreatePayload {
  party_id: number
  invoice_number: string
  invoice_date: string
  notes?: string
  discount_amount?: number
  gst_amount?: number
  rounding_adjustment?: number
  items: PurchaseItemPayload[]
  payments?: PurchasePaymentPayload[]
}

export interface PurchaseUpdatePayload {
  party_id?: number
  invoice_number?: string
  invoice_date?: string
  notes?: string
  discount_amount?: number
  gst_amount?: number
  rounding_adjustment?: number
}

export interface PurchasePaymentCreatePayload {
  amount: number
  mode?: 'cash' | 'online' | 'split' | 'writeoff'
  cash_amount?: number
  online_amount?: number
  note?: string
  paid_at?: string
  is_writeoff?: boolean
}

export type PurchasePaymentUpdatePayload = Partial<PurchasePaymentCreatePayload>

export interface PurchasePaymentBookRow {
  id: number
  purchase_id: number
  paid_at: string
  mode: 'cash' | 'online' | 'split' | 'writeoff'
  amount: number
  cash_amount: number
  online_amount: number
  note?: string | null
  invoice_number?: string | null
  party_id: number
  supplier_name?: string | null
}

export interface SupplierPaymentCreatePayload {
  mode: 'cash' | 'online' | 'split'
  cash_amount?: number
  online_amount?: number
  note?: string
  payment_date?: string
  is_writeoff?: boolean
  allocations: Array<{ purchase_id: number; amount: number }>
}

export async function createPurchase(payload: PurchaseCreatePayload): Promise<Purchase> {
  const res = await api.post<Purchase>('/purchases', payload)
  return res.data
}

export async function fetchPurchases(params?: {
  party_id?: number
  from_date?: string
  to_date?: string
  limit?: number
  offset?: number
}): Promise<Purchase[]> {
  const res = await api.get<Purchase[]>('/purchases', { params })
  return res.data
}

export async function fetchPurchase(id: number): Promise<Purchase> {
  const res = await api.get<Purchase>(`/purchases/${id}`)
  return res.data
}

export async function listPurchasePayments(params?: {
  from_date?: string
  to_date?: string
  limit?: number
  offset?: number
}): Promise<PurchasePaymentBookRow[]> {
  const res = await api.get<PurchasePaymentBookRow[]>('/purchases/payments', { params })
  return res.data
}

export async function updatePurchase(id: number, payload: PurchaseUpdatePayload): Promise<Purchase> {
  const res = await api.patch<Purchase>(`/purchases/${id}`, payload)
  return res.data
}

export async function addPurchasePayment(id: number, payload: PurchasePaymentCreatePayload): Promise<Purchase> {
  const res = await api.post<Purchase>(`/purchases/${id}/payments`, payload)
  return res.data
}

export async function updatePurchasePayment(
  id: number,
  paymentId: number,
  payload: PurchasePaymentUpdatePayload,
): Promise<Purchase> {
  const res = await api.patch<Purchase>(`/purchases/${id}/payments/${paymentId}`, payload)
  return res.data
}

export async function deletePurchasePayment(id: number, paymentId: number): Promise<Purchase> {
  const res = await api.delete<Purchase>(`/purchases/${id}/payments/${paymentId}`)
  return res.data
}

export async function restorePurchasePayment(id: number, paymentId: number): Promise<Purchase> {
  const res = await api.post<Purchase>(`/purchases/${id}/payments/${paymentId}/restore`)
  return res.data
}

export async function addSupplierPayment(id: number, payload: SupplierPaymentCreatePayload): Promise<Purchase[]> {
  const res = await api.post<Purchase[]>(`/purchases/supplier-payment/${id}`, payload)
  return res.data
}

export async function cancelPurchase(id: number): Promise<Purchase> {
  const res = await api.post<Purchase>(`/purchases/${id}/cancel`)
  return res.data
}

export async function replacePurchaseItems(id: number, items: PurchaseItemPayload[]): Promise<Purchase> {
  const res = await api.put<Purchase>(`/purchases/${id}/items`, { items })
  return res.data
}

export async function fetchSupplierLedger(partyId: number): Promise<PurchaseLedgerRow[]> {
  const res = await api.get<PurchaseLedgerRow[]>(`/purchases/ledger/${partyId}`)
  return res.data
}

export async function fetchSupplierLedgerSummary(partyId: number): Promise<SupplierLedgerSummary> {
  const res = await api.get<SupplierLedgerSummary>(`/purchases/supplier-summary/${partyId}`)
  return res.data
}
