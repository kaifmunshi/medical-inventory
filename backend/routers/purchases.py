from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func
from sqlmodel import SQLModel, select

from backend.accounting import mark_voucher_deleted, post_purchase_payment_voucher, sync_purchase_vouchers
from backend.controls import assert_financial_year_unlocked, log_audit
from backend.db import get_session
from backend.models import (
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
    PurchaseUpdate,
    StockMovement,
    SupplierLedgerSummary,
)
from backend.security import require_min_role

router = APIRouter()


class PurchaseItemsReplace(SQLModel):
    items: List[PurchaseItemIn]


class SupplierPaymentAllocationIn(SQLModel):
    purchase_id: int
    amount: float


class SupplierPaymentCreate(SQLModel):
    mode: str = "cash"
    cash_amount: float = 0.0
    online_amount: float = 0.0
    note: Optional[str] = None
    payment_date: Optional[str] = None
    is_writeoff: bool = False
    allocations: List[SupplierPaymentAllocationIn]


STOCK_SOURCE_CREATED = "CREATED"
STOCK_SOURCE_ATTACHED = "ATTACHED"


def now_ts() -> str:
    return datetime.now().isoformat(timespec="seconds")


def clean_text(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    text = " ".join(str(v).strip().split())
    return text or None


def clean_date(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    text = str(v).strip()
    if not text:
        return None
    if len(text) != 10:
        raise HTTPException(status_code=400, detail="Dates must be YYYY-MM-DD")
    return text


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


def ensure_supplier(session, party_id: int) -> Party:
    row = session.get(Party, party_id)
    if not row or not row.is_active:
        raise HTTPException(status_code=400, detail="Supplier not found")
    if row.party_group != "SUNDRY_CREDITOR":
        raise HTTPException(status_code=400, detail="party_id must belong to a supplier")
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
    existing = session.exec(
        select(Product).where(
            func.lower(Product.name) == name.lower(),
            func.lower(func.coalesce(Product.brand, "")) == (normalized_brand or "").lower(),
        )
    ).first()
    if existing:
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


def make_purchase_out(session, row: Purchase) -> PurchaseOut:
    items = session.exec(select(PurchaseItem).where(PurchaseItem.purchase_id == row.id).order_by(PurchaseItem.id.asc())).all()
    payments = session.exec(
        select(PurchasePayment).where(PurchasePayment.purchase_id == row.id).order_by(PurchasePayment.id.asc())
    ).all()
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
    )


def purchase_item_total_qty(item: PurchaseItem) -> int:
    return int(item.sealed_qty or 0) + int(item.free_qty or 0)


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
    if covered <= 0:
        purchase.payment_status = "UNPAID"
    elif covered + 0.0001 < float(purchase.total_amount or 0):
        purchase.payment_status = "PARTIAL"
    else:
        purchase.payment_status = "PAID"
    purchase.updated_at = now_ts()
    session.add(purchase)
    session.commit()


def purchase_payment_source_type(payment: PurchasePayment) -> str:
    return "PURCHASE_WRITEOFF" if bool(payment.is_writeoff) else "PURCHASE_PAYMENT"


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
            qty = int(raw.sealed_qty or 0)
            if qty <= 0:
                raise HTTPException(status_code=400, detail="sealed_qty must be greater than 0")
            free_qty = int(raw.free_qty or 0)
            if free_qty < 0:
                raise HTTPException(status_code=400, detail="free_qty cannot be negative")
            if round2(raw.cost_price) < 0:
                raise HTTPException(status_code=400, detail="rate cannot be negative")
            if round2(raw.mrp) < 0:
                raise HTTPException(status_code=400, detail="mrp cannot be negative")

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
            total_qty = qty + free_qty
            effective_cost = round2(line_total / total_qty) if total_qty > 0 else round2(raw.cost_price)
            subtotal_amount = round2(subtotal_amount + line_total)
            prepared_items.append(
                {
                    "product": product,
                    "existing_inventory_item": existing_inventory_item,
                    "stock_source": stock_source,
                    "expiry_date": clean_date(raw.expiry_date),
                    "rack_number": rack_number,
                    "sealed_qty": qty,
                    "free_qty": free_qty,
                    "cost_price": round2(raw.cost_price),
                    "effective_cost_price": effective_cost,
                    "mrp": round2(raw.mrp),
                    "gst_percent": 0.0,
                    "discount_amount": round2(raw.discount_amount),
                    "rounding_adjustment": line_rounding,
                    "line_total": line_total,
                }
            )

        discount_amount = round2(payload.discount_amount)
        gst_amount = 0.0
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
            prepared_payments.append(
                {
                    "mode": mode,
                    "amount": amount,
                    "cash_amount": cash_amount,
                    "online_amount": online_amount,
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

        if paid_amount + writeoff_amount <= 0:
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
            if stock_source == STOCK_SOURCE_ATTACHED:
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
                paid_at=payment["paid_at"],
                mode=payment["mode"],
                amount=payment["amount"],
                cash_amount=payment["cash_amount"],
                online_amount=payment["online_amount"],
                note=payment["note"],
                is_writeoff=bool(payment["is_writeoff"]),
                is_deleted=False,
                deleted_at=None,
            )
            session.add(payment_row)

        log_audit(
            session,
            entity_type="PURCHASE",
            entity_id=int(purchase.id),
            action="CREATE",
            note=f"Created purchase #{purchase.id}",
            details={"invoice_number": purchase.invoice_number, "total_amount": purchase.total_amount, "party_id": purchase.party_id},
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
            )
        session.commit()
        return make_purchase_out(session, purchase)


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


@router.get("/{purchase_id}", response_model=PurchaseOut)
def get_purchase(purchase_id: int) -> PurchaseOut:
    with get_session() as session:
        row = session.get(Purchase, purchase_id)
        if not row or row.is_deleted:
            raise HTTPException(status_code=404, detail="Purchase not found")
        return make_purchase_out(session, row)


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
            outstanding = round2(float(row.total_amount or 0) - float(row.paid_amount or 0) - float(row.writeoff_amount or 0))
            out.append(
                PurchaseLedgerRow(
                    purchase_id=row.id,
                    invoice_number=row.invoice_number,
                    invoice_date=row.invoice_date,
                    total_amount=row.total_amount,
                    paid_amount=row.paid_amount,
                    writeoff_amount=row.writeoff_amount,
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
        assert_financial_year_unlocked(session, row.invoice_date, context="Purchase update")

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
            row.invoice_date = invoice_date
        if "notes" in data:
            row.notes = clean_text(data["notes"])
        if "discount_amount" in data:
            row.discount_amount = round2(data["discount_amount"])
        row.gst_amount = 0.0
        if "rounding_adjustment" in data:
            row.rounding_adjustment = round2(data["rounding_adjustment"])

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
        log_audit(
            session,
            entity_type="PURCHASE",
            entity_id=int(row.id),
            action="UPDATE",
            note=f"Updated purchase #{row.id}",
            details={"invoice_number": row.invoice_number, "total_amount": row.total_amount, "party_id": row.party_id},
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
    if not payload.allocations:
        raise HTTPException(status_code=400, detail="At least one purchase allocation is required")

    allocation_map: Dict[int, float] = {}
    for allocation in payload.allocations:
        purchase_id = int(allocation.purchase_id or 0)
        amount = round2(allocation.amount)
        if purchase_id <= 0:
            raise HTTPException(status_code=400, detail="purchase_id is required")
        if amount <= 0:
            raise HTTPException(status_code=400, detail="Allocation amounts must be greater than 0")
        allocation_map[purchase_id] = round2(allocation_map.get(purchase_id, 0.0) + amount)

    allocation_total = round2(sum(allocation_map.values()))
    mode, total_amount, cash_amount, online_amount = normalize_payment_mode(
        payload.mode,
        allocation_total,
        payload.cash_amount,
        payload.online_amount,
        bool(payload.is_writeoff),
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
                float(row.total_amount or 0)
                - float(row.paid_amount or 0)
                - float(row.writeoff_amount or 0)
            )
            if amount > outstanding + 0.0001:
                raise HTTPException(status_code=400, detail=f"Allocation for purchase {purchase_id} exceeds outstanding amount")

        cash_remaining = cash_amount
        online_remaining = online_amount
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

            payment = PurchasePayment(
                purchase_id=row.id,
                paid_at=payment_ts,
                mode=mode,
                amount=amount,
                cash_amount=cash_share,
                online_amount=online_share,
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
            )
            log_audit(
                session,
                entity_type="PURCHASE_PAYMENT",
                entity_id=int(payment.id),
                action="CREATE",
                note=f"Added supplier payment to purchase #{row.id}",
                details={"purchase_id": row.id, "amount": payment.amount, "mode": payment.mode, "is_writeoff": bool(payment.is_writeoff)},
            )
            cash_remaining = round2(cash_remaining - cash_share)
            online_remaining = round2(online_remaining - online_share)

        session.commit()
        return [make_purchase_out(session, purchases_by_id[purchase_id]) for purchase_id, _amount in allocations]


@router.post("/{purchase_id}/payments", response_model=PurchaseOut)
def add_purchase_payment(purchase_id: int, payload: PurchasePaymentCreate) -> PurchaseOut:
    mode, amount, cash_amount, online_amount = normalize_payment_mode(
        payload.mode,
        payload.amount,
        payload.cash_amount,
        payload.online_amount,
        bool(payload.is_writeoff),
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
        if projected > float(row.total_amount or 0) + 0.0001:
            raise HTTPException(status_code=400, detail="Payment exceeds outstanding amount")

        payment = PurchasePayment(
            purchase_id=row.id,
            paid_at=paid_at,
            mode=mode,
            amount=amount,
            cash_amount=cash_amount,
            online_amount=online_amount,
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

        active_payments = session.exec(
            select(PurchasePayment).where(
                PurchasePayment.purchase_id == row.id,
                PurchasePayment.is_deleted == False,  # noqa: E712
                PurchasePayment.id != payment.id,
            )
        ).all()
        settled_elsewhere = round2(sum(float(p.amount or 0) for p in active_payments))
        if settled_elsewhere + amount > float(row.total_amount or 0) + 0.0001:
            raise HTTPException(status_code=400, detail="Payment exceeds outstanding amount")

        payment.paid_at = next_paid_at
        payment.mode = mode
        payment.amount = amount
        payment.cash_amount = cash_amount
        payment.online_amount = online_amount
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
            details={"purchase_id": row.id, "amount": payment.amount, "is_writeoff": bool(payment.is_writeoff)},
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
        if settled_active + float(payment.amount or 0) > float(row.total_amount or 0) + 0.0001:
            raise HTTPException(status_code=400, detail="Restored payment exceeds purchase total")

        payment.is_deleted = False
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
        assert_financial_year_unlocked(session, purchase.invoice_date, context="Purchase item replacement")

        existing_items = get_purchase_items(session, purchase_id)
        touched: List[tuple[PurchaseItem, Item]] = []
        for item in existing_items:
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
            qty = int(raw.sealed_qty or 0)
            if qty <= 0:
                raise HTTPException(status_code=400, detail="sealed_qty must be greater than 0")
            free_qty = int(raw.free_qty or 0)
            if free_qty < 0:
                raise HTTPException(status_code=400, detail="free_qty cannot be negative")
            if round2(raw.cost_price) < 0:
                raise HTTPException(status_code=400, detail="rate cannot be negative")

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
            total_qty = qty + free_qty
            effective_cost = round2(line_total / total_qty) if total_qty > 0 else round2(raw.cost_price)
            subtotal_amount = round2(subtotal_amount + line_total)
            prepared_items.append(
                {
                    "product": product,
                    "existing_inventory_item": existing_inventory_item,
                    "stock_source": stock_source,
                    "expiry_date": clean_date(raw.expiry_date),
                    "rack_number": rack_number,
                    "sealed_qty": qty,
                    "free_qty": free_qty,
                    "cost_price": round2(raw.cost_price),
                    "effective_cost_price": effective_cost,
                    "mrp": round2(raw.mrp),
                    "gst_percent": 0.0,
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
            if stock_source == STOCK_SOURCE_ATTACHED:
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
        purchase.gst_amount = 0.0
        purchase.total_amount = round2(
            float(subtotal_amount or 0)
            - float(purchase.discount_amount or 0)
            + float(purchase.gst_amount or 0)
            + float(purchase.rounding_adjustment or 0)
        )
        if float(purchase.paid_amount or 0) + float(purchase.writeoff_amount or 0) > float(purchase.total_amount or 0) + 0.0001:
            raise HTTPException(status_code=400, detail="Edited items reduce total below received amount")

        session.add(purchase)
        log_audit(
            session,
            entity_type="PURCHASE",
            entity_id=int(purchase.id),
            action="UPDATE_ITEMS",
            note=f"Replaced items on purchase #{purchase.id}",
            details={"total_amount": purchase.total_amount, "item_count": len(payload.items)},
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
        assert_financial_year_unlocked(session, purchase.invoice_date, context="Purchase cancel")

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
        log_audit(
            session,
            entity_type="PURCHASE",
            entity_id=int(purchase.id),
            action="DELETE",
            note=f"Cancelled purchase #{purchase.id}",
            details={"invoice_number": purchase.invoice_number},
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
        total_paid = round2(sum(float(row.paid_amount or 0) for row in rows))
        total_writeoff = round2(sum(float(row.writeoff_amount or 0) for row in rows))
        outstanding = round2(total_purchases - total_paid - total_writeoff)
        return SupplierLedgerSummary(
            party_id=party_id,
            total_purchases=total_purchases,
            total_paid=total_paid,
            total_writeoff=total_writeoff,
            outstanding_amount=outstanding,
        )
