# F:\medical-inventory\backend\routers\billing.py
from fastapi import APIRouter, HTTPException, Query
from typing import List, Optional
from datetime import datetime

from sqlmodel import select
from backend.db import get_session
from backend.models import (
    Item, Bill, BillItem,
    BillCreate, BillOut, BillItemOut
)

router = APIRouter()

def round2(x: float) -> float:
    return float(f"{x:.2f}")

@router.get("/", response_model=List[BillOut])
def list_bills(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)")
):
    with get_session() as session:
        stmt = select(Bill).order_by(Bill.id.desc()).limit(limit).offset(offset)
        rows = session.exec(stmt).all()

        # simple date filter (string compare is fine with ISO if provided)
        if from_date:
            rows = [b for b in rows if b.date_time[:10] >= from_date]
        if to_date:
            rows = [b for b in rows if b.date_time[:10] <= to_date]

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
                items=[BillItemOut(
                    item_id=i.item_id, item_name=i.item_name,
                    mrp=i.mrp, quantity=i.quantity, line_total=i.line_total
                ) for i in items]
            ))
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
            items=[BillItemOut(
                item_id=i.item_id, item_name=i.item_name,
                mrp=i.mrp, quantity=i.quantity, line_total=i.line_total
            ) for i in items]
        )

@router.post("/", response_model=BillOut, status_code=201)
def create_bill(payload: BillCreate):
    if not payload.items:
        raise HTTPException(status_code=400, detail="Bill must have at least one item")
    if payload.discount_percent < 0 or payload.discount_percent > 100:
        raise HTTPException(status_code=400, detail="Discount must be between 0 and 100")
    if payload.payment_mode not in {"cash", "online", "split"}:
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
        if payload.payment_mode == "cash":
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

        # 4) Create Bill + BillItems and deduct stock (transaction-like)
        b = Bill(
            discount_percent=payload.discount_percent,
            subtotal=subtotal,
            total_amount=total,  # store final (manual or computed)
            payment_mode=payload.payment_mode,
            payment_cash=cash,
            payment_online=online,
            notes=payload.notes
        )
        session.add(b)
        session.commit()       # to get bill id
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

        except Exception as e:
            # rollback by restoring stock if anything failed after bill insert
            session.rollback()
            # reload items and restore
            for line in payload.items:
                itm = session.get(Item, line.item_id)
                if itm:
                    itm.stock += line.quantity
                    session.add(itm)
            session.commit()
            raise HTTPException(status_code=500, detail=f"Failed to create bill: {e}")

        # 5) Return full bill with items
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
            items=[BillItemOut(
                item_id=i.item_id, item_name=i.item_name,
                mrp=i.mrp, quantity=i.quantity, line_total=i.line_total
            ) for i in items]
        )
