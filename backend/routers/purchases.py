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
    PurchaseUpdate,
    StockMovement,
    SupplierLedgerSummary,
)
from backend.security import require_min_role

router = APIRouter()


class PurchaseItemsReplace(SQLModel):
    items: List[PurchaseItemIn]


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


def add_stock_movement(
    session,
    *,
    item_id: int,
    delta: int,
    reason: str,
    ref_type: Optional[str],
    ref_id: Optional[int],
    note: Optional[str],
) -> None:
    session.add(
        StockMovement(
            item_id=int(item_id),
            ts=now_ts(),
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
                raise HTTPException(status_code=400, detail="cost_price cannot be negative")
            if round2(raw.mrp) < 0:
                raise HTTPException(status_code=400, detail="mrp cannot be negative")

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
            line_total = round2((qty * float(raw.cost_price or 0)) - float(raw.discount_amount or 0))
            total_qty = qty + free_qty
            effective_cost = round2(line_total / total_qty) if total_qty > 0 else round2(raw.cost_price)
            subtotal_amount = round2(subtotal_amount + line_total)
            prepared_items.append(
                {
                    "product": product,
                    "expiry_date": clean_date(raw.expiry_date),
                    "rack_number": rack_number,
                    "sealed_qty": qty,
                    "free_qty": free_qty,
                    "cost_price": round2(raw.cost_price),
                    "effective_cost_price": effective_cost,
                    "mrp": round2(raw.mrp),
                    "gst_percent": round2(raw.gst_percent),
                    "discount_amount": round2(raw.discount_amount),
                    "line_total": line_total,
                }
            )

        discount_amount = round2(payload.discount_amount)
        gst_amount = round2(payload.gst_amount)
        rounding_adjustment = round2(payload.rounding_adjustment)
        total_amount = round2(subtotal_amount - discount_amount + gst_amount + rounding_adjustment)
        if total_amount < 0:
            raise HTTPException(status_code=400, detail="Purchase total cannot be negative")

        paid_amount = 0.0
        writeoff_amount = 0.0
        for payment in payload.payments:
            amount = round2(payment.amount)
            if amount <= 0:
                raise HTTPException(status_code=400, detail="Payment amount must be greater than 0")
            if payment.is_writeoff:
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
                line_total=entry["line_total"],
            )
            session.add(purchase_item)

        payment_ts = f"{invoice_date}T00:00:00"
        for payment in payload.payments:
            payment_row = PurchasePayment(
                purchase_id=purchase.id,
                paid_at=payment_ts,
                amount=round2(payment.amount),
                note=clean_text(payment.note),
                is_writeoff=bool(payment.is_writeoff),
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
        if "gst_amount" in data:
            row.gst_amount = round2(data["gst_amount"])
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


@router.post("/{purchase_id}/payments", response_model=PurchaseOut)
def add_purchase_payment(purchase_id: int, payload: PurchasePaymentCreate) -> PurchaseOut:
    amount = round2(payload.amount)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="amount must be greater than 0")

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
            amount=amount,
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
            line_total = round2((qty * float(raw.cost_price or 0)) - float(raw.discount_amount or 0))
            total_qty = qty + free_qty
            effective_cost = round2(line_total / total_qty) if total_qty > 0 else round2(raw.cost_price)
            subtotal_amount = round2(subtotal_amount + line_total)
            prepared_items.append(
                {
                    "product": product,
                    "expiry_date": clean_date(raw.expiry_date),
                    "rack_number": rack_number,
                    "sealed_qty": qty,
                    "free_qty": free_qty,
                    "cost_price": round2(raw.cost_price),
                    "effective_cost_price": effective_cost,
                    "mrp": round2(raw.mrp),
                    "gst_percent": round2(raw.gst_percent),
                    "discount_amount": round2(raw.discount_amount),
                    "line_total": line_total,
                }
            )

        for purchase_item, inventory_item in touched:
            purchase_item_qty = purchase_item_total_qty(purchase_item)
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
            )
            session.delete(purchase_item)

        session.flush()
        ts = now_ts()
        for entry in prepared_items:
            product: Product = entry["product"]
            total_qty = int(entry["sealed_qty"]) + int(entry["free_qty"])
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
                    line_total=entry["line_total"],
                )
            )

        purchase.subtotal_amount = subtotal_amount
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

        items = get_purchase_items(session, purchase_id)
        for item in items:
            inventory_item = assert_purchase_item_untouched(session, item)
            qty = purchase_item_total_qty(item)
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
