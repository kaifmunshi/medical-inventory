import api from './api'
import type { Customer } from '../lib/types'

export interface CustomerCreatePayload {
  name: string
  phone?: string
  address_line?: string
  opening_balance?: number
}
export interface CustomerUpdatePayload {
  name?: string
  phone?: string
  address_line?: string
  opening_balance?: number
}

export interface CustomerSummaryTotals {
  total_bills: number
  active_bills: number
  deleted_bills: number
  paid_bills: number
  partial_bills: number
  unpaid_bills: number
  total_sales: number
  total_paid: number
  total_pending: number
}

export interface CustomerSummary {
  customer: Customer
  totals: CustomerSummaryTotals
  bills: any[]
}

export interface UnlinkedBillCandidate {
  id: number
  date_time: string
  total_amount: number
  payment_status: string
  notes?: string | null
}

export async function fetchCustomers(params?: {
  q?: string
  limit?: number
  offset?: number
  archived_only?: boolean
}): Promise<Customer[]> {
  const res = await api.get<Customer[]>('/customers', { params })
  return res.data
}

export async function createCustomer(payload: CustomerCreatePayload): Promise<Customer> {
  const res = await api.post<Customer>('/customers', payload)
  return res.data
}

export async function updateCustomer(id: number, payload: CustomerUpdatePayload): Promise<Customer> {
  const res = await api.patch<Customer>(`/customers/${id}`, payload)
  return res.data
}

export async function deleteCustomer(id: number): Promise<void> {
  await api.delete(`/customers/${id}`)
}

export async function getCustomerSummary(id: number, params?: { include_unlinked_notes?: boolean }): Promise<CustomerSummary> {
  const res = await api.get<CustomerSummary>(`/customers/${id}/summary`, { params })
  return res.data
}

export async function fetchUnlinkedBillCandidates(params: {
  keep_customer_id?: number
  remove_customer_id?: number
}): Promise<UnlinkedBillCandidate[]> {
  const res = await api.get<UnlinkedBillCandidate[]>('/customers/unlinked-bill-candidates', { params })
  return res.data
}

export async function moveCustomerBills(source_customer_id: number, destination_customer_id: number) {
  const res = await api.post('/customers/move-bills', { source_customer_id, destination_customer_id })
  return res.data as { moved_count: number; source_customer_id: number; destination_customer_id: number }
}

export async function mergeCustomers(keep_customer_id: number, remove_customer_id: number, extra_bill_ids: number[] = []) {
  const res = await api.post('/customers/merge', { keep_customer_id, remove_customer_id, extra_bill_ids })
  return res.data as {
    keep_customer_id: number
    removed_customer_id: number
    moved_bills: number
    moved_receipts: number
    moved_ledgers: number
    deactivated_party_id?: number | null
  }
}
