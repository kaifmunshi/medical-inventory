from typing import Optional, List
from datetime import datetime
from sqlmodel import SQLModel, Field, Column, String

# ---------- DB Tables ----------
class Item(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    brand: Optional[str] = Field(default=None, index=True)
    # batch_no: REMOVED
    expiry_date: Optional[str] = Field(default=None, sa_column=Column(String(10)))
    mrp: float
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
    note: Optional[str] = None


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


# ---------- Schemas (requests / responses) ----------
class ItemCreate(SQLModel):
    name: str
    mrp: float
    stock: int = 0
    rack_number: int = 0
    brand: Optional[str] = None
    expiry_date: Optional[str] = None


class ItemUpdate(SQLModel):
    name: Optional[str] = None
    mrp: Optional[float] = None
    stock: Optional[int] = None
    brand: Optional[str] = None
    rack_number: Optional[int] = None
    expiry_date: Optional[str] = None


class ItemOut(SQLModel):
    id: int
    name: str
    mrp: float
    stock: int
    brand: Optional[str] = None
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
