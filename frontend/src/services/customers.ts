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
