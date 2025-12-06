// src/services/returns.ts
import api from './api'

// --- Types (match backend schema exactly) ---
export type ReturnLine = { item_id: number; quantity: number }

export type CreateReturnBody = {
  source_bill_id: number
  items: ReturnLine[]
  refund_mode: 'cash' | 'online'      // required by backend
  refund_cash: number                 // required by backend
  refund_online: number               // required by backend
  notes?: string
}

export type ListReturnsParams = {
  from_date?: string   // YYYY-MM-DD
  to_date?: string     // YYYY-MM-DD (inclusive)
  limit?: number
  offset?: number
}

// Optional typing for a return record (adjust to your API as needed)
export type ReturnRecord = {
  id: number
  source_bill_id: number
  items: Array<{ item_id: number; quantity: number; mrp?: number; item_name?: string }>
  refund_mode: 'cash' | 'online'
  refund_cash: number
  refund_online: number
  notes?: string
  created_at?: string
  date_time?: string
  subtotal_return?: number
}

// When searching bills, backend may return a single bill or a list.
export type BillSearchResult = any | any[]

// 🔹 NEW: summary for a bill’s return status
export type ReturnSummaryRow = {
  item_id: number
  item_name: string
  mrp: number
  sold: number
  already_returned: number
  remaining: number
}

// --- API calls ---

// Keep existing behavior: numeric id → /billing/{id}/, else → /billing/?q=
export async function findBill(idOrQuery: string) {
  if (/^\d+$/.test(idOrQuery)) {
    const { data } = await api.get(`/billing/${idOrQuery}/`)
    return data as BillSearchResult
  }
  const { data } = await api.get('/billing/', { params: { q: idOrQuery } })
  return data as BillSearchResult
}

// Create Return (matches Swagger schema)
export async function createReturn(body: CreateReturnBody) {
  const { data } = await api.post('/returns/', body)
  return data as ReturnRecord
}

// List Returns
export async function listReturns(params: ListReturnsParams = {}) {
  const { data } = await api.get('/returns/', { params })
  return data as ReturnRecord[]
}

// ✅ Exchange API — matches Swagger: POST /returns/exchange
export type ExchangePayload = {
  source_bill_id: number;
  return_items: { item_id: number; quantity: number }[];
  new_items: { item_id: number; quantity: number }[];
  discount_percent?: number;
  // when customer pays (net > 0)
  payment_mode?: 'cash' | 'online' | 'split';
  payment_cash?: number;
  payment_online?: number;
  // when you refund (net < 0)
  refund_mode?: 'cash' | 'online';
  refund_cash?: number;
  refund_online?: number;
  notes?: string;
};

export async function createExchange(payload: ExchangePayload) {
  // note the trailing slash to match your other endpoints
  const { data } = await api.post('/returns/exchange/', payload);
  return data;
}

// Fetch a single return by ID
export async function getReturn(id: number) {
  const { data } = await api.get(`/returns/${id}/`)
  return data as ReturnRecord
}

// 🔹 NEW: fetch remaining quantity per item for a bill (sold, returned, remaining)
export async function getReturnSummary(billId: number) {
  const { data } = await api.get(`/returns/summary/${billId}`)
  return data as ReturnSummaryRow[]
}
