// frontend/src/lib/types.ts
export type ID = number

export interface Item {
  id: ID
  name: string
  brand?: string | null
  expiry_date?: string | null // YYYY-MM-DD
  mrp: number
  stock: number

  // ✅ NEW
  rack_number: number

  created_at?: string
  updated_at?: string
}

export interface BillItemIn {
  item_id: ID
  quantity: number
  mrp: number
}

export interface BillCreate {
  items: BillItemIn[]
  discount_percent?: number
  tax_percent?: number
  payment_mode: 'cash' | 'online' | 'split'
  payment_cash?: number
  payment_online?: number
  notes?: string
}

/**
 * NEW – for "Requested Items" feature
 */
export interface RequestedItem {
  id: ID
  customer_name?: string | null
  mobile: string
  item_name: string
  notes?: string | null
  is_available: boolean
  created_at?: string
  updated_at?: string
}

export interface Customer {
  id: ID
  name: string
  phone?: string | null
  address_line?: string | null
  created_at?: string
  updated_at?: string
}
