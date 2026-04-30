from typing import Optional, List
from datetime import datetime
from sqlmodel import SQLModel, Field, Column, String

# ---------- DB Tables ----------
class Item(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    brand: Optional[str] = Field(default=None, index=True)
    product_id: Optional[int] = Field(default=None, index=True)
    category_id: Optional[int] = Field(default=None, index=True)
    # batch_no: REMOVED
    expiry_date: Optional[str] = Field(default=None, sa_column=Column(String(10)))
    mrp: float
    cost_price: float = 0.0
    stock: int = 0
    rack_number: int = Field(default=0, index=True)
    # ✅ NEW: soft-archive sold-out duplicate batches
    is_archived: bool = Field(default=False, index=True)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


# --- UPDATED ---
class Bill(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    date_time: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    discount_percent: float = 0.0
    subtotal: float
    total_amount: float

    # payment_mode now can also be "credit"
    payment_mode: str  # "cash" | "online" | "split" | "credit"

    payment_cash: float = 0.0
    payment_online: float = 0.0
    notes: Optional[str] = None

    # ✅ credit bill tracking
    is_credit: bool = Field(default=False, index=True)              # true if credit
    payment_status: str = Field(default="PAID", index=True)         # "PAID"|"UNPAID"|"PARTIAL"
    paid_amount: float = 0.0                                        # total paid so far
    writeoff_amount: float = 0.0
    paid_at: Optional[str] = None                                   # keep plain Optional[str]
    is_deleted: bool = Field(default=False, index=True)
    deleted_at: Optional[str] = None


class BillItem(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    bill_id: int
    item_id: int
    item_name: str                      # denormalized for easy printing later
    mrp: float
    quantity: int
    line_total: float                   # qty * mrp (no tax)


class BillItemAllocation(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    bill_id: int = Field(index=True)
    bill_item_id: int = Field(index=True)
    item_id: int = Field(index=True)
    lot_id: Optional[int] = Field(default=None, index=True)
    quantity: int = 0
    stock_unit: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"), index=True)


class BillPayment(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    bill_id: int = Field(index=True)

    received_at: str = Field(
        default_factory=lambda: datetime.now().isoformat(timespec="seconds"),
        index=True,
    )

    mode: str  # "cash" | "online" | "split"
    cash_amount: float = 0.0
    online_amount: float = 0.0
    writeoff_amount: float = 0.0
    note: Optional[str] = None
    is_writeoff: bool = Field(default=False, index=True)
    is_deleted: bool = Field(default=False, index=True)
    deleted_at: Optional[str] = None


# ---------- Returns (DB) ----------
class Return(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    date_time: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    source_bill_id: Optional[int] = None   # can be null for “no bill”
    subtotal_return: float                 # sum of (qty * mrp) being returned
    refund_cash: float = 0.0
    refund_online: float = 0.0
    notes: Optional[str] = None

    rounding_adjustment: float = 0.0


class ReturnItem(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    return_id: int
    item_id: int
    item_name: str
    mrp: float
    quantity: int
    line_total: float


class ExchangeRecord(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"), index=True)
    source_bill_id: Optional[int] = None
    return_id: int = Field(index=True)
    new_bill_id: int = Field(index=True)
    theoretical_net: float = 0.0
    net_due: float = 0.0
    rounding_adjustment: float = 0.0
    payment_mode: str = "cash"
    payment_cash: float = 0.0
    payment_online: float = 0.0
    refund_cash: float = 0.0
    refund_online: float = 0.0
    notes: Optional[str] = None


# ---------- Requested Items (DB) ----------
class RequestedItem(SQLModel, table=True):
    """
    Simple table for 'customer requested items' – independent of Inventory.
    """
    id: Optional[int] = Field(default=None, primary_key=True)
    customer_name: Optional[str] = None
    mobile: str = Field(index=True)
    item_name: str
    notes: Optional[str] = None
    is_available: bool = Field(default=False, index=True)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))

# ---------- Customers (DB) ----------
class Customer(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    phone: Optional[str] = Field(default=None, index=True)
    address_line: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


class Brand(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    is_active: bool = Field(default=True, index=True)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


class Category(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    is_active: bool = Field(default=True, index=True)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


class Product(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    alias: Optional[str] = Field(default=None, index=True)
    brand: Optional[str] = Field(default=None, index=True)
    category_id: Optional[int] = Field(default=None, index=True)
    default_rack_number: int = Field(default=0, index=True)
    printed_price: float = 0.0
    parent_unit_name: Optional[str] = None
    child_unit_name: Optional[str] = None
    loose_sale_enabled: bool = Field(default=False, index=True)
    default_conversion_qty: Optional[int] = None
    is_active: bool = Field(default=True, index=True)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


class InventoryLot(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    product_id: int = Field(index=True)
    expiry_date: Optional[str] = Field(default=None, sa_column=Column(String(10)))
    mrp: float = 0.0
    cost_price: Optional[float] = None
    rack_number: int = Field(default=0, index=True)
    sealed_qty: int = Field(default=0)
    loose_qty: int = Field(default=0)
    conversion_qty: Optional[int] = None
    opened_from_lot_id: Optional[int] = Field(default=None, index=True)
    legacy_item_id: Optional[int] = Field(default=None, index=True)
    is_active: bool = Field(default=True, index=True)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


class AppUser(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    role: str = Field(index=True)  # OWNER | MANAGER | STAFF
    pin: Optional[str] = None
    is_active: bool = Field(default=True, index=True)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


# ---------- Schemas (requests / responses) ----------
class ItemCreate(SQLModel):
    name: str
    mrp: float
    cost_price: float = 0.0
    stock: int = 0
    rack_number: int = 0
    brand: Optional[str] = None
    expiry_date: Optional[str] = None
    product_id: Optional[int] = None
    category_id: Optional[int] = None


class ItemUpdate(SQLModel):
    name: Optional[str] = None
    mrp: Optional[float] = None
    cost_price: Optional[float] = None
    stock: Optional[int] = None
    brand: Optional[str] = None
    rack_number: Optional[int] = None
    expiry_date: Optional[str] = None
    product_id: Optional[int] = None
    category_id: Optional[int] = None


class ItemOut(SQLModel):
    id: int
    name: str
    mrp: float
    cost_price: float
    stock: int
    brand: Optional[str] = None
    product_id: Optional[int] = None
    category_id: Optional[int] = None
    rack_number: int
    expiry_date: Optional[str] = None
    created_at: str
    updated_at: str


# --- Billing Schemas ---
class BillItemIn(SQLModel):
    item_id: int
    quantity: int
    custom_unit_price: Optional[float] = None


class BillCreate(SQLModel):
    items: List[BillItemIn]
    discount_percent: float = 0.0
    payment_mode: str                 # "cash" | "online" | "split" | "credit"
    payment_cash: float = 0.0
    payment_online: float = 0.0
    payment_credit: float = 0.0
    final_amount: Optional[float] = None
    date_time: Optional[str] = None
    notes: Optional[str] = None


class BillItemOut(SQLModel):
    item_id: int
    item_name: str
    mrp: float
    quantity: int
    line_total: float


class BillOut(SQLModel):
    id: int
    date_time: str
    discount_percent: float
    subtotal: float
    total_amount: float
    payment_mode: str
    payment_cash: float
    payment_online: float
    notes: Optional[str] = None

    is_credit: bool = False
    payment_status: str = "PAID"
    paid_amount: float = 0.0
    writeoff_amount: float = 0.0
    paid_at: Optional[str] = None
    is_deleted: bool = False
    deleted_at: Optional[str] = None

    items: List[BillItemOut]


# ---------- Returns (Schemas) ----------
class ReturnItemIn(SQLModel):
    item_id: int
    quantity: int


class ReturnCreate(SQLModel):
    source_bill_id: Optional[int] = None
    items: List[ReturnItemIn]
    refund_mode: str                        # "cash" | "online" | "split" | "credit"
    refund_cash: float = 0.0
    refund_online: float = 0.0
    notes: Optional[str] = None


class ReturnItemOut(SQLModel):
    item_id: int
    item_name: str
    mrp: float
    quantity: int
    line_total: float


class ReturnOut(SQLModel):
    id: int
    date_time: str
    source_bill_id: Optional[int]
    subtotal_return: float
    refund_cash: float
    refund_online: float
    notes: Optional[str] = None
    rounding_adjustment: float = 0.0
    items: List[ReturnItemOut]


# ---------- Exchange (Schema only – uses Bill + Return under the hood) ----------
class ExchangeCreate(SQLModel):
    source_bill_id: Optional[int] = None
    return_items: List[ReturnItemIn]
    new_items: List[BillItemIn]
    discount_percent: float = 0.0
    payment_mode: str
    payment_cash: float = 0.0
    payment_online: float = 0.0
    refund_cash: float = 0.0
    refund_online: float = 0.0
    notes: Optional[str] = None
    rounding_adjustment: float = 0.0


# ---------- Requested Items (Schemas) ----------
class RequestedItemCreate(SQLModel):
    customer_name: Optional[str] = None
    mobile: str
    item_name: str
    notes: Optional[str] = None


class RequestedItemUpdate(SQLModel):
    customer_name: Optional[str] = None
    mobile: Optional[str] = None
    item_name: Optional[str] = None
    notes: Optional[str] = None
    is_available: Optional[bool] = None


class RequestedItemOut(SQLModel):
    id: int
    customer_name: Optional[str] = None
    mobile: str
    item_name: str
    notes: Optional[str] = None
    is_available: bool
    created_at: str
    updated_at: str


# ---------- Customers (Schemas) ----------
class CustomerCreate(SQLModel):
    name: str
    phone: Optional[str] = None
    address_line: Optional[str] = None

class CustomerUpdate(SQLModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    address_line: Optional[str] = None


class CustomerOut(SQLModel):
    id: int
    name: str
    phone: Optional[str] = None
    address_line: Optional[str] = None
    created_at: str
    updated_at: str


class BrandCreate(SQLModel):
    name: str


class BrandUpdate(SQLModel):
    name: Optional[str] = None
    is_active: Optional[bool] = None


class BrandOut(SQLModel):
    id: int
    name: str
    is_active: bool
    created_at: str
    updated_at: str


class CategoryCreate(SQLModel):
    name: str


class CategoryUpdate(SQLModel):
    name: Optional[str] = None
    is_active: Optional[bool] = None


class CategoryOut(SQLModel):
    id: int
    name: str
    is_active: bool
    created_at: str
    updated_at: str


class ProductCreate(SQLModel):
    name: str
    alias: Optional[str] = None
    brand: Optional[str] = None
    category_id: Optional[int] = None
    default_rack_number: int = 0
    printed_price: float = 0.0
    parent_unit_name: Optional[str] = None
    child_unit_name: Optional[str] = None
    loose_sale_enabled: bool = False
    default_conversion_qty: Optional[int] = None


class ProductUpdate(SQLModel):
    name: Optional[str] = None
    alias: Optional[str] = None
    brand: Optional[str] = None
    category_id: Optional[int] = None
    default_rack_number: Optional[int] = None
    printed_price: Optional[float] = None
    parent_unit_name: Optional[str] = None
    child_unit_name: Optional[str] = None
    loose_sale_enabled: Optional[bool] = None
    default_conversion_qty: Optional[int] = None
    is_active: Optional[bool] = None


class ProductOut(SQLModel):
    id: int
    name: str
    alias: Optional[str] = None
    brand: Optional[str] = None
    category_id: Optional[int] = None
    default_rack_number: int
    printed_price: float
    parent_unit_name: Optional[str] = None
    child_unit_name: Optional[str] = None
    loose_sale_enabled: bool = False
    default_conversion_qty: Optional[int] = None
    is_active: bool
    created_at: str
    updated_at: str


class InventoryLotCreate(SQLModel):
    product_id: int
    expiry_date: Optional[str] = None
    mrp: float = 0.0
    cost_price: Optional[float] = None
    rack_number: int = 0
    sealed_qty: int = 0
    loose_qty: int = 0
    conversion_qty: Optional[int] = None
    opened_from_lot_id: Optional[int] = None


class InventoryLotUpdate(SQLModel):
    expiry_date: Optional[str] = None
    mrp: Optional[float] = None
    cost_price: Optional[float] = None
    rack_number: Optional[int] = None
    sealed_qty: Optional[int] = None
    loose_qty: Optional[int] = None
    conversion_qty: Optional[int] = None
    opened_from_lot_id: Optional[int] = None
    is_active: Optional[bool] = None


class InventoryLotOut(SQLModel):
    id: int
    product_id: int
    expiry_date: Optional[str] = None
    mrp: float
    cost_price: Optional[float] = None
    rack_number: int
    sealed_qty: int
    loose_qty: int
    conversion_qty: Optional[int] = None
    opened_from_lot_id: Optional[int] = None
    legacy_item_id: Optional[int] = None
    is_active: bool
    created_at: str
    updated_at: str


class AppUserCreate(SQLModel):
    name: str
    role: str
    pin: Optional[str] = None


class AppUserUpdate(SQLModel):
    name: Optional[str] = None
    role: Optional[str] = None
    pin: Optional[str] = None
    is_active: Optional[bool] = None


class AppUserOut(SQLModel):
    id: int
    name: str
    role: str
    has_pin: bool = False
    is_active: bool
    created_at: str
    updated_at: str


# --- Cashbook (DB) ---
class CashbookEntry(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    created_at: str = Field(
        default_factory=lambda: datetime.now().isoformat(timespec="seconds"),
        index=True,
    )

    entry_type: str = Field(index=True)  # "WITHDRAWAL" | "EXPENSE"
    amount: float                        # always store positive number
    note: Optional[str] = None


# --- Cashbook Schemas ---
class CashbookCreate(SQLModel):
    entry_type: str  # "WITHDRAWAL" | "EXPENSE"
    amount: float
    note: Optional[str] = None
    entry_date: Optional[str] = None  # YYYY-MM-DD (optional; defaults to today)


class CashbookOut(SQLModel):
    id: int
    created_at: str
    entry_type: str
    amount: float
    note: Optional[str] = None


class CashbookSummary(SQLModel):
    cash_out: float
    withdrawals: float
    expenses: float
    count: int


# --- Bankbook (DB) ---
class BankbookEntry(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    created_at: str = Field(
        default_factory=lambda: datetime.now().isoformat(timespec="seconds"),
        index=True,
    )

    entry_type: str = Field(index=True)  # "RECEIPT" | "WITHDRAWAL" | "EXPENSE"
    mode: str = Field(index=True)        # "UPI" | "NEFT" | "RTGS" | "IMPS" | "BANK_DEPOSIT"
    amount: float
    txn_charges: float = 0.0
    note: Optional[str] = None


# --- Bankbook Schemas ---
class BankbookCreate(SQLModel):
    entry_type: str
    mode: str
    amount: float
    txn_charges: float = 0.0
    note: Optional[str] = None
    entry_date: Optional[str] = None


class BankbookOut(SQLModel):
    id: int
    created_at: str
    entry_type: str
    mode: str
    amount: float
    txn_charges: float = 0.0
    note: Optional[str] = None


class BankbookSummary(SQLModel):
    bank_out: float
    withdrawals: float
    expenses: float
    receipts: float
    charges: float
    net_change: float
    count: int


# ---------- Stock Movement Ledger (DB) ----------
class StockMovement(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    item_id: int = Field(index=True)

    ts: str = Field(index=True)          # ISO datetime string
    delta: int                           # +in / -out
    reason: str = Field(index=True)      # OPENING / SALE / RETURN / ADJUST

    ref_type: Optional[str] = Field(default=None, index=True)  # BILL / ITEM / MANUAL
    ref_id: Optional[int] = Field(default=None, index=True)

    note: Optional[str] = None
    actor: Optional[str] = None


class Party(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    party_group: str = Field(index=True)  # SUNDRY_DEBTOR | SUNDRY_CREDITOR
    phone: Optional[str] = Field(default=None, index=True)
    address_line: Optional[str] = None
    gst_number: Optional[str] = None
    notes: Optional[str] = None
    opening_balance: float = 0.0
    opening_balance_type: str = Field(default="DR")
    legacy_customer_id: Optional[int] = Field(default=None, index=True)
    is_active: bool = Field(default=True, index=True)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


class FinancialYear(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    label: str = Field(index=True)
    start_date: str = Field(sa_column=Column(String(10)))
    end_date: str = Field(sa_column=Column(String(10)))
    is_active: bool = Field(default=False, index=True)
    is_locked: bool = Field(default=False, index=True)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


class AuditLog(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    event_ts: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"), index=True)
    entity_type: str = Field(index=True)
    entity_id: Optional[int] = Field(default=None, index=True)
    action: str = Field(index=True)
    note: Optional[str] = None
    details_json: Optional[str] = None
    actor: Optional[str] = None


class StockAudit(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    status: str = Field(default="DRAFT", index=True)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    closed_at: Optional[str] = None


class StockAuditItem(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    audit_id: int = Field(index=True)
    item_id: int = Field(index=True)
    system_stock: int = 0
    physical_stock: Optional[int] = None


class Purchase(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    party_id: int = Field(index=True)
    invoice_number: str = Field(index=True)
    invoice_date: str = Field(sa_column=Column(String(10)))
    notes: Optional[str] = None
    subtotal_amount: float = 0.0
    discount_amount: float = 0.0
    gst_amount: float = 0.0
    rounding_adjustment: float = 0.0
    total_amount: float = 0.0
    paid_amount: float = 0.0
    writeoff_amount: float = 0.0
    payment_status: str = Field(default="UNPAID", index=True)
    is_deleted: bool = Field(default=False, index=True)
    deleted_at: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


class PurchaseItem(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    purchase_id: int = Field(index=True)
    product_id: int = Field(index=True)
    inventory_item_id: Optional[int] = Field(default=None, index=True)
    lot_id: Optional[int] = Field(default=None, index=True)
    stock_source: str = Field(default="CREATED", index=True)
    product_name: str
    brand: Optional[str] = None
    expiry_date: Optional[str] = Field(default=None, sa_column=Column(String(10)))
    rack_number: int = 0
    sealed_qty: int = 0
    free_qty: int = 0
    cost_price: float = 0.0
    effective_cost_price: float = 0.0
    mrp: float = 0.0
    gst_percent: float = 0.0
    discount_amount: float = 0.0
    rounding_adjustment: float = 0.0
    line_total: float = 0.0


class PurchasePayment(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    purchase_id: int = Field(index=True)
    paid_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"), index=True)
    mode: str = Field(default="cash", index=True)
    amount: float = 0.0
    cash_amount: float = 0.0
    online_amount: float = 0.0
    note: Optional[str] = None
    is_writeoff: bool = Field(default=False, index=True)
    is_deleted: bool = Field(default=False, index=True)
    deleted_at: Optional[str] = None


class PackOpenEvent(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    source_lot_id: int = Field(index=True)
    loose_lot_id: int = Field(index=True)
    source_item_id: Optional[int] = Field(default=None, index=True)
    loose_item_id: Optional[int] = Field(default=None, index=True)
    packs_opened: int = 0
    loose_units_created: int = 0
    note: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"), index=True)


class PartyReceipt(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    party_id: int = Field(index=True)
    received_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"), index=True)
    mode: str
    cash_amount: float = 0.0
    online_amount: float = 0.0
    total_amount: float = 0.0
    unallocated_amount: float = 0.0
    note: Optional[str] = None
    is_deleted: bool = Field(default=False, index=True)
    deleted_at: Optional[str] = None


class ReceiptBillAdjustment(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    receipt_id: int = Field(index=True)
    bill_id: int = Field(index=True)
    bill_payment_id: Optional[int] = Field(default=None, index=True)
    adjusted_amount: float = 0.0
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"), index=True)


class LedgerGroup(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    nature: str = Field(index=True)  # ASSET | LIABILITY | INCOME | EXPENSE
    system_key: Optional[str] = Field(default=None, index=True)
    is_system: bool = Field(default=False, index=True)
    is_active: bool = Field(default=True, index=True)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


class Ledger(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    group_id: int = Field(index=True)
    party_id: Optional[int] = Field(default=None, index=True)
    system_key: Optional[str] = Field(default=None, index=True)
    is_system: bool = Field(default=False, index=True)
    is_active: bool = Field(default=True, index=True)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


class Voucher(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    voucher_type: str = Field(index=True)
    source_type: str = Field(index=True)
    source_id: int = Field(index=True)
    voucher_no: str = Field(index=True)
    voucher_date: str = Field(index=True)
    narration: Optional[str] = None
    total_amount: float = 0.0
    is_deleted: bool = Field(default=False, index=True)
    deleted_at: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


class VoucherEntry(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    voucher_id: int = Field(index=True)
    ledger_id: int = Field(index=True)
    entry_type: str = Field(index=True)  # DR | CR
    amount: float = 0.0
    narration: Optional[str] = None
    sort_order: int = Field(default=0)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


class PartyCreate(SQLModel):
    name: str
    party_group: str
    phone: Optional[str] = None
    address_line: Optional[str] = None
    gst_number: Optional[str] = None
    notes: Optional[str] = None
    opening_balance: float = 0.0
    opening_balance_type: str = "DR"


class PartyUpdate(SQLModel):
    name: Optional[str] = None
    party_group: Optional[str] = None
    phone: Optional[str] = None
    address_line: Optional[str] = None
    gst_number: Optional[str] = None
    notes: Optional[str] = None
    opening_balance: Optional[float] = None
    opening_balance_type: Optional[str] = None
    is_active: Optional[bool] = None


class PartyOut(SQLModel):
    id: int
    name: str
    party_group: str
    phone: Optional[str] = None
    address_line: Optional[str] = None
    gst_number: Optional[str] = None
    notes: Optional[str] = None
    opening_balance: float
    opening_balance_type: str
    legacy_customer_id: Optional[int] = None
    is_active: bool
    created_at: str
    updated_at: str


class FinancialYearCreate(SQLModel):
    label: str
    start_date: str
    end_date: str
    is_active: bool = False


class FinancialYearUpdate(SQLModel):
    label: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    is_active: Optional[bool] = None
    is_locked: Optional[bool] = None


class FinancialYearOut(SQLModel):
    id: int
    label: str
    start_date: str
    end_date: str
    is_active: bool
    is_locked: bool
    created_at: str
    updated_at: str


class AuditLogOut(SQLModel):
    id: int
    event_ts: str
    entity_type: str
    entity_id: Optional[int] = None
    action: str
    note: Optional[str] = None
    details_json: Optional[str] = None
    actor: Optional[str] = None


class StockAuditCreate(SQLModel):
    name: str


class StockAuditOut(SQLModel):
    id: int
    name: str
    status: str
    created_at: str
    closed_at: Optional[str] = None


class StockAuditItemOut(SQLModel):
    id: int
    audit_id: int
    item_id: int
    system_stock: int
    physical_stock: Optional[int] = None
    item_name: str
    item_brand: Optional[str] = None
    item_rack: Optional[int] = None
    item_mrp: float
    item_expiry: Optional[str] = None


class PurchaseItemIn(SQLModel):
    existing_inventory_item_id: Optional[int] = None
    product_id: Optional[int] = None
    product_name: str
    alias: Optional[str] = None
    brand: Optional[str] = None
    category_id: Optional[int] = None
    expiry_date: Optional[str] = None
    rack_number: Optional[int] = None
    sealed_qty: int
    free_qty: int = 0
    cost_price: float
    mrp: float
    gst_percent: float = 0.0
    discount_amount: float = 0.0
    rounding_adjustment: float = 0.0
    loose_sale_enabled: bool = False
    parent_unit_name: Optional[str] = None
    child_unit_name: Optional[str] = None
    conversion_qty: Optional[int] = None


class PurchasePaymentIn(SQLModel):
    amount: float
    mode: Optional[str] = None
    cash_amount: float = 0.0
    online_amount: float = 0.0
    note: Optional[str] = None
    is_writeoff: bool = False


class PurchaseCreate(SQLModel):
    party_id: int
    invoice_number: str
    invoice_date: str
    notes: Optional[str] = None
    discount_amount: float = 0.0
    gst_amount: float = 0.0
    rounding_adjustment: float = 0.0
    items: List[PurchaseItemIn]
    payments: List[PurchasePaymentIn] = []


class PurchaseUpdate(SQLModel):
    party_id: Optional[int] = None
    invoice_number: Optional[str] = None
    invoice_date: Optional[str] = None
    notes: Optional[str] = None
    discount_amount: Optional[float] = None
    gst_amount: Optional[float] = None
    rounding_adjustment: Optional[float] = None


class PurchasePaymentCreate(SQLModel):
    amount: float
    mode: Optional[str] = None
    cash_amount: float = 0.0
    online_amount: float = 0.0
    note: Optional[str] = None
    paid_at: Optional[str] = None
    is_writeoff: bool = False


class PurchaseItemOut(SQLModel):
    id: int
    purchase_id: int
    product_id: int
    inventory_item_id: Optional[int] = None
    lot_id: Optional[int] = None
    stock_source: str = "CREATED"
    product_name: str
    brand: Optional[str] = None
    expiry_date: Optional[str] = None
    rack_number: int
    sealed_qty: int
    free_qty: int
    cost_price: float
    effective_cost_price: float
    mrp: float
    gst_percent: float
    discount_amount: float
    rounding_adjustment: float = 0.0
    line_total: float


class PurchasePaymentOut(SQLModel):
    id: int
    purchase_id: int
    paid_at: str
    mode: str = "cash"
    amount: float
    cash_amount: float = 0.0
    online_amount: float = 0.0
    note: Optional[str] = None
    is_writeoff: bool
    is_deleted: bool
    deleted_at: Optional[str] = None


class PurchaseOut(SQLModel):
    id: int
    party_id: int
    invoice_number: str
    invoice_date: str
    notes: Optional[str] = None
    subtotal_amount: float
    discount_amount: float
    gst_amount: float
    rounding_adjustment: float
    total_amount: float
    paid_amount: float
    writeoff_amount: float
    payment_status: str
    is_deleted: bool
    deleted_at: Optional[str] = None
    created_at: str
    updated_at: str
    items: List[PurchaseItemOut]
    payments: List[PurchasePaymentOut]


class PurchaseLedgerRow(SQLModel):
    purchase_id: int
    invoice_number: str
    invoice_date: str
    total_amount: float
    paid_amount: float
    writeoff_amount: float
    outstanding_amount: float
    payment_status: str
    notes: Optional[str] = None


class SupplierLedgerSummary(SQLModel):
    party_id: int
    total_purchases: float
    total_paid: float
    total_writeoff: float
    outstanding_amount: float


class DebtorLedgerRow(SQLModel):
    bill_id: int
    bill_date: str
    customer_name: str
    total_amount: float
    paid_amount: float
    writeoff_amount: float = 0.0
    outstanding_amount: float
    payment_status: str
    notes: Optional[str] = None


class OpenBillOut(SQLModel):
    bill_id: int
    bill_date: str
    total_amount: float
    paid_amount: float
    writeoff_amount: float = 0.0
    outstanding_amount: float
    payment_status: str
    notes: Optional[str] = None


class ReceiptAdjustmentIn(SQLModel):
    bill_id: int
    amount: float


class PartyReceiptCreate(SQLModel):
    mode: str
    cash_amount: float = 0.0
    online_amount: float = 0.0
    note: Optional[str] = None
    payment_date: Optional[str] = None
    adjustments: List[ReceiptAdjustmentIn] = []


class PartyReceiptOut(SQLModel):
    id: int
    party_id: int
    received_at: str
    mode: str
    cash_amount: float
    online_amount: float
    total_amount: float
    unallocated_amount: float
    note: Optional[str] = None
    is_deleted: bool
    deleted_at: Optional[str] = None


class ReceiptBillAdjustmentOut(SQLModel):
    id: int
    receipt_id: int
    bill_id: int
    bill_payment_id: Optional[int] = None
    adjusted_amount: float
    created_at: str


class LotOpenCreate(SQLModel):
    lot_id: int
    packs_opened: int
    note: Optional[str] = None


class InventoryLotBrowseOut(SQLModel):
    id: int
    product_id: int
    product_name: str
    alias: Optional[str] = None
    brand: Optional[str] = None
    category_id: Optional[int] = None
    expiry_date: Optional[str] = None
    mrp: float
    cost_price: Optional[float] = None
    rack_number: int
    sealed_qty: int
    loose_qty: int
    conversion_qty: Optional[int] = None
    loose_sale_enabled: bool = False
    parent_unit_name: Optional[str] = None
    child_unit_name: Optional[str] = None
    opened_from_lot_id: Optional[int] = None
    legacy_item_id: Optional[int] = None
    is_active: bool
    created_at: str
    updated_at: str


class PackOpenEventOut(SQLModel):
    id: int
    source_lot_id: int
    loose_lot_id: int
    source_item_id: Optional[int] = None
    loose_item_id: Optional[int] = None
    packs_opened: int
    loose_units_created: int
    note: Optional[str] = None
    created_at: str


class VoucherDayBookRow(SQLModel):
    ts: str
    voucher_type: str
    source_type: str
    source_id: int
    voucher_no: str
    party_name: Optional[str] = None
    narration: Optional[str] = None
    amount: float
    cash_amount: float = 0.0
    online_amount: float = 0.0
    status: Optional[str] = None
    is_deleted: bool = False


class VoucherDayBookSummary(SQLModel):
    total_rows: int
    sales_total: float = 0.0
    purchase_total: float = 0.0
    receipt_total: float = 0.0
    payment_total: float = 0.0
    return_total: float = 0.0
    exchange_total: float = 0.0
    expense_total: float = 0.0
    withdrawal_total: float = 0.0
    stock_journal_count: int = 0
    writeoff_total: float = 0.0


class VoucherDayBookOut(SQLModel):
    from_date: str
    to_date: str
    rows: List[VoucherDayBookRow]
    summary: VoucherDayBookSummary


class LedgerGroupOut(SQLModel):
    id: int
    name: str
    nature: str
    system_key: Optional[str] = None
    is_system: bool
    is_active: bool
    created_at: str
    updated_at: str


class LedgerOut(SQLModel):
    id: int
    name: str
    group_id: int
    party_id: Optional[int] = None
    system_key: Optional[str] = None
    is_system: bool
    is_active: bool
    created_at: str
    updated_at: str


class VoucherEntryOut(SQLModel):
    id: int
    voucher_id: int
    ledger_id: int
    entry_type: str
    amount: float
    narration: Optional[str] = None
    sort_order: int
    created_at: str


class VoucherOut(SQLModel):
    id: int
    voucher_type: str
    source_type: str
    source_id: int
    voucher_no: str
    voucher_date: str
    narration: Optional[str] = None
    total_amount: float
    is_deleted: bool
    deleted_at: Optional[str] = None
    created_at: str
    updated_at: str
    entries: List[VoucherEntryOut]
