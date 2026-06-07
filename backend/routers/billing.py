# F:\medical-inventory\backend\routers\billing.py

from fastapi import APIRouter, HTTPException, Query
from typing import List, Optional, Dict, Any
from datetime import datetime
from pydantic import BaseModel
from sqlmodel import select
from sqlalchemy import or_, exists, func, cast
from sqlalchemy.types import Integer, Float
from backend.accounting import mark_voucher_deleted, post_bill_payment_voucher, post_party_receipt_voucher, sync_bill_vouchers
from backend.controls import assert_financial_year_unlocked
from backend.utils.archive_rules import apply_archive_rules
from backend.db import get_session
from backend.models import (
    Item, Bill, BillItem, BillPayment,
    BillCreate, BillOut, BillItemOut,
    Customer, Party, PartyReceipt, ReceiptBillAdjustment,
    StockMovement,  # ✅ NEW
)
from backend.inventory_lot_sync import item_stock_kind, item_stock_meta, sync_lot_quantity_for_item
from backend.security import require_min_role

router = APIRouter()


# -------------------- Safe helpers --------------------

def round2(x: float) -> float:
    return float(f"{x:.2f}")


def as_f(x: Any) -> float:
    """
    Safe float conversion: None -> 0.0, "12" -> 12.0
    Prevents future crashes due to missing numeric fields.
    """
    try:
        if x is None:
            return 0.0
        return float(x)
    except Exception:
        return 0.0


def as_i(x: Any) -> int:
    try:
        if x is None:
            return 0
        return int(x)
    except Exception:
        return 0


def bill_line_unit_price(line: Any, item: Item) -> float:
    raw = getattr(line, "custom_unit_price", None)
    if raw is None:
        return round2(as_f(getattr(item, "mrp", 0.0)))
    price = round2(as_f(raw))
    if price < 0:
        raise HTTPException(status_code=400, detail="custom_unit_price cannot be negative")
    return price


def iso_date(s: Optional[str]) -> str:
    """
    Extract YYYY-MM-DD from an ISO string safely.
    """
    if not s:
        return ""
    ss = str(s)
    return ss[:10] if len(ss) >= 10 else ss


def now_ts() -> str:
    return datetime.now().isoformat(timespec="seconds")


def normalize_bill_ts(raw: Optional[str], fallback: str) -> str:
    if not raw:
        return fallback
    s = str(raw).strip()
    if not s:
        return fallback
    s = s.replace(" ", "T")
    try:
        dt = datetime.fromisoformat(s)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid date_time. Use ISO format.")
    return dt.isoformat(timespec="seconds")


def normalize_payment_ts(raw: Optional[str], fallback: str) -> str:
    if not raw:
        return fallback
    s = str(raw).strip().replace(" ", "T")
    if not s:
        return fallback
    if len(s) == 10:
        s = f"{s}T00:00:00"
    try:
        dt = datetime.fromisoformat(s)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid payment_date. Use YYYY-MM-DD or ISO format.")
    return dt.isoformat(timespec="seconds")


def is_deleted_bill(b: Bill) -> bool:
    return bool(getattr(b, "is_deleted", False))


def normalize_name(v: Optional[str]) -> str:
    return " ".join(str(v or "").strip().split())


def resolve_bill_party_links(session, *, customer_id: Optional[int], party_id: Optional[int], notes: Optional[str]) -> tuple[Optional[int], Optional[int]]:
    cid = int(customer_id) if customer_id is not None and int(customer_id or 0) > 0 else None
    pid = int(party_id) if party_id is not None and int(party_id or 0) > 0 else None

    if cid:
        customer = session.get(Customer, cid)
        if not customer:
            raise HTTPException(status_code=400, detail="Customer not found")
        party = session.exec(
            select(Party).where(
                Party.party_group == "SUNDRY_DEBTOR",
                Party.legacy_customer_id == cid,
            )
        ).first()
        if not party:
            name = normalize_name(customer.name)
            if name:
                party = session.exec(
                    select(Party).where(
                        Party.party_group == "SUNDRY_DEBTOR",
                        func.lower(func.trim(func.coalesce(Party.name, ""))) == name.lower(),
                    )
                ).first()
        if not party:
            party = Party(
                name=normalize_name(customer.name) or f"Customer #{cid}",
                party_group="SUNDRY_DEBTOR",
                phone=getattr(customer, "phone", None),
                address_line=getattr(customer, "address_line", None),
                opening_balance=0.0,
                opening_balance_type="DR",
                legacy_customer_id=cid,
                is_active=True,
                created_at=now_ts(),
                updated_at=now_ts(),
            )
            session.add(party)
            session.flush()
        elif getattr(party, "legacy_customer_id", None) is None:
            party.legacy_customer_id = cid
            party.updated_at = now_ts()
            session.add(party)
            session.flush()
        return cid, int(party.id)

    if pid:
        party = session.get(Party, pid)
        if not party or party.party_group != "SUNDRY_DEBTOR":
            raise HTTPException(status_code=400, detail="Debtor party not found")
        return getattr(party, "legacy_customer_id", None), int(party.id)

    note_lines = str(notes or "").splitlines()
    first = note_lines[0].strip() if note_lines else ""
    if first.lower().startswith("customer:"):
        name = normalize_name(first.split(":", 1)[1].split("|", 1)[0])
        if name:
            party = session.exec(
                select(Party).where(
                    Party.party_group == "SUNDRY_DEBTOR",
                    func.lower(func.trim(func.coalesce(Party.name, ""))) == name.lower(),
                )
            ).first()
            if party:
                return getattr(party, "legacy_customer_id", None), int(party.id)

    return None, None


def active_bill_payments_query(bill_id: int):
    return select(BillPayment).where(BillPayment.bill_id == bill_id, BillPayment.is_deleted == False)  # noqa: E712


def bill_outstanding_amount(bill: Bill) -> float:
    total_amount = round2(as_f(bill.total_amount))
    covered = round2(as_f(bill.paid_amount) + as_f(getattr(bill, "writeoff_amount", 0.0)))
    return round2(max(0.0, total_amount - covered))


def recalculate_bill_payment_state(session, bill: Bill) -> Dict[str, Any]:
    pays = session.exec(active_bill_payments_query(bill.id)).all()

    receipt_pays = [x for x in pays if not bool(getattr(x, "is_writeoff", False))]
    writeoff_pays = [x for x in pays if bool(getattr(x, "is_writeoff", False))]

    total_cash = round2(sum(as_f(x.cash_amount) for x in receipt_pays))
    total_online = round2(sum(as_f(x.online_amount) for x in receipt_pays))
    total_paid = round2(total_cash + total_online)
    total_writeoff = round2(sum(as_f(getattr(x, "writeoff_amount", 0.0)) for x in writeoff_pays))
    total_amount = round2(as_f(bill.total_amount))
    covered_total = round2(total_paid + total_writeoff)

    bill.payment_cash = total_cash
    bill.payment_online = total_online
    bill.paid_amount = total_paid
    bill.writeoff_amount = total_writeoff

    if total_amount <= 0:
        bill.payment_status = "PAID"
        bill.paid_at = bill.paid_at or getattr(bill, "date_time", None)
        bill.is_credit = False
    elif covered_total <= 0:
        bill.payment_status = "UNPAID"
        bill.paid_at = None
        bill.is_credit = True
    elif covered_total + 0.0001 < total_amount:
        bill.payment_status = "PARTIAL"
        bill.paid_at = None
        bill.is_credit = True
    else:
        bill.payment_status = "PAID"
        latest_paid_at = max((str(p.received_at or "") for p in pays), default="")
        bill.paid_at = latest_paid_at or None
        bill.is_credit = False

    return {
        "bill_id": bill.id,
        "payment_status": bill.payment_status,
        "paid_amount": bill.paid_amount,
        "writeoff_amount": bill.writeoff_amount,
        "total_amount": bill.total_amount,
        "pending_amount": round2(max(0.0, total_amount - covered_total)),
    }


def receipt_adjustment_for_payment(session, payment_id: int) -> Optional[ReceiptBillAdjustment]:
    return session.exec(
        select(ReceiptBillAdjustment)
        .where(ReceiptBillAdjustment.bill_payment_id == int(payment_id))
        .limit(1)
    ).first()


def active_receipt_adjusted_total(session, receipt_id: int, *, exclude_adjustment_id: Optional[int] = None) -> float:
    adjustments = session.exec(
        select(ReceiptBillAdjustment).where(ReceiptBillAdjustment.receipt_id == int(receipt_id))
    ).all()
    total = 0.0
    for adjustment in adjustments:
        if exclude_adjustment_id is not None and int(adjustment.id or 0) == int(exclude_adjustment_id):
            continue
        if adjustment.bill_payment_id is not None:
            payment = session.get(BillPayment, int(adjustment.bill_payment_id))
            if payment and bool(getattr(payment, "is_deleted", False)):
                continue
        total += as_f(adjustment.adjusted_amount)
    return round2(total)


def active_receipt_channel_totals(session, receipt_id: int, *, exclude_adjustment_id: Optional[int] = None) -> Dict[str, float]:
    adjustments = session.exec(
        select(ReceiptBillAdjustment).where(ReceiptBillAdjustment.receipt_id == int(receipt_id))
    ).all()
    cash = 0.0
    online = 0.0
    for adjustment in adjustments:
        if exclude_adjustment_id is not None and int(adjustment.id or 0) == int(exclude_adjustment_id):
            continue
        if adjustment.bill_payment_id is None:
            continue
        payment = session.get(BillPayment, int(adjustment.bill_payment_id))
        if not payment or bool(getattr(payment, "is_deleted", False)):
            continue
        cash += as_f(payment.cash_amount)
        online += as_f(payment.online_amount)
    return {"cash": round2(cash), "online": round2(online)}


def validate_receipt_payment_channels(session, adjustment: ReceiptBillAdjustment, cash: float, online: float) -> None:
    receipt = session.get(PartyReceipt, int(adjustment.receipt_id))
    if not receipt:
        raise HTTPException(status_code=400, detail="Customer receipt for this payment was not found")
    used = active_receipt_channel_totals(
        session,
        int(receipt.id),
        exclude_adjustment_id=int(adjustment.id or 0),
    )
    proposed_cash = round2(used["cash"] + cash)
    proposed_online = round2(used["online"] + online)
    if proposed_cash > round2(as_f(receipt.cash_amount)) + 0.0001:
        raise HTTPException(status_code=400, detail="Cash amount exceeds cash balance on the customer receipt")
    if proposed_online > round2(as_f(receipt.online_amount)) + 0.0001:
        raise HTTPException(status_code=400, detail="Online amount exceeds online balance on the customer receipt")


def sync_party_receipt_unallocated(session, receipt_id: int) -> None:
    receipt = session.get(PartyReceipt, int(receipt_id))
    if not receipt:
        return
    adjusted = active_receipt_adjusted_total(session, int(receipt.id))
    receipt.unallocated_amount = round2(max(0.0, as_f(receipt.total_amount) - adjusted))
    session.add(receipt)


def sync_receipt_adjustment_for_payment(session, payment: BillPayment, amount: float, *, restore_receipt: bool = False) -> None:
    adjustment = receipt_adjustment_for_payment(session, int(payment.id or 0))
    if not adjustment:
        return
    receipt = session.get(PartyReceipt, int(adjustment.receipt_id))
    if not receipt:
        return
    proposed = round2(amount)
    other_adjusted = active_receipt_adjusted_total(
        session,
        int(receipt.id),
        exclude_adjustment_id=int(adjustment.id or 0),
    )
    if proposed > 0 and other_adjusted + proposed > round2(as_f(receipt.total_amount)) + 0.0001:
        raise HTTPException(status_code=400, detail="Amount exceeds available amount on customer receipt")
    adjustment.adjusted_amount = proposed
    session.add(adjustment)
    if restore_receipt and bool(getattr(receipt, "is_deleted", False)):
        receipt.is_deleted = False
        receipt.deleted_at = None
        session.add(receipt)
    sync_party_receipt_unallocated(session, int(receipt.id))


def add_movement(
    session,
    *,
    item_id: int,
    delta: int,
    reason: str,
    ref_type: str,
    ref_id: int,
    note: Optional[str] = None,
):
    """
    Append-only inventory ledger row.
    +delta => stock IN, -delta => stock OUT.
    """
    session.add(
        StockMovement(
            item_id=int(item_id),
            ts=now_ts(),
            delta=int(delta),
            reason=str(reason),
            ref_type=str(ref_type),
            ref_id=int(ref_id),
            note=note,
        )
    )


def bill_item_to_out(session, row: BillItem) -> BillItemOut:
    item = session.get(Item, int(row.item_id or 0)) if row.item_id else None
    return BillItemOut(
        item_id=row.item_id,
        item_name=row.item_name,
        brand=(str(item.brand) if item and item.brand else None),
        batch_number=(str(item.id) if item and item.id else None),
        expiry_date=(str(item.expiry_date) if item and item.expiry_date else None),
        mrp=row.mrp,
        quantity=row.quantity,
        line_total=row.line_total,
        **item_stock_meta(session, int(row.item_id or 0)),
    )


# -------------------- Response Models --------------------

class BillPageOut(BaseModel):
    """
    ✅ Paginated response for reports/infinite scroll
    """
    items: List[BillOut]
    next_offset: Optional[int] = None

class ItemSalesRowOut(BaseModel):
    item_id: int
    item_name: str
    brand: Optional[str] = None
    is_loose_stock: bool = False
    stock_unit_label: Optional[str] = None
    qty_sold: int
    gross_sales: float
    last_sold_at: Optional[str] = None


class ItemSalesPageOut(BaseModel):
    items: List[ItemSalesRowOut]
    next_offset: Optional[int] = None


# -------------------- Bills list endpoints --------------------

@router.get("/", response_model=List[BillOut])
def list_bills(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)"),
    deleted_filter: str = Query("active", pattern="^(active|deleted|all)$")
):
    """
    Backward-compatible endpoint (returns plain array).
    Keep this as-is because other frontend screens may already rely on it.
    """
    with get_session() as session:
        stmt = select(Bill)
        if deleted_filter == "active":
            stmt = stmt.where(Bill.is_deleted == False)  # noqa: E712
        elif deleted_filter == "deleted":
            stmt = stmt.where(Bill.is_deleted == True)  # noqa: E712

        if from_date:
            stmt = stmt.where(Bill.date_time >= f"{from_date}T00:00:00")
        if to_date:
            stmt = stmt.where(Bill.date_time <= f"{to_date}T23:59:59")

        stmt = stmt.order_by(Bill.id.desc()).limit(limit).offset(offset)
        rows = session.exec(stmt).all()

        out: List[BillOut] = []
        for b in rows:
            items = session.exec(select(BillItem).where(BillItem.bill_id == b.id)).all()
            out.append(BillOut(
                id=b.id,
                date_time=b.date_time,
                customer_id=getattr(b, "customer_id", None),
                party_id=getattr(b, "party_id", None),
                discount_percent=b.discount_percent,
                subtotal=b.subtotal,
                total_amount=b.total_amount,
                payment_mode=b.payment_mode,
                payment_cash=b.payment_cash,
                payment_online=b.payment_online,
                notes=b.notes,

                # ✅ credit fields
                is_credit=b.is_credit,
                payment_status=b.payment_status,
                paid_amount=b.paid_amount,
                writeoff_amount=getattr(b, "writeoff_amount", 0.0),
                paid_at=b.paid_at,
                is_deleted=b.is_deleted,
                deleted_at=b.deleted_at,

                items=[bill_item_to_out(session, i) for i in items]
            ))
        return out


@router.get("/paged", response_model=BillPageOut)
def list_bills_paged(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)"),
    q: Optional[str] = Query(None, description="Search by id/item/notes"),
    deleted_filter: str = Query("active", pattern="^(active|deleted|all)$"),
    bill_filter: str = Query("all", pattern="^(all|credit|unmapped|unmapped_credit)$"),
):
    """
    ✅ Paged endpoint for Reports infinite scroll.
    """
    with get_session() as session:
        stmt = select(Bill)

        if deleted_filter == "active":
            stmt = stmt.where(Bill.is_deleted == False)  # noqa: E712
        elif deleted_filter == "deleted":
            stmt = stmt.where(Bill.is_deleted == True)  # noqa: E712

        # ✅ Date filtering in SQL (ISO strings compare correctly)
        if from_date:
            stmt = stmt.where(Bill.date_time >= f"{from_date}T00:00:00")
        if to_date:
            stmt = stmt.where(Bill.date_time <= f"{to_date}T23:59:59")

        if bill_filter in {"credit", "unmapped_credit"}:
            stmt = stmt.where(
                or_(
                    Bill.is_credit == True,  # noqa: E712
                    Bill.payment_status != "PAID",
                    func.lower(func.coalesce(Bill.payment_mode, "")) == "credit",
                )
            )

        if bill_filter in {"unmapped", "unmapped_credit"}:
            note = func.lower(func.ltrim(func.coalesce(Bill.notes, "")))
            stmt = stmt.where(
                (Bill.customer_id.is_(None) | (Bill.customer_id <= 0)),
                ~note.like("customer:%"),
            )

        # ✅ Search filter in SQL (id OR notes OR item_name)
        qq = (q or "").strip()
        if qq:
            like = f"%{qq.lower()}%"

            id_filter = None
            if qq.isdigit():
                id_filter = (Bill.id == int(qq))

            notes_match = func.lower(func.coalesce(Bill.notes, "")).like(like)

            items_match = exists().where(
                (BillItem.bill_id == Bill.id) &
                (func.lower(func.coalesce(BillItem.item_name, "")).like(like))
            )

            brand_match = exists().where(
                (BillItem.bill_id == Bill.id) &
                (BillItem.item_id == Item.id) &
                (func.lower(func.coalesce(Item.brand, "")).like(like))
            )

            if id_filter is not None:
                stmt = stmt.where(or_(id_filter, notes_match, items_match, brand_match))
            else:
                stmt = stmt.where(or_(notes_match, items_match, brand_match))

        # ✅ Order + accurate pagination (limit+1)
        stmt = stmt.order_by(Bill.id.desc()).limit(limit + 1).offset(offset)
        rows = session.exec(stmt).all()

        has_more = len(rows) > limit
        if has_more:
            rows = rows[:limit]

        out: List[BillOut] = []
        for b in rows:
            items = session.exec(select(BillItem).where(BillItem.bill_id == b.id)).all()
            out.append(BillOut(
                id=b.id,
                date_time=b.date_time,
                customer_id=getattr(b, "customer_id", None),
                party_id=getattr(b, "party_id", None),
                discount_percent=b.discount_percent,
                subtotal=b.subtotal,
                total_amount=b.total_amount,
                payment_mode=b.payment_mode,
                payment_cash=b.payment_cash,
                payment_online=b.payment_online,
                notes=b.notes,

                is_credit=b.is_credit,
                payment_status=b.payment_status,
                paid_amount=b.paid_amount,
                writeoff_amount=getattr(b, "writeoff_amount", 0.0),
                paid_at=b.paid_at,
                is_deleted=b.is_deleted,
                deleted_at=b.deleted_at,

                items=[bill_item_to_out(session, i) for i in items]
            ))

        next_offset = (offset + limit) if has_more else None
        return {"items": out, "next_offset": next_offset}


@router.get("/credit-pending-total")
def credit_pending_total():
    with get_session() as session:
        outstanding_expr = (
            func.coalesce(Bill.total_amount, 0)
            - func.coalesce(Bill.paid_amount, 0)
            - func.coalesce(Bill.writeoff_amount, 0)
        )
        total = session.exec(
            select(func.coalesce(func.sum(outstanding_expr), 0))
            .where(Bill.is_deleted == False)  # noqa: E712
            .where(Bill.payment_status != "PAID")
            .where(outstanding_expr > 0)
        ).first()
        return {"pending": round2(float(total or 0))}


@router.get("/reports/item-sales", response_model=ItemSalesPageOut)
def report_item_sales(
    from_date: str = Query(..., description="YYYY-MM-DD"),
    to_date: str = Query(..., description="YYYY-MM-DD (inclusive)"),
    q: Optional[str] = Query(None, description="Search by item name or brand"),
    deleted_filter: str = Query("active", pattern="^(active|deleted|all)$"),
    limit: int = Query(60, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """
    ✅ Items Sold Report (for re-order decisions)
    - Groups by (item_id + item_name + brand)
    - Sums quantity sold in bills
    - Filters by bill date_time
    - Supports search + pagination
    - Sorted by qty_sold DESC (top selling first)
    """

    start_ts = f"{from_date}T00:00:00"
    end_ts = f"{to_date}T23:59:59"

    qq = (q or "").strip().lower()
    like = f"%{qq}%"

    with get_session() as session:
        try:
            qty_expr = func.coalesce(func.sum(cast(BillItem.quantity, Integer)), 0)
            gross_expr = func.coalesce(
                func.sum(cast(BillItem.quantity, Float) * cast(BillItem.mrp, Float)),
                0
            )

            stmt = (
                select(
                    BillItem.item_id.label("item_id"),
                    func.coalesce(BillItem.item_name, "").label("item_name"),
                    func.nullif(func.trim(func.coalesce(Item.brand, "")), "").label("brand"),
                    qty_expr.label("qty_sold"),
                    gross_expr.label("gross_sales"),
                    func.max(Bill.date_time).label("last_sold_at"),
                )
                .select_from(BillItem)
                .join(Bill, Bill.id == BillItem.bill_id)
                .join(Item, Item.id == BillItem.item_id, isouter=True)
                .where(Bill.date_time >= start_ts)
                .where(Bill.date_time <= end_ts)
            )

            if deleted_filter == "active":
                stmt = stmt.where(Bill.is_deleted == False)  # noqa: E712
            elif deleted_filter == "deleted":
                stmt = stmt.where(Bill.is_deleted == True)  # noqa: E712

            if qq:
                stmt = stmt.where(
                    or_(
                        func.lower(func.coalesce(BillItem.item_name, "")).like(like),
                        func.lower(func.coalesce(Item.brand, "")).like(like),
                    )
                )

            stmt = (
                stmt.group_by(BillItem.item_id, BillItem.item_name, Item.brand)
                .order_by(
                    qty_expr.desc(),
                    func.coalesce(BillItem.item_name, "").asc(),
                    func.coalesce(Item.brand, "").asc(),
                )
                .limit(limit + 1)
                .offset(offset)
            )

            rows = session.exec(stmt).all()

            has_more = len(rows) > limit
            if has_more:
                rows = rows[:limit]

            out: List[ItemSalesRowOut] = []
            for r in rows:
                meta = item_stock_meta(session, int(r.item_id or 0))
                out.append(
                    ItemSalesRowOut(
                        item_id=int(r.item_id or 0),
                        item_name=str(r.item_name or ""),
                        brand=(str(r.brand) if r.brand else None),
                        is_loose_stock=bool(meta.get("is_loose_stock")),
                        stock_unit_label=meta.get("stock_unit_label"),
                        qty_sold=int(r.qty_sold or 0),
                        gross_sales=round2(as_f(r.gross_sales)),
                        last_sold_at=r.last_sold_at,
                    )
                )

            next_offset = (offset + limit) if has_more else None
            return {"items": out, "next_offset": next_offset}

        except Exception as e:
            # ✅ so Swagger + frontend can show the real reason
            raise HTTPException(status_code=500, detail=f"item-sales failed: {e}")


@router.get("/payments")
def list_payments(
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)"),
    limit: int = Query(500, ge=1, le=2000),
    offset: int = Query(0, ge=0),
    deleted_filter: str = Query("active", pattern="^(active|deleted|all)$"),
):
    with get_session() as session:
        stmt = (
            select(BillPayment, Bill)
            .join(Bill, Bill.id == BillPayment.bill_id)
            .where(BillPayment.is_deleted == False)  # noqa: E712
        )
        if deleted_filter == "active":
            stmt = stmt.where(Bill.is_deleted == False)  # noqa: E712
        elif deleted_filter == "deleted":
            stmt = stmt.where(Bill.is_deleted == True)  # noqa: E712

        if from_date:
            stmt = stmt.where(BillPayment.received_at >= f"{from_date}T00:00:00")
        if to_date:
            stmt = stmt.where(BillPayment.received_at <= f"{to_date}T23:59:59.999999")

        stmt = stmt.order_by(BillPayment.id.desc()).offset(offset).limit(limit)
        rows = session.exec(stmt).all()

        out: List[Dict[str, Any]] = []
        for p, b in rows:
            out.append({
                "id": p.id,
                "bill_id": p.bill_id,
                "bill_date_time": b.date_time,
                "received_at": p.received_at,
                "mode": p.mode,
                "cash_amount": round2(as_f(p.cash_amount)),
                "online_amount": round2(as_f(p.online_amount)),
                "writeoff_amount": round2(as_f(getattr(p, "writeoff_amount", 0.0))),
                "note": p.note,
                "is_writeoff": bool(getattr(p, "is_writeoff", False)),
                "is_deleted": bool(getattr(p, "is_deleted", False)),
                "deleted_at": getattr(p, "deleted_at", None),
            })
        return out


@router.get("/{bill_id}", response_model=BillOut)
def get_bill(bill_id: int):
    with get_session() as session:
        b = session.get(Bill, bill_id)
        if not b:
            raise HTTPException(status_code=404, detail="Bill not found")
        items = session.exec(select(BillItem).where(BillItem.bill_id == b.id)).all()
        return BillOut(
            id=b.id,
            date_time=b.date_time,
            customer_id=getattr(b, "customer_id", None),
            party_id=getattr(b, "party_id", None),
            discount_percent=b.discount_percent,
            subtotal=b.subtotal,
            total_amount=b.total_amount,
            payment_mode=b.payment_mode,
            payment_cash=b.payment_cash,
            payment_online=b.payment_online,
            notes=b.notes,

            is_credit=b.is_credit,
            payment_status=b.payment_status,
            paid_amount=b.paid_amount,
            writeoff_amount=getattr(b, "writeoff_amount", 0.0),
            paid_at=b.paid_at,
            is_deleted=b.is_deleted,
            deleted_at=b.deleted_at,

            items=[bill_item_to_out(session, i) for i in items]
        )


# -------------------- Create Bill --------------------

@router.post("/", response_model=BillOut, status_code=201)
def create_bill(payload: BillCreate):
    if not payload.items:
        raise HTTPException(status_code=400, detail="Bill must have at least one item")
    if payload.discount_percent < 0 or payload.discount_percent > 100:
        raise HTTPException(status_code=400, detail="Discount must be between 0 and 100")
    if payload.payment_mode not in {"cash", "online", "split", "credit"}:
        raise HTTPException(status_code=400, detail="Invalid payment_mode")

    # NEW: read optional manual final amount (works even if model ignores extra fields)
    manual_final = getattr(payload, "final_amount", None)
    if manual_final is not None:
        try:
            manual_final = round2(float(manual_final))
            if manual_final < 0:
                raise HTTPException(status_code=400, detail="final_amount cannot be negative")
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid final_amount")

    with get_session() as session:
        # 1) Load items and validate stock
        db_items: Dict[int, Item] = {}
        line_price_by_item: Dict[int, float] = {}
        subtotal = 0.0

        for line in payload.items:
            itm = session.get(Item, line.item_id)
            if not itm:
                raise HTTPException(status_code=404, detail=f"Item {line.item_id} not found")
            if line.quantity <= 0:
                raise HTTPException(status_code=400, detail="Quantity must be > 0")
            if itm.stock < line.quantity:
                raise HTTPException(status_code=400, detail=f"Insufficient stock for {itm.name}")

            db_items[line.item_id] = itm
            line_price = bill_line_unit_price(line, itm)
            line_price_by_item[line.item_id] = line_price
            subtotal += (as_i(line.quantity) * line_price)

        subtotal = round2(subtotal)
        computed_total = round2(subtotal * (1 - as_f(payload.discount_percent) / 100.0))

        # 2) Use manual override if provided; else computed total
        total = manual_final if manual_final is not None else computed_total

        # 3) Validate payment split (against chosen total) — hardened for None inputs
        pay_cash_in = round2(as_f(getattr(payload, "payment_cash", 0.0)))
        pay_online_in = round2(as_f(getattr(payload, "payment_online", 0.0)))
        pay_credit_in = round2(as_f(getattr(payload, "payment_credit", 0.0)))

        if total <= 0:
            cash, online, credit = 0.0, 0.0, 0.0
            stored_payment_mode = "cash"
        elif payload.payment_mode == "credit":
            cash, online, credit = 0.0, 0.0, total
            stored_payment_mode = payload.payment_mode
        elif payload.payment_mode == "cash":
            if round2(pay_cash_in) != total:
                raise HTTPException(status_code=400, detail="payment_cash must equal total_amount")
            cash, online, credit = total, 0.0, 0.0
            stored_payment_mode = payload.payment_mode
        elif payload.payment_mode == "online":
            if round2(pay_online_in) != total:
                raise HTTPException(status_code=400, detail="payment_online must equal total_amount")
            cash, online, credit = 0.0, total, 0.0
            stored_payment_mode = payload.payment_mode
        else:  # split
            if pay_credit_in < 0:
                raise HTTPException(status_code=400, detail="payment_credit cannot be negative")
            if round2(pay_cash_in + pay_online_in + pay_credit_in) != total:
                raise HTTPException(
                    status_code=400,
                    detail="Cash + Online + Credit must equal total_amount"
                )
            cash, online, credit = round2(pay_cash_in), round2(pay_online_in), round2(pay_credit_in)
            stored_payment_mode = payload.payment_mode

        # 4) Create Bill + BillItems and deduct stock (✅ single transaction)
        now_iso = now_ts()
        bill_ts = normalize_bill_ts(getattr(payload, "date_time", None), now_iso)
        assert_financial_year_unlocked(session, bill_ts, context="Bill creation")

        paid_now = round2(cash + online)
        if total <= 0:
            status = "PAID"
            paid_at = bill_ts
            is_credit = False
        elif paid_now <= 0:
            status = "UNPAID"
            paid_at = None
        elif paid_now + 0.0001 < total:
            status = "PARTIAL"
            paid_at = bill_ts
        else:
            status = "PAID"
            paid_at = bill_ts
        has_credit_component = round2(total - paid_now) > 0
        is_credit = False if total <= 0 else payload.payment_mode == "credit" or has_credit_component
        paid_amount = paid_now
        linked_customer_id, linked_party_id = resolve_bill_party_links(
            session,
            customer_id=getattr(payload, "customer_id", None),
            party_id=getattr(payload, "party_id", None),
            notes=getattr(payload, "notes", None),
        )

        try:
            b = Bill(
                date_time=bill_ts,
                customer_id=linked_customer_id,
                party_id=linked_party_id,
                discount_percent=payload.discount_percent,
                subtotal=subtotal,
                total_amount=total,
                payment_mode=stored_payment_mode,
                payment_cash=cash,
                payment_online=online,
                notes=getattr(payload, "notes", None),

                # ✅ credit tracking
                is_credit=is_credit,
                payment_status=status,
                paid_amount=paid_amount,
                writeoff_amount=0.0,
                paid_at=paid_at,
                is_deleted=False,
                deleted_at=None,
            )

            session.add(b)
            session.flush()  # ✅ ensures b.id is available without committing

            # Deduct stock & create line items + SALE ledger
            for line in payload.items:
                itm = db_items[line.item_id]
                qty = as_i(line.quantity)

                itm.stock = as_i(itm.stock) - qty
                session.add(itm)
                # ✅ archive sold-out duplicate batches
                apply_archive_rules(session, itm)
                sync_lot_quantity_for_item(session, itm, ts=bill_ts)
                bi = BillItem(
                    bill_id=b.id,
                    item_id=itm.id,
                    item_name=itm.name,
                    mrp=as_f(itm.mrp),
                    quantity=qty,
                    line_total=round2(qty * as_f(line_price_by_item.get(itm.id, itm.mrp)))
                )
                session.add(bi)

                # ✅ Ledger: SALE (stock OUT)
                add_movement(
                    session,
                    item_id=itm.id,
                    delta=-qty,
                    reason="SALE",
                    ref_type="BILL",
                    ref_id=b.id,
                    note=f"Bill #{b.id}",
                )

            # ✅ If not credit, create a BillPayment for reporting "Collected Today"
            if paid_now > 0:
                p = BillPayment(
                    bill_id=b.id,
                    received_at=bill_ts,
                    mode=stored_payment_mode,  # cash/online/split
                    cash_amount=cash,
                    online_amount=online,
                    writeoff_amount=0.0,
                    note="auto: payment at bill creation",
                    is_writeoff=False,
                )
                session.add(p)

            session.commit()
            session.refresh(b)
            sync_bill_vouchers(session, b)
            session.commit()

        except HTTPException:
            session.rollback()
            raise
        except Exception as e:
            session.rollback()
            raise HTTPException(status_code=500, detail=f"Failed to create bill: {e}")

        items = session.exec(select(BillItem).where(BillItem.bill_id == b.id)).all()
        return BillOut(
            id=b.id,
            date_time=b.date_time,
            customer_id=getattr(b, "customer_id", None),
            party_id=getattr(b, "party_id", None),
            discount_percent=b.discount_percent,
            subtotal=b.subtotal,
            total_amount=b.total_amount,
            payment_mode=b.payment_mode,
            payment_cash=b.payment_cash,
            payment_online=b.payment_online,
            notes=b.notes,

            is_credit=b.is_credit,
            payment_status=b.payment_status,
            paid_amount=b.paid_amount,
            writeoff_amount=getattr(b, "writeoff_amount", 0.0),
            paid_at=b.paid_at,
            is_deleted=b.is_deleted,
            deleted_at=b.deleted_at,

            items=[bill_item_to_out(session, i) for i in items]
        )


class BillEditItemIn(BaseModel):
    item_id: int
    quantity: int
    custom_unit_price: Optional[float] = None


class BillUpdateIn(BaseModel):
    items: List[BillEditItemIn]
    discount_percent: float = 0.0
    payment_mode: str  # "cash" | "online" | "split" | "credit"
    payment_cash: float = 0.0
    payment_online: float = 0.0
    payment_credit: float = 0.0
    customer_id: Optional[int] = None
    party_id: Optional[int] = None
    final_amount: Optional[float] = None
    date_time: Optional[str] = None
    notes: Optional[str] = None


@router.put("/{bill_id}", response_model=BillOut)
def update_bill(bill_id: int, payload: BillUpdateIn):
    require_min_role("MANAGER", context="Bill edit")
    if not payload.items:
        raise HTTPException(status_code=400, detail="Bill must have at least one item")
    if payload.discount_percent < 0 or payload.discount_percent > 100:
        raise HTTPException(status_code=400, detail="Discount must be between 0 and 100")
    if payload.payment_mode not in {"cash", "online", "split", "credit"}:
        raise HTTPException(status_code=400, detail="Invalid payment_mode")

    manual_final = payload.final_amount
    if manual_final is not None:
        try:
            manual_final = round2(float(manual_final))
            if manual_final < 0:
                raise HTTPException(status_code=400, detail="final_amount cannot be negative")
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid final_amount")

    with get_session() as session:
        b = session.get(Bill, bill_id)
        if not b:
            raise HTTPException(status_code=404, detail="Bill not found")
        if is_deleted_bill(b):
            raise HTTPException(status_code=400, detail="Deleted bill cannot be edited")

        existing_items = session.exec(select(BillItem).where(BillItem.bill_id == b.id)).all()
        old_qty_by_item: Dict[int, int] = {}
        for it in existing_items:
            old_qty_by_item[it.item_id] = old_qty_by_item.get(it.item_id, 0) + as_i(it.quantity)

        def _norm_txt(v: Any) -> str:
            return str(v or "").strip().lower()

        stock_kind_cache: Dict[int, str] = {}

        def _stock_kind(it: Item) -> str:
            iid = as_i(getattr(it, "id", 0))
            if iid not in stock_kind_cache:
                stock_kind_cache[iid] = item_stock_kind(session, it)
            return stock_kind_cache[iid]

        def _group_key(name: Any, brand: Any, kind: str) -> str:
            return f"{_norm_txt(name)}__{_norm_txt(brand)}__{kind}"

        def _expiry_sort_key(it: Item):
            raw = str(getattr(it, "expiry_date", "") or "").strip()
            exp = raw[:10] if raw else "9999-99-99"
            no_exp = 1 if not raw else 0
            return (no_exp, exp, as_i(getattr(it, "id", 0)))

        requested_item_ids = {as_i(x.item_id) for x in payload.items}
        db_items: Dict[int, Item] = {}
        for iid in requested_item_ids | set(old_qty_by_item.keys()):
            itm = session.get(Item, iid)
            if not itm:
                raise HTTPException(status_code=404, detail=f"Item {iid} not found")
            db_items[iid] = itm

        requested_qty_by_group: Dict[str, int] = {}
        seed_item_by_group: Dict[str, Item] = {}
        unit_price_by_group: Dict[str, float] = {}
        for line in payload.items:
            qty = as_i(line.quantity)
            if qty <= 0:
                raise HTTPException(status_code=400, detail="Quantity must be > 0")
            seed = db_items.get(as_i(line.item_id))
            if not seed:
                raise HTTPException(status_code=404, detail=f"Item {line.item_id} not found")
            gk = _group_key(seed.name, getattr(seed, "brand", None), _stock_kind(seed))
            requested_qty_by_group[gk] = requested_qty_by_group.get(gk, 0) + qty
            seed_item_by_group[gk] = seed
            custom_price = bill_line_unit_price(line, seed)
            if gk not in unit_price_by_group:
                unit_price_by_group[gk] = custom_price

        new_qty_by_item: Dict[int, int] = {}
        line_price_by_item: Dict[int, float] = {}

        for gk, requested_qty in requested_qty_by_group.items():
            seed = seed_item_by_group[gk]
            group_name = str(seed.name or "")
            group_brand = str(getattr(seed, "brand", "") or "")

            candidates = session.exec(
                select(Item).where(
                    func.lower(Item.name) == func.lower(group_name),
                    func.lower(func.coalesce(Item.brand, "")) == func.lower(group_brand),
                )
            ).all()
            seed_kind = _stock_kind(seed)
            candidates = sorted([it for it in candidates if _stock_kind(it) == seed_kind], key=_expiry_sort_key)

            remaining = as_i(requested_qty)
            total_available = 0
            for it in candidates:
                iid = as_i(getattr(it, "id", 0))
                avail = max(0, as_i(getattr(it, "stock", 0)) + old_qty_by_item.get(iid, 0))
                total_available += avail
                if remaining <= 0 or avail <= 0:
                    continue
                take = min(remaining, avail)
                new_qty_by_item[iid] = new_qty_by_item.get(iid, 0) + as_i(take)
                line_price_by_item[iid] = as_f(unit_price_by_group.get(gk, getattr(seed, "mrp", 0.0)))
                db_items[iid] = it
                remaining -= take

            if remaining > 0:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Insufficient stock for {group_name} ({group_brand or 'no brand'}). "
                        f"Requested={requested_qty}, available across batches={total_available}."
                    ),
                )

        touched_item_ids = set(old_qty_by_item.keys()) | set(new_qty_by_item.keys())
        for iid in touched_item_ids:
            if iid not in db_items:
                itm = session.get(Item, iid)
                if not itm:
                    raise HTTPException(status_code=404, detail=f"Item {iid} not found")
                db_items[iid] = itm

        subtotal = 0.0
        for iid, qty in new_qty_by_item.items():
            unit = as_f(line_price_by_item.get(iid, db_items[iid].mrp))
            subtotal += unit * as_i(qty)
        subtotal = round2(subtotal)
        computed_total = round2(subtotal * (1 - as_f(payload.discount_percent) / 100.0))
        total = manual_final if manual_final is not None else computed_total

        pay_cash_in = round2(as_f(payload.payment_cash))
        pay_online_in = round2(as_f(payload.payment_online))
        pay_credit_in = round2(as_f(getattr(payload, "payment_credit", 0.0)))
        if total <= 0:
            cash, online, credit = 0.0, 0.0, 0.0
            requested_payment_mode = "cash"
        elif payload.payment_mode == "credit":
            cash, online, credit = 0.0, 0.0, total
            requested_payment_mode = payload.payment_mode
        elif payload.payment_mode == "cash":
            if pay_cash_in != total:
                raise HTTPException(status_code=400, detail="payment_cash must equal total_amount")
            cash, online, credit = total, 0.0, 0.0
            requested_payment_mode = payload.payment_mode
        elif payload.payment_mode == "online":
            if pay_online_in != total:
                raise HTTPException(status_code=400, detail="payment_online must equal total_amount")
            cash, online, credit = 0.0, total, 0.0
            requested_payment_mode = payload.payment_mode
        else:
            if pay_credit_in < 0:
                raise HTTPException(status_code=400, detail="payment_credit cannot be negative")
            if round2(pay_cash_in + pay_online_in + pay_credit_in) != total:
                raise HTTPException(
                    status_code=400,
                    detail="Cash + Online + Credit must equal total_amount"
                )
            cash, online, credit = pay_cash_in, pay_online_in, pay_credit_in
            requested_payment_mode = payload.payment_mode

        pays = session.exec(active_bill_payments_query(b.id)).all()
        manual_receipts = [
            p for p in pays
            if str(getattr(p, "note", "") or "") != "auto: payment at bill creation"
        ]
        has_manual_receipts = len(manual_receipts) > 0

        if has_manual_receipts:
            total_cash = round2(sum(as_f(getattr(p, "cash_amount", 0.0)) for p in pays))
            total_online = round2(sum(as_f(getattr(p, "online_amount", 0.0)) for p in pays))
            cash, online = total_cash, total_online
            credit = round2(max(0.0, total - (cash + online)))
            if cash > 0 and online > 0:
                effective_payment_mode = "split"
            elif cash > 0:
                effective_payment_mode = "cash"
            elif online > 0:
                effective_payment_mode = "online"
            else:
                effective_payment_mode = "credit"
        else:
            effective_payment_mode = requested_payment_mode

        for iid, itm in db_items.items():
            old_qty = old_qty_by_item.get(iid, 0)
            new_qty = new_qty_by_item.get(iid, 0)
            current_stock = as_i(itm.stock)
            additional_needed = max(0, new_qty - old_qty)
            if additional_needed > current_stock:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Insufficient stock for {itm.name} (item #{iid}). "
                        f"Current stock={current_stock}, already in bill={old_qty}, "
                        f"requested in edit={new_qty}, additional needed={additional_needed}."
                    ),
                )

        now_iso = now_ts()
        bill_ts = normalize_bill_ts(getattr(payload, "date_time", None), b.date_time or now_iso)
        linked_customer_id, linked_party_id = resolve_bill_party_links(
            session,
            customer_id=getattr(payload, "customer_id", None),
            party_id=getattr(payload, "party_id", None),
            notes=getattr(payload, "notes", None),
        )

        def _bill_item_signature() -> List[tuple[int, int, float]]:
            return sorted(
                (
                    as_i(it.item_id),
                    as_i(it.quantity),
                    round2(as_f(getattr(it, "mrp", 0.0))),
                )
                for it in existing_items
            )

        def _payload_item_signature() -> List[tuple[int, int, float]]:
            return sorted(
                (
                    as_i(iid),
                    as_i(qty),
                    round2(as_f(line_price_by_item.get(iid, db_items[iid].mrp))),
                )
                for iid, qty in new_qty_by_item.items()
            )

        customer_link_only_edit = (
            _bill_item_signature() == _payload_item_signature()
            and round2(as_f(payload.discount_percent)) == round2(as_f(b.discount_percent))
            and round2(total) == round2(as_f(b.total_amount))
            and round2(cash) == round2(as_f(b.payment_cash))
            and round2(online) == round2(as_f(b.payment_online))
            and str(effective_payment_mode or "") == str(b.payment_mode or "")
            and str(bill_ts or "") == str(b.date_time or "")
        )
        if not customer_link_only_edit:
            assert_financial_year_unlocked(session, bill_ts, context="Bill edit")
        paid_now = round2(cash + online)
        if has_manual_receipts and paid_now > round2(total) + 0.0001:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Cannot reduce bill total below received amount. "
                    f"Received={paid_now:.2f}, New total={round2(total):.2f}"
                ),
            )
        has_credit_component = round2(total - paid_now) > 0
        is_credit = False if total <= 0 else effective_payment_mode == "credit" or has_credit_component
        if total <= 0:
            status = "PAID"
            paid_at = bill_ts
        elif paid_now <= 0:
            status = "UNPAID"
            paid_at = None
        elif paid_now + 0.0001 < total:
            status = "PARTIAL"
            paid_at = None if has_manual_receipts else bill_ts
        else:
            status = "PAID"
            paid_at = bill_ts
        paid_amount = paid_now

        try:
            # Update stock and append stock ledger correction entries.
            for iid, itm in db_items.items():
                old_qty = old_qty_by_item.get(iid, 0)
                new_qty = new_qty_by_item.get(iid, 0)
                stock_delta = old_qty - new_qty
                if stock_delta == 0:
                    continue

                itm.stock = as_i(itm.stock) + stock_delta
                session.add(itm)
                apply_archive_rules(session, itm)
                sync_lot_quantity_for_item(session, itm, ts=now_iso)

                add_movement(
                    session,
                    item_id=itm.id,
                    delta=stock_delta,
                    reason="BILL_EDIT",
                    ref_type="BILL",
                    ref_id=b.id,
                    note=f"Bill #{b.id} edited (qty correction)",
                )

            for it in existing_items:
                session.delete(it)
            session.flush()

            for iid, qty in new_qty_by_item.items():
                itm = db_items[iid]
                session.add(BillItem(
                    bill_id=b.id,
                    item_id=iid,
                    item_name=itm.name,
                    mrp=as_f(itm.mrp),
                    quantity=as_i(qty),
                    line_total=round2(as_f(line_price_by_item.get(iid, itm.mrp)) * as_i(qty)),
                ))

            if not has_manual_receipts:
                for p in pays:
                    session.delete(p)
                if paid_now > 0:
                    session.add(BillPayment(
                        bill_id=b.id,
                        received_at=bill_ts,
                        mode=payload.payment_mode,
                        cash_amount=cash,
                        online_amount=online,
                        writeoff_amount=0.0,
                        note="auto: payment at bill creation",
                        is_writeoff=False,
                    ))

            b.date_time = bill_ts
            b.customer_id = linked_customer_id
            b.party_id = linked_party_id
            b.discount_percent = payload.discount_percent
            b.subtotal = subtotal
            b.total_amount = total
            b.payment_mode = effective_payment_mode
            b.payment_cash = cash
            b.payment_online = online
            b.notes = payload.notes
            b.is_credit = is_credit
            b.payment_status = status
            b.paid_amount = paid_amount
            b.writeoff_amount = round2(
                sum(as_f(getattr(p, "writeoff_amount", 0.0)) for p in pays if not bool(getattr(p, "is_deleted", False)))
            ) if has_manual_receipts else 0.0
            b.paid_at = paid_at

            session.add(b)
            session.commit()
            session.refresh(b)
            sync_bill_vouchers(session, b)
            session.commit()
        except HTTPException:
            session.rollback()
            raise
        except Exception as e:
            session.rollback()
            raise HTTPException(status_code=500, detail=f"Failed to edit bill: {e}")

        items = session.exec(select(BillItem).where(BillItem.bill_id == b.id)).all()
        return BillOut(
            id=b.id,
            date_time=b.date_time,
            customer_id=getattr(b, "customer_id", None),
            party_id=getattr(b, "party_id", None),
            discount_percent=b.discount_percent,
            subtotal=b.subtotal,
            total_amount=b.total_amount,
            payment_mode=b.payment_mode,
            payment_cash=b.payment_cash,
            payment_online=b.payment_online,
            notes=b.notes,
            is_credit=b.is_credit,
            payment_status=b.payment_status,
            paid_amount=b.paid_amount,
            writeoff_amount=getattr(b, "writeoff_amount", 0.0),
            paid_at=b.paid_at,
            is_deleted=b.is_deleted,
            deleted_at=b.deleted_at,
            items=[bill_item_to_out(session, i) for i in items]
        )


@router.delete("/{bill_id}")
def soft_delete_bill(bill_id: int):
    require_min_role("MANAGER", context="Bill delete")
    with get_session() as session:
        b = session.get(Bill, bill_id)
        if not b:
            raise HTTPException(status_code=404, detail="Bill not found")
        assert_financial_year_unlocked(session, b.date_time, context="Bill delete")

        if is_deleted_bill(b):
            return {"bill_id": b.id, "is_deleted": True, "deleted_at": b.deleted_at}

        bill_items = session.exec(select(BillItem).where(BillItem.bill_id == b.id)).all()
        qty_by_item: Dict[int, int] = {}
        for line in bill_items:
            iid = as_i(getattr(line, "item_id", 0))
            qty = as_i(getattr(line, "quantity", 0))
            if iid <= 0 or qty <= 0:
                continue
            qty_by_item[iid] = qty_by_item.get(iid, 0) + qty

        for iid, qty in qty_by_item.items():
            itm = session.get(Item, iid)
            if not itm:
                continue
            itm.stock = as_i(itm.stock) + as_i(qty)
            session.add(itm)
            apply_archive_rules(session, itm)
            sync_lot_quantity_for_item(session, itm)
            add_movement(
                session,
                item_id=itm.id,
                delta=as_i(qty),
                reason="BILL_DELETE",
                ref_type="BILL",
                ref_id=b.id,
                note=f"Bill #{b.id} soft-deleted (stock restored)",
            )

        b.is_deleted = True
        b.deleted_at = now_ts()
        session.add(b)
        session.commit()
        mark_voucher_deleted(session, source_type="BILL", source_id=int(b.id))
        pays = session.exec(select(BillPayment).where(BillPayment.bill_id == b.id)).all()
        for p in pays:
            mark_voucher_deleted(session, source_type="BILL_PAYMENT", source_id=int(p.id))
        session.commit()
        return {"bill_id": b.id, "is_deleted": True, "deleted_at": b.deleted_at}


@router.post("/{bill_id}/recover")
def recover_bill(bill_id: int):
    require_min_role("MANAGER", context="Bill recover")
    with get_session() as session:
        b = session.get(Bill, bill_id)
        if not b:
            raise HTTPException(status_code=404, detail="Bill not found")
        assert_financial_year_unlocked(session, b.date_time, context="Bill recover")

        if not is_deleted_bill(b):
            return {"bill_id": b.id, "is_deleted": False, "deleted_at": None}

        bill_items = session.exec(select(BillItem).where(BillItem.bill_id == b.id)).all()
        qty_by_item: Dict[int, int] = {}
        for line in bill_items:
            iid = as_i(getattr(line, "item_id", 0))
            qty = as_i(getattr(line, "quantity", 0))
            if iid <= 0 or qty <= 0:
                continue
            qty_by_item[iid] = qty_by_item.get(iid, 0) + qty

        for iid, qty in qty_by_item.items():
            itm = session.get(Item, iid)
            if not itm:
                raise HTTPException(status_code=404, detail=f"Item {iid} not found for recover")
            if as_i(itm.stock) < as_i(qty):
                raise HTTPException(
                    status_code=400,
                    detail=f"Cannot recover bill. Insufficient stock for {itm.name}",
                )

        for iid, qty in qty_by_item.items():
            itm = session.get(Item, iid)
            if not itm:
                continue
            itm.stock = as_i(itm.stock) - as_i(qty)
            session.add(itm)
            apply_archive_rules(session, itm)
            sync_lot_quantity_for_item(session, itm)
            add_movement(
                session,
                item_id=itm.id,
                delta=-as_i(qty),
                reason="BILL_RECOVER",
                ref_type="BILL",
                ref_id=b.id,
                note=f"Bill #{b.id} recovered (stock deducted again)",
            )

        b.is_deleted = False
        b.deleted_at = None
        session.add(b)
        session.commit()
        sync_bill_vouchers(session, b)
        pays = session.exec(
            select(BillPayment).where(BillPayment.bill_id == b.id, BillPayment.is_deleted == False)  # noqa: E712
        ).all()
        for p in pays:
            note = str(p.note or "").strip().lower()
            if note == "auto: payment at bill creation":
                continue
            post_bill_payment_voucher(
                session,
                b,
                int(p.id),
                p.received_at,
                float(p.cash_amount or 0),
                float(p.online_amount or 0),
                p.note,
            )
        session.commit()
        return {"bill_id": b.id, "is_deleted": False, "deleted_at": None}


# ------------------ Receive Payment on Credit Bill ------------------

class ReceivePaymentIn(BaseModel):
    mode: str  # "cash" | "online" | "split"
    cash_amount: float = 0.0
    online_amount: float = 0.0
    writeoff_amount: float = 0.0
    is_writeoff: bool = False
    note: Optional[str] = None
    payment_date: Optional[str] = None


def validate_payment_payload(payload: ReceivePaymentIn) -> Dict[str, Any]:
    if bool(payload.is_writeoff):
        writeoff = round2(as_f(payload.writeoff_amount))
        if writeoff <= 0:
            raise HTTPException(status_code=400, detail="Write-off amount must be > 0")
        if round2(as_f(payload.cash_amount)) != 0 or round2(as_f(payload.online_amount)) != 0:
            raise HTTPException(status_code=400, detail="Cash and online amounts must be 0 for write-off")
        return {"cash": 0.0, "online": 0.0, "writeoff": writeoff, "mode": "writeoff", "is_writeoff": True}

    if payload.mode not in {"cash", "online", "split"}:
        raise HTTPException(status_code=400, detail="Invalid mode")

    cash = round2(as_f(payload.cash_amount))
    online = round2(as_f(payload.online_amount))

    if payload.mode == "cash" and online != 0:
        raise HTTPException(status_code=400, detail="For cash mode, online_amount must be 0")
    if payload.mode == "online" and cash != 0:
        raise HTTPException(status_code=400, detail="For online mode, cash_amount must be 0")

    if (cash + online) <= 0:
        raise HTTPException(status_code=400, detail="Payment amount must be > 0")

    return {"cash": cash, "online": online, "writeoff": 0.0, "mode": payload.mode, "is_writeoff": False}


@router.post("/{bill_id}/receive-payment")
def receive_payment(bill_id: int, payload: ReceivePaymentIn):
    """
    ✅ Future-bug-proofing:
    - Inserts BillPayment (source of truth)
    - Recomputes Bill totals from BillPayment rows (prevents drift / double counting forever)
    """
    vals = validate_payment_payload(payload)
    cash = vals["cash"]
    online = vals["online"]
    writeoff = vals["writeoff"]
    is_writeoff = vals["is_writeoff"]

    now_iso = now_ts()
    payment_ts = normalize_payment_ts(payload.payment_date, now_iso)

    with get_session() as session:
        assert_financial_year_unlocked(session, payment_ts, context="Bill payment receipt")
        b = session.get(Bill, bill_id)
        if not b:
            raise HTTPException(status_code=404, detail="Bill not found")
        if is_deleted_bill(b):
            raise HTTPException(status_code=400, detail="Cannot receive payment on deleted bill")

        # 1) Insert payment record (THIS is the source of truth for "Collected Today")
        pending_before = bill_outstanding_amount(b)
        entry_amount = round2(cash + online + writeoff)
        if entry_amount > pending_before + 0.0001:
            raise HTTPException(status_code=400, detail="Amount exceeds outstanding amount")

        p = BillPayment(
            bill_id=bill_id,
            received_at=payment_ts,
            mode=vals["mode"],
            cash_amount=cash,
            online_amount=online,
            writeoff_amount=writeoff,
            note=payload.note,
            is_writeoff=is_writeoff,
        )
        session.add(p)
        session.commit()

        # 2) Recalculate totals from all BillPayment rows (prevents future inconsistencies)
        result = recalculate_bill_payment_state(session, b)
        session.add(b)
        session.commit()
        post_bill_payment_voucher(
            session,
            b,
            int(p.id),
            p.received_at,
            float(p.cash_amount or 0),
            float(p.online_amount or 0),
            float(getattr(p, "writeoff_amount", 0) or 0),
            bool(getattr(p, "is_writeoff", False)),
            p.note,
        )
        session.commit()
        return result


@router.put("/{bill_id}/payments/{payment_id}")
def edit_bill_payment(bill_id: int, payment_id: int, payload: ReceivePaymentIn):
    require_min_role("MANAGER", context="Bill payment edit")
    vals = validate_payment_payload(payload)
    cash = vals["cash"]
    online = vals["online"]
    writeoff = vals["writeoff"]
    is_writeoff = vals["is_writeoff"]

    payment_ts = normalize_payment_ts(payload.payment_date, now_ts())

    with get_session() as session:
        assert_financial_year_unlocked(session, payment_ts, context="Bill payment edit")
        b = session.get(Bill, bill_id)
        if not b:
            raise HTTPException(status_code=404, detail="Bill not found")
        if is_deleted_bill(b):
            raise HTTPException(status_code=400, detail="Cannot edit payment on deleted bill")

        p = session.get(BillPayment, payment_id)
        if not p or int(p.bill_id) != int(bill_id) or bool(getattr(p, "is_deleted", False)):
            raise HTTPException(status_code=404, detail="Payment not found")
        receipt_adjustment = receipt_adjustment_for_payment(session, int(p.id or 0))
        receipt_managed = receipt_adjustment is not None
        if receipt_adjustment:
            if is_writeoff or writeoff > 0:
                raise HTTPException(status_code=400, detail="Customer receipt allocations cannot be changed to write-off")
            validate_receipt_payment_channels(session, receipt_adjustment, cash, online)

        other_active_total = round2(
            sum(
                as_f(row.cash_amount) + as_f(row.online_amount) + as_f(getattr(row, "writeoff_amount", 0.0))
                for row in session.exec(active_bill_payments_query(b.id)).all()
                if int(getattr(row, "id", 0) or 0) != int(p.id)
            )
        )
        proposed_total = round2(cash + online + writeoff)
        if other_active_total + proposed_total > round2(as_f(b.total_amount)) + 0.0001:
            raise HTTPException(status_code=400, detail="Amount exceeds outstanding amount")

        p.received_at = payment_ts
        p.mode = vals["mode"]
        p.cash_amount = cash
        p.online_amount = online
        p.writeoff_amount = writeoff
        p.note = payload.note
        p.is_writeoff = is_writeoff
        session.add(p)
        sync_receipt_adjustment_for_payment(session, p, round2(cash + online))

        result = recalculate_bill_payment_state(session, b)
        session.add(b)
        session.commit()
        if receipt_managed:
            mark_voucher_deleted(session, source_type="BILL_PAYMENT", source_id=int(p.id))
        else:
            post_bill_payment_voucher(
                session,
                b,
                int(p.id),
                p.received_at,
                float(p.cash_amount or 0),
                float(p.online_amount or 0),
                float(getattr(p, "writeoff_amount", 0) or 0),
                bool(getattr(p, "is_writeoff", False)),
                p.note,
            )
        session.commit()
        return result


# ------------------ List Payments for a Bill ------------------

@router.get("/{bill_id}/payments")
def list_bill_payments(bill_id: int):
    with get_session() as session:
        b = session.get(Bill, bill_id)
        if not b:
            raise HTTPException(status_code=404, detail="Bill not found")

        pays = session.exec(
            select(BillPayment)
            .where(BillPayment.bill_id == bill_id)
            .order_by(BillPayment.id.desc())
        ).all()

        out = []
        for p in pays:
            adjustment = receipt_adjustment_for_payment(session, int(p.id or 0))
            out.append({
                "id": p.id,
                "bill_id": p.bill_id,
                "received_at": p.received_at,
                "mode": p.mode,
                "cash_amount": p.cash_amount,
                "online_amount": p.online_amount,
                "writeoff_amount": getattr(p, "writeoff_amount", 0.0),
                "note": p.note,
                "is_writeoff": bool(getattr(p, "is_writeoff", False)),
                "is_deleted": bool(getattr(p, "is_deleted", False)),
                "deleted_at": getattr(p, "deleted_at", None),
                "is_receipt_managed": adjustment is not None,
                "receipt_id": getattr(adjustment, "receipt_id", None) if adjustment else None,
                "receipt_adjustment_id": getattr(adjustment, "id", None) if adjustment else None,
            })
        return out


@router.delete("/{bill_id}/payments/{payment_id}")
def undo_bill_payment(bill_id: int, payment_id: int):
    require_min_role("MANAGER", context="Bill payment delete")
    with get_session() as session:
        b = session.get(Bill, bill_id)
        if not b:
            raise HTTPException(status_code=404, detail="Bill not found")
        if is_deleted_bill(b):
            raise HTTPException(status_code=400, detail="Cannot undo payment on deleted bill")

        p = session.get(BillPayment, payment_id)
        if not p or int(p.bill_id) != int(bill_id) or bool(getattr(p, "is_deleted", False)):
            raise HTTPException(status_code=404, detail="Payment not found")
        assert_financial_year_unlocked(session, p.received_at, context="Bill payment delete")
        p.is_deleted = True
        p.deleted_at = now_ts()
        session.add(p)
        sync_receipt_adjustment_for_payment(session, p, 0.0)

        result = recalculate_bill_payment_state(session, b)
        session.add(b)
        session.commit()
        mark_voucher_deleted(session, source_type="BILL_PAYMENT", source_id=int(p.id))
        session.commit()
        return result


@router.post("/{bill_id}/payments/{payment_id}/recover")
def recover_bill_payment(bill_id: int, payment_id: int):
    require_min_role("MANAGER", context="Bill payment recover")
    with get_session() as session:
        b = session.get(Bill, bill_id)
        if not b:
            raise HTTPException(status_code=404, detail="Bill not found")
        if is_deleted_bill(b):
            raise HTTPException(status_code=400, detail="Cannot recover payment on deleted bill")

        p = session.get(BillPayment, payment_id)
        if not p or int(p.bill_id) != int(bill_id) or not bool(getattr(p, "is_deleted", False)):
            raise HTTPException(status_code=404, detail="Deleted payment not found")
        assert_financial_year_unlocked(session, p.received_at, context="Bill payment recover")
        receipt_adjustment = receipt_adjustment_for_payment(session, int(p.id or 0))
        receipt_managed = receipt_adjustment is not None
        receipt = session.get(PartyReceipt, int(receipt_adjustment.receipt_id)) if receipt_adjustment else None
        restore_receipt_voucher = bool(receipt and getattr(receipt, "is_deleted", False))
        if receipt_adjustment:
            if bool(getattr(p, "is_writeoff", False)) or as_f(getattr(p, "writeoff_amount", 0.0)) > 0:
                raise HTTPException(status_code=400, detail="Customer receipt allocations cannot be recovered as write-off")
            validate_receipt_payment_channels(session, receipt_adjustment, round2(as_f(p.cash_amount)), round2(as_f(p.online_amount)))

        p.is_deleted = False
        p.deleted_at = None
        session.add(p)
        sync_receipt_adjustment_for_payment(
            session,
            p,
            round2(as_f(p.cash_amount) + as_f(p.online_amount)),
            restore_receipt=True,
        )

        result = recalculate_bill_payment_state(session, b)
        session.add(b)
        session.commit()
        if receipt_managed:
            mark_voucher_deleted(session, source_type="BILL_PAYMENT", source_id=int(p.id))
            if restore_receipt_voucher and receipt:
                party = session.get(Party, int(receipt.party_id))
                if party:
                    post_party_receipt_voucher(
                        session,
                        int(receipt.id),
                        party,
                        receipt.received_at,
                        float(receipt.total_amount or 0),
                        float(receipt.cash_amount or 0),
                        float(receipt.online_amount or 0),
                        receipt.note,
                    )
        else:
            post_bill_payment_voucher(
                session,
                b,
                int(p.id),
                p.received_at,
                float(p.cash_amount or 0),
                float(p.online_amount or 0),
                float(getattr(p, "writeoff_amount", 0) or 0),
                bool(getattr(p, "is_writeoff", False)),
                p.note,
            )
        session.commit()
        return result


# ------------------ Dashboard helper: Payments Summary (Collected Today) ------------------

def _receipt_adjustment_payment_ids(session) -> set[int]:
    return {
        int(row.bill_payment_id)
        for row in session.exec(
            select(ReceiptBillAdjustment)
            .join(PartyReceipt, PartyReceipt.id == ReceiptBillAdjustment.receipt_id)
            .where(ReceiptBillAdjustment.bill_payment_id.is_not(None))
            .where(PartyReceipt.is_deleted == False)  # noqa: E712
        ).all()
        if row.bill_payment_id is not None
    }


@router.get("/payments/summary")
def payments_summary(
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)"),
    deleted_filter: str = Query("active", pattern="^(active|deleted|all)$"),
) -> Dict[str, Any]:
    """
    Dashboard "Collected Today" MUST include:
    - normal bills (auto BillPayment at bill creation)
    - credit bill receipts (receive-payment)
    So we aggregate from BillPayment.received_at (NOT from Bill rows).
    """
    with get_session() as session:
        receipt_adjustment_payment_ids = _receipt_adjustment_payment_ids(session)
        stmt = (
            select(BillPayment)
            .join(Bill, Bill.id == BillPayment.bill_id)
            .where(BillPayment.is_deleted == False)  # noqa: E712
            .order_by(BillPayment.id.desc())
        )
        if deleted_filter == "active":
            stmt = stmt.where(Bill.is_deleted == False)  # noqa: E712
        elif deleted_filter == "deleted":
            stmt = stmt.where(Bill.is_deleted == True)  # noqa: E712
        payment_date_expr = func.substr(func.coalesce(BillPayment.received_at, ""), 1, 10)
        if from_date:
            stmt = stmt.where(payment_date_expr >= from_date)
        if to_date:
            stmt = stmt.where(payment_date_expr <= to_date)

        pays = [
            p for p in session.exec(stmt).all()
            if not bool(getattr(p, "is_writeoff", False))
            and int(getattr(p, "id", 0) or 0) not in receipt_adjustment_payment_ids
        ]

        cash = round2(sum(as_f(p.cash_amount) for p in pays))
        online = round2(sum(as_f(p.online_amount) for p in pays))
        receipt_rows: List[PartyReceipt] = []
        if deleted_filter != "deleted":
            receipt_stmt = select(PartyReceipt).where(PartyReceipt.is_deleted == False)  # noqa: E712
            receipt_date_expr = func.substr(func.coalesce(PartyReceipt.received_at, ""), 1, 10)
            if from_date:
                receipt_stmt = receipt_stmt.where(receipt_date_expr >= from_date)
            if to_date:
                receipt_stmt = receipt_stmt.where(receipt_date_expr <= to_date)
            receipt_rows = session.exec(receipt_stmt).all()
        cash = round2(cash + sum(as_f(row.cash_amount) for row in receipt_rows))
        online = round2(online + sum(as_f(row.online_amount) for row in receipt_rows))
        total = round2(cash + online)

        return {
            "cash_collected": cash,
            "online_collected": online,
            "total_collected": total,
            "count": len(pays) + len(receipt_rows),
        }


# ------------------ NEW FEATURE: Collections Aggregate ------------------

@router.get("/payments/aggregate")
def payments_aggregate(
    from_date: str = Query(..., description="YYYY-MM-DD"),
    to_date: str = Query(..., description="YYYY-MM-DD"),
    group_by: str = Query("day", pattern="^(day|month)$"),
    deleted_filter: str = Query("active", pattern="^(active|deleted|all)$"),
) -> List[Dict[str, Any]]:
    """
    ✅ NEW: Aggregate REAL collections (cash/online actually received) by day or month.
    Uses BillPayment.received_at as source of truth.

    This is DIFFERENT from sales_aggregate:
    - sales_aggregate = billed amount view (Bill.total_amount)
    - payments_aggregate = collection view (BillPayment cash/online)
    """
    start_ts = f"{from_date}T00:00:00"
    end_ts = f"{to_date}T23:59:59"

    with get_session() as session:
        if group_by == "month":
            period_expr = func.substr(BillPayment.received_at, 1, 7)  # YYYY-MM
            receipt_period_expr = func.substr(PartyReceipt.received_at, 1, 7)
        else:
            period_expr = func.substr(BillPayment.received_at, 1, 10)  # YYYY-MM-DD
            receipt_period_expr = func.substr(PartyReceipt.received_at, 1, 10)

        receipt_adjustment_payment_ids = _receipt_adjustment_payment_ids(session)

        stmt = (
            select(
                period_expr.label("period"),
                func.count(BillPayment.id).label("payments_count"),
                func.coalesce(func.sum(BillPayment.cash_amount), 0).label("cash_total"),
                func.coalesce(func.sum(BillPayment.online_amount), 0).label("online_total"),
            )
            .select_from(BillPayment)
            .join(Bill, Bill.id == BillPayment.bill_id)
            .where(BillPayment.is_deleted == False)  # noqa: E712
            .where(BillPayment.is_writeoff == False)  # noqa: E712
            .where(BillPayment.received_at >= start_ts)
            .where(BillPayment.received_at <= end_ts)
            .group_by(period_expr)
            .order_by(period_expr.asc())
        )
        if receipt_adjustment_payment_ids:
            stmt = stmt.where(BillPayment.id.notin_(receipt_adjustment_payment_ids))

        if deleted_filter == "active":
            stmt = stmt.where(Bill.is_deleted == False)  # noqa: E712
        elif deleted_filter == "deleted":
            stmt = stmt.where(Bill.is_deleted == True)  # noqa: E712

        rows = session.exec(stmt).all()

        period_map: Dict[str, Dict[str, Any]] = {}
        for r in rows:
            cash = round2(as_f(r.cash_total))
            online = round2(as_f(r.online_total))
            bucket = period_map.setdefault(
                r.period,
                {"period": r.period, "payments_count": 0, "cash_total": 0.0, "online_total": 0.0},
            )
            bucket["payments_count"] += int(r.payments_count or 0)
            bucket["cash_total"] = round2(bucket["cash_total"] + cash)
            bucket["online_total"] = round2(bucket["online_total"] + online)

        if deleted_filter != "deleted":
            receipt_stmt = (
                select(
                    receipt_period_expr.label("period"),
                    func.count(PartyReceipt.id).label("payments_count"),
                    func.coalesce(func.sum(PartyReceipt.cash_amount), 0).label("cash_total"),
                    func.coalesce(func.sum(PartyReceipt.online_amount), 0).label("online_total"),
                )
                .select_from(PartyReceipt)
                .where(PartyReceipt.is_deleted == False)  # noqa: E712
                .where(PartyReceipt.received_at >= start_ts)
                .where(PartyReceipt.received_at <= end_ts)
                .group_by(receipt_period_expr)
                .order_by(receipt_period_expr.asc())
            )
            for r in session.exec(receipt_stmt).all():
                bucket = period_map.setdefault(
                    r.period,
                    {"period": r.period, "payments_count": 0, "cash_total": 0.0, "online_total": 0.0},
                )
                bucket["payments_count"] += int(r.payments_count or 0)
                bucket["cash_total"] = round2(bucket["cash_total"] + as_f(r.cash_total))
                bucket["online_total"] = round2(bucket["online_total"] + as_f(r.online_total))

        out: List[Dict[str, Any]] = []
        for period in sorted(period_map):
            bucket = period_map[period]
            cash = round2(bucket["cash_total"])
            online = round2(bucket["online_total"])
            out.append({
                "period": period,
                "payments_count": int(bucket["payments_count"] or 0),
                "cash_total": cash,
                "online_total": online,
                "total_collected": round2(cash + online),
            })

        return out


# ------------------ Reports helper: Daily/Monthly Sales Aggregates ------------------

@router.get("/summary/aggregate")
def sales_aggregate(
    from_date: str = Query(..., description="YYYY-MM-DD"),
    to_date: str = Query(..., description="YYYY-MM-DD"),
    group_by: str = Query("day", pattern="^(day|month)$"),
    deleted_filter: str = Query("active", pattern="^(active|deleted|all)$"),
) -> List[Dict[str, Any]]:
    """
    Returns aggregates grouped by day or month.

    NOTE:
    - gross_sales is based on Bill.total_amount (final billed amount)
    - paid_total is sum of Bill.paid_amount
    - pending_total = gross_sales - paid_total (clamped to >= 0)

    This is "sales view" (based on bills).
    If you want "collection view", use /billing/payments/aggregate.
    """
    start_ts = f"{from_date}T00:00:00"
    end_ts = f"{to_date}T23:59:59"

    with get_session() as session:
        if group_by == "month":
            period_expr = func.substr(Bill.date_time, 1, 7)  # YYYY-MM
        else:
            period_expr = func.substr(Bill.date_time, 1, 10)  # YYYY-MM-DD

        stmt = (
            select(
                period_expr.label("period"),
                func.count(Bill.id).label("bills_count"),
                func.coalesce(func.sum(Bill.total_amount), 0).label("gross_sales"),
                func.coalesce(func.sum(Bill.paid_amount + Bill.writeoff_amount), 0).label("paid_total"),
            )
            .where(Bill.date_time >= start_ts)
            .where(Bill.date_time <= end_ts)
            .group_by(period_expr)
            .order_by(period_expr.asc())
        )

        if deleted_filter == "active":
            stmt = stmt.where(Bill.is_deleted == False)  # noqa: E712
        elif deleted_filter == "deleted":
            stmt = stmt.where(Bill.is_deleted == True)  # noqa: E712

        rows = session.exec(stmt).all()

        out: List[Dict[str, Any]] = []
        for r in rows:
            gross = as_f(r.gross_sales)
            paid = as_f(r.paid_total)
            pending = max(0.0, gross - paid)

            out.append({
                "period": r.period,
                "bills_count": int(r.bills_count or 0),
                "gross_sales": round2(gross),
                "paid_total": round2(paid),
                "pending_total": round2(pending),
            })

        return out
