// src/services/billing.ts
import api from './api'

// ---------- Create Bill (request) ----------
export interface BillItemIn { item_id: number; quantity: number; mrp: number }

export interface BillCreate {
  items: BillItemIn[];
  discount_percent?: number;
  tax_percent?: number;
  payment_mode: 'cash' | 'online' | 'split';
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
  payment_mode: 'cash' | 'online' | 'split';
  payment_cash: number;
  payment_online: number;
  notes: string;
  items: BillItem[];
}

export async function getBill(id: number) {
  const { data } = await api.get<Bill>(`/billing/${id}/`);
  return data;
}

// ---------- List Bills ----------
export async function listBills(params: {
  q?: string;          // <-- keep this so Reports.tsx can pass q
  from_date?: string;  // YYYY-MM-DD
  to_date?: string;    // YYYY-MM-DD (inclusive)
  limit?: number;      // backend min 1, max 500
  offset?: number;     // >= 0
}) {
  const { data } = await api.get<Bill[]>('/billing/', { params });
  return data; // array of bills
}
