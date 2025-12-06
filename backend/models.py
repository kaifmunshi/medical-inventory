# backend/models.py
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
    created_at: str = Field(
        default_factory=lambda: datetime.now().isoformat(timespec="seconds")
    )
    updated_at: str = Field(
        default_factory=lambda: datetime.now().isoformat(timespec="seconds")
    )

# --- NEW ---
class Bill(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    date_time: str = Field(
        default_factory=lambda: datetime.now().isoformat(timespec="seconds")
    )
    discount_percent: float = 0.0       # invoice-level discount %
    subtotal: float                     # sum of (qty * mrp)
    total_amount: float                 # after discount
    payment_mode: str                   # "cash" | "online" | "split"
    payment_cash: float = 0.0
    payment_online: float = 0.0
    notes: Optional[str] = None


class BillItem(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    bill_id: int
    item_id: int
    item_name: str                      # denormalized for easy printing later
    mrp: float
    quantity: int
    line_total: float                   # qty * mrp (no tax)

# ---------- Returns (DB) ----------
class Return(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    date_time: str = Field(
        default_factory=lambda: datetime.now().isoformat(timespec="seconds")
    )
    source_bill_id: Optional[int] = None   # can be null for “no bill”
    subtotal_return: float                  # sum of (qty * mrp) being returned
    refund_cash: float = 0.0
    refund_online: float = 0.0
    notes: Optional[str] = None

    # NEW: how much we adjusted the theoretical net in an exchange
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

    # 👇 FIXED: removed sa_column, just keep index
    mobile: str = Field(index=True)

    item_name: str
    notes: Optional[str] = None
    is_available: bool = Field(default=False, index=True)
    created_at: str = Field(
        default_factory=lambda: datetime.now().isoformat(timespec="seconds")
    )
    updated_at: str = Field(
        default_factory=lambda: datetime.now().isoformat(timespec="seconds")
    )


# ---------- Schemas (requests / responses) ----------
class ItemCreate(SQLModel):
    name: str
    mrp: float
    stock: int = 0
    brand: Optional[str] = None
    # batch_no: REMOVED
    expiry_date: Optional[str] = None


class ItemUpdate(SQLModel):
    name: Optional[str] = None
    mrp: Optional[float] = None
    stock: Optional[int] = None
    brand: Optional[str] = None
    # batch_no: REMOVED
    expiry_date: Optional[str] = None


class ItemOut(SQLModel):
    id: int
    name: str
    mrp: float
    stock: int
    brand: Optional[str] = None
    # batch_no: REMOVED
    expiry_date: Optional[str] = None
    created_at: str
    updated_at: str

# --- Billing Schemas ---
class BillItemIn(SQLModel):
    item_id: int
    quantity: int


class BillCreate(SQLModel):
    items: List[BillItemIn]
    discount_percent: float = 0.0
    payment_mode: str                 # "cash" | "online" | "split"
    payment_cash: float = 0.0
    payment_online: float = 0.0
    final_amount: Optional[float] = None   # <-- ADD THIS
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
    items: List[BillItemOut]

# ---------- Returns (Schemas) ----------
class ReturnItemIn(SQLModel):
    item_id: int
    quantity: int


class ReturnCreate(SQLModel):
    source_bill_id: Optional[int] = None
    items: List[ReturnItemIn]
    refund_mode: str                        # "cash" | "online" | "split"
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

    # NEW
    rounding_adjustment: float = 0.0

    items: List[ReturnItemOut]


# ---------- Exchange (Schema only – uses Bill + Return under the hood) ----------
class ExchangeCreate(SQLModel):
    source_bill_id: Optional[int] = None
    return_items: List[ReturnItemIn]       # items customer gives back
    new_items: List[BillItemIn]            # items customer takes
    discount_percent: float = 0.0          # applies only to new_items
    payment_mode: str                      # "cash" | "online" | "split"
    payment_cash: float = 0.0              # positive => customer pays; negative handled as refund inputs below
    payment_online: float = 0.0
    refund_cash: float = 0.0               # if net is refund to customer
    refund_online: float = 0.0
    notes: Optional[str] = None

    # NEW: FE will send this
    rounding_adjustment: float = 0.0       # can be +ve or -ve

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
