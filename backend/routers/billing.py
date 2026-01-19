# F:\medical-inventory\backend\routers\billing.py

from fastapi import APIRouter, HTTPException, Query
from typing import List, Optional, Dict, Any
from datetime import datetime
from pydantic import BaseModel
from sqlmodel import select
from sqlalchemy import or_, exists, func


from backend.db import get_session
from backend.models import (
    Item, Bill, BillItem, BillPayment,
    BillCreate, BillOut, BillItemOut
)

router = APIRouter()


def round2(x: float) -> float:
    return float(f"{x:.2f}")


def iso_date(s: Optional[str]) -> str:
    """
    Extract YYYY-MM-DD from an ISO string safely.
    """
    if not s:
        return ""
    ss = str(s)
    return ss[:10] if len(ss) >= 10 else ss


# ✅ Paginated response for reports/infinite scroll (new)
class BillPageOut(BaseModel):
    items: List[BillOut]
    next_offset: Optional[int] = None


@router.get("/", response_model=List[BillOut])
def list_bills(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)")
):
    """
    Backward-compatible endpoint (returns plain array).
    Keep this as-is because other frontend screens may already rely on it.
    """
    with get_session() as session:
        stmt = select(Bill).order_by(Bill.id.desc()).limit(limit).offset(offset)
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

                items=[BillItemOut(
                    item_id=i.item_id,
                    item_name=i.item_name,
                    mrp=i.mrp,
                    quantity=i.quantity,
                    line_total=i.line_total
                ) for i in items]
            ))
        return out


# ✅ New paged endpoint for Reports infinite scroll
@router.get("/paged", response_model=BillPageOut)
def list_bills_paged(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)"),
    q: Optional[str] = Query(None, description="Search by id/item/notes"),
):
    with get_session() as session:
        stmt = select(Bill)

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

                # ✅ credit fields
                is_credit=b.is_credit,
                payment_status=b.payment_status,
                paid_amount=b.paid_amount,
                paid_at=b.paid_at,

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

            # ✅ credit fields
            is_credit=b.is_credit,
            payment_status=b.payment_status,
            paid_amount=b.paid_amount,
            paid_at=b.paid_at,

            items=[BillItemOut(
                item_id=i.item_id,
                item_name=i.item_name,
                mrp=i.mrp,
                quantity=i.quantity,
                line_total=i.line_total
            ) for i in items]
        )


@router.post("/", response_model=BillOut, status_code=201)
def create_bill(payload: BillCreate):
    if not payload.items:
        raise HTTPException(status_code=400, detail="Bill must have at least one item")
    if payload.discount_percent < 0 or payload.discount_percent > 100:
        raise HTTPException(status_code=400, detail="Discount must be between 0 and 100")
    if payload.payment_mode not in {"cash", "online", "split", "credit"}:
        raise HTTPException(status_code=400, detail="Invalid payment_mode")

    # NEW: read optional manual final amount (will work even if model ignores extra fields)
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
        db_items = {}
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
            subtotal += (line.quantity * itm.mrp)

        subtotal = round2(subtotal)
        computed_total = round2(subtotal * (1 - payload.discount_percent / 100.0))

        # 2) Use manual override if provided; else computed total
        total = manual_final if manual_final is not None else computed_total

        # 3) Validate payment split (against chosen total)
        if payload.payment_mode == "credit":
            # credit bill: no payment now
            cash, online = 0.0, 0.0
        elif payload.payment_mode == "cash":
            if round2(payload.payment_cash) != total:
                raise HTTPException(status_code=400, detail="payment_cash must equal total_amount")
            cash, online = total, 0.0
        elif payload.payment_mode == "online":
            if round2(payload.payment_online) != total:
                raise HTTPException(status_code=400, detail="payment_online must equal total_amount")
            cash, online = 0.0, total
        else:  # split
            if round2(payload.payment_cash + payload.payment_online) != total:
                raise HTTPException(status_code=400, detail="Cash + Online must equal total_amount")
            cash, online = round2(payload.payment_cash), round2(payload.payment_online)

        # 4) Create Bill + BillItems and deduct stock
        now_iso = datetime.now().isoformat(timespec="seconds")

        is_credit = payload.payment_mode == "credit"
        status = "UNPAID" if is_credit else "PAID"
        paid_amount = 0.0 if is_credit else total
        paid_at = None if is_credit else now_iso

        b = Bill(
            discount_percent=payload.discount_percent,
            subtotal=subtotal,
            total_amount=total,
            payment_mode=payload.payment_mode,
            payment_cash=cash,
            payment_online=online,
            notes=payload.notes,

            # ✅ credit tracking
            is_credit=is_credit,
            payment_status=status,
            paid_amount=paid_amount,
            paid_at=paid_at
        )

        session.add(b)
        session.commit()
        session.refresh(b)

        try:
            # Deduct stock & create line items
            for line in payload.items:
                itm = db_items[line.item_id]
                itm.stock -= line.quantity
                session.add(itm)

                bi = BillItem(
                    bill_id=b.id,
                    item_id=itm.id,
                    item_name=itm.name,
                    mrp=itm.mrp,
                    quantity=line.quantity,
                    line_total=round2(line.quantity * itm.mrp)
                )
                session.add(bi)

            session.commit()

            # ✅ If not credit, create a BillPayment for reporting "Collected Today"
            if not is_credit:
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

        except Exception as e:
            session.rollback()
            # restore stock
            for line in payload.items:
                itm = session.get(Item, line.item_id)
                if itm:
                    itm.stock += line.quantity
                    session.add(itm)
            session.commit()
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

            items=[BillItemOut(
                item_id=i.item_id,
                item_name=i.item_name,
                mrp=i.mrp,
                quantity=i.quantity,
                line_total=i.line_total
            ) for i in items]
        )


# ------------------ Receive Payment on Credit Bill ------------------

class ReceivePaymentIn(BaseModel):
    mode: str  # "cash" | "online" | "split"
    cash_amount: float = 0.0
    online_amount: float = 0.0
    note: Optional[str] = None


@router.post("/{bill_id}/receive-payment")
def receive_payment(bill_id: int, payload: ReceivePaymentIn):
    if payload.mode not in {"cash", "online", "split"}:
        raise HTTPException(status_code=400, detail="Invalid mode")

    cash = round2(payload.cash_amount or 0.0)
    online = round2(payload.online_amount or 0.0)

    if payload.mode == "cash" and online != 0:
        raise HTTPException(status_code=400, detail="For cash mode, online_amount must be 0")
    if payload.mode == "online" and cash != 0:
        raise HTTPException(status_code=400, detail="For online mode, cash_amount must be 0")
    if payload.mode == "split" and (cash + online) <= 0:
        raise HTTPException(status_code=400, detail="Split payment must have some amount")

    if payload.mode != "split" and (cash + online) <= 0:
        raise HTTPException(status_code=400, detail="Payment amount must be > 0")

    now_iso = datetime.now().isoformat(timespec="seconds")

    with get_session() as session:
        b = session.get(Bill, bill_id)
        if not b:
            raise HTTPException(status_code=404, detail="Bill not found")

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

        # 2) Recalculate paid_amount from all BillPayment rows (cash + online)
        pays = session.exec(select(BillPayment).where(BillPayment.bill_id == bill_id)).all()
        total_paid = round2(sum((x.cash_amount or 0) + (x.online_amount or 0) for x in pays))
        b.paid_amount = total_paid

        # 3) ALSO maintain Bill.payment_cash / Bill.payment_online as "total collected for this bill"
        b.payment_cash = round2((b.payment_cash or 0.0) + cash)
        b.payment_online = round2((b.payment_online or 0.0) + online)

        # 4) Decide status (UNPAID / PARTIAL / PAID)
        if total_paid <= 0:
            b.payment_status = "UNPAID"
            b.paid_at = None
            b.is_credit = True
        elif total_paid + 0.0001 < b.total_amount:
            b.payment_status = "PARTIAL"
            b.paid_at = None
            b.is_credit = True
        else:
            b.payment_status = "PAID"
            b.paid_at = now_iso
            b.is_credit = False  # fully settled

        session.add(b)
        session.commit()

        return {
            "bill_id": b.id,
            "payment_status": b.payment_status,
            "paid_amount": b.paid_amount,
            "total_amount": b.total_amount,
            "pending_amount": round2(b.total_amount - b.paid_amount)
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
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)")
) -> Dict[str, Any]:
    """
    Dashboard needs "Collected Today" that includes:
    - payments collected from normal bills (auto BillPayment at bill creation)
    - payments collected later from credit bills (/receive-payment)

    So we aggregate from BillPayment.received_at (NOT from Bill rows).
    """
    with get_session() as session:
        pays = session.exec(select(BillPayment).order_by(BillPayment.id.desc())).all()

        if from_date:
            pays = [p for p in pays if iso_date(p.received_at) >= from_date]
        if to_date:
            pays = [p for p in pays if iso_date(p.received_at) <= to_date]

        cash = round2(sum(float(p.cash_amount or 0.0) for p in pays))
        online = round2(sum(float(p.online_amount or 0.0) for p in pays))
        total = round2(cash + online)

        return {
            "cash_collected": cash,
            "online_collected": online,
            "total_collected": total,
            "count": len(pays),
        }


# ------------------ Reports helper: Daily/Monthly Sales Aggregates ------------------

@router.get("/summary/aggregate")
def sales_aggregate(
    from_date: str = Query(..., description="YYYY-MM-DD"),
    to_date: str = Query(..., description="YYYY-MM-DD"),
    group_by: str = Query("day", pattern="^(day|month)$"),
) -> List[Dict[str, Any]]:
    """
    Returns aggregates grouped by day or month.

    NOTE:
    - gross_sales is based on Bill.total_amount (final billed amount)
    - paid_total is sum of Bill.paid_amount
    - pending_total = gross_sales - paid_total (clamped to >= 0)

    This is "sales view" (based on bills).
    If you want "collection view" (cash/online actually received), use BillPayment aggregation.
    """
    start_ts = f"{from_date}T00:00:00"
    end_ts = f"{to_date}T23:59:59"

    with get_session() as session:
        # SQLite-friendly period grouping from ISO string: "YYYY-MM-DDTHH:MM:SS"
        if group_by == "month":
            # YYYY-MM
            period_expr = func.substr(Bill.date_time, 1, 7)
        else:
            # YYYY-MM-DD
            period_expr = func.substr(Bill.date_time, 1, 10)

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

        rows = session.exec(stmt).all()

        out: List[Dict[str, Any]] = []
        for r in rows:
            gross = float(r.gross_sales or 0.0)
            paid = float(r.paid_total or 0.0)
            pending = max(0.0, gross - paid)

            out.append({
                "period": r.period,
                "bills_count": int(r.bills_count or 0),
                "gross_sales": round2(gross),
                "paid_total": round2(paid),
                "pending_total": round2(pending),
            })

        return out
