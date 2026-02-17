# F:\medical-inventory\backend\routers\billing.py

from fastapi import APIRouter, HTTPException, Query
from typing import List, Optional, Dict, Any
from datetime import datetime
from pydantic import BaseModel
from sqlmodel import select
from sqlalchemy import or_, exists, func, cast
from sqlalchemy.types import Integer, Float
from backend.utils.archive_rules import apply_archive_rules
from backend.db import get_session
from backend.models import (
    Item, Bill, BillItem, BillPayment,
    BillCreate, BillOut, BillItemOut,
    StockMovement,  # ✅ NEW
)

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


def is_deleted_bill(b: Bill) -> bool:
    return bool(getattr(b, "is_deleted", False))


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
        stmt = stmt.order_by(Bill.id.desc()).limit(limit).offset(offset)
        rows = session.exec(stmt).all()

        # simple date filter (string compare is fine with ISO if provided)
        if from_date:
            rows = [b for b in rows if (b.date_time or "")[:10] >= from_date]
        if to_date:
            rows = [b for b in rows if (b.date_time or "")[:10] <= to_date]

        out: List[BillOut] = []
        for b in rows:
            items = session.exec(select(BillItem).where(BillItem.bill_id == b.id)).all()
            out.append(BillOut(
                id=b.id,
                date_time=b.date_time,
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
                paid_at=b.paid_at,
                is_deleted=b.is_deleted,
                deleted_at=b.deleted_at,

                items=[BillItemOut(
                    item_id=i.item_id,
                    item_name=i.item_name,
                    mrp=i.mrp,
                    quantity=i.quantity,
                    line_total=i.line_total
                ) for i in items]
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

            if id_filter is not None:
                stmt = stmt.where(or_(id_filter, notes_match, items_match))
            else:
                stmt = stmt.where(or_(notes_match, items_match))

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
                paid_at=b.paid_at,
                is_deleted=b.is_deleted,
                deleted_at=b.deleted_at,

                items=[BillItemOut(
                    item_id=i.item_id,
                    item_name=i.item_name,
                    mrp=i.mrp,
                    quantity=i.quantity,
                    line_total=i.line_total
                ) for i in items]
            ))

        next_offset = (offset + limit) if has_more else None
        return {"items": out, "next_offset": next_offset}

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
                out.append(
                    ItemSalesRowOut(
                        item_id=int(r.item_id or 0),
                        item_name=str(r.item_name or ""),
                        brand=(str(r.brand) if r.brand else None),
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
        )
        if deleted_filter == "active":
            stmt = stmt.where(Bill.is_deleted == False)  # noqa: E712
        elif deleted_filter == "deleted":
            stmt = stmt.where(Bill.is_deleted == True)  # noqa: E712

        if from_date:
            stmt = stmt.where(BillPayment.received_at >= f"{from_date}T00:00:00")
        if to_date:
            stmt = stmt.where(BillPayment.received_at <= f"{to_date}T23:59:59")

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
                "note": p.note,
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
            paid_at=b.paid_at,
            is_deleted=b.is_deleted,
            deleted_at=b.deleted_at,

            items=[BillItemOut(
                item_id=i.item_id,
                item_name=i.item_name,
                mrp=i.mrp,
                quantity=i.quantity,
                line_total=i.line_total
            ) for i in items]
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
            line_price = as_f(getattr(line, "custom_unit_price", None))
            if line_price <= 0:
                line_price = as_f(itm.mrp)
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

        if payload.payment_mode == "credit":
            cash, online, credit = 0.0, 0.0, total
        elif payload.payment_mode == "cash":
            if round2(pay_cash_in) != total:
                raise HTTPException(status_code=400, detail="payment_cash must equal total_amount")
            cash, online, credit = total, 0.0, 0.0
        elif payload.payment_mode == "online":
            if round2(pay_online_in) != total:
                raise HTTPException(status_code=400, detail="payment_online must equal total_amount")
            cash, online, credit = 0.0, total, 0.0
        else:  # split
            if pay_credit_in < 0:
                raise HTTPException(status_code=400, detail="payment_credit cannot be negative")
            if round2(pay_cash_in + pay_online_in + pay_credit_in) != total:
                raise HTTPException(
                    status_code=400,
                    detail="Cash + Online + Credit must equal total_amount"
                )
            cash, online, credit = round2(pay_cash_in), round2(pay_online_in), round2(pay_credit_in)

        # 4) Create Bill + BillItems and deduct stock (✅ single transaction)
        now_iso = now_ts()

        paid_now = round2(cash + online)
        has_credit_component = round2(total - paid_now) > 0
        is_credit = payload.payment_mode == "credit" or has_credit_component
        if paid_now <= 0:
            status = "UNPAID"
            paid_at = None
        elif paid_now + 0.0001 < total:
            status = "PARTIAL"
            paid_at = now_iso
        else:
            status = "PAID"
            paid_at = now_iso
        paid_amount = paid_now

        try:
            b = Bill(
                date_time=now_iso,
                discount_percent=payload.discount_percent,
                subtotal=subtotal,
                total_amount=total,
                payment_mode=payload.payment_mode,
                payment_cash=cash,
                payment_online=online,
                notes=getattr(payload, "notes", None),

                # ✅ credit tracking
                is_credit=is_credit,
                payment_status=status,
                paid_amount=paid_amount,
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
                    received_at=now_iso,
                    mode=payload.payment_mode,  # cash/online/split
                    cash_amount=cash,
                    online_amount=online,
                    note="auto: payment at bill creation"
                )
                session.add(p)

            session.commit()
            session.refresh(b)

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
            paid_at=b.paid_at,
            is_deleted=b.is_deleted,
            deleted_at=b.deleted_at,

            items=[BillItemOut(
                item_id=i.item_id,
                item_name=i.item_name,
                mrp=i.mrp,
                quantity=i.quantity,
                line_total=i.line_total
            ) for i in items]
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
    final_amount: Optional[float] = None
    notes: Optional[str] = None


@router.put("/{bill_id}", response_model=BillOut)
def update_bill(bill_id: int, payload: BillUpdateIn):
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

        new_qty_by_item: Dict[int, int] = {}
        for line in payload.items:
            qty = as_i(line.quantity)
            if qty <= 0:
                raise HTTPException(status_code=400, detail="Quantity must be > 0")
            new_qty_by_item[line.item_id] = new_qty_by_item.get(line.item_id, 0) + qty

        touched_item_ids = set(old_qty_by_item.keys()) | set(new_qty_by_item.keys())
        db_items: Dict[int, Item] = {}
        for iid in touched_item_ids:
            itm = session.get(Item, iid)
            if not itm:
                raise HTTPException(status_code=404, detail=f"Item {iid} not found")
            db_items[iid] = itm

        line_price_by_item: Dict[int, float] = {}
        subtotal = 0.0
        for iid, qty in new_qty_by_item.items():
            payload_line = next((x for x in payload.items if int(x.item_id) == int(iid)), None)
            custom_price = as_f(getattr(payload_line, "custom_unit_price", None) if payload_line else None)
            if custom_price <= 0:
                custom_price = as_f(db_items[iid].mrp)
            line_price_by_item[iid] = custom_price
            subtotal += custom_price * as_i(qty)
        subtotal = round2(subtotal)
        computed_total = round2(subtotal * (1 - as_f(payload.discount_percent) / 100.0))
        total = manual_final if manual_final is not None else computed_total

        pay_cash_in = round2(as_f(payload.payment_cash))
        pay_online_in = round2(as_f(payload.payment_online))
        pay_credit_in = round2(as_f(getattr(payload, "payment_credit", 0.0)))
        if payload.payment_mode == "credit":
            cash, online, credit = 0.0, 0.0, total
        elif payload.payment_mode == "cash":
            if pay_cash_in != total:
                raise HTTPException(status_code=400, detail="payment_cash must equal total_amount")
            cash, online, credit = total, 0.0, 0.0
        elif payload.payment_mode == "online":
            if pay_online_in != total:
                raise HTTPException(status_code=400, detail="payment_online must equal total_amount")
            cash, online, credit = 0.0, total, 0.0
        else:
            if pay_credit_in < 0:
                raise HTTPException(status_code=400, detail="payment_credit cannot be negative")
            if round2(pay_cash_in + pay_online_in + pay_credit_in) != total:
                raise HTTPException(
                    status_code=400,
                    detail="Cash + Online + Credit must equal total_amount"
                )
            cash, online, credit = pay_cash_in, pay_online_in, pay_credit_in

        # Preserve payment history integrity: allow edit only when no manual receipts exist.
        pays = session.exec(select(BillPayment).where(BillPayment.bill_id == b.id)).all()
        manual_receipts = [
            p for p in pays
            if str(getattr(p, "note", "") or "") != "auto: payment at bill creation"
        ]
        if manual_receipts:
            raise HTTPException(
                status_code=400,
                detail="Bill has received payments. Edit is blocked to prevent payment history mismatch."
            )

        for iid, itm in db_items.items():
            old_qty = old_qty_by_item.get(iid, 0)
            new_qty = new_qty_by_item.get(iid, 0)
            available_for_edit = as_i(itm.stock) + old_qty
            if new_qty > available_for_edit:
                raise HTTPException(status_code=400, detail=f"Insufficient stock for {itm.name}")

        now_iso = now_ts()
        paid_now = round2(cash + online)
        has_credit_component = round2(total - paid_now) > 0
        is_credit = payload.payment_mode == "credit" or has_credit_component
        if paid_now <= 0:
            status = "UNPAID"
            paid_at = None
        elif paid_now + 0.0001 < total:
            status = "PARTIAL"
            paid_at = now_iso
        else:
            status = "PAID"
            paid_at = now_iso
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

            for p in pays:
                session.delete(p)
            if paid_now > 0:
                session.add(BillPayment(
                    bill_id=b.id,
                    received_at=now_iso,
                    mode=payload.payment_mode,
                    cash_amount=cash,
                    online_amount=online,
                    note="auto: payment at bill creation",
                ))

            b.discount_percent = payload.discount_percent
            b.subtotal = subtotal
            b.total_amount = total
            b.payment_mode = payload.payment_mode
            b.payment_cash = cash
            b.payment_online = online
            b.notes = payload.notes
            b.is_credit = is_credit
            b.payment_status = status
            b.paid_amount = paid_amount
            b.paid_at = paid_at

            session.add(b)
            session.commit()
            session.refresh(b)
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
            paid_at=b.paid_at,
            is_deleted=b.is_deleted,
            deleted_at=b.deleted_at,
            items=[BillItemOut(
                item_id=i.item_id,
                item_name=i.item_name,
                mrp=i.mrp,
                quantity=i.quantity,
                line_total=i.line_total,
            ) for i in items]
        )


@router.delete("/{bill_id}")
def soft_delete_bill(bill_id: int):
    with get_session() as session:
        b = session.get(Bill, bill_id)
        if not b:
            raise HTTPException(status_code=404, detail="Bill not found")

        if is_deleted_bill(b):
            return {"bill_id": b.id, "is_deleted": True, "deleted_at": b.deleted_at}

        b.is_deleted = True
        b.deleted_at = now_ts()
        session.add(b)
        session.commit()
        return {"bill_id": b.id, "is_deleted": True, "deleted_at": b.deleted_at}


@router.post("/{bill_id}/recover")
def recover_bill(bill_id: int):
    with get_session() as session:
        b = session.get(Bill, bill_id)
        if not b:
            raise HTTPException(status_code=404, detail="Bill not found")

        b.is_deleted = False
        b.deleted_at = None
        session.add(b)
        session.commit()
        return {"bill_id": b.id, "is_deleted": False, "deleted_at": None}


# ------------------ Receive Payment on Credit Bill ------------------

class ReceivePaymentIn(BaseModel):
    mode: str  # "cash" | "online" | "split"
    cash_amount: float = 0.0
    online_amount: float = 0.0
    note: Optional[str] = None


@router.post("/{bill_id}/receive-payment")
def receive_payment(bill_id: int, payload: ReceivePaymentIn):
    """
    ✅ Future-bug-proofing:
    - Inserts BillPayment (source of truth)
    - Recomputes Bill totals from BillPayment rows (prevents drift / double counting forever)
    """
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

    now_iso = now_ts()

    with get_session() as session:
        b = session.get(Bill, bill_id)
        if not b:
            raise HTTPException(status_code=404, detail="Bill not found")
        if is_deleted_bill(b):
            raise HTTPException(status_code=400, detail="Cannot receive payment on deleted bill")

        # 1) Insert payment record (THIS is the source of truth for "Collected Today")
        p = BillPayment(
            bill_id=bill_id,
            received_at=now_iso,
            mode=payload.mode,
            cash_amount=cash,
            online_amount=online,
            note=payload.note
        )
        session.add(p)
        session.commit()

        # 2) Recalculate totals from all BillPayment rows (prevents future inconsistencies)
        pays = session.exec(select(BillPayment).where(BillPayment.bill_id == bill_id)).all()

        total_cash = round2(sum(as_f(x.cash_amount) for x in pays))
        total_online = round2(sum(as_f(x.online_amount) for x in pays))
        total_paid = round2(total_cash + total_online)

        # Keep Bill fields aligned with payments history
        b.payment_cash = total_cash
        b.payment_online = total_online
        b.paid_amount = total_paid

        # 3) Decide status (UNPAID / PARTIAL / PAID)
        total_amount = round2(as_f(b.total_amount))

        if total_paid <= 0:
            b.payment_status = "UNPAID"
            b.paid_at = None
            b.is_credit = True
        elif total_paid + 0.0001 < total_amount:
            b.payment_status = "PARTIAL"
            b.paid_at = None
            b.is_credit = True
        else:
            b.payment_status = "PAID"
            b.paid_at = now_iso
            b.is_credit = False

        session.add(b)
        session.commit()

        return {
            "bill_id": b.id,
            "payment_status": b.payment_status,
            "paid_amount": b.paid_amount,
            "total_amount": b.total_amount,
            "pending_amount": round2(max(0.0, total_amount - total_paid))
        }


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

        return [
            {
                "id": p.id,
                "bill_id": p.bill_id,
                "received_at": p.received_at,
                "mode": p.mode,
                "cash_amount": p.cash_amount,
                "online_amount": p.online_amount,
                "note": p.note,
            }
            for p in pays
        ]


# ------------------ Dashboard helper: Payments Summary (Collected Today) ------------------

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
        stmt = (
            select(BillPayment)
            .join(Bill, Bill.id == BillPayment.bill_id)
            .order_by(BillPayment.id.desc())
        )
        if deleted_filter == "active":
            stmt = stmt.where(Bill.is_deleted == False)  # noqa: E712
        elif deleted_filter == "deleted":
            stmt = stmt.where(Bill.is_deleted == True)  # noqa: E712

        pays = session.exec(stmt).all()

        if from_date:
            pays = [p for p in pays if iso_date(p.received_at) >= from_date]
        if to_date:
            pays = [p for p in pays if iso_date(p.received_at) <= to_date]

        cash = round2(sum(as_f(p.cash_amount) for p in pays))
        online = round2(sum(as_f(p.online_amount) for p in pays))
        total = round2(cash + online)

        return {
            "cash_collected": cash,
            "online_collected": online,
            "total_collected": total,
            "count": len(pays),
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
        else:
            period_expr = func.substr(BillPayment.received_at, 1, 10)  # YYYY-MM-DD

        stmt = (
            select(
                period_expr.label("period"),
                func.count(BillPayment.id).label("payments_count"),
                func.coalesce(func.sum(BillPayment.cash_amount), 0).label("cash_total"),
                func.coalesce(func.sum(BillPayment.online_amount), 0).label("online_total"),
            )
            .select_from(BillPayment)
            .join(Bill, Bill.id == BillPayment.bill_id)
            .where(BillPayment.received_at >= start_ts)
            .where(BillPayment.received_at <= end_ts)
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
            cash = round2(as_f(r.cash_total))
            online = round2(as_f(r.online_total))
            total = round2(cash + online)

            out.append({
                "period": r.period,
                "payments_count": int(r.payments_count or 0),
                "cash_total": cash,
                "online_total": online,
                "total_collected": total,
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
                func.coalesce(func.sum(Bill.paid_amount), 0).label("paid_total"),
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
