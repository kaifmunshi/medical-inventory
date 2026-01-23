# F:\medical-inventory\backend\routers\returns.py

from fastapi import APIRouter, HTTPException, Query
from typing import List, Optional, Dict
from sqlmodel import select
from datetime import datetime

from backend.db import get_session
from backend.models import (
    Item, Bill, BillItem,
    Return, ReturnItem,
    ReturnCreate, ReturnOut, ReturnItemOut,
    ExchangeCreate,
    StockMovement,
)

router = APIRouter()


def round2(x: float) -> float:
    return float(f"{x:.2f}")


# Allow manual round-off near the computed amount
ROUND_TOLERANCE = 5.0  # e.g., 104.35 → any refund between ~99.35 and ~109.35 is OK


def now_ts() -> str:
    return datetime.now().isoformat(timespec="seconds")


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


# ---------- helpers ----------

def sold_map_for_bill(session, bill_id: int) -> Dict[int, int]:
    """item_id -> sold qty (from BillItem)"""
    out: Dict[int, int] = {}
    bill_items = session.exec(select(BillItem).where(BillItem.bill_id == bill_id)).all()
    for bi in bill_items:
        out[bi.item_id] = out.get(bi.item_id, 0) + int(bi.quantity)
    return out


def already_returned_map_for_bill(session, bill_id: int) -> Dict[int, int]:
    """item_id -> sum of quantities already returned for this bill"""
    out: Dict[int, int] = {}
    rets = session.exec(select(Return).where(Return.source_bill_id == bill_id)).all()
    for r in rets:
        items = session.exec(select(ReturnItem).where(ReturnItem.return_id == r.id)).all()
        for ri in items:
            out[ri.item_id] = out.get(ri.item_id, 0) + int(ri.quantity)
    return out


# -------------------- RETURNS --------------------

@router.get("/", response_model=List[ReturnOut])
def list_returns(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)"),
):
    with get_session() as session:
        stmt = select(Return).order_by(Return.id.desc()).limit(limit).offset(offset)
        rows = session.exec(stmt).all()

        # lightweight filter (keeps your old behavior)
        if from_date:
            rows = [r for r in rows if r.date_time[:10] >= from_date]
        if to_date:
            rows = [r for r in rows if r.date_time[:10] <= to_date]

        out: List[ReturnOut] = []
        for r in rows:
            items = session.exec(select(ReturnItem).where(ReturnItem.return_id == r.id)).all()
            out.append(
                ReturnOut(
                    id=r.id,
                    date_time=r.date_time,
                    source_bill_id=r.source_bill_id,
                    subtotal_return=r.subtotal_return,
                    refund_cash=r.refund_cash,
                    refund_online=r.refund_online,
                    notes=r.notes,
                    rounding_adjustment=getattr(r, "rounding_adjustment", 0.0),
                    items=[
                        ReturnItemOut(
                            item_id=i.item_id,
                            item_name=i.item_name,
                            mrp=i.mrp,
                            quantity=i.quantity,
                            line_total=i.line_total,
                        )
                        for i in items
                    ],
                )
            )
        return out


# ✅ IMPORTANT: summary MUST be defined before "/{return_id}" or it gets swallowed!
@router.get("/summary/{bill_id}", response_model=List[dict])
def bill_return_summary(bill_id: int):
    """
    Returns per item:
    sold, already_returned, remaining
    Used by Returns + Exchange UI to prevent over-returning.
    """
    with get_session() as session:
        bill = session.get(Bill, bill_id)
        if not bill:
            raise HTTPException(status_code=404, detail="Bill not found")

        sold = sold_map_for_bill(session, bill_id)
        already = already_returned_map_for_bill(session, bill_id)

        rows = session.exec(select(BillItem).where(BillItem.bill_id == bill_id)).all()
        out = []
        for bi in rows:
            s = sold.get(bi.item_id, 0)
            a = already.get(bi.item_id, 0)
            remaining = max(0, s - a)
            out.append({
                "item_id": bi.item_id,
                "item_name": bi.item_name,
                "mrp": bi.mrp,
                "sold": s,
                "already_returned": a,
                "remaining": remaining,
            })
        return out


@router.get("/{return_id}", response_model=ReturnOut)
def get_return(return_id: int):
    with get_session() as session:
        r = session.get(Return, return_id)
        if not r:
            raise HTTPException(status_code=404, detail="Return not found")
        items = session.exec(select(ReturnItem).where(ReturnItem.return_id == r.id)).all()
        return ReturnOut(
            id=r.id,
            date_time=r.date_time,
            source_bill_id=r.source_bill_id,
            subtotal_return=r.subtotal_return,
            refund_cash=r.refund_cash,
            refund_online=r.refund_online,
            notes=r.notes,
            rounding_adjustment=getattr(r, "rounding_adjustment", 0.0),
            items=[
                ReturnItemOut(
                    item_id=i.item_id,
                    item_name=i.item_name,
                    mrp=i.mrp,
                    quantity=i.quantity,
                    line_total=i.line_total,
                )
                for i in items
            ],
        )


@router.post("/", response_model=ReturnOut, status_code=201)
def create_return(payload: ReturnCreate):
    if not payload.items:
        raise HTTPException(status_code=400, detail="Return must have at least one item")
    if payload.refund_mode not in {"cash", "online", "split"}:
        raise HTTPException(status_code=400, detail="Invalid refund_mode")

    with get_session() as session:
        sold_lookup: Dict[int, int] = {}
        returned_lookup: Dict[int, int] = {}
        bill = None
        disc_pct = 0.0
        tax_pct = 0.0
        factor = 1.0  # final_total / computed_total

        if payload.source_bill_id:
            bill = session.get(Bill, payload.source_bill_id)
            if not bill:
                raise HTTPException(status_code=404, detail="Source bill not found")

            sold_lookup = sold_map_for_bill(session, bill.id)
            returned_lookup = already_returned_map_for_bill(session, bill.id)

            # bill-level proration (mirror frontend)
            try:
                disc_pct = float(getattr(bill, "discount_percent", 0.0) or 0.0)
                tax_pct = float(getattr(bill, "tax_percent", 0.0) or 0.0)
            except Exception:
                disc_pct, tax_pct = 0.0, 0.0

            try:
                if hasattr(bill, "subtotal") and bill.subtotal is not None:
                    subtotal_bill = float(bill.subtotal)
                else:
                    subtotal_bill = 0.0
                    for iid, qty in sold_lookup.items():
                        it = session.get(Item, iid)
                        if it:
                            subtotal_bill += float(it.mrp) * int(qty)

                after_disc_bill = subtotal_bill * (1 - disc_pct / 100.0)
                computed_total = after_disc_bill * (1 + tax_pct / 100.0)
                final_total = float(getattr(bill, "total_amount", computed_total) or computed_total)
                factor = (final_total / computed_total) if computed_total > 0 else 1.0
            except Exception:
                factor = 1.0

        # ----- compute subtotal_return using remaining qty -----
        subtotal_return = 0.0
        db_items: Dict[int, Item] = {}

        for line in payload.items:
            if line.quantity <= 0:
                raise HTTPException(status_code=400, detail="Quantity must be > 0")
            itm = session.get(Item, line.item_id)
            if not itm:
                raise HTTPException(status_code=404, detail=f"Item {line.item_id} not found")

            # Prevent returning more than sold - already_returned
            if sold_lookup:
                sold = sold_lookup.get(itm.id, 0)
                already_ret = returned_lookup.get(itm.id, 0)
                remaining = max(0, sold - already_ret)
                if remaining <= 0:
                    raise HTTPException(status_code=400, detail=f"No remaining qty to return for {itm.name}")
                if line.quantity > remaining:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Return qty exceeds remaining for {itm.name} (remaining {remaining})"
                    )

            db_items[line.item_id] = itm

            base = float(itm.mrp) * int(line.quantity)
            if bill:
                after_disc = base * (1 - disc_pct / 100.0)
                after_tax = after_disc * (1 + tax_pct / 100.0)
                charged = after_tax * factor
                subtotal_return += charged
            else:
                subtotal_return += base

        subtotal_return = round2(subtotal_return)

        # ----- validate refund with tolerance -----
        if payload.refund_mode == "cash":
            rc, ro = round2(payload.refund_cash), 0.0
            if abs(rc - subtotal_return) > ROUND_TOLERANCE:
                raise HTTPException(
                    status_code=400,
                    detail=f"refund_cash deviates from computed subtotal by more than ₹{int(ROUND_TOLERANCE)}"
                )
        elif payload.refund_mode == "online":
            rc, ro = 0.0, round2(payload.refund_online)
            if abs(ro - subtotal_return) > ROUND_TOLERANCE:
                raise HTTPException(
                    status_code=400,
                    detail=f"refund_online deviates from computed subtotal by more than ₹{int(ROUND_TOLERANCE)}"
                )
        else:
            rc, ro = round2(payload.refund_cash), round2(payload.refund_online)
            if abs(round2(rc + ro) - subtotal_return) > ROUND_TOLERANCE:
                raise HTTPException(
                    status_code=400,
                    detail=f"Cash + Online deviates from computed subtotal by more than ₹{int(ROUND_TOLERANCE)}"
                )

        # ----- save Return header -----
        r = Return(
            source_bill_id=payload.source_bill_id,
            subtotal_return=subtotal_return,
            refund_cash=rc,
            refund_online=ro,
            notes=payload.notes,
        )
        session.add(r)
        session.commit()
        session.refresh(r)

        # ----- save Return items + restock + ledger -----
        try:
            for line in payload.items:
                itm = db_items[line.item_id]
                qty = int(line.quantity)

                # restock
                itm.stock += qty
                session.add(itm)

                # Ledger: RETURN (stock IN)
                add_movement(
                    session,
                    item_id=itm.id,
                    delta=qty,
                    reason="RETURN",
                    ref_type="RETURN",
                    ref_id=r.id,
                    note=f"Return #{r.id}",
                )

                line_total = float(itm.mrp) * qty
                if bill:
                    after_disc = line_total * (1 - disc_pct / 100.0)
                    after_tax = after_disc * (1 + tax_pct / 100.0)
                    line_total = after_tax * factor

                session.add(ReturnItem(
                    return_id=r.id,
                    item_id=itm.id,
                    item_name=itm.name,
                    mrp=float(itm.mrp),
                    quantity=qty,
                    line_total=round2(line_total)
                ))

            session.commit()
        except Exception as e:
            session.rollback()
            raise HTTPException(status_code=500, detail=f"Failed to create return: {e}")

        items = session.exec(select(ReturnItem).where(ReturnItem.return_id == r.id)).all()
        return ReturnOut(
            id=r.id,
            date_time=r.date_time,
            source_bill_id=r.source_bill_id,
            subtotal_return=r.subtotal_return,
            refund_cash=r.refund_cash,
            refund_online=r.refund_online,
            notes=r.notes,
            rounding_adjustment=getattr(r, "rounding_adjustment", 0.0),
            items=[
                ReturnItemOut(
                    item_id=i.item_id,
                    item_name=i.item_name,
                    mrp=i.mrp,
                    quantity=i.quantity,
                    line_total=i.line_total,
                )
                for i in items
            ],
        )


# -------------------- EXCHANGE --------------------
# NOTE: You can delete this whole endpoint in future. Returns logic remains perfect.

# ✅ accept trailing slash to match frontend: "/returns/exchange/"
@router.post("/exchange/", response_model=dict, status_code=201)
def create_exchange(payload: ExchangeCreate):
    """
    Creates BOTH a Return and a new Bill in one flow.
    Validates net payable/refundable and adjusts stock accordingly.
    Returns: { return: ReturnOut, bill: BillOut-like dict, net_due }
    """
    if not payload.return_items:
        raise HTTPException(status_code=400, detail="Exchange must include return_items")
    if not payload.new_items:
        raise HTTPException(status_code=400, detail="Exchange must include new_items")
    if payload.discount_percent < 0 or payload.discount_percent > 100:
        raise HTTPException(status_code=400, detail="Discount must be between 0 and 100")
    if payload.payment_mode not in {"cash", "online", "split"}:
        raise HTTPException(status_code=400, detail="Invalid payment_mode")

    with get_session() as session:
        sold_lookup = {}
        returned_lookup = {}
        bill = None
        disc_pct = 0.0
        tax_pct = 0.0
        factor = 1.0

        if payload.source_bill_id:
            bill = session.get(Bill, payload.source_bill_id)
            if not bill:
                raise HTTPException(status_code=404, detail="Source bill not found")

            sold_lookup = sold_map_for_bill(session, bill.id)
            returned_lookup = already_returned_map_for_bill(session, bill.id)

            try:
                disc_pct = float(getattr(bill, "discount_percent", 0.0) or 0.0)
                tax_pct = float(getattr(bill, "tax_percent", 0.0) or 0.0)
            except Exception:
                disc_pct, tax_pct = 0.0, 0.0

            try:
                if hasattr(bill, "subtotal") and bill.subtotal is not None:
                    subtotal_bill = float(bill.subtotal)
                else:
                    subtotal_bill = 0.0
                    for iid, qty in sold_lookup.items():
                        it = session.get(Item, iid)
                        if it:
                            subtotal_bill += float(it.mrp) * int(qty)

                after_disc_bill = subtotal_bill * (1 - disc_pct / 100.0)
                computed_total = after_disc_bill * (1 + tax_pct / 100.0)
                final_total = float(getattr(bill, "total_amount", computed_total) or computed_total)
                factor = (final_total / computed_total) if computed_total > 0 else 1.0
            except Exception:
                factor = 1.0

        # 1) Compute return subtotal using remaining qty
        return_subtotal = 0.0
        ret_items_map = {}  # item_id -> (Item, qty)
        for line in payload.return_items:
            itm = session.get(Item, line.item_id)
            if not itm:
                raise HTTPException(status_code=404, detail=f"Return item {line.item_id} not found")
            if line.quantity <= 0:
                raise HTTPException(status_code=400, detail="Return quantity must be > 0")

            if sold_lookup:
                sold = sold_lookup.get(itm.id, 0)
                already = returned_lookup.get(itm.id, 0)
                remaining = max(0, sold - already)
                if remaining <= 0:
                    raise HTTPException(status_code=400, detail=f"No remaining qty to return for {itm.name}")
                if line.quantity > remaining:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Return qty exceeds remaining for {itm.name} (remaining {remaining})"
                    )

            ret_items_map[itm.id] = (itm, int(line.quantity))

            base = float(itm.mrp) * int(line.quantity)
            if bill:
                after_disc = base * (1 - disc_pct / 100.0)
                after_tax = after_disc * (1 + tax_pct / 100.0)
                charged = after_tax * factor
            else:
                charged = base
            return_subtotal += charged

        return_subtotal = round2(return_subtotal)

        # 2) Compute new bill totals and stock check
        new_items_map = {}
        bill_subtotal = 0.0
        for line in payload.new_items:
            itm = session.get(Item, line.item_id)
            if not itm:
                raise HTTPException(status_code=404, detail=f"New item {line.item_id} not found")
            if line.quantity <= 0:
                raise HTTPException(status_code=400, detail="New item quantity must be > 0")
            if itm.stock < line.quantity:
                raise HTTPException(status_code=400, detail=f"Insufficient stock for {itm.name}")
            new_items_map[itm.id] = (itm, int(line.quantity))
            bill_subtotal += int(line.quantity) * float(itm.mrp)

        bill_subtotal = round2(bill_subtotal)
        bill_total = round2(bill_subtotal * (1 - payload.discount_percent / 100.0))

        # 3) Theoretical net due (no manual rounding)
        theoretical_net = round2(bill_total - return_subtotal)

        rounding_adjustment = round2(getattr(payload, "rounding_adjustment", 0.0) or 0.0)
        net_due = round2(theoretical_net + rounding_adjustment)

        # Validate payment/refund fields
        if net_due > 0:
            if payload.payment_mode == "cash":
                ok = round2(payload.payment_cash) == net_due
            elif payload.payment_mode == "online":
                ok = round2(payload.payment_online) == net_due
            else:
                ok = round2(payload.payment_cash + payload.payment_online) == net_due
            if not ok:
                raise HTTPException(status_code=400, detail="Payment amounts must equal net due")
            r_cash, r_online = 0.0, 0.0
            b_cash = round2(payload.payment_cash)
            b_online = round2(payload.payment_online)
        elif net_due < 0:
            refund_total = round2(payload.refund_cash + payload.refund_online)
            if refund_total != abs(net_due):
                raise HTTPException(status_code=400, detail="Refund amounts must equal |net due|")
            r_cash, r_online = round2(payload.refund_cash), round2(payload.refund_online)
            b_cash, b_online = 0.0, 0.0
        else:
            r_cash = r_online = b_cash = b_online = 0.0

        # 4) Create Return + add stock, then create Bill + deduct stock
        ret = Return(
            source_bill_id=payload.source_bill_id,
            subtotal_return=return_subtotal,
            refund_cash=r_cash,
            refund_online=r_online,
            notes=payload.notes,
            rounding_adjustment=rounding_adjustment,
        )

        session.add(ret)
        session.commit()
        session.refresh(ret)

        # return items: stock IN + ledger
        for itm, qty in ret_items_map.values():
            itm.stock += qty
            session.add(itm)

            add_movement(
                session,
                item_id=itm.id,
                delta=qty,
                reason="EXCHANGE_IN",
                ref_type="EXCHANGE",
                ref_id=ret.id,
                note=f"Exchange return #{ret.id}",
            )

            base = float(itm.mrp) * qty
            if bill:
                after_disc = base * (1 - disc_pct / 100.0)
                after_tax = after_disc * (1 + tax_pct / 100.0)
                line_total = after_tax * factor
            else:
                line_total = base

            session.add(ReturnItem(
                return_id=ret.id, item_id=itm.id, item_name=itm.name,
                mrp=itm.mrp, quantity=qty, line_total=round2(line_total)
            ))
        session.commit()

        # create new bill (exchange)
        b = Bill(
            discount_percent=payload.discount_percent,
            subtotal=bill_subtotal,
            total_amount=bill_total,
            payment_mode=payload.payment_mode,
            payment_cash=b_cash,
            payment_online=b_online,
            notes=payload.notes
        )
        session.add(b)
        session.commit()
        session.refresh(b)

        # new items: stock OUT + ledger
        for itm, qty in new_items_map.values():
            if itm.stock < qty:
                raise HTTPException(status_code=400, detail=f"Insufficient stock during exchange for {itm.name}")
            itm.stock -= qty
            session.add(itm)

            add_movement(
                session,
                item_id=itm.id,
                delta=-qty,
                reason="EXCHANGE_OUT",
                ref_type="EXCHANGE",
                ref_id=b.id,
                note=f"Exchange bill #{b.id}",
            )

            session.add(BillItem(
                bill_id=b.id, item_id=itm.id, item_name=itm.name,
                mrp=itm.mrp, quantity=qty, line_total=round2(qty * itm.mrp)
            ))
        session.commit()

        ret_items = session.exec(select(ReturnItem).where(ReturnItem.return_id == ret.id)).all()
        bill_items = session.exec(select(BillItem).where(BillItem.bill_id == b.id)).all()

        return {
            "net_due": net_due,
            "theoretical_net": theoretical_net,
            "rounding_adjustment": rounding_adjustment,
            "return": ReturnOut(
                id=ret.id,
                date_time=ret.date_time,
                source_bill_id=ret.source_bill_id,
                subtotal_return=ret.subtotal_return,
                refund_cash=ret.refund_cash,
                refund_online=ret.refund_online,
                notes=ret.notes,
                rounding_adjustment=getattr(ret, "rounding_adjustment", 0.0),
                items=[
                    {
                        "item_id": i.item_id,
                        "item_name": i.item_name,
                        "mrp": i.mrp,
                        "quantity": i.quantity,
                        "line_total": i.line_total
                    } for i in ret_items
                ],
            ),
            "bill": {
                "id": b.id,
                "date_time": b.date_time,
                "discount_percent": b.discount_percent,
                "subtotal": b.subtotal,
                "total_amount": b.total_amount,
                "payment_mode": b.payment_mode,
                "payment_cash": b.payment_cash,
                "payment_online": b.payment_online,
                "notes": b.notes,
                "items": [
                    {
                        "item_id": i.item_id,
                        "item_name": i.item_name,
                        "mrp": i.mrp,
                        "quantity": i.quantity,
                        "line_total": i.line_total,
                    }
                    for i in bill_items
                ],
            },
        }
