// src/services/billing.ts
import api from './api'

// ---------- Create Bill (request) ----------
export interface BillItemIn { item_id: number; quantity: number; mrp: number }

export interface BillCreate {
  items: BillItemIn[];
  discount_percent?: number;
  tax_percent?: number;
  payment_mode: 'cash' | 'online' | 'split' | 'credit';
  payment_cash?: number;
  payment_online?: number;
  notes?: string;
}

export async function createBill(payload: BillCreate) {
  const { data } = await api.post('/billing/', payload);
  return data;
}

// ---------- Read single Bill (response) ----------
export interface BillItem {
  item_id: number;
  item_name: string;
  mrp: number;
  quantity: number;
  line_total: number;
}

export interface Bill {
  id: number;
  date_time: string;
  discount_percent: number;
  subtotal: number;
  total_amount: number;
  payment_mode: 'cash' | 'online' | 'split' | 'credit';
  payment_cash: number;
  payment_online: number;
  notes: string;

  // credit bill fields
  is_credit: boolean;
  payment_status: 'PAID' | 'UNPAID' | 'PARTIAL';
  paid_amount: number;
  paid_at: string | null;

  items: BillItem[];
}

export async function getBill(id: number) {
  const { data } = await api.get<Bill>(`/billing/${id}/`);
  return data;
}

// ---------- List Bills ----------
export async function listBills(params: {
  q?: string;
  from_date?: string;
  to_date?: string;
  limit?: number;
  offset?: number;
}) {
  const { data } = await api.get<Bill[]>('/billing/', { params });
  return data;
}

// ---------- Receive Payment on Credit Bill ----------
export interface ReceivePaymentIn {
  mode: 'cash' | 'online' | 'split';
  cash_amount?: number;
  online_amount?: number;
  note?: string;
}

export interface ReceivePaymentOut {
  bill_id: number;
  payment_status: 'PAID' | 'UNPAID' | 'PARTIAL';
  paid_amount: number;
  total_amount: number;
  pending_amount: number;
}

export async function receivePayment(billId: number, payload: ReceivePaymentIn) {
  const { data } = await api.post<ReceivePaymentOut>(`/billing/${billId}/receive-payment`, payload)
  return data
}

// ---------- List Payments for a Bill ----------
export interface BillPaymentRow {
  id: number;
  bill_id: number;
  received_at: string;
  mode: 'cash' | 'online' | 'split' | 'credit';
  cash_amount: number;
  online_amount: number;
  note?: string | null;
}

export async function listBillPayments(billId: number) {
  const { data } = await api.get<BillPaymentRow[]>(`/billing/${billId}/payments`);
  return data;
}

// ---------- NEW: List Payments (date-range) for Dashboard ----------
export async function listPayments(params: {
  from_date?: string;
  to_date?: string;
  limit?: number;
  offset?: number;
}) {
  const { data } = await api.get<BillPaymentRow[]>(`/billing/payments`, { params })
  return data
}


export async function listBillsPaged(params: {
  from_date?: string
  to_date?: string
  q?: string
  limit?: number
  offset?: number
}) {
  const res = await api.get('/billing/paged', { params })
  return res.data as { items: any[]; next_offset?: number | null }
}




// ---------- Payments Summary (Collected Today) ----------
export type PaymentsSummary = {
  cash_collected: number
  online_collected: number
  total_collected: number
  count: number
}

export async function getPaymentsSummary(params: {
  from_date?: string
  to_date?: string
}) {
  const { data } = await api.get<PaymentsSummary>('/billing/payments/summary', { params })
  return data
}
export async function getSalesAggregate(params: {
  from_date: string
  to_date: string
  group_by: 'day' | 'month'
}) {
  const res = await api.get('/billing/summary/aggregate', { params })
  return res.data as Array<{
    period: string
    bills_count: number
    gross_sales: number
    paid_total: number
    pending_total: number
  }>
}
