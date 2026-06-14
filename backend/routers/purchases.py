from datetime import datetime
import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func
from sqlmodel import SQLModel, select

from backend.accounting import mark_voucher_deleted, post_purchase_payment_voucher, sync_purchase_vouchers
from backend.controls import assert_financial_year_unlocked, log_audit
from backend.db import get_session
from backend.models import (
    AuditLog,
    AuditLogOut,
    Brand,
    Category,
    InventoryLot,
    Item,
    Party,
    Product,
    Purchase,
    PurchaseCreate,
    PurchaseItem,
    PurchaseItemIn,
    PurchaseItemOut,
    PurchaseLedgerRow,
    PurchaseOut,
    PurchasePayment,
    PurchasePaymentCreate,
    PurchasePaymentOut,
    PurchasePaymentUpdate,
    PurchaseReturn,
    PurchaseUpdate,
    StockMovement,
    SupplierLedgerSummary,
)
from backend.security import require_min_role

router = APIRouter()


def purchase_gst_amount(subtotal: float, discount: float, items: List[PurchaseItem]) -> float:
    subtotal = round2(subtotal)
    taxable_after_header_discount = max(0.0, round2(subtotal - round2(discount)))
    factor = taxable_after_header_discount / subtotal if subtotal > 0 else 0.0
    return round2(sum(round2(max(0.0, float(item.line_total or 0)) * float(item.gst_percent or 0) / 100.0) for item in items) * factor)


def raw_purchase_gst_amount(subtotal: float, discount: float, items: List[Dict[str, Any]]) -> float:
    subtotal = round2(subtotal)
    taxable_after_header_discount = max(0.0, round2(subtotal - round2(discount)))
    factor = taxable_after_header_discount / subtotal if subtotal > 0 else 0.0
    return round2(sum(round2(max(0.0, float(item["line_total"])) * float(item["gst_percent"]) / 100.0) for item in items) * factor)


def purchase_snapshot(session, purchase: Purchase) -> dict:
    items = get_purchase_items(session, int(purchase.id))
    return {
        "purchase": {
            "id": int(purchase.id),
            "party_id": int(purchase.party_id),
            "invoice_number": purchase.invoice_number,
            "invoice_date": purchase.invoice_date,
            "notes": purchase.notes,
            "subtotal_amount": round2(purchase.subtotal_amount),
            "discount_amount": round2(purchase.discount_amount),
            "gst_amount": round2(purchase.gst_amount),
            "rounding_adjustment": round2(purchase.rounding_adjustment),
            "total_amount": round2(purchase.total_amount),
            "is_deleted": bool(purchase.is_deleted),
        },
        "items": [
            {
                "id": int(item.id),
                "product_id": int(item.product_id),
                "inventory_item_id": int(item.inventory_item_id) if item.inventory_item_id else None,
                "lot_id": int(item.lot_id) if item.lot_id else None,
                "product_name": item.product_name,
                "sealed_qty": int(item.sealed_qty),
                "free_qty": int(item.free_qty),
                "cost_price": round2(item.cost_price),
                "gst_percent": round2(item.gst_percent),
                "discount_amount": round2(item.discount_amount),
                "rounding_adjustment": round2(item.rounding_adjustment),
                "line_total": round2(item.line_total),
            }
            for item in items
        ],
    }


class PurchaseItemsReplace(SQLModel):
    items: List[PurchaseItemIn]


class FreeStockCreate(SQLModel):
    party_id: Optional[int] = None
    invoice_number: Optional[str] = None
    invoice_date: str
    notes: Optional[str] = None
    items: List[PurchaseItemIn]


class SupplierPaymentAllocationIn(SQLModel):
    purchase_id: int
    amount: float


class SupplierPaymentCreate(SQLModel):
    amount: Optional[float] = None
    mode: str = "cash"
    bank_mode: Optional[str] = None
    transaction_id: Optional[str] = None
    cash_amount: float = 0.0
    online_amount: float = 0.0
    txn_charges: float = 0.0
    note: Optional[str] = None
    payment_date: Optional[str] = None
    is_writeoff: bool = False
    allocations: List[SupplierPaymentAllocationIn] = []


class PurchasePaymentBookRow(SQLModel):
    id: int
    purchase_id: int
    party_id: int
    paid_at: str
    mode: str
    bank_mode: Optional[str] = None
    transaction_id: Optional[str] = None
    amount: float
    cash_amount: float
    online_amount: float
    txn_charges: float = 0.0
    note: Optional[str] = None
    invoice_number: Optional[str] = None
    supplier_name: Optional[str] = None
    is_writeoff: bool = False
    is_deleted: bool = False
    deleted_at: Optional[str] = None


STOCK_SOURCE_CREATED = "CREATED"
STOCK_SOURCE_ATTACHED = "ATTACHED"
VALID_BANK_MODES = {"UPI", "NEFT", "RTGS", "IMPS"}
FREE_STOCK_NO_SUPPLIER_NAME = "Free Stock / No Supplier"


def now_ts() -> str:
    return datetime.now().isoformat(timespec="seconds")


def clean_text(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    text = " ".join(str(v).strip().split())
    return text or None


def product_name_key(v: Optional[str]) -> str:
    text = (clean_text(v) or "").lower()
    return re.sub(r"\b(\d+)\s+(g|gm|ml|tab|tabs|tablet|tablets|cap|caps|n)\b", r"\1\2", text)


def clean_date(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    text = str(v).strip()
    if not text:
        return None
    if len(text) != 10:
        raise HTTPException(status_code=400, detail="Dates must be YYYY-MM-DD")
    return text


def require_expiry_date(v: Optional[str], *, context: str) -> str:
    expiry = clean_date(v)
    if not expiry:
        raise HTTPException(status_code=400, detail=f"{context} expiry date is required")
    return expiry


def round2(x: Any) -> float:
    return float(f"{float(x or 0):.2f}")


def normalize_payment_mode(mode: Optional[str], amount: float, cash_amount: float, online_amount: float, is_writeoff: bool) -> tuple[str, float, float, float]:
    total = round2(amount)
    if total <= 0:
        raise HTTPException(status_code=400, detail="amount must be greater than 0")

    if is_writeoff:
        return "writeoff", total, 0.0, 0.0

    normalized = str(mode or "cash").strip().lower()
    if normalized not in {"cash", "online", "split"}:
        raise HTTPException(status_code=400, detail="mode must be cash, online, or split")

    cash = round2(cash_amount)
    online = round2(online_amount)
    if cash < 0 or online < 0:
        raise HTTPException(status_code=400, detail="cash_amount and online_amount cannot be negative")

    if cash <= 0 and online <= 0:
        if normalized == "online":
            online = total
        else:
            cash = total

    if normalized == "cash" and online != 0:
        raise HTTPException(status_code=400, detail="online_amount must be 0 for cash mode")
    if normalized == "online" and cash != 0:
        raise HTTPException(status_code=400, detail="cash_amount must be 0 for online mode")
    if normalized == "split" and cash + online <= 0:
        raise HTTPException(status_code=400, detail="split mode requires cash or online amount")
    if abs(round2(cash + online) - total) > 0.01:
        raise HTTPException(status_code=400, detail="cash_amount + online_amount must equal amount")

    return normalized, total, cash, online


def normalize_purchase_bank_details(
    *,
    is_writeoff: bool,
    online_amount: float,
    bank_mode: Optional[str],
    transaction_id: Optional[str],
    txn_charges: Optional[float],
) -> tuple[Optional[str], Optional[str], float]:
    charges = round2(txn_charges or 0)
    if charges < 0:
        raise HTTPException(status_code=400, detail="txn_charges cannot be negative")
    if is_writeoff or round2(online_amount) <= 0:
        if charges > 0:
            raise HTTPException(status_code=400, detail="txn_charges require an online/bank amount")
        return None, None, 0.0

    normalized_bank_mode = str(bank_mode or "UPI").strip().upper()
    if normalized_bank_mode not in VALID_BANK_MODES:
        raise HTTPException(status_code=400, detail="bank_mode must be UPI, NEFT, RTGS or IMPS")
    normalized_transaction_id = clean_text(transaction_id) if normalized_bank_mode == "UPI" else None
    return normalized_bank_mode, normalized_transaction_id, charges


def ensure_supplier(session, party_id: int) -> Party:
    row = session.get(Party, party_id)
    if not row or not row.is_active:
        raise HTTPException(status_code=400, detail="Supplier not found")
    if row.party_group != "SUNDRY_CREDITOR":
        raise HTTPException(status_code=400, detail="party_id must belong to a supplier")
    return row


def ensure_free_stock_supplier(session) -> Party:
    row = session.exec(
        select(Party).where(
            Party.party_group == "SUNDRY_CREDITOR",
            func.lower(Party.name) == FREE_STOCK_NO_SUPPLIER_NAME.lower(),
        )
    ).first()
    ts = now_ts()
    if row:
        if not row.is_active:
            row.is_active = True
            row.updated_at = ts
            session.add(row)
            session.commit()
            session.refresh(row)
        return row

    row = Party(
        name=FREE_STOCK_NO_SUPPLIER_NAME,
        party_group="SUNDRY_CREDITOR",
        notes="System supplier used only when free stock is added without an actual supplier.",
        opening_balance=0.0,
        opening_balance_type="CR",
        is_active=True,
        created_at=ts,
        updated_at=ts,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def ensure_category(session, category_id: Optional[int]) -> Optional[int]:
    if category_id is None:
        return None
    if not session.get(Category, category_id):
        raise HTTPException(status_code=400, detail="Category not found")
    return category_id


def ensure_brand_row(session, brand_name: Optional[str]) -> None:
    name = clean_text(brand_name)
    if not name:
        return
    existing = session.exec(select(Brand).where(func.lower(Brand.name) == name.lower())).first()
    if existing:
        if not existing.is_active:
            existing.is_active = True
            existing.updated_at = now_ts()
            session.add(existing)
        return
    ts = now_ts()
    session.add(Brand(name=name, is_active=True, created_at=ts, updated_at=ts))
    session.flush()


def ensure_product(
    session,
    *,
    product_id: Optional[int],
    product_name: str,
    alias: Optional[str],
    brand: Optional[str],
    category_id: Optional[int],
    rack_number: Optional[int],
    loose_sale_enabled: bool,
    parent_unit_name: Optional[str],
    child_unit_name: Optional[str],
    conversion_qty: Optional[int],
    printed_price: Optional[float],
) -> Product:
    if product_id is not None:
        row = session.get(Product, product_id)
        if not row:
            raise HTTPException(status_code=400, detail=f"Product #{product_id} not found")
        return row

    name = clean_text(product_name)
    if not name:
        raise HTTPException(status_code=400, detail="product_name is required")
    normalized_brand = clean_text(brand)
    ensure_brand_row(session, normalized_brand)
    name_key = product_name_key(name)
    existing_products = session.exec(
        select(Product)
        .where(func.lower(func.coalesce(Product.brand, "")) == (normalized_brand or "").lower())
        .order_by(Product.id.asc())
    ).all()
    for existing in existing_products:
        if product_name_key(existing.name) == name_key:
            return existing

    ts = now_ts()
    row = Product(
        name=name,
        alias=clean_text(alias),
        brand=normalized_brand,
        category_id=ensure_category(session, category_id),
        default_rack_number=int(rack_number or 0),
        printed_price=round2(printed_price),
        parent_unit_name=clean_text(parent_unit_name),
        child_unit_name=clean_text(child_unit_name),
        loose_sale_enabled=bool(loose_sale_enabled),
        default_conversion_qty=conversion_qty,
        is_active=True,
        created_at=ts,
        updated_at=ts,
    )
    session.add(row)
    session.flush()
    return row


def purchase_item_stock_source(item: PurchaseItem) -> str:
    return str(getattr(item, "stock_source", STOCK_SOURCE_CREATED) or STOCK_SOURCE_CREATED).upper()


def ensure_inventory_batch_not_already_purchased(
    session,
    inventory_item_id: int,
    *,
    ignore_purchase_id: Optional[int] = None,
) -> None:
    stmt = (
        select(PurchaseItem, Purchase)
        .join(Purchase, Purchase.id == PurchaseItem.purchase_id)
        .where(
            PurchaseItem.inventory_item_id == int(inventory_item_id),
            Purchase.is_deleted == False,  # noqa: E712
        )
    )
    if ignore_purchase_id is not None:
        stmt = stmt.where(PurchaseItem.purchase_id != int(ignore_purchase_id))
    existing = session.exec(stmt).first()
    if existing:
        _purchase_item, purchase = existing
        raise HTTPException(
            status_code=400,
            detail=(
                f"Inventory batch #{inventory_item_id} is already linked to "
                f"purchase {purchase.invoice_number or purchase.id}"
            ),
        )


def ensure_product_for_existing_inventory(
    session,
    *,
    inventory_item: Item,
    raw: PurchaseItemIn,
) -> Product:
    product_id = raw.product_id or inventory_item.product_id
    if product_id is not None:
        product = session.get(Product, product_id)
        if not product:
            raise HTTPException(status_code=400, detail=f"Product #{product_id} not found")
    else:
        product = ensure_product(
            session,
            product_id=None,
            product_name=clean_text(raw.product_name) or inventory_item.name,
            alias=raw.alias,
            brand=clean_text(raw.brand) if raw.brand is not None else inventory_item.brand,
            category_id=raw.category_id if raw.category_id is not None else inventory_item.category_id,
            rack_number=raw.rack_number if raw.rack_number is not None else inventory_item.rack_number,
            loose_sale_enabled=raw.loose_sale_enabled,
            parent_unit_name=raw.parent_unit_name,
            child_unit_name=raw.child_unit_name,
            conversion_qty=raw.conversion_qty,
            printed_price=raw.mrp if raw.mrp is not None else inventory_item.mrp,
        )

    changed = False
    if inventory_item.product_id != product.id:
        inventory_item.product_id = product.id
        changed = True
    if inventory_item.category_id is None and product.category_id is not None:
        inventory_item.category_id = product.category_id
        changed = True
    if changed:
        inventory_item.updated_at = now_ts()
        session.add(inventory_item)
    return product


def get_or_create_lot_for_inventory_item(
    session,
    *,
    inventory_item: Item,
    product: Product,
    effective_cost_price: float,
    conversion_qty: Optional[int],
    ts: str,
) -> InventoryLot:
    lot = session.exec(
        select(InventoryLot)
        .where(InventoryLot.legacy_item_id == inventory_item.id)
        .order_by(InventoryLot.id.asc())
    ).first()
    if lot:
        lot.product_id = product.id
        lot.cost_price = effective_cost_price
        lot.updated_at = ts
        session.add(lot)
        session.flush()
        return lot

    lot = InventoryLot(
        product_id=product.id,
        expiry_date=inventory_item.expiry_date,
        mrp=float(inventory_item.mrp or 0),
        cost_price=effective_cost_price,
        rack_number=int(inventory_item.rack_number or 0),
        sealed_qty=max(0, int(inventory_item.stock or 0)),
        loose_qty=0,
        conversion_qty=conversion_qty if conversion_qty and conversion_qty > 0 else product.default_conversion_qty,
        opened_from_lot_id=None,
        legacy_item_id=inventory_item.id,
        is_active=not bool(getattr(inventory_item, "is_archived", False)),
        created_at=ts,
        updated_at=ts,
    )
    session.add(lot)
    session.flush()
    return lot


def add_stock_movement(
    session,
    *,
    item_id: int,
    delta: int,
    reason: str,
    ref_type: Optional[str],
    ref_id: Optional[int],
    note: Optional[str],
    ts: Optional[str] = None,
) -> None:
    session.add(
        StockMovement(
            item_id=int(item_id),
            ts=ts or now_ts(),
            delta=int(delta),
            reason=str(reason),
            ref_type=ref_type,
            ref_id=ref_id,
            note=note,
            actor="SYSTEM",
        )
    )


def date_key(value: Optional[str]) -> str:
    return str(value or "")[:10]


def find_opening_item_create_placeholder(
    session,
    *,
    inventory_item_id: int,
    total_qty: int,
    invoice_date: str,
) -> Optional[StockMovement]:
    opening_rows = session.exec(
        select(StockMovement)
        .where(StockMovement.item_id == int(inventory_item_id))
        .where(StockMovement.reason == "OPENING")
        .where(StockMovement.ref_type == "ITEM_CREATE")
        .order_by(StockMovement.ts.asc(), StockMovement.id.asc())
    ).all()
    positive_openings = [row for row in opening_rows if int(row.delta or 0) > 0]
    if len(positive_openings) != 1:
        return None
    opening = positive_openings[0]
    if int(opening.delta or 0) != int(total_qty or 0):
        return None
    opening_date = date_key(opening.ts)
    purchase_date = date_key(invoice_date)
    if not opening_date or not purchase_date or opening_date < purchase_date:
        return None

    pre_invoice_count = session.exec(
        select(func.count(StockMovement.id))
        .where(StockMovement.item_id == int(inventory_item_id))
        .where(func.date(StockMovement.ts) < func.date(purchase_date))
    ).first()
    if int(pre_invoice_count or 0) != 0:
        return None

    existing_purchase_count = session.exec(
        select(func.count(StockMovement.id))
        .where(StockMovement.item_id == int(inventory_item_id))
        .where(StockMovement.reason == "PURCHASE")
        .where(StockMovement.ref_type == "PURCHASE")
    ).first()
    if int(existing_purchase_count or 0) != 0:
        return None
    return opening


def convert_opening_placeholder_to_purchase(
    session,
    *,
    inventory_item: Item,
    opening_movement: StockMovement,
    product: Product,
    total_qty: int,
    effective_cost_price: float,
    mrp: float,
    rack_number: int,
    expiry_date: Optional[str],
    purchase_id: int,
    invoice_number: str,
    purchase_stock_ts: str,
    ts: str,
) -> InventoryLot:
    inventory_item.product_id = product.id
    inventory_item.category_id = product.category_id
    inventory_item.expiry_date = expiry_date or inventory_item.expiry_date
    inventory_item.mrp = round2(mrp)
    inventory_item.cost_price = round2(effective_cost_price)
    inventory_item.rack_number = int(rack_number or 0)
    inventory_item.updated_at = ts
    session.add(inventory_item)

    inventory_lot = get_or_create_lot_for_inventory_item(
        session,
        inventory_item=inventory_item,
        product=product,
        effective_cost_price=round2(effective_cost_price),
        conversion_qty=product.default_conversion_qty,
        ts=ts,
    )
    inventory_lot.expiry_date = inventory_item.expiry_date
    inventory_lot.mrp = round2(mrp)
    inventory_lot.rack_number = int(rack_number or 0)
    inventory_lot.sealed_qty = max(0, int(inventory_item.stock or 0))
    inventory_lot.loose_qty = 0
    inventory_lot.is_active = not bool(getattr(inventory_item, "is_archived", False))
    inventory_lot.updated_at = ts
    session.add(inventory_lot)

    opening_movement.ts = purchase_stock_ts
    opening_movement.reason = "PURCHASE"
    opening_movement.ref_type = "PURCHASE"
    opening_movement.ref_id = int(purchase_id)
    opening_movement.note = f"Purchase {invoice_number}"
    opening_movement.actor = "SYSTEM"
    session.add(opening_movement)
    return inventory_lot


def make_purchase_out(session, row: Purchase) -> PurchaseOut:
    items = session.exec(select(PurchaseItem).where(PurchaseItem.purchase_id == row.id).order_by(PurchaseItem.id.asc())).all()
    payments = session.exec(
        select(PurchasePayment).where(PurchasePayment.purchase_id == row.id).order_by(PurchasePayment.id.asc())
    ).all()
    return_total = round2(session.exec(
        select(func.coalesce(func.sum(PurchaseReturn.total_amount), 0)).where(
            PurchaseReturn.purchase_id == row.id,
            PurchaseReturn.is_deleted == False,  # noqa: E712
        )
    ).one() or 0)
    return PurchaseOut(
        id=row.id,
        party_id=row.party_id,
        invoice_number=row.invoice_number,
        invoice_date=row.invoice_date,
        notes=row.notes,
        subtotal_amount=row.subtotal_amount,
        discount_amount=row.discount_amount,
        gst_amount=row.gst_amount,
        rounding_adjustment=row.rounding_adjustment,
        total_amount=row.total_amount,
        paid_amount=row.paid_amount,
        writeoff_amount=row.writeoff_amount,
        payment_status=row.payment_status,
        is_deleted=row.is_deleted,
        deleted_at=row.deleted_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
        items=[PurchaseItemOut(**item.dict()) for item in items],
        payments=[PurchasePaymentOut(**payment.dict()) for payment in payments],
        return_total=return_total,
        net_amount=round2(float(row.total_amount or 0) - return_total),
    )


def assert_purchase_has_no_active_returns(session, purchase_id: int, *, context: str) -> None:
    active = session.exec(
        select(PurchaseReturn.id).where(
            PurchaseReturn.purchase_id == purchase_id,
            PurchaseReturn.is_deleted == False,  # noqa: E712
        ).limit(1)
    ).first()
    if active is not None:
        raise HTTPException(status_code=400, detail=f"{context} is not allowed after a purchase return. Cancel the return first")


def make_purchase_payment_out(payment: PurchasePayment, party_id: Optional[int] = None) -> PurchasePaymentOut:
    data = payment.dict()
    data["party_id"] = party_id if party_id is not None else data.get("party_id")
    return PurchasePaymentOut(**data)


def purchase_item_total_qty(item: PurchaseItem) -> int:
    return int(item.sealed_qty or 0) + int(item.free_qty or 0)


def validate_purchase_line_quantities(raw: PurchaseItemIn) -> tuple[int, int, int]:
    qty = int(raw.sealed_qty or 0)
    free_qty = int(raw.free_qty or 0)
    if qty < 0:
        raise HTTPException(status_code=400, detail="sealed_qty cannot be negative")
    if free_qty < 0:
        raise HTTPException(status_code=400, detail="free_qty cannot be negative")
    total_qty = qty + free_qty
    if total_qty <= 0:
        raise HTTPException(status_code=400, detail="Enter paid qty or free qty greater than 0")
    return qty, free_qty, total_qty


def get_purchase_items(session, purchase_id: int) -> List[PurchaseItem]:
    return session.exec(
        select(PurchaseItem).where(PurchaseItem.purchase_id == purchase_id).order_by(PurchaseItem.id.asc())
    ).all()


def assert_purchase_item_untouched(session, purchase_item: PurchaseItem) -> Item:
    if not purchase_item.inventory_item_id:
        raise HTTPException(status_code=400, detail=f"Purchase item #{purchase_item.id} is missing stock linkage")
    inventory_item = session.get(Item, purchase_item.inventory_item_id)
    if not inventory_item:
        raise HTTPException(status_code=400, detail=f"Inventory item #{purchase_item.inventory_item_id} not found")
    total_qty = purchase_item_total_qty(purchase_item)
    if int(inventory_item.stock or 0) != total_qty:
        raise HTTPException(
            status_code=400,
            detail=f"Purchase item #{purchase_item.id} cannot be edited because stock has already changed",
        )
    return inventory_item


def _purchase_item_edit_id(raw: PurchaseItemIn) -> Optional[int]:
    value = getattr(raw, "purchase_item_id", None)
    return int(value) if value is not None else None


def can_update_purchase_items_in_place(existing_items: List[PurchaseItem], raw_items: List[PurchaseItemIn]) -> bool:
    raw_ids = [_purchase_item_edit_id(raw) for raw in raw_items]
    if any(raw_id is None for raw_id in raw_ids):
        return False
    existing_ids = {int(item.id or 0) for item in existing_items}
    return len(raw_ids) == len(existing_ids) and set(int(raw_id or 0) for raw_id in raw_ids) == existing_ids


def _purchase_line_identity_changed(raw: PurchaseItemIn, item: PurchaseItem) -> bool:
    raw_product_id = int(raw.product_id or 0)
    if raw_product_id and raw_product_id != int(item.product_id or 0):
        return True
    if (clean_text(raw.product_name) or "") != (clean_text(item.product_name) or ""):
        return True
    if (clean_text(raw.brand) or "") != (clean_text(item.brand) or ""):
        return True
    return False


def purchase_item_matches_raw(raw: PurchaseItemIn, item: PurchaseItem) -> bool:
    raw_product_id = int(raw.product_id or 0)
    if raw_product_id and raw_product_id != int(item.product_id or 0):
        return False
    try:
        raw_expiry = require_expiry_date(raw.expiry_date, context=raw.product_name or "Purchase item")
    except HTTPException:
        return False
    return (
        (clean_text(raw.product_name) or "") == (clean_text(item.product_name) or "")
        and (clean_text(raw.brand) or "") == (clean_text(item.brand) or "")
        and raw_expiry == (clean_date(item.expiry_date) or "")
        and int(raw.rack_number if raw.rack_number is not None else item.rack_number or 0) == int(item.rack_number or 0)
        and int(raw.sealed_qty or 0) == int(item.sealed_qty or 0)
        and int(raw.free_qty or 0) == int(item.free_qty or 0)
        and round2(raw.cost_price) == round2(item.cost_price)
        and round2(raw.mrp) == round2(item.mrp)
        and round2(raw.gst_percent) == round2(item.gst_percent)
        and round2(raw.discount_amount) == round2(item.discount_amount)
        and round2(raw.rounding_adjustment) == round2(item.rounding_adjustment)
    )


def update_purchase_items_in_place(session, purchase: Purchase, raw_items: List[PurchaseItemIn]) -> PurchaseOut:
    """Safely adjust existing purchase lines without recreating sold batches."""
    before_snapshot = purchase_snapshot(session, purchase)
    existing_items = get_purchase_items(session, int(purchase.id))
    existing_by_id = {int(item.id or 0): item for item in existing_items}
    subtotal_amount = 0.0
    purchase_stock_ts = f"{purchase.invoice_date}T00:00:00"
    ts = now_ts()
    changed_lines: List[Dict[str, Any]] = []

    for raw in raw_items:
        purchase_item_id = _purchase_item_edit_id(raw)
        if purchase_item_id is None or purchase_item_id not in existing_by_id:
            raise HTTPException(status_code=400, detail="Purchase item identity is missing for in-place edit")
        item = existing_by_id[purchase_item_id]
        stock_source = purchase_item_stock_source(item)
        if not item.inventory_item_id:
            raise HTTPException(status_code=400, detail=f"Purchase item #{item.id} is missing stock linkage")
        inventory_item = session.get(Item, int(item.inventory_item_id))
        if not inventory_item:
            raise HTTPException(status_code=400, detail=f"Inventory item #{item.inventory_item_id} not found")
        if not item.lot_id:
            raise HTTPException(status_code=400, detail=f"Purchase item #{item.id} is missing lot linkage")
        lot = session.get(InventoryLot, int(item.lot_id))
        if not lot:
            raise HTTPException(status_code=400, detail=f"Inventory lot #{item.lot_id} not found")
        if lot.legacy_item_id is not None and int(lot.legacy_item_id) != int(inventory_item.id):
            raise HTTPException(
                status_code=400,
                detail=f"Purchase item #{item.id} lot does not match linked inventory batch",
            )

        qty, free_qty, new_qty = validate_purchase_line_quantities(raw)
        if round2(raw.cost_price) < 0:
            raise HTTPException(status_code=400, detail="rate cannot be negative")
        if round2(raw.mrp) < 0:
            raise HTTPException(status_code=400, detail="mrp cannot be negative")
        if round2(raw.gst_percent) < 0 or round2(raw.gst_percent) > 100:
            raise HTTPException(status_code=400, detail="GST percent must be between 0 and 100")

        old_qty = purchase_item_total_qty(item)
        delta = int(new_qty - old_qty)
        identity_changed = _purchase_line_identity_changed(raw, item)
        old_expiry = clean_date(item.expiry_date)
        new_expiry = require_expiry_date(raw.expiry_date, context=raw.product_name or "Purchase item")
        rack_number = int(raw.rack_number if raw.rack_number is not None else item.rack_number or 0)

        if identity_changed:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Purchase item #{item.id} cannot change product/batch identity here. "
                    "Only expiry, rack, qty, free, rate, MRP, discount, and rounding can be edited in place."
                ),
            )

        stock_delta = delta if stock_source == STOCK_SOURCE_CREATED else 0
        next_stock = int(inventory_item.stock or 0) + stock_delta
        if stock_source == STOCK_SOURCE_CREATED and next_stock < 0:
            raise HTTPException(
                status_code=400,
                detail=f"Purchase item #{item.id} cannot reduce stock below 0",
            )

        line_rounding = round2(raw.rounding_adjustment)
        line_total = round2((qty * float(raw.cost_price or 0)) - float(raw.discount_amount or 0) + line_rounding)
        effective_cost = round2(line_total / new_qty) if new_qty > 0 else round2(raw.cost_price)
        subtotal_amount = round2(subtotal_amount + line_total)

        inventory_item.expiry_date = new_expiry
        inventory_item.rack_number = rack_number
        inventory_item.cost_price = effective_cost
        inventory_item.mrp = round2(raw.mrp)
        inventory_item.updated_at = ts
        session.add(inventory_item)

        lot.expiry_date = new_expiry
        lot.rack_number = rack_number
        lot.cost_price = effective_cost
        lot.mrp = round2(raw.mrp)
        lot.updated_at = ts
        session.add(lot)

        if stock_delta:
            inventory_item.stock = next_stock
            inventory_item.is_archived = bool(next_stock <= 0)
            inventory_item.updated_at = ts
            session.add(inventory_item)
            next_lot_qty = int(lot.sealed_qty or 0) + stock_delta
            if next_lot_qty < 0:
                raise HTTPException(
                    status_code=400,
                    detail=f"Purchase item #{item.id} cannot reduce lot stock below 0",
                )
            lot.sealed_qty = next_lot_qty
            lot.loose_qty = int(lot.loose_qty or 0)
            lot.is_active = bool(next_lot_qty > 0 or int(lot.loose_qty or 0) > 0)
            lot.updated_at = ts
            session.add(lot)
            add_stock_movement(
                session,
                item_id=int(inventory_item.id),
                delta=stock_delta,
                reason="PURCHASE_EDIT",
                ref_type="PURCHASE",
                ref_id=int(purchase.id),
                note=f"Edited purchase {purchase.invoice_number}: qty {old_qty} -> {new_qty}",
                ts=purchase_stock_ts,
            )
            changed_lines.append({"purchase_item_id": int(item.id), "old_qty": old_qty, "new_qty": new_qty, "delta": stock_delta})
        elif delta:
            changed_lines.append({"purchase_item_id": int(item.id), "old_qty": old_qty, "new_qty": new_qty, "delta": 0})

        item.sealed_qty = qty
        item.free_qty = free_qty
        item.expiry_date = new_expiry
        item.rack_number = rack_number
        item.cost_price = round2(raw.cost_price)
        item.effective_cost_price = effective_cost
        item.mrp = round2(raw.mrp)
        item.gst_percent = round2(raw.gst_percent)
        item.discount_amount = round2(raw.discount_amount)
        item.rounding_adjustment = line_rounding
        item.line_total = line_total
        session.add(item)
        if old_expiry != new_expiry:
            changed_lines.append({"purchase_item_id": int(item.id), "old_expiry": old_expiry, "new_expiry": new_expiry})

    purchase.subtotal_amount = subtotal_amount
    purchase.gst_amount = purchase_gst_amount(subtotal_amount, purchase.discount_amount, list(existing_by_id.values()))
    purchase.total_amount = round2(
        float(subtotal_amount or 0)
        - float(purchase.discount_amount or 0)
        + float(purchase.gst_amount or 0)
        + float(purchase.rounding_adjustment or 0)
    )
    if float(purchase.paid_amount or 0) + float(purchase.writeoff_amount or 0) > float(purchase.total_amount or 0) + 0.0001:
        raise HTTPException(status_code=400, detail="Edited items reduce total below settled amount")

    purchase.updated_at = ts
    session.add(purchase)
    session.flush()
    log_audit(
        session,
        entity_type="PURCHASE",
        entity_id=int(purchase.id),
        action="UPDATE_ITEMS",
        note=f"Updated purchase item quantities on purchase #{purchase.id}",
        details={
            "before": before_snapshot,
            "after": purchase_snapshot(session, purchase),
            "changed_lines": changed_lines,
        },
    )
    session.commit()
    recompute_purchase_payment_state(session, purchase)
    supplier = ensure_supplier(session, purchase.party_id)
    sync_purchase_vouchers(session, purchase, supplier)
    session.commit()
    session.refresh(purchase)
    return make_purchase_out(session, purchase)


def create_inventory_lot(
    session,
    *,
    product: Product,
    inventory_item: Item,
    expiry_date: Optional[str],
    rack_number: int,
    total_qty: int,
    effective_cost_price: float,
    mrp: float,
    conversion_qty: Optional[int],
    ts: str,
) -> InventoryLot:
    lot = InventoryLot(
        product_id=product.id,
        expiry_date=expiry_date,
        mrp=mrp,
        cost_price=effective_cost_price,
        rack_number=rack_number,
        sealed_qty=total_qty,
        loose_qty=0,
        conversion_qty=conversion_qty if conversion_qty and conversion_qty > 0 else product.default_conversion_qty,
        opened_from_lot_id=None,
        legacy_item_id=inventory_item.id,
        is_active=True,
        created_at=ts,
        updated_at=ts,
    )
    session.add(lot)
    session.flush()
    return lot


def recompute_purchase_payment_state(session, purchase: Purchase) -> None:
    payments = session.exec(
        select(PurchasePayment).where(
            PurchasePayment.purchase_id == purchase.id,
            PurchasePayment.is_deleted == False,  # noqa: E712
        )
    ).all()
    paid_amount = round2(sum(float(p.amount or 0) for p in payments if not bool(p.is_writeoff)))
    writeoff_amount = round2(sum(float(p.amount or 0) for p in payments if bool(p.is_writeoff)))
    purchase.paid_amount = paid_amount
    purchase.writeoff_amount = writeoff_amount

    covered = round2(paid_amount + writeoff_amount)
    total_amount = purchase_net_amount(session, purchase)
    if total_amount <= 0:
        purchase.payment_status = "PAID"
    elif covered <= 0:
        purchase.payment_status = "UNPAID"
    elif covered + 0.0001 < total_amount:
        purchase.payment_status = "PARTIAL"
    else:
        purchase.payment_status = "PAID"
    purchase.updated_at = now_ts()
    session.add(purchase)
    session.commit()


def purchase_payment_source_type(payment: PurchasePayment) -> str:
    return "PURCHASE_WRITEOFF" if bool(payment.is_writeoff) else "PURCHASE_PAYMENT"


def purchase_net_amount(session, purchase: Purchase) -> float:
    return_total = session.exec(
        select(func.coalesce(func.sum(PurchaseReturn.total_amount), 0)).where(
            PurchaseReturn.purchase_id == purchase.id,
            PurchaseReturn.is_deleted == False,  # noqa: E712
        )
    ).one() or 0
    return round2(max(0.0, float(purchase.total_amount or 0) - float(return_total or 0)))


@router.post("/", response_model=PurchaseOut, status_code=201)
def create_purchase(payload: PurchaseCreate) -> PurchaseOut:
    invoice_number = clean_text(payload.invoice_number)
    if not invoice_number:
        raise HTTPException(status_code=400, detail="invoice_number is required")
    invoice_date = clean_date(payload.invoice_date)
    if not invoice_date:
        raise HTTPException(status_code=400, detail="invoice_date is required")
    if not payload.items:
        raise HTTPException(status_code=400, detail="At least one item is required")

    with get_session() as session:
        assert_financial_year_unlocked(session, invoice_date, context="Purchase creation")
        supplier = ensure_supplier(session, payload.party_id)

        duplicate = session.exec(
            select(Purchase).where(
                Purchase.party_id == supplier.id,
                func.lower(Purchase.invoice_number) == invoice_number.lower(),
                Purchase.is_deleted == False,  # noqa: E712
            )
        ).first()
        if duplicate:
            raise HTTPException(status_code=400, detail="This invoice number already exists for the supplier")

        subtotal_amount = 0.0
        prepared_items: List[Dict[str, Any]] = []
        for raw in payload.items:
            expiry_date = require_expiry_date(raw.expiry_date, context=raw.product_name or "Purchase item")
            qty, free_qty, total_qty = validate_purchase_line_quantities(raw)
            if round2(raw.cost_price) < 0:
                raise HTTPException(status_code=400, detail="rate cannot be negative")
            if round2(raw.mrp) < 0:
                raise HTTPException(status_code=400, detail="mrp cannot be negative")
            if round2(raw.gst_percent) < 0 or round2(raw.gst_percent) > 100:
                raise HTTPException(status_code=400, detail="GST percent must be between 0 and 100")

            existing_inventory_item = None
            stock_source = STOCK_SOURCE_CREATED
            if raw.existing_inventory_item_id is not None:
                existing_inventory_item = session.get(Item, int(raw.existing_inventory_item_id))
                if not existing_inventory_item:
                    raise HTTPException(status_code=400, detail=f"Inventory batch #{raw.existing_inventory_item_id} not found")
                ensure_inventory_batch_not_already_purchased(session, int(existing_inventory_item.id))
                product = ensure_product_for_existing_inventory(
                    session,
                    inventory_item=existing_inventory_item,
                    raw=raw,
                )
                stock_source = STOCK_SOURCE_ATTACHED
            else:
                product = ensure_product(
                    session,
                    product_id=raw.product_id,
                    product_name=raw.product_name,
                    alias=raw.alias,
                    brand=raw.brand,
                    category_id=raw.category_id,
                    rack_number=raw.rack_number,
                    loose_sale_enabled=raw.loose_sale_enabled,
                    parent_unit_name=raw.parent_unit_name,
                    child_unit_name=raw.child_unit_name,
                    conversion_qty=raw.conversion_qty,
                    printed_price=raw.mrp,
                )

            rack_number = int(raw.rack_number if raw.rack_number is not None else product.default_rack_number or 0)
            line_rounding = round2(raw.rounding_adjustment)
            line_total = round2((qty * float(raw.cost_price or 0)) - float(raw.discount_amount or 0) + line_rounding)
            effective_cost = round2(line_total / total_qty) if total_qty > 0 else round2(raw.cost_price)
            opening_placeholder_movement = None
            convert_opening_to_purchase = False
            if existing_inventory_item is not None:
                opening_placeholder_movement = find_opening_item_create_placeholder(
                    session,
                    inventory_item_id=int(existing_inventory_item.id),
                    total_qty=total_qty,
                    invoice_date=invoice_date,
                )
                if opening_placeholder_movement is not None:
                    stock_source = STOCK_SOURCE_CREATED
                    convert_opening_to_purchase = True
            subtotal_amount = round2(subtotal_amount + line_total)
            prepared_items.append(
                {
                    "product": product,
                    "existing_inventory_item": existing_inventory_item,
                    "opening_placeholder_movement": opening_placeholder_movement,
                    "convert_opening_to_purchase": convert_opening_to_purchase,
                    "stock_source": stock_source,
                    "expiry_date": expiry_date,
                    "rack_number": rack_number,
                    "sealed_qty": qty,
                    "free_qty": free_qty,
                    "cost_price": round2(raw.cost_price),
                    "effective_cost_price": effective_cost,
                    "mrp": round2(raw.mrp),
                    "gst_percent": round2(raw.gst_percent),
                    "discount_amount": round2(raw.discount_amount),
                    "rounding_adjustment": line_rounding,
                    "line_total": line_total,
                }
            )

        discount_amount = round2(payload.discount_amount)
        gst_amount = raw_purchase_gst_amount(subtotal_amount, discount_amount, prepared_items)
        rounding_adjustment = round2(payload.rounding_adjustment)
        total_amount = round2(subtotal_amount - discount_amount + gst_amount + rounding_adjustment)
        if total_amount < 0:
            raise HTTPException(status_code=400, detail="Purchase total cannot be negative")

        paid_amount = 0.0
        writeoff_amount = 0.0
        prepared_payments = []
        for payment in payload.payments:
            payment_ts = f"{invoice_date}T00:00:00"
            if payment.paid_at:
                payment_date = clean_date(payment.paid_at)
                if not payment_date:
                    raise HTTPException(status_code=400, detail="paid_at is required")
                payment_ts = f"{payment_date}T00:00:00"
            assert_financial_year_unlocked(session, payment_ts, context="Purchase payment")
            mode, amount, cash_amount, online_amount = normalize_payment_mode(
                payment.mode,
                payment.amount,
                payment.cash_amount,
                payment.online_amount,
                bool(payment.is_writeoff),
            )
            bank_mode, transaction_id, txn_charges = normalize_purchase_bank_details(
                is_writeoff=bool(payment.is_writeoff),
                online_amount=online_amount,
                bank_mode=payment.bank_mode,
                transaction_id=payment.transaction_id,
                txn_charges=payment.txn_charges,
            )
            prepared_payments.append(
                {
                    "mode": mode,
                    "bank_mode": bank_mode,
                    "transaction_id": transaction_id,
                    "amount": amount,
                    "cash_amount": cash_amount,
                    "online_amount": online_amount,
                    "txn_charges": txn_charges,
                    "note": clean_text(payment.note),
                    "paid_at": payment_ts,
                    "is_writeoff": bool(payment.is_writeoff),
                }
            )
            if bool(payment.is_writeoff):
                writeoff_amount = round2(writeoff_amount + amount)
            else:
                paid_amount = round2(paid_amount + amount)

        if paid_amount + writeoff_amount > total_amount + 0.0001:
            raise HTTPException(status_code=400, detail="Payments and write-offs exceed purchase total")

        if total_amount <= 0:
            payment_status = "PAID"
        elif paid_amount + writeoff_amount <= 0:
            payment_status = "UNPAID"
        elif paid_amount + writeoff_amount + 0.0001 < total_amount:
            payment_status = "PARTIAL"
        else:
            payment_status = "PAID"

        ts = now_ts()
        purchase_stock_ts = f"{invoice_date}T00:00:00"
        purchase = Purchase(
            party_id=supplier.id,
            invoice_number=invoice_number,
            invoice_date=invoice_date,
            notes=clean_text(payload.notes),
            subtotal_amount=subtotal_amount,
            discount_amount=discount_amount,
            gst_amount=gst_amount,
            rounding_adjustment=rounding_adjustment,
            total_amount=total_amount,
            paid_amount=paid_amount,
            writeoff_amount=writeoff_amount,
            payment_status=payment_status,
            is_deleted=False,
            deleted_at=None,
            created_at=ts,
            updated_at=ts,
        )
        session.add(purchase)
        session.flush()

        for entry in prepared_items:
            product: Product = entry["product"]
            total_qty = int(entry["sealed_qty"]) + int(entry["free_qty"])
            stock_source = str(entry["stock_source"])
            if entry.get("convert_opening_to_purchase"):
                inventory_item = entry["existing_inventory_item"]
                opening_movement = entry["opening_placeholder_movement"]
                if not inventory_item or not opening_movement:
                    raise HTTPException(status_code=400, detail="Opening stock could not be converted to purchase stock")
                inventory_lot = convert_opening_placeholder_to_purchase(
                    session,
                    inventory_item=inventory_item,
                    opening_movement=opening_movement,
                    product=product,
                    total_qty=total_qty,
                    effective_cost_price=entry["effective_cost_price"],
                    mrp=entry["mrp"],
                    rack_number=entry["rack_number"],
                    expiry_date=entry["expiry_date"],
                    purchase_id=int(purchase.id),
                    invoice_number=invoice_number,
                    purchase_stock_ts=purchase_stock_ts,
                    ts=ts,
                )
            elif stock_source == STOCK_SOURCE_ATTACHED:
                inventory_item = entry["existing_inventory_item"]
                inventory_item.cost_price = entry["effective_cost_price"]
                inventory_item.updated_at = ts
                session.add(inventory_item)
                session.flush()
                inventory_lot = get_or_create_lot_for_inventory_item(
                    session,
                    inventory_item=inventory_item,
                    product=product,
                    effective_cost_price=entry["effective_cost_price"],
                    conversion_qty=product.default_conversion_qty,
                    ts=ts,
                )
                add_stock_movement(
                    session,
                    item_id=int(inventory_item.id),
                    delta=0,
                    reason="PURCHASE_LINK",
                    ref_type="PURCHASE",
                    ref_id=int(purchase.id),
                    note=f"Linked existing inventory to purchase {invoice_number}",
                    ts=purchase_stock_ts,
                )
            else:
                inventory_item = Item(
                    name=product.name,
                    brand=product.brand,
                    product_id=product.id,
                    category_id=product.category_id,
                    expiry_date=entry["expiry_date"],
                    mrp=entry["mrp"],
                    cost_price=entry["effective_cost_price"],
                    stock=total_qty,
                    rack_number=entry["rack_number"],
                    is_archived=False,
                    created_at=ts,
                    updated_at=ts,
                )
                session.add(inventory_item)
                session.flush()
                add_stock_movement(
                    session,
                    item_id=int(inventory_item.id),
                    delta=total_qty,
                    reason="PURCHASE",
                    ref_type="PURCHASE",
                    ref_id=int(purchase.id),
                    note=f"Purchase {invoice_number}",
                    ts=purchase_stock_ts,
                )
                inventory_lot = create_inventory_lot(
                    session,
                    product=product,
                    inventory_item=inventory_item,
                    expiry_date=entry["expiry_date"],
                    rack_number=entry["rack_number"],
                    total_qty=total_qty,
                    effective_cost_price=entry["effective_cost_price"],
                    mrp=entry["mrp"],
                    conversion_qty=product.default_conversion_qty,
                    ts=ts,
                )

            purchase_item = PurchaseItem(
                purchase_id=purchase.id,
                product_id=product.id,
                inventory_item_id=inventory_item.id,
                lot_id=inventory_lot.id,
                stock_source=stock_source,
                product_name=product.name,
                brand=product.brand,
                expiry_date=entry["expiry_date"],
                rack_number=entry["rack_number"],
                sealed_qty=entry["sealed_qty"],
                free_qty=entry["free_qty"],
                cost_price=entry["cost_price"],
                effective_cost_price=entry["effective_cost_price"],
                mrp=entry["mrp"],
                gst_percent=entry["gst_percent"],
                discount_amount=entry["discount_amount"],
                rounding_adjustment=entry["rounding_adjustment"],
                line_total=entry["line_total"],
            )
            session.add(purchase_item)

        for payment in prepared_payments:
            payment_row = PurchasePayment(
                purchase_id=purchase.id,
                party_id=supplier.id,
                paid_at=payment["paid_at"],
                mode=payment["mode"],
                bank_mode=payment["bank_mode"],
                transaction_id=payment["transaction_id"],
                amount=payment["amount"],
                cash_amount=payment["cash_amount"],
                online_amount=payment["online_amount"],
                txn_charges=payment["txn_charges"],
                note=payment["note"],
                is_writeoff=bool(payment["is_writeoff"]),
                is_deleted=False,
                deleted_at=None,
            )
            session.add(payment_row)

        session.flush()
        log_audit(
            session,
            entity_type="PURCHASE",
            entity_id=int(purchase.id),
            action="CREATE",
            note=f"Created purchase #{purchase.id}",
            details={"after": purchase_snapshot(session, purchase)},
        )
        session.commit()
        session.refresh(purchase)
        sync_purchase_vouchers(session, purchase, supplier)
        payments = session.exec(select(PurchasePayment).where(PurchasePayment.purchase_id == purchase.id)).all()
        for payment in payments:
            post_purchase_payment_voucher(
                session,
                purchase,
                supplier,
                int(payment.id or 0),
                float(payment.amount or 0),
                bool(payment.is_writeoff),
                payment.note,
                payment.paid_at,
                float(getattr(payment, "cash_amount", 0) or 0),
                float(getattr(payment, "online_amount", 0) or 0),
                getattr(payment, "bank_mode", None),
                float(getattr(payment, "txn_charges", 0) or 0),
                getattr(payment, "transaction_id", None),
            )
        session.commit()
        return make_purchase_out(session, purchase)


@router.post("/free-stock", response_model=PurchaseOut, status_code=201)
def create_free_stock(payload: FreeStockCreate) -> PurchaseOut:
    invoice_date = clean_date(payload.invoice_date)
    if not invoice_date:
        raise HTTPException(status_code=400, detail="invoice_date is required")
    if not payload.items:
        raise HTTPException(status_code=400, detail="At least one free stock item is required")

    sanitized_items: List[PurchaseItemIn] = []
    for raw in payload.items:
        paid_qty = int(raw.sealed_qty or 0)
        _qty, free_qty, _total_qty = validate_purchase_line_quantities(raw)
        if paid_qty != 0:
            raise HTTPException(status_code=400, detail="Free stock cannot have paid qty")
        if free_qty <= 0:
            raise HTTPException(status_code=400, detail="Free stock qty must be greater than 0")
        if round2(raw.cost_price) != 0:
            raise HTTPException(status_code=400, detail="Free stock rate must be 0")
        if round2(raw.discount_amount) != 0 or round2(raw.rounding_adjustment) != 0:
            raise HTTPException(status_code=400, detail="Free stock cannot have discount or round off")
        if raw.existing_inventory_item_id is not None:
            raise HTTPException(status_code=400, detail="Free stock must create a new stock batch")

        data = raw.dict()
        data.update(
            {
                "purchase_item_id": None,
                "existing_inventory_item_id": None,
                "sealed_qty": 0,
                "free_qty": free_qty,
                "cost_price": 0.0,
                "gst_percent": 0.0,
                "discount_amount": 0.0,
                "rounding_adjustment": 0.0,
            }
        )
        sanitized_items.append(PurchaseItemIn(**data))

    if payload.party_id is None:
        with get_session() as session:
            supplier = ensure_free_stock_supplier(session)
            party_id = int(supplier.id or 0)
    else:
        with get_session() as session:
            supplier = ensure_supplier(session, int(payload.party_id))
            party_id = int(supplier.id or 0)

    invoice_number = clean_text(payload.invoice_number)
    if not invoice_number:
        invoice_number = f"FREE-{invoice_date.replace('-', '')}-{datetime.now().strftime('%H%M%S%f')[:10]}"

    return create_purchase(
        PurchaseCreate(
            party_id=party_id,
            invoice_number=invoice_number,
            invoice_date=invoice_date,
            notes=clean_text(payload.notes),
            discount_amount=0.0,
            gst_amount=0.0,
            rounding_adjustment=0.0,
            items=sanitized_items,
            payments=[],
        )
    )


@router.get("/", response_model=List[PurchaseOut])
def list_purchases(
    party_id: Optional[int] = Query(None),
    from_date: Optional[str] = Query(None),
    to_date: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> List[PurchaseOut]:
    with get_session() as session:
        stmt = select(Purchase).where(Purchase.is_deleted == False)  # noqa: E712
        if party_id is not None:
            stmt = stmt.where(Purchase.party_id == party_id)
        if from_date:
            stmt = stmt.where(Purchase.invoice_date >= clean_date(from_date))
        if to_date:
            stmt = stmt.where(Purchase.invoice_date <= clean_date(to_date))
        rows = session.exec(stmt.order_by(Purchase.id.desc()).offset(offset).limit(limit)).all()
        return [make_purchase_out(session, row) for row in rows]


@router.get("/payments", response_model=List[PurchasePaymentBookRow])
def list_purchase_payments(
    from_date: Optional[str] = Query(None),
    to_date: Optional[str] = Query(None),
    party_id: Optional[int] = Query(None),
    include_writeoffs: bool = Query(False),
    include_deleted: bool = Query(False),
    limit: int = Query(200, ge=1, le=2000),
    offset: int = Query(0, ge=0),
) -> List[PurchasePaymentBookRow]:
    start_iso = f"{clean_date(from_date)}T00:00:00" if from_date else None
    end_iso = f"{clean_date(to_date)}T23:59:59.999999" if to_date else None

    with get_session() as session:
        stmt = select(PurchasePayment)
        if not include_deleted:
            stmt = stmt.where(PurchasePayment.is_deleted == False)  # noqa: E712
        if not include_writeoffs:
            stmt = stmt.where(PurchasePayment.is_writeoff == False)  # noqa: E712
        if party_id is not None:
            stmt = stmt.where(PurchasePayment.party_id == int(party_id))
        if start_iso:
            stmt = stmt.where(PurchasePayment.paid_at >= start_iso)
        if end_iso:
            stmt = stmt.where(PurchasePayment.paid_at <= end_iso)

        payments = session.exec(
            stmt.order_by(PurchasePayment.paid_at.desc(), PurchasePayment.id.desc())
            .offset(offset)
            .limit(limit)
        ).all()
        purchase_ids = {int(payment.purchase_id or 0) for payment in payments if int(payment.purchase_id or 0) > 0}
        purchases = (
            session.exec(select(Purchase).where(Purchase.id.in_(purchase_ids))).all()
            if purchase_ids
            else []
        )
        purchase_map = {int(purchase.id or 0): purchase for purchase in purchases}

        filtered: List[tuple[PurchasePayment, Optional[Purchase], int]] = []
        for payment in payments:
            purchase = purchase_map.get(int(payment.purchase_id or 0))
            if purchase and purchase.is_deleted and not include_deleted:
                continue
            resolved_party_id = int(purchase.party_id or 0) if purchase else int(getattr(payment, "party_id", 0) or 0)
            if not resolved_party_id:
                continue
            if party_id is not None and resolved_party_id != int(party_id):
                continue
            filtered.append((payment, purchase, resolved_party_id))

        party_ids = {resolved_party_id for _payment, _purchase, resolved_party_id in filtered}
        parties = (
            session.exec(select(Party).where(Party.id.in_(party_ids))).all()
            if party_ids
            else []
        )
        party_map = {int(party.id or 0): party.name for party in parties}

        return [
            PurchasePaymentBookRow(
                id=int(payment.id or 0),
                purchase_id=int(purchase.id or 0) if purchase else 0,
                party_id=resolved_party_id,
                paid_at=payment.paid_at,
                mode=payment.mode,
                bank_mode=getattr(payment, "bank_mode", None),
                transaction_id=getattr(payment, "transaction_id", None),
                amount=float(payment.amount or 0),
                cash_amount=float(payment.cash_amount or 0),
                online_amount=float(payment.online_amount or 0),
                txn_charges=float(getattr(payment, "txn_charges", 0) or 0),
                note=payment.note,
                invoice_number=purchase.invoice_number if purchase else None,
                supplier_name=party_map.get(resolved_party_id),
                is_writeoff=bool(payment.is_writeoff),
                is_deleted=bool(payment.is_deleted) or bool(getattr(purchase, "is_deleted", False)),
                deleted_at=payment.deleted_at,
            )
            for payment, purchase, resolved_party_id in filtered
        ]


@router.get("/{purchase_id}", response_model=PurchaseOut)
def get_purchase(purchase_id: int) -> PurchaseOut:
    with get_session() as session:
        row = session.get(Purchase, purchase_id)
        if not row or row.is_deleted:
            raise HTTPException(status_code=404, detail="Purchase not found")
        return make_purchase_out(session, row)


@router.get("/{purchase_id}/history", response_model=List[AuditLogOut])
def get_purchase_history(purchase_id: int) -> List[AuditLogOut]:
    with get_session() as session:
        if not session.get(Purchase, purchase_id):
            raise HTTPException(status_code=404, detail="Purchase not found")
        return session.exec(
            select(AuditLog).where(
                AuditLog.entity_type == "PURCHASE",
                AuditLog.entity_id == purchase_id,
            ).order_by(AuditLog.id.desc())
        ).all()


@router.get("/ledger/{party_id}", response_model=List[PurchaseLedgerRow])
def supplier_ledger(party_id: int) -> List[PurchaseLedgerRow]:
    with get_session() as session:
        ensure_supplier(session, party_id)
        rows = session.exec(
            select(Purchase)
            .where(Purchase.party_id == party_id, Purchase.is_deleted == False)  # noqa: E712
            .order_by(Purchase.invoice_date.desc(), Purchase.id.desc())
        ).all()
        out: List[PurchaseLedgerRow] = []
        for row in rows:
            return_amount = round2(session.exec(
                select(func.coalesce(func.sum(PurchaseReturn.total_amount), 0)).where(
                    PurchaseReturn.purchase_id == row.id,
                    PurchaseReturn.is_deleted == False,  # noqa: E712
                )
            ).one() or 0)
            net_amount = round2(float(row.total_amount or 0) - return_amount)
            outstanding = round2(net_amount - float(row.paid_amount or 0) - float(row.writeoff_amount or 0))
            out.append(
                PurchaseLedgerRow(
                    purchase_id=row.id,
                    invoice_number=row.invoice_number,
                    invoice_date=row.invoice_date,
                    total_amount=row.total_amount,
                    paid_amount=row.paid_amount,
                    writeoff_amount=row.writeoff_amount,
                    return_amount=return_amount,
                    net_amount=net_amount,
                    outstanding_amount=outstanding,
                    payment_status=row.payment_status,
                    notes=row.notes,
                )
            )
        return out


@router.patch("/{purchase_id}", response_model=PurchaseOut)
def update_purchase(purchase_id: int, payload: PurchaseUpdate) -> PurchaseOut:
    require_min_role("MANAGER", context="Purchase update")
    with get_session() as session:
        row = session.get(Purchase, purchase_id)
        if not row or row.is_deleted:
            raise HTTPException(status_code=404, detail="Purchase not found")
        assert_purchase_has_no_active_returns(session, purchase_id, context="Purchase update")
        assert_financial_year_unlocked(session, row.invoice_date, context="Purchase update")
        before_snapshot = purchase_snapshot(session, row)

        data = payload.dict(exclude_unset=True)
        if "party_id" in data:
            supplier = ensure_supplier(session, int(data["party_id"]))
            row.party_id = supplier.id
        if "invoice_number" in data:
            invoice_number = clean_text(data["invoice_number"])
            if not invoice_number:
                raise HTTPException(status_code=400, detail="invoice_number is required")
            duplicate = session.exec(
                select(Purchase).where(
                    Purchase.id != purchase_id,
                    Purchase.party_id == row.party_id,
                    func.lower(Purchase.invoice_number) == invoice_number.lower(),
                    Purchase.is_deleted == False,  # noqa: E712
                )
            ).first()
            if duplicate:
                raise HTTPException(status_code=400, detail="This invoice number already exists for the supplier")
            row.invoice_number = invoice_number
        if "invoice_date" in data:
            invoice_date = clean_date(data["invoice_date"])
            if not invoice_date:
                raise HTTPException(status_code=400, detail="invoice_date is required")
            assert_financial_year_unlocked(session, invoice_date, context="Purchase update")
            row.invoice_date = invoice_date
        if "notes" in data:
            row.notes = clean_text(data["notes"])
        if "discount_amount" in data:
            row.discount_amount = round2(data["discount_amount"])
        row.gst_amount = purchase_gst_amount(
            row.subtotal_amount,
            row.discount_amount,
            get_purchase_items(session, int(row.id)),
        )
        if "rounding_adjustment" in data:
            row.rounding_adjustment = round2(data["rounding_adjustment"])

        if "party_id" in data:
            for payment in session.exec(select(PurchasePayment).where(PurchasePayment.purchase_id == row.id)).all():
                payment.party_id = row.party_id
                session.add(payment)

        row.total_amount = round2(
            float(row.subtotal_amount or 0)
            - float(row.discount_amount or 0)
            + float(row.gst_amount or 0)
            + float(row.rounding_adjustment or 0)
        )
        if row.total_amount < 0:
            raise HTTPException(status_code=400, detail="Purchase total cannot be negative")
        if float(row.paid_amount or 0) + float(row.writeoff_amount or 0) > float(row.total_amount or 0) + 0.0001:
            raise HTTPException(status_code=400, detail="Updated header reduces total below settled amount")

        row.updated_at = now_ts()
        session.add(row)
        session.flush()
        log_audit(
            session,
            entity_type="PURCHASE",
            entity_id=int(row.id),
            action="UPDATE",
            note=f"Updated purchase #{row.id}",
            details={"before": before_snapshot, "after": purchase_snapshot(session, row)},
        )
        session.commit()
        recompute_purchase_payment_state(session, row)
        supplier = ensure_supplier(session, row.party_id)
        sync_purchase_vouchers(session, row, supplier)
        session.commit()
        session.refresh(row)
        return make_purchase_out(session, row)


@router.post("/supplier-payment/{party_id}", response_model=List[PurchaseOut])
def add_supplier_payment(party_id: int, payload: SupplierPaymentCreate) -> List[PurchaseOut]:
    allocation_map: Dict[int, float] = {}
    for allocation in payload.allocations or []:
        purchase_id = int(allocation.purchase_id or 0)
        amount = round2(allocation.amount)
        if purchase_id <= 0:
            raise HTTPException(status_code=400, detail="purchase_id is required")
        if amount <= 0:
            raise HTTPException(status_code=400, detail="Allocation amounts must be greater than 0")
        allocation_map[purchase_id] = round2(allocation_map.get(purchase_id, 0.0) + amount)

    allocation_total = round2(sum(allocation_map.values()))
    payment_total = allocation_total
    if not allocation_map:
        if payload.amount is not None:
            payment_total = round2(payload.amount)
        else:
            payment_total = round2(float(payload.cash_amount or 0) + float(payload.online_amount or 0))
    mode, total_amount, cash_amount, online_amount = normalize_payment_mode(
        payload.mode,
        payment_total,
        payload.cash_amount,
        payload.online_amount,
        bool(payload.is_writeoff),
    )
    bank_mode, transaction_id, txn_charges = normalize_purchase_bank_details(
        is_writeoff=bool(payload.is_writeoff),
        online_amount=online_amount,
        bank_mode=payload.bank_mode,
        transaction_id=payload.transaction_id,
        txn_charges=payload.txn_charges,
    )

    payment_ts = payload.payment_date
    if payment_ts:
        payment_ts = clean_date(payment_ts)
        payment_ts = f"{payment_ts}T00:00:00"
    else:
        payment_ts = now_ts()

    with get_session() as session:
        supplier = ensure_supplier(session, party_id)
        assert_financial_year_unlocked(session, payment_ts, context="Supplier payment")

        if not allocation_map:
            payment = PurchasePayment(
                purchase_id=0,
                party_id=supplier.id,
                paid_at=payment_ts,
                mode=mode,
                bank_mode=bank_mode,
                transaction_id=transaction_id,
                amount=total_amount,
                cash_amount=cash_amount,
                online_amount=online_amount,
                txn_charges=txn_charges,
                note=clean_text(payload.note),
                is_writeoff=bool(payload.is_writeoff),
                is_deleted=False,
                deleted_at=None,
            )
            session.add(payment)
            session.flush()
            post_purchase_payment_voucher(
                session,
                None,
                supplier,
                int(payment.id or 0),
                float(payment.amount or 0),
                bool(payment.is_writeoff),
                payment.note,
                payment.paid_at,
                float(payment.cash_amount or 0),
                float(payment.online_amount or 0),
                payment.bank_mode,
                float(payment.txn_charges or 0),
                payment.transaction_id,
            )
            log_audit(
                session,
                entity_type="PURCHASE_PAYMENT",
                entity_id=int(payment.id),
                action="CREATE",
                note=f"Added supplier payment without purchase for {supplier.name}",
                details={
                    "party_id": supplier.id,
                    "amount": payment.amount,
                    "mode": payment.mode,
                    "bank_mode": payment.bank_mode,
                    "transaction_id": payment.transaction_id,
                    "txn_charges": payment.txn_charges,
                    "is_writeoff": bool(payment.is_writeoff),
                    "unallocated": True,
                },
            )
            session.commit()
            return []

        purchase_ids = list(allocation_map.keys())
        rows = session.exec(
            select(Purchase)
            .where(Purchase.id.in_(purchase_ids))
            .where(Purchase.is_deleted == False)  # noqa: E712
        ).all()
        purchases_by_id = {int(row.id): row for row in rows if row.id is not None}

        missing_ids = [purchase_id for purchase_id in purchase_ids if purchase_id not in purchases_by_id]
        if missing_ids:
            raise HTTPException(status_code=404, detail=f"Purchase not found: {missing_ids[0]}")

        for purchase_id, amount in allocation_map.items():
            row = purchases_by_id[purchase_id]
            if int(row.party_id) != int(supplier.id):
                raise HTTPException(status_code=400, detail=f"Purchase {purchase_id} does not belong to this supplier")
            outstanding = round2(
                purchase_net_amount(session, row)
                - float(row.paid_amount or 0)
                - float(row.writeoff_amount or 0)
            )
            if amount > outstanding + 0.0001:
                raise HTTPException(status_code=400, detail=f"Allocation for purchase {purchase_id} exceeds outstanding amount")

        cash_remaining = cash_amount
        online_remaining = online_amount
        charges_remaining = txn_charges
        allocations = list(allocation_map.items())
        for index, (purchase_id, amount) in enumerate(allocations):
            row = purchases_by_id[purchase_id]
            is_last = index == len(allocations) - 1
            if bool(payload.is_writeoff):
                cash_share = 0.0
                online_share = 0.0
            elif is_last:
                cash_share = round2(cash_remaining)
                online_share = round2(online_remaining)
            else:
                cash_share = round2((cash_amount / total_amount) * amount) if total_amount > 0 else 0.0
                cash_share = min(cash_remaining, max(0.0, cash_share))
                online_share = round2(amount - cash_share)
                if online_share > online_remaining:
                    online_share = round2(online_remaining)
                    cash_share = round2(amount - online_share)
                cash_share = max(0.0, cash_share)
                online_share = max(0.0, online_share)

            charge_share = 0.0
            if not bool(payload.is_writeoff) and online_share > 0 and txn_charges > 0:
                if online_remaining <= online_share + 0.0001:
                    charge_share = round2(charges_remaining)
                else:
                    charge_share = round2((txn_charges / online_amount) * online_share) if online_amount > 0 else 0.0
                    charge_share = min(charges_remaining, max(0.0, charge_share))

            payment = PurchasePayment(
                purchase_id=row.id,
                party_id=supplier.id,
                paid_at=payment_ts,
                mode=mode,
                bank_mode=bank_mode if online_share > 0 else None,
                transaction_id=transaction_id if online_share > 0 and bank_mode == "UPI" else None,
                amount=amount,
                cash_amount=cash_share,
                online_amount=online_share,
                txn_charges=charge_share,
                note=clean_text(payload.note),
                is_writeoff=bool(payload.is_writeoff),
                is_deleted=False,
                deleted_at=None,
            )
            session.add(payment)
            session.flush()

            recompute_purchase_payment_state(session, row)
            session.add(row)
            post_purchase_payment_voucher(
                session,
                row,
                supplier,
                int(payment.id or 0),
                float(payment.amount or 0),
                bool(payment.is_writeoff),
                payment.note,
                payment.paid_at,
                float(payment.cash_amount or 0),
                float(payment.online_amount or 0),
                payment.bank_mode,
                float(payment.txn_charges or 0),
                payment.transaction_id,
            )
            log_audit(
                session,
                entity_type="PURCHASE_PAYMENT",
                entity_id=int(payment.id),
                action="CREATE",
                note=f"Added supplier payment to purchase #{row.id}",
                details={
                    "purchase_id": row.id,
                    "amount": payment.amount,
                    "mode": payment.mode,
                    "bank_mode": payment.bank_mode,
                    "transaction_id": payment.transaction_id,
                    "txn_charges": payment.txn_charges,
                    "is_writeoff": bool(payment.is_writeoff),
                },
            )
            cash_remaining = round2(cash_remaining - cash_share)
            online_remaining = round2(online_remaining - online_share)
            charges_remaining = round2(charges_remaining - charge_share)

        session.commit()
        return [make_purchase_out(session, purchases_by_id[purchase_id]) for purchase_id, _amount in allocations]


def supplier_payment_context(session, party_id: int, payment_id: int) -> tuple[Party, PurchasePayment, Optional[Purchase]]:
    supplier = ensure_supplier(session, party_id)
    payment = session.get(PurchasePayment, payment_id)
    if not payment:
        raise HTTPException(status_code=404, detail="Payment not found")

    purchase = session.get(Purchase, payment.purchase_id) if int(payment.purchase_id or 0) > 0 else None
    if purchase:
        if purchase.is_deleted:
            raise HTTPException(status_code=404, detail="Purchase not found")
        if int(purchase.party_id or 0) != int(supplier.id):
            raise HTTPException(status_code=404, detail="Payment not found")
    elif int(getattr(payment, "party_id", 0) or 0) != int(supplier.id):
        raise HTTPException(status_code=404, detail="Payment not found")

    return supplier, payment, purchase


@router.patch("/supplier-payment/{party_id}/payments/{payment_id}", response_model=PurchasePaymentOut)
def update_supplier_payment(party_id: int, payment_id: int, payload: PurchasePaymentUpdate) -> PurchasePaymentOut:
    require_min_role("MANAGER", context="Supplier payment update")
    data = payload.dict(exclude_unset=True)
    with get_session() as session:
        supplier, payment, purchase = supplier_payment_context(session, party_id, payment_id)
        if payment.is_deleted:
            raise HTTPException(status_code=404, detail="Payment not found")

        assert_financial_year_unlocked(session, payment.paid_at, context="Supplier payment update")
        old_source_type = purchase_payment_source_type(payment)

        next_paid_at = payment.paid_at
        if "paid_at" in data:
            clean_paid_at = clean_date(data.get("paid_at"))
            if not clean_paid_at:
                raise HTTPException(status_code=400, detail="paid_at is required")
            next_paid_at = f"{clean_paid_at}T00:00:00"
            assert_financial_year_unlocked(session, next_paid_at, context="Supplier payment update")

        next_is_writeoff = bool(data.get("is_writeoff", payment.is_writeoff))
        mode, amount, cash_amount, online_amount = normalize_payment_mode(
            data.get("mode", payment.mode),
            data.get("amount", payment.amount),
            data.get("cash_amount", payment.cash_amount),
            data.get("online_amount", payment.online_amount),
            next_is_writeoff,
        )
        bank_mode, transaction_id, txn_charges = normalize_purchase_bank_details(
            is_writeoff=next_is_writeoff,
            online_amount=online_amount,
            bank_mode=data.get("bank_mode", getattr(payment, "bank_mode", None)),
            transaction_id=data.get("transaction_id", getattr(payment, "transaction_id", None)),
            txn_charges=data.get("txn_charges", getattr(payment, "txn_charges", 0)),
        )

        if purchase:
            active_payments = session.exec(
                select(PurchasePayment).where(
                    PurchasePayment.purchase_id == purchase.id,
                    PurchasePayment.is_deleted == False,  # noqa: E712
                    PurchasePayment.id != payment.id,
                )
            ).all()
            settled_elsewhere = round2(sum(float(p.amount or 0) for p in active_payments))
            if settled_elsewhere + amount > purchase_net_amount(session, purchase) + 0.0001:
                raise HTTPException(status_code=400, detail="Payment exceeds outstanding amount")

        payment.party_id = supplier.id
        payment.paid_at = next_paid_at
        payment.mode = mode
        payment.bank_mode = bank_mode
        payment.transaction_id = transaction_id
        payment.amount = amount
        payment.cash_amount = cash_amount
        payment.online_amount = online_amount
        payment.txn_charges = txn_charges
        if "note" in data:
            payment.note = clean_text(data.get("note"))
        payment.is_writeoff = next_is_writeoff
        session.add(payment)
        log_audit(
            session,
            entity_type="PURCHASE_PAYMENT",
            entity_id=int(payment.id),
            action="UPDATE",
            note=f"Updated supplier payment #{payment.id}",
            details={
                "party_id": supplier.id,
                "purchase_id": purchase.id if purchase else None,
                "amount": payment.amount,
                "mode": payment.mode,
                "bank_mode": payment.bank_mode,
                "transaction_id": payment.transaction_id,
                "txn_charges": payment.txn_charges,
                "is_writeoff": bool(payment.is_writeoff),
            },
        )
        session.commit()
        if purchase:
            recompute_purchase_payment_state(session, purchase)
        new_source_type = purchase_payment_source_type(payment)
        if new_source_type != old_source_type:
            mark_voucher_deleted(session, source_type=old_source_type, source_id=int(payment.id or 0))
        post_purchase_payment_voucher(
            session,
            purchase,
            supplier,
            int(payment.id or 0),
            float(payment.amount or 0),
            bool(payment.is_writeoff),
            payment.note,
            payment.paid_at,
            float(getattr(payment, "cash_amount", 0) or 0),
            float(getattr(payment, "online_amount", 0) or 0),
            getattr(payment, "bank_mode", None),
            float(getattr(payment, "txn_charges", 0) or 0),
            getattr(payment, "transaction_id", None),
        )
        session.commit()
        session.refresh(payment)
        return make_purchase_payment_out(payment, int(supplier.id))


@router.delete("/supplier-payment/{party_id}/payments/{payment_id}", response_model=PurchasePaymentOut)
def delete_supplier_payment(party_id: int, payment_id: int) -> PurchasePaymentOut:
    require_min_role("MANAGER", context="Supplier payment delete")
    with get_session() as session:
        supplier, payment, purchase = supplier_payment_context(session, party_id, payment_id)
        if payment.is_deleted:
            raise HTTPException(status_code=404, detail="Payment not found")

        assert_financial_year_unlocked(session, payment.paid_at, context="Supplier payment delete")
        source_type = purchase_payment_source_type(payment)
        payment.party_id = supplier.id
        payment.is_deleted = True
        payment.deleted_at = now_ts()
        session.add(payment)
        log_audit(
            session,
            entity_type="PURCHASE_PAYMENT",
            entity_id=int(payment.id),
            action="DELETE",
            note=f"Deleted supplier payment #{payment.id}",
            details={"party_id": supplier.id, "purchase_id": purchase.id if purchase else None, "amount": payment.amount, "is_writeoff": bool(payment.is_writeoff)},
        )
        session.commit()
        if purchase:
            recompute_purchase_payment_state(session, purchase)
        mark_voucher_deleted(session, source_type=source_type, source_id=int(payment.id or 0))
        session.commit()
        session.refresh(payment)
        return make_purchase_payment_out(payment, int(supplier.id))


@router.post("/supplier-payment/{party_id}/payments/{payment_id}/restore", response_model=PurchasePaymentOut)
def restore_supplier_payment(party_id: int, payment_id: int) -> PurchasePaymentOut:
    require_min_role("MANAGER", context="Supplier payment restore")
    with get_session() as session:
        supplier, payment, purchase = supplier_payment_context(session, party_id, payment_id)
        if not payment.is_deleted:
            raise HTTPException(status_code=400, detail="Payment is already active")

        assert_financial_year_unlocked(session, payment.paid_at, context="Supplier payment restore")
        if purchase:
            active_payments = session.exec(
                select(PurchasePayment).where(
                    PurchasePayment.purchase_id == purchase.id,
                    PurchasePayment.is_deleted == False,  # noqa: E712
                )
            ).all()
            settled_active = round2(sum(float(p.amount or 0) for p in active_payments))
            if settled_active + float(payment.amount or 0) > purchase_net_amount(session, purchase) + 0.0001:
                raise HTTPException(status_code=400, detail="Restored payment exceeds purchase total")

        payment.party_id = supplier.id
        payment.is_deleted = False
        payment.deleted_at = None
        session.add(payment)
        log_audit(
            session,
            entity_type="PURCHASE_PAYMENT",
            entity_id=int(payment.id),
            action="RESTORE",
            note=f"Restored supplier payment #{payment.id}",
            details={"party_id": supplier.id, "purchase_id": purchase.id if purchase else None, "amount": payment.amount, "is_writeoff": bool(payment.is_writeoff)},
        )
        session.commit()
        if purchase:
            recompute_purchase_payment_state(session, purchase)
        post_purchase_payment_voucher(
            session,
            purchase,
            supplier,
            int(payment.id or 0),
            float(payment.amount or 0),
            bool(payment.is_writeoff),
            payment.note,
            payment.paid_at,
            float(getattr(payment, "cash_amount", 0) or 0),
            float(getattr(payment, "online_amount", 0) or 0),
            getattr(payment, "bank_mode", None),
            float(getattr(payment, "txn_charges", 0) or 0),
            getattr(payment, "transaction_id", None),
        )
        session.commit()
        session.refresh(payment)
        return make_purchase_payment_out(payment, int(supplier.id))


@router.post("/{purchase_id}/payments", response_model=PurchaseOut)
def add_purchase_payment(purchase_id: int, payload: PurchasePaymentCreate) -> PurchaseOut:
    mode, amount, cash_amount, online_amount = normalize_payment_mode(
        payload.mode,
        payload.amount,
        payload.cash_amount,
        payload.online_amount,
        bool(payload.is_writeoff),
    )
    bank_mode, transaction_id, txn_charges = normalize_purchase_bank_details(
        is_writeoff=bool(payload.is_writeoff),
        online_amount=online_amount,
        bank_mode=payload.bank_mode,
        transaction_id=payload.transaction_id,
        txn_charges=payload.txn_charges,
    )

    with get_session() as session:
        row = session.get(Purchase, purchase_id)
        if not row or row.is_deleted:
            raise HTTPException(status_code=404, detail="Purchase not found")

        paid_at = payload.paid_at
        if paid_at:
            paid_at = clean_date(paid_at)
            paid_at = f"{paid_at}T00:00:00"
        else:
            paid_at = now_ts()
        assert_financial_year_unlocked(session, paid_at, context="Purchase payment")

        projected = round2(
            float(row.paid_amount or 0)
            + float(row.writeoff_amount or 0)
            + amount
        )
        if projected > purchase_net_amount(session, row) + 0.0001:
            raise HTTPException(status_code=400, detail="Payment exceeds outstanding amount")

        payment = PurchasePayment(
            purchase_id=row.id,
            party_id=row.party_id,
            paid_at=paid_at,
            mode=mode,
            bank_mode=bank_mode,
            transaction_id=transaction_id,
            amount=amount,
            cash_amount=cash_amount,
            online_amount=online_amount,
            txn_charges=txn_charges,
            note=clean_text(payload.note),
            is_writeoff=bool(payload.is_writeoff),
            is_deleted=False,
            deleted_at=None,
        )
        session.add(payment)
        session.flush()
        log_audit(
            session,
            entity_type="PURCHASE_PAYMENT",
            entity_id=int(payment.id),
            action="CREATE",
            note=f"Added payment to purchase #{row.id}",
            details={
                "purchase_id": row.id,
                "amount": payment.amount,
                "mode": payment.mode,
                "bank_mode": payment.bank_mode,
                "transaction_id": payment.transaction_id,
                "txn_charges": payment.txn_charges,
                "is_writeoff": bool(payment.is_writeoff),
            },
        )
        session.commit()
        recompute_purchase_payment_state(session, row)
        supplier = ensure_supplier(session, row.party_id)
        post_purchase_payment_voucher(
            session,
            row,
            supplier,
            int(payment.id or 0),
            float(payment.amount or 0),
            bool(payment.is_writeoff),
            payment.note,
            payment.paid_at,
            float(getattr(payment, "cash_amount", 0) or 0),
            float(getattr(payment, "online_amount", 0) or 0),
            getattr(payment, "bank_mode", None),
            float(getattr(payment, "txn_charges", 0) or 0),
            getattr(payment, "transaction_id", None),
        )
        session.commit()
        session.refresh(row)
        return make_purchase_out(session, row)


@router.patch("/{purchase_id}/payments/{payment_id}", response_model=PurchaseOut)
def update_purchase_payment(purchase_id: int, payment_id: int, payload: PurchasePaymentUpdate) -> PurchaseOut:
    require_min_role("MANAGER", context="Purchase payment update")
    data = payload.dict(exclude_unset=True)
    with get_session() as session:
        row = session.get(Purchase, purchase_id)
        if not row or row.is_deleted:
            raise HTTPException(status_code=404, detail="Purchase not found")
        payment = session.get(PurchasePayment, payment_id)
        if not payment or int(payment.purchase_id) != int(row.id) or payment.is_deleted:
            raise HTTPException(status_code=404, detail="Payment not found")

        assert_financial_year_unlocked(session, payment.paid_at, context="Purchase payment update")
        old_source_type = purchase_payment_source_type(payment)

        next_paid_at = payment.paid_at
        if "paid_at" in data:
            clean_paid_at = clean_date(data.get("paid_at"))
            if not clean_paid_at:
                raise HTTPException(status_code=400, detail="paid_at is required")
            next_paid_at = f"{clean_paid_at}T00:00:00"
            assert_financial_year_unlocked(session, next_paid_at, context="Purchase payment update")

        next_is_writeoff = bool(data.get("is_writeoff", payment.is_writeoff))
        mode, amount, cash_amount, online_amount = normalize_payment_mode(
            data.get("mode", payment.mode),
            data.get("amount", payment.amount),
            data.get("cash_amount", payment.cash_amount),
            data.get("online_amount", payment.online_amount),
            next_is_writeoff,
        )
        bank_mode, transaction_id, txn_charges = normalize_purchase_bank_details(
            is_writeoff=next_is_writeoff,
            online_amount=online_amount,
            bank_mode=data.get("bank_mode", getattr(payment, "bank_mode", None)),
            transaction_id=data.get("transaction_id", getattr(payment, "transaction_id", None)),
            txn_charges=data.get("txn_charges", getattr(payment, "txn_charges", 0)),
        )

        active_payments = session.exec(
            select(PurchasePayment).where(
                PurchasePayment.purchase_id == row.id,
                PurchasePayment.is_deleted == False,  # noqa: E712
                PurchasePayment.id != payment.id,
            )
        ).all()
        settled_elsewhere = round2(sum(float(p.amount or 0) for p in active_payments))
        if settled_elsewhere + amount > purchase_net_amount(session, row) + 0.0001:
            raise HTTPException(status_code=400, detail="Payment exceeds outstanding amount")

        payment.paid_at = next_paid_at
        payment.party_id = row.party_id
        payment.mode = mode
        payment.bank_mode = bank_mode
        payment.transaction_id = transaction_id
        payment.amount = amount
        payment.cash_amount = cash_amount
        payment.online_amount = online_amount
        payment.txn_charges = txn_charges
        if "note" in data:
            payment.note = clean_text(data.get("note"))
        payment.is_writeoff = next_is_writeoff
        session.add(payment)
        log_audit(
            session,
            entity_type="PURCHASE_PAYMENT",
            entity_id=int(payment.id),
            action="UPDATE",
            note=f"Updated payment #{payment.id} for purchase #{row.id}",
            details={
                "purchase_id": row.id,
                "amount": payment.amount,
                "mode": payment.mode,
                "bank_mode": payment.bank_mode,
                "transaction_id": payment.transaction_id,
                "txn_charges": payment.txn_charges,
                "is_writeoff": bool(payment.is_writeoff),
            },
        )
        session.commit()
        recompute_purchase_payment_state(session, row)
        supplier = ensure_supplier(session, row.party_id)
        new_source_type = purchase_payment_source_type(payment)
        if new_source_type != old_source_type:
            mark_voucher_deleted(session, source_type=old_source_type, source_id=int(payment.id or 0))
        post_purchase_payment_voucher(
            session,
            row,
            supplier,
            int(payment.id or 0),
            float(payment.amount or 0),
            bool(payment.is_writeoff),
            payment.note,
            payment.paid_at,
            float(getattr(payment, "cash_amount", 0) or 0),
            float(getattr(payment, "online_amount", 0) or 0),
            getattr(payment, "bank_mode", None),
            float(getattr(payment, "txn_charges", 0) or 0),
            getattr(payment, "transaction_id", None),
        )
        session.commit()
        session.refresh(row)
        return make_purchase_out(session, row)


@router.delete("/{purchase_id}/payments/{payment_id}", response_model=PurchaseOut)
def delete_purchase_payment(purchase_id: int, payment_id: int) -> PurchaseOut:
    require_min_role("MANAGER", context="Purchase payment delete")
    with get_session() as session:
        row = session.get(Purchase, purchase_id)
        if not row or row.is_deleted:
            raise HTTPException(status_code=404, detail="Purchase not found")
        payment = session.get(PurchasePayment, payment_id)
        if not payment or int(payment.purchase_id) != int(row.id) or payment.is_deleted:
            raise HTTPException(status_code=404, detail="Payment not found")

        assert_financial_year_unlocked(session, payment.paid_at, context="Purchase payment delete")
        source_type = purchase_payment_source_type(payment)
        payment.is_deleted = True
        payment.party_id = row.party_id
        payment.deleted_at = now_ts()
        session.add(payment)
        log_audit(
            session,
            entity_type="PURCHASE_PAYMENT",
            entity_id=int(payment.id),
            action="DELETE",
            note=f"Deleted payment #{payment.id} for purchase #{row.id}",
            details={"purchase_id": row.id, "amount": payment.amount, "is_writeoff": bool(payment.is_writeoff)},
        )
        session.commit()
        recompute_purchase_payment_state(session, row)
        mark_voucher_deleted(session, source_type=source_type, source_id=int(payment.id or 0))
        session.commit()
        session.refresh(row)
        return make_purchase_out(session, row)


@router.post("/{purchase_id}/payments/{payment_id}/restore", response_model=PurchaseOut)
def restore_purchase_payment(purchase_id: int, payment_id: int) -> PurchaseOut:
    require_min_role("MANAGER", context="Purchase payment restore")
    with get_session() as session:
        row = session.get(Purchase, purchase_id)
        if not row or row.is_deleted:
            raise HTTPException(status_code=404, detail="Purchase not found")
        payment = session.get(PurchasePayment, payment_id)
        if not payment or int(payment.purchase_id) != int(row.id):
            raise HTTPException(status_code=404, detail="Payment not found")
        if not payment.is_deleted:
            raise HTTPException(status_code=400, detail="Payment is already active")

        assert_financial_year_unlocked(session, payment.paid_at, context="Purchase payment restore")
        active_payments = session.exec(
            select(PurchasePayment).where(
                PurchasePayment.purchase_id == row.id,
                PurchasePayment.is_deleted == False,  # noqa: E712
            )
        ).all()
        settled_active = round2(sum(float(p.amount or 0) for p in active_payments))
        if settled_active + float(payment.amount or 0) > purchase_net_amount(session, row) + 0.0001:
            raise HTTPException(status_code=400, detail="Restored payment exceeds purchase total")

        payment.is_deleted = False
        payment.party_id = row.party_id
        payment.deleted_at = None
        session.add(payment)
        log_audit(
            session,
            entity_type="PURCHASE_PAYMENT",
            entity_id=int(payment.id),
            action="RESTORE",
            note=f"Restored payment #{payment.id} for purchase #{row.id}",
            details={"purchase_id": row.id, "amount": payment.amount, "is_writeoff": bool(payment.is_writeoff)},
        )
        session.commit()
        recompute_purchase_payment_state(session, row)
        supplier = ensure_supplier(session, row.party_id)
        post_purchase_payment_voucher(
            session,
            row,
            supplier,
            int(payment.id or 0),
            float(payment.amount or 0),
            bool(payment.is_writeoff),
            payment.note,
            payment.paid_at,
            float(getattr(payment, "cash_amount", 0) or 0),
            float(getattr(payment, "online_amount", 0) or 0),
            getattr(payment, "bank_mode", None),
            float(getattr(payment, "txn_charges", 0) or 0),
            getattr(payment, "transaction_id", None),
        )
        session.commit()
        session.refresh(row)
        return make_purchase_out(session, row)


@router.put("/{purchase_id}/items", response_model=PurchaseOut)
def replace_purchase_items(purchase_id: int, payload: PurchaseItemsReplace) -> PurchaseOut:
    require_min_role("MANAGER", context="Purchase item replacement")
    if not payload.items:
        raise HTTPException(status_code=400, detail="At least one item is required")

    with get_session() as session:
        purchase = session.get(Purchase, purchase_id)
        if not purchase or purchase.is_deleted:
            raise HTTPException(status_code=404, detail="Purchase not found")
        assert_purchase_has_no_active_returns(session, purchase_id, context="Purchase item replacement")
        assert_financial_year_unlocked(session, purchase.invoice_date, context="Purchase item replacement")

        existing_items = get_purchase_items(session, purchase_id)
        before_snapshot = purchase_snapshot(session, purchase)
        if can_update_purchase_items_in_place(existing_items, payload.items):
            return update_purchase_items_in_place(session, purchase, payload.items)

        existing_by_id = {int(item.id or 0): item for item in existing_items}
        raw_existing_ids: List[int] = []
        for raw in payload.items:
            raw_id = _purchase_item_edit_id(raw)
            if raw_id is None:
                continue
            if raw_id not in existing_by_id:
                raise HTTPException(status_code=400, detail=f"Purchase item #{raw_id} does not belong to this purchase")
            if raw_id in raw_existing_ids:
                raise HTTPException(status_code=400, detail=f"Purchase item #{raw_id} was submitted more than once")
            if not purchase_item_matches_raw(raw, existing_by_id[raw_id]):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Purchase item #{raw_id} has changes. Save edits to existing rows separately "
                        "before adding or removing purchase rows."
                    ),
                )
            raw_existing_ids.append(raw_id)
        raw_existing_id_set = set(raw_existing_ids)
        removed_existing_items = [item for item in existing_items if int(item.id or 0) not in raw_existing_id_set]

        touched: List[tuple[PurchaseItem, Item]] = []
        for item in removed_existing_items:
            if purchase_item_stock_source(item) == STOCK_SOURCE_ATTACHED:
                if not item.inventory_item_id:
                    raise HTTPException(status_code=400, detail=f"Purchase item #{item.id} is missing stock linkage")
                inventory_item = session.get(Item, item.inventory_item_id)
                if not inventory_item:
                    raise HTTPException(status_code=400, detail=f"Inventory item #{item.inventory_item_id} not found")
            else:
                inventory_item = assert_purchase_item_untouched(session, item)
            touched.append((item, inventory_item))

        subtotal_amount = 0.0
        prepared_items: List[Dict[str, Any]] = []
        for raw in payload.items:
            purchase_item_id = _purchase_item_edit_id(raw)
            if purchase_item_id is not None:
                subtotal_amount = round2(subtotal_amount + float(existing_by_id[purchase_item_id].line_total or 0))
                continue

            qty, free_qty, total_qty = validate_purchase_line_quantities(raw)
            if round2(raw.cost_price) < 0:
                raise HTTPException(status_code=400, detail="rate cannot be negative")
            if round2(raw.gst_percent) < 0 or round2(raw.gst_percent) > 100:
                raise HTTPException(status_code=400, detail="GST percent must be between 0 and 100")

            existing_inventory_item = None
            stock_source = STOCK_SOURCE_CREATED
            if raw.existing_inventory_item_id is not None:
                existing_inventory_item = session.get(Item, int(raw.existing_inventory_item_id))
                if not existing_inventory_item:
                    raise HTTPException(status_code=400, detail=f"Inventory batch #{raw.existing_inventory_item_id} not found")
                ensure_inventory_batch_not_already_purchased(
                    session,
                    int(existing_inventory_item.id),
                    ignore_purchase_id=purchase_id,
                )
                product = ensure_product_for_existing_inventory(
                    session,
                    inventory_item=existing_inventory_item,
                    raw=raw,
                )
                stock_source = STOCK_SOURCE_ATTACHED
            else:
                product = ensure_product(
                    session,
                    product_id=raw.product_id,
                    product_name=raw.product_name,
                    alias=raw.alias,
                    brand=raw.brand,
                    category_id=raw.category_id,
                    rack_number=raw.rack_number,
                    loose_sale_enabled=raw.loose_sale_enabled,
                    parent_unit_name=raw.parent_unit_name,
                    child_unit_name=raw.child_unit_name,
                    conversion_qty=raw.conversion_qty,
                    printed_price=raw.mrp,
                )
            rack_number = int(raw.rack_number if raw.rack_number is not None else product.default_rack_number or 0)
            line_rounding = round2(raw.rounding_adjustment)
            line_total = round2((qty * float(raw.cost_price or 0)) - float(raw.discount_amount or 0) + line_rounding)
            effective_cost = round2(line_total / total_qty) if total_qty > 0 else round2(raw.cost_price)
            opening_placeholder_movement = None
            convert_opening_to_purchase = False
            if existing_inventory_item is not None:
                opening_placeholder_movement = find_opening_item_create_placeholder(
                    session,
                    inventory_item_id=int(existing_inventory_item.id),
                    total_qty=total_qty,
                    invoice_date=purchase.invoice_date,
                )
                if opening_placeholder_movement is not None:
                    stock_source = STOCK_SOURCE_CREATED
                    convert_opening_to_purchase = True
            subtotal_amount = round2(subtotal_amount + line_total)
            prepared_items.append(
                {
                    "product": product,
                    "existing_inventory_item": existing_inventory_item,
                    "opening_placeholder_movement": opening_placeholder_movement,
                    "convert_opening_to_purchase": convert_opening_to_purchase,
                    "stock_source": stock_source,
                    "expiry_date": require_expiry_date(raw.expiry_date, context=raw.product_name or "Purchase item"),
                    "rack_number": rack_number,
                    "sealed_qty": qty,
                    "free_qty": free_qty,
                    "cost_price": round2(raw.cost_price),
                    "effective_cost_price": effective_cost,
                    "mrp": round2(raw.mrp),
                    "gst_percent": round2(raw.gst_percent),
                    "discount_amount": round2(raw.discount_amount),
                    "rounding_adjustment": line_rounding,
                    "line_total": line_total,
                }
            )

        purchase_stock_ts = f"{purchase.invoice_date}T00:00:00"
        for purchase_item, inventory_item in touched:
            purchase_item_qty = purchase_item_total_qty(purchase_item)
            if purchase_item_stock_source(purchase_item) == STOCK_SOURCE_ATTACHED:
                add_stock_movement(
                    session,
                    item_id=int(inventory_item.id),
                    delta=0,
                    reason="PURCHASE_LINK_REMOVED",
                    ref_type="PURCHASE",
                    ref_id=int(purchase.id),
                    note=f"Removed existing inventory link from purchase {purchase.invoice_number}",
                    ts=purchase_stock_ts,
                )
            else:
                inventory_item.stock = 0
                inventory_item.is_archived = True
                inventory_item.updated_at = now_ts()
                session.add(inventory_item)
                if purchase_item.lot_id:
                    lot = session.get(InventoryLot, purchase_item.lot_id)
                    if lot:
                        lot.sealed_qty = 0
                        lot.loose_qty = 0
                        lot.is_active = False
                        lot.updated_at = inventory_item.updated_at
                        session.add(lot)
                add_stock_movement(
                    session,
                    item_id=int(inventory_item.id),
                    delta=-purchase_item_qty,
                    reason="PURCHASE_EDIT",
                    ref_type="PURCHASE",
                    ref_id=int(purchase.id),
                    note=f"Replaced items on purchase {purchase.invoice_number}",
                    ts=purchase_stock_ts,
                )
            session.delete(purchase_item)

        session.flush()
        ts = now_ts()
        for entry in prepared_items:
            product: Product = entry["product"]
            total_qty = int(entry["sealed_qty"]) + int(entry["free_qty"])
            stock_source = str(entry["stock_source"])
            if entry.get("convert_opening_to_purchase"):
                inventory_item = entry["existing_inventory_item"]
                opening_movement = entry["opening_placeholder_movement"]
                if not inventory_item or not opening_movement:
                    raise HTTPException(status_code=400, detail="Opening stock could not be converted to purchase stock")
                inventory_lot = convert_opening_placeholder_to_purchase(
                    session,
                    inventory_item=inventory_item,
                    opening_movement=opening_movement,
                    product=product,
                    total_qty=total_qty,
                    effective_cost_price=entry["effective_cost_price"],
                    mrp=entry["mrp"],
                    rack_number=entry["rack_number"],
                    expiry_date=entry["expiry_date"],
                    purchase_id=int(purchase.id),
                    invoice_number=purchase.invoice_number,
                    purchase_stock_ts=purchase_stock_ts,
                    ts=ts,
                )
            elif stock_source == STOCK_SOURCE_ATTACHED:
                inventory_item = entry["existing_inventory_item"]
                inventory_item.cost_price = entry["effective_cost_price"]
                inventory_item.updated_at = ts
                session.add(inventory_item)
                session.flush()
                inventory_lot = get_or_create_lot_for_inventory_item(
                    session,
                    inventory_item=inventory_item,
                    product=product,
                    effective_cost_price=entry["effective_cost_price"],
                    conversion_qty=product.default_conversion_qty,
                    ts=ts,
                )
                add_stock_movement(
                    session,
                    item_id=int(inventory_item.id),
                    delta=0,
                    reason="PURCHASE_LINK",
                    ref_type="PURCHASE",
                    ref_id=int(purchase.id),
                    note=f"Linked existing inventory to purchase {purchase.invoice_number}",
                    ts=purchase_stock_ts,
                )
            else:
                inventory_item = Item(
                    name=product.name,
                    brand=product.brand,
                    product_id=product.id,
                    category_id=product.category_id,
                    expiry_date=entry["expiry_date"],
                    mrp=entry["mrp"],
                    cost_price=entry["effective_cost_price"],
                    stock=total_qty,
                    rack_number=entry["rack_number"],
                    is_archived=False,
                    created_at=ts,
                    updated_at=ts,
                )
                session.add(inventory_item)
                session.flush()
                add_stock_movement(
                    session,
                    item_id=int(inventory_item.id),
                    delta=total_qty,
                    reason="PURCHASE",
                    ref_type="PURCHASE",
                    ref_id=int(purchase.id),
                    note=f"Purchase {purchase.invoice_number}",
                    ts=purchase_stock_ts,
                )
                inventory_lot = create_inventory_lot(
                    session,
                    product=product,
                    inventory_item=inventory_item,
                    expiry_date=entry["expiry_date"],
                    rack_number=entry["rack_number"],
                    total_qty=total_qty,
                    effective_cost_price=entry["effective_cost_price"],
                    mrp=entry["mrp"],
                    conversion_qty=product.default_conversion_qty,
                    ts=ts,
                )

            session.add(
                PurchaseItem(
                    purchase_id=purchase.id,
                    product_id=product.id,
                    inventory_item_id=inventory_item.id,
                    lot_id=inventory_lot.id,
                    stock_source=stock_source,
                    product_name=product.name,
                    brand=product.brand,
                    expiry_date=entry["expiry_date"],
                    rack_number=entry["rack_number"],
                    sealed_qty=entry["sealed_qty"],
                    free_qty=entry["free_qty"],
                    cost_price=entry["cost_price"],
                    effective_cost_price=entry["effective_cost_price"],
                    mrp=entry["mrp"],
                    gst_percent=entry["gst_percent"],
                    discount_amount=entry["discount_amount"],
                    rounding_adjustment=entry["rounding_adjustment"],
                    line_total=entry["line_total"],
                )
            )

        purchase.subtotal_amount = subtotal_amount
        session.flush()
        purchase.gst_amount = purchase_gst_amount(
            subtotal_amount,
            purchase.discount_amount,
            get_purchase_items(session, int(purchase.id)),
        )
        purchase.total_amount = round2(
            float(subtotal_amount or 0)
            - float(purchase.discount_amount or 0)
            + float(purchase.gst_amount or 0)
            + float(purchase.rounding_adjustment or 0)
        )
        if float(purchase.paid_amount or 0) + float(purchase.writeoff_amount or 0) > float(purchase.total_amount or 0) + 0.0001:
            raise HTTPException(status_code=400, detail="Edited items reduce total below settled amount")

        session.add(purchase)
        session.flush()
        log_audit(
            session,
            entity_type="PURCHASE",
            entity_id=int(purchase.id),
            action="UPDATE_ITEMS",
            note=f"Replaced items on purchase #{purchase.id}",
            details={"before": before_snapshot, "after": purchase_snapshot(session, purchase)},
        )
        session.commit()
        recompute_purchase_payment_state(session, purchase)
        supplier = ensure_supplier(session, purchase.party_id)
        sync_purchase_vouchers(session, purchase, supplier)
        session.commit()
        session.refresh(purchase)
        return make_purchase_out(session, purchase)


@router.post("/{purchase_id}/cancel", response_model=PurchaseOut)
def cancel_purchase(purchase_id: int) -> PurchaseOut:
    require_min_role("MANAGER", context="Purchase cancel")
    with get_session() as session:
        purchase = session.get(Purchase, purchase_id)
        if not purchase or purchase.is_deleted:
            raise HTTPException(status_code=404, detail="Purchase not found")
        assert_purchase_has_no_active_returns(session, purchase_id, context="Purchase cancel")
        assert_financial_year_unlocked(session, purchase.invoice_date, context="Purchase cancel")
        before_snapshot = purchase_snapshot(session, purchase)

        purchase_stock_ts = f"{purchase.invoice_date}T00:00:00"
        items = get_purchase_items(session, purchase_id)
        for item in items:
            qty = purchase_item_total_qty(item)
            if purchase_item_stock_source(item) == STOCK_SOURCE_ATTACHED:
                if not item.inventory_item_id:
                    raise HTTPException(status_code=400, detail=f"Purchase item #{item.id} is missing stock linkage")
                inventory_item = session.get(Item, item.inventory_item_id)
                if not inventory_item:
                    raise HTTPException(status_code=400, detail=f"Inventory item #{item.inventory_item_id} not found")
                add_stock_movement(
                    session,
                    item_id=int(inventory_item.id),
                    delta=0,
                    reason="PURCHASE_LINK_CANCEL",
                    ref_type="PURCHASE",
                    ref_id=int(purchase.id),
                    note=f"Cancelled existing inventory link for purchase {purchase.invoice_number}",
                    ts=purchase_stock_ts,
                )
            else:
                inventory_item = assert_purchase_item_untouched(session, item)
                inventory_item.stock = 0
                inventory_item.is_archived = True
                inventory_item.updated_at = now_ts()
                session.add(inventory_item)
                if item.lot_id:
                    lot = session.get(InventoryLot, item.lot_id)
                    if lot:
                        lot.sealed_qty = 0
                        lot.loose_qty = 0
                        lot.is_active = False
                        lot.updated_at = inventory_item.updated_at
                        session.add(lot)
                add_stock_movement(
                    session,
                    item_id=int(inventory_item.id),
                    delta=-qty,
                    reason="PURCHASE_CANCEL",
                    ref_type="PURCHASE",
                    ref_id=int(purchase.id),
                    note=f"Cancelled purchase {purchase.invoice_number}",
                    ts=purchase_stock_ts,
                )

        purchase.is_deleted = True
        purchase.deleted_at = now_ts()
        purchase.updated_at = purchase.deleted_at
        session.add(purchase)
        session.flush()
        log_audit(
            session,
            entity_type="PURCHASE",
            entity_id=int(purchase.id),
            action="DELETE",
            note=f"Cancelled purchase #{purchase.id}",
            details={"before": before_snapshot, "after": purchase_snapshot(session, purchase)},
        )
        session.commit()
        mark_voucher_deleted(session, source_type="PURCHASE", source_id=int(purchase.id))
        payments = session.exec(select(PurchasePayment).where(PurchasePayment.purchase_id == purchase.id)).all()
        for payment in payments:
            source_type = "PURCHASE_WRITEOFF" if bool(payment.is_writeoff) else "PURCHASE_PAYMENT"
            mark_voucher_deleted(session, source_type=source_type, source_id=int(payment.id or 0))
        session.commit()
        session.refresh(purchase)
        return make_purchase_out(session, purchase)


@router.get("/supplier-summary/{party_id}", response_model=SupplierLedgerSummary)
def supplier_summary(party_id: int) -> SupplierLedgerSummary:
    with get_session() as session:
        ensure_supplier(session, party_id)
        rows = session.exec(
            select(Purchase).where(Purchase.party_id == party_id, Purchase.is_deleted == False)  # noqa: E712
        ).all()
        total_purchases = round2(sum(float(row.total_amount or 0) for row in rows))
        total_returns = round2(session.exec(
            select(func.coalesce(func.sum(PurchaseReturn.total_amount), 0)).where(
                PurchaseReturn.party_id == party_id,
                PurchaseReturn.is_deleted == False,  # noqa: E712
            )
        ).one() or 0)
        payments = session.exec(
            select(PurchasePayment).where(
                PurchasePayment.party_id == party_id,
                PurchasePayment.is_deleted == False,  # noqa: E712
            )
        ).all()
        active_payments: List[PurchasePayment] = []
        for payment in payments:
            if int(payment.purchase_id or 0) > 0:
                purchase = session.get(Purchase, payment.purchase_id)
                if not purchase or purchase.is_deleted:
                    continue
            active_payments.append(payment)
        total_paid = round2(sum(float(row.amount or 0) for row in active_payments if not bool(row.is_writeoff)))
        total_writeoff = round2(sum(float(row.amount or 0) for row in active_payments if bool(row.is_writeoff)))
        outstanding = round2(total_purchases - total_returns - total_paid - total_writeoff)
        return SupplierLedgerSummary(
            party_id=party_id,
            total_purchases=total_purchases,
            total_paid=total_paid,
            total_writeoff=total_writeoff,
            total_returns=total_returns,
            outstanding_amount=outstanding,
        )
