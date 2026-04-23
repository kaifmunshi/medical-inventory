import api from './api'
import type { Customer } from '../lib/types'

export interface CustomerCreatePayload {
  name: string
  phone?: string
  address_line?: string
}
export interface CustomerUpdatePayload {
  name?: string
  phone?: string
  address_line?: string
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

export async function fetchCustomers(params?: { q?: string }): Promise<Customer[]> {
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

export async function getCustomerSummary(id: number): Promise<CustomerSummary> {
  const res = await api.get<CustomerSummary>(`/customers/${id}/summary`)
  return res.data
}

export async function moveCustomerBills(source_customer_id: number, destination_customer_id: number) {
  const res = await api.post('/customers/move-bills', { source_customer_id, destination_customer_id })
  return res.data as { moved_count: number; source_customer_id: number; destination_customer_id: number }
}
