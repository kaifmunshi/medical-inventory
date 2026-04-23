export type ID = number

export interface Item {
  id: ID
  name: string
  brand?: string | null
  product_id?: ID | null
  category_id?: ID | null
  expiry_date?: string | null
  mrp: number
  cost_price?: number
  stock: number
  rack_number: number
  created_at?: string
  updated_at?: string
}

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

export interface Brand {
  id: ID
  name: string
  is_active: boolean
  created_at?: string
  updated_at?: string
}

export interface Category {
  id: ID
  name: string
  is_active: boolean
  created_at?: string
  updated_at?: string
}

export interface Product {
  id: ID
  name: string
  alias?: string | null
  brand?: string | null
  category_id?: ID | null
  default_rack_number: number
  printed_price: number
  parent_unit_name?: string | null
  child_unit_name?: string | null
  loose_sale_enabled?: boolean
  default_conversion_qty?: number | null
  is_active: boolean
  created_at?: string
  updated_at?: string
}

export interface Party {
  id: ID
  name: string
  party_group: 'SUNDRY_DEBTOR' | 'SUNDRY_CREDITOR'
  phone?: string | null
  address_line?: string | null
  gst_number?: string | null
  notes?: string | null
  opening_balance: number
  opening_balance_type: 'DR' | 'CR'
  legacy_customer_id?: ID | null
  is_active: boolean
  created_at?: string
  updated_at?: string
}

export interface FinancialYear {
  id: ID
  label: string
  start_date: string
  end_date: string
  is_active: boolean
  is_locked: boolean
  created_at?: string
  updated_at?: string
}

export interface AuditLog {
  id: ID
  event_ts: string
  entity_type: string
  entity_id?: ID | null
  action: string
  note?: string | null
  details_json?: string | null
  actor?: string | null
}

export interface AppUser {
  id: ID
  name: string
  role: 'OWNER' | 'MANAGER' | 'STAFF'
  has_pin: boolean
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface UserSession {
  token: string
  user: AppUser
}

export interface StockAudit {
  id: ID
  name: string
  status: 'DRAFT' | 'FINALIZED'
  created_at: string
  closed_at?: string | null
}

export interface StockAuditItem {
  id: ID
  audit_id: ID
  item_id: ID
  system_stock: number
  physical_stock?: number | null
  item_name: string
  item_brand?: string | null
  item_rack?: number | null
  item_mrp: number
  item_expiry?: string | null
}

export interface PurchaseItemPayload {
  product_id?: ID
  product_name: string
  alias?: string
  brand?: string
  category_id?: ID
  expiry_date?: string
  rack_number?: number
  sealed_qty: number
  free_qty?: number
  cost_price: number
  mrp: number
  gst_percent?: number
  discount_amount?: number
  loose_sale_enabled?: boolean
  parent_unit_name?: string
  child_unit_name?: string
  conversion_qty?: number
}

export interface PurchasePaymentPayload {
  amount: number
  note?: string
  is_writeoff?: boolean
}

export interface PurchaseItem {
  id: ID
  purchase_id: ID
  product_id: ID
  inventory_item_id?: ID | null
  lot_id?: ID | null
  product_name: string
  brand?: string | null
  expiry_date?: string | null
  rack_number: number
  sealed_qty: number
  free_qty: number
  cost_price: number
  effective_cost_price: number
  mrp: number
  gst_percent: number
  discount_amount: number
  line_total: number
}

export interface PurchasePayment {
  id: ID
  purchase_id: ID
  paid_at: string
  amount: number
  note?: string | null
  is_writeoff: boolean
  is_deleted: boolean
  deleted_at?: string | null
}

export interface Purchase {
  id: ID
  party_id: ID
  invoice_number: string
  invoice_date: string
  notes?: string | null
  subtotal_amount: number
  discount_amount: number
  gst_amount: number
  rounding_adjustment: number
  total_amount: number
  paid_amount: number
  writeoff_amount: number
  payment_status: 'UNPAID' | 'PARTIAL' | 'PAID'
  is_deleted: boolean
  deleted_at?: string | null
  created_at: string
  updated_at: string
  items: PurchaseItem[]
  payments: PurchasePayment[]
}

export interface PurchaseLedgerRow {
  purchase_id: ID
  invoice_number: string
  invoice_date: string
  total_amount: number
  paid_amount: number
  writeoff_amount: number
  outstanding_amount: number
  payment_status: 'UNPAID' | 'PARTIAL' | 'PAID'
  notes?: string | null
}

export interface SupplierLedgerSummary {
  party_id: ID
  total_purchases: number
  total_paid: number
  total_writeoff: number
  outstanding_amount: number
}

export interface InventoryLotBrowse {
  id: ID
  product_id: ID
  product_name: string
  alias?: string | null
  brand?: string | null
  category_id?: ID | null
  expiry_date?: string | null
  mrp: number
  cost_price?: number | null
  rack_number: number
  sealed_qty: number
  loose_qty: number
  conversion_qty?: number | null
  loose_sale_enabled: boolean
  parent_unit_name?: string | null
  child_unit_name?: string | null
  opened_from_lot_id?: ID | null
  legacy_item_id?: ID | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface PackOpenEvent {
  id: ID
  source_lot_id: ID
  loose_lot_id: ID
  source_item_id?: ID | null
  loose_item_id?: ID | null
  packs_opened: number
  loose_units_created: number
  note?: string | null
  created_at: string
}

export interface DebtorLedgerRow {
  bill_id: ID
  bill_date: string
  customer_name: string
  total_amount: number
  paid_amount: number
  writeoff_amount: number
  outstanding_amount: number
  payment_status: 'UNPAID' | 'PARTIAL' | 'PAID'
  notes?: string | null
}

export interface OpenBill {
  bill_id: ID
  bill_date: string
  total_amount: number
  paid_amount: number
  writeoff_amount: number
  outstanding_amount: number
  payment_status: 'UNPAID' | 'PARTIAL' | 'PAID'
  notes?: string | null
}

export interface PartyReceipt {
  id: ID
  party_id: ID
  received_at: string
  mode: 'cash' | 'online' | 'split'
  cash_amount: number
  online_amount: number
  total_amount: number
  unallocated_amount: number
  note?: string | null
  is_deleted: boolean
  deleted_at?: string | null
}

export interface ReceiptBillAdjustment {
  id: ID
  receipt_id: ID
  bill_id: ID
  bill_payment_id?: ID | null
  adjusted_amount: number
  created_at: string
}

export interface VoucherDayBookRow {
  ts: string
  voucher_type:
    | 'SALE'
    | 'PURCHASE'
    | 'RECEIPT'
    | 'PAYMENT'
    | 'RETURN'
    | 'EXCHANGE'
    | 'EXPENSE'
    | 'WITHDRAWAL'
    | 'STOCK_JOURNAL'
    | 'WRITE_OFF'
  source_type: string
  source_id: ID
  voucher_no: string
  party_name?: string | null
  narration?: string | null
  amount: number
  cash_amount: number
  online_amount: number
  status?: string | null
  is_deleted: boolean
}

export interface VoucherDayBookSummary {
  total_rows: number
  sales_total: number
  purchase_total: number
  receipt_total: number
  payment_total: number
  return_total: number
  exchange_total: number
  expense_total: number
  withdrawal_total: number
  stock_journal_count: number
  writeoff_total: number
}

export interface VoucherDayBook {
  from_date: string
  to_date: string
  rows: VoucherDayBookRow[]
  summary: VoucherDayBookSummary
}

export interface LedgerGroup {
  id: ID
  name: string
  nature: 'ASSET' | 'LIABILITY' | 'INCOME' | 'EXPENSE'
  system_key?: string | null
  is_system: boolean
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface Ledger {
  id: ID
  name: string
  group_id: ID
  party_id?: ID | null
  system_key?: string | null
  is_system: boolean
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface PostedVoucherEntry {
  id: ID
  voucher_id: ID
  ledger_id: ID
  entry_type: 'DR' | 'CR'
  amount: number
  narration?: string | null
  sort_order: number
  created_at: string
}

export interface PostedVoucher {
  id: ID
  voucher_type: string
  source_type: string
  source_id: ID
  voucher_no: string
  voucher_date: string
  narration?: string | null
  total_amount: number
  is_deleted: boolean
  deleted_at?: string | null
  created_at: string
  updated_at: string
  entries: PostedVoucherEntry[]
}
