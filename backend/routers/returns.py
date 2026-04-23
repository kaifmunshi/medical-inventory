# F:\medical-inventory\backend\routers\returns.py

from fastapi import APIRouter, HTTPException, Query
from typing import List, Optional, Dict
from sqlmodel import select
from datetime import datetime
from backend.controls import assert_financial_year_unlocked
from backend.utils.archive_rules import apply_archive_rules
from backend.db import get_session
from backend.models import (
    Item, Bill, BillItem,
    Return, ReturnItem,
    ReturnCreate, ReturnOut, ReturnItemOut,
    ExchangeCreate,
    ExchangeRecord,
    StockMovement,
)

router = APIRouter()


def round2(x: float) -> float:
    return float(f"{x:.2f}")


# Allow manual round-off near the computed amount
ROUND_TOLERANCE = 5.0  # e.g., 104.35 → any refund between ~99.35 and ~109.35 is OK
MONEY_EPSILON = 0.01   # allow 1 paisa drift between FE/BE rounding paths
EXCHANGE_SETTLE_EPSILON = 0.05  # absorb small FE/BE rounding drift in exchange settlement


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


def charged_unit_map_for_bill(session, bill_id: int) -> Dict[int, float]:
    """
    item_id -> effective charged per-unit from BillItem rows.
    Uses historical billed line_total/qty, so exchange/return matches original charge,
    even when item MRP changed or bill used manual final amount adjustments.
    """
    totals: Dict[int, float] = {}
    qtys: Dict[int, int] = {}
    rows = session.exec(select(BillItem).where(BillItem.bill_id == bill_id)).all()
    for bi in rows:
        iid = int(bi.item_id)
        totals[iid] = float(totals.get(iid, 0.0)) + float(getattr(bi, "line_total", 0.0) or 0.0)
        qtys[iid] = int(qtys.get(iid, 0)) + int(getattr(bi, "quantity", 0) or 0)
    out: Dict[int, float] = {}
    for iid, q in qtys.items():
        if q > 0:
            out[iid] = round2(float(totals.get(iid, 0.0)) / float(q))
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
        stmt = select(Return)
        if from_date:
            stmt = stmt.where(Return.date_time >= f"{from_date}T00:00:00")
        if to_date:
            stmt = stmt.where(Return.date_time <= f"{to_date}T23:59:59")
        stmt = stmt.order_by(Return.id.desc()).limit(limit).offset(offset)
        rows = session.exec(stmt).all()

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
        if is_deleted_bill(bill):
            raise HTTPException(status_code=400, detail="Returns are not allowed for deleted bills")

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


@router.get("/exchange/records", response_model=List[dict])
def list_exchange_records(
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)"),
):
    with get_session() as session:
        stmt = select(ExchangeRecord)
        if from_date:
            stmt = stmt.where(ExchangeRecord.created_at >= f"{from_date}T00:00:00")
        if to_date:
            stmt = stmt.where(ExchangeRecord.created_at <= f"{to_date}T23:59:59")
        stmt = stmt.order_by(ExchangeRecord.id.desc()).offset(offset).limit(limit)
        rows = session.exec(stmt).all()
        return [
            {
                "id": r.id,
                "created_at": r.created_at,
                "source_bill_id": r.source_bill_id,
                "return_id": r.return_id,
                "new_bill_id": r.new_bill_id,
                "payment_mode": r.payment_mode,
                "payment_cash": r.payment_cash,
                "payment_online": r.payment_online,
                "refund_cash": r.refund_cash,
                "refund_online": r.refund_online,
                "net_due": r.net_due,
            }
            for r in rows
        ]


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


@router.get("/{return_id}/exchange", response_model=dict)
def get_exchange_by_return(return_id: int):
    with get_session() as session:
        ex = session.exec(select(ExchangeRecord).where(ExchangeRecord.return_id == return_id)).first()
        if not ex:
            raise HTTPException(status_code=404, detail="Exchange record not found for this return")

        ret = session.get(Return, ex.return_id)
        bill = session.get(Bill, ex.new_bill_id)
        if not ret or not bill:
            raise HTTPException(status_code=404, detail="Linked exchange data is missing")

        ret_items = session.exec(select(ReturnItem).where(ReturnItem.return_id == ret.id)).all()
        bill_items = session.exec(select(BillItem).where(BillItem.bill_id == bill.id)).all()

        return {
            "id": ex.id,
            "created_at": ex.created_at,
            "source_bill_id": ex.source_bill_id,
            "return_id": ex.return_id,
            "new_bill_id": ex.new_bill_id,
            "theoretical_net": ex.theoretical_net,
            "net_due": ex.net_due,
            "rounding_adjustment": ex.rounding_adjustment,
            "payment_mode": ex.payment_mode,
            "payment_cash": ex.payment_cash,
            "payment_online": ex.payment_online,
            "refund_cash": ex.refund_cash,
            "refund_online": ex.refund_online,
            "notes": ex.notes,
            "return": {
                "id": ret.id,
                "date_time": ret.date_time,
                "subtotal_return": ret.subtotal_return,
                "refund_cash": ret.refund_cash,
                "refund_online": ret.refund_online,
                "items": [
                    {
                        "item_id": i.item_id,
                        "item_name": i.item_name,
                        "mrp": i.mrp,
                        "quantity": i.quantity,
                        "line_total": i.line_total,
                    }
                    for i in ret_items
                ],
            },
            "bill": {
                "id": bill.id,
                "date_time": bill.date_time,
                "discount_percent": bill.discount_percent,
                "subtotal": bill.subtotal,
                "total_amount": bill.total_amount,
                "payment_mode": bill.payment_mode,
                "payment_cash": bill.payment_cash,
                "payment_online": bill.payment_online,
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


@router.post("/", response_model=ReturnOut, status_code=201)
def create_return(payload: ReturnCreate):
    if not payload.items:
        raise HTTPException(status_code=400, detail="Return must have at least one item")
    if payload.refund_mode not in {"cash", "online", "split", "credit"}:
        raise HTTPException(status_code=400, detail="Invalid refund_mode")
    if payload.refund_cash < 0 or payload.refund_online < 0:
        raise HTTPException(status_code=400, detail="Refund amounts cannot be negative")

    with get_session() as session:
        assert_financial_year_unlocked(session, now_ts(), context="Return creation")
        sold_lookup: Dict[int, int] = {}
        returned_lookup: Dict[int, int] = {}
        charged_unit_lookup: Dict[int, float] = {}
        bill = None
        disc_pct = 0.0
        tax_pct = 0.0
        factor = 1.0  # final_total / computed_total

        if payload.source_bill_id:
            bill = session.get(Bill, payload.source_bill_id)
            if not bill:
                raise HTTPException(status_code=404, detail="Source bill not found")
            if is_deleted_bill(bill):
                raise HTTPException(status_code=400, detail="Returns are not allowed for deleted bills")

            sold_lookup = sold_map_for_bill(session, bill.id)
            returned_lookup = already_returned_map_for_bill(session, bill.id)
            charged_unit_lookup = charged_unit_map_for_bill(session, bill.id)

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
                raw_final_total = getattr(bill, "total_amount", None)
                final_total = computed_total if raw_final_total is None else float(raw_final_total)
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

            qty = int(line.quantity)
            base = float(itm.mrp) * qty
            if bill and itm.id in charged_unit_lookup:
                subtotal_return += float(charged_unit_lookup[itm.id]) * qty
            elif bill:
                after_disc = base * (1 - disc_pct / 100.0)
                after_tax = after_disc * (1 + tax_pct / 100.0)
                charged = after_tax * factor
                subtotal_return += charged
            else:
                subtotal_return += base

        subtotal_return = round2(subtotal_return)

        # ----- validate refund with tolerance -----
        if payload.refund_mode == "credit":
            # credit mode: don't expect immediate cash/online refund here.
            rc, ro = 0.0, 0.0
        elif payload.refund_mode == "cash":
            rc, ro = round2(payload.refund_cash), 0.0
            if abs(rc - subtotal_return) > ROUND_TOLERANCE:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"refund_cash ₹{rc:.2f} deviates from computed subtotal ₹{subtotal_return:.2f} "
                        f"by more than ₹{int(ROUND_TOLERANCE)}"
                    )
                )
        elif payload.refund_mode == "online":
            rc, ro = 0.0, round2(payload.refund_online)
            if abs(ro - subtotal_return) > ROUND_TOLERANCE:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"refund_online ₹{ro:.2f} deviates from computed subtotal ₹{subtotal_return:.2f} "
                        f"by more than ₹{int(ROUND_TOLERANCE)}"
                    )
                )
        else:
            rc, ro = round2(payload.refund_cash), round2(payload.refund_online)
            if abs(round2(rc + ro) - subtotal_return) > ROUND_TOLERANCE:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"cash+online ₹{round2(rc + ro):.2f} deviates from computed subtotal ₹{subtotal_return:.2f} "
                        f"by more than ₹{int(ROUND_TOLERANCE)}"
                    )
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
                # ✅ unarchive if stock came back
                apply_archive_rules(session, itm)
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

                if bill and itm.id in charged_unit_lookup:
                    line_total = float(charged_unit_lookup[itm.id]) * qty
                else:
                    line_total = float(itm.mrp) * qty
                if bill and itm.id not in charged_unit_lookup:
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
        # If refund was credited to the source bill (bill on credit), adjust that bill's outstanding
        try:
            if payload.refund_mode == "credit" and payload.source_bill_id:
                bill = session.get(Bill, payload.source_bill_id)
                if bill:
                    # reduce total_amount by returned subtotal
                    new_total = round2(float(getattr(bill, "total_amount", 0.0)) - float(subtotal_return))
                    if new_total < 0:
                        new_total = 0.0
                    bill.total_amount = new_total

                    # recompute payment_status based on paid_amount
                    paid = float(getattr(bill, "paid_amount", 0.0) or 0.0)
                    if paid >= bill.total_amount:
                        bill.payment_status = "PAID"
                    elif paid > 0:
                        bill.payment_status = "PARTIAL"
                    else:
                        bill.payment_status = "UNPAID"

                    session.add(bill)
                    session.commit()
        except Exception:
            session.rollback()
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
    if payload.payment_mode not in {"cash", "online", "split", "credit"}:
        raise HTTPException(status_code=400, detail="Invalid payment_mode")
    if (
        payload.payment_cash < 0
        or payload.payment_online < 0
        or payload.refund_cash < 0
        or payload.refund_online < 0
    ):
        raise HTTPException(status_code=400, detail="Payment/refund amounts cannot be negative")

    with get_session() as session:
        assert_financial_year_unlocked(session, now_ts(), context="Exchange creation")
        sold_lookup = {}
        returned_lookup = {}
        charged_unit_lookup = {}
        bill = None
        disc_pct = 0.0
        tax_pct = 0.0
        factor = 1.0

        if payload.source_bill_id:
            bill = session.get(Bill, payload.source_bill_id)
            if not bill:
                raise HTTPException(status_code=404, detail="Source bill not found")
            if is_deleted_bill(bill):
                raise HTTPException(status_code=400, detail="Exchange is not allowed for deleted bills")

            sold_lookup = sold_map_for_bill(session, bill.id)
            returned_lookup = already_returned_map_for_bill(session, bill.id)
            charged_unit_lookup = charged_unit_map_for_bill(session, bill.id)

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
                raw_final_total = getattr(bill, "total_amount", None)
                final_total = computed_total if raw_final_total is None else float(raw_final_total)
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

            qty = int(line.quantity)
            base = float(itm.mrp) * qty
            if bill and itm.id in charged_unit_lookup:
                charged = float(charged_unit_lookup[itm.id]) * qty
            elif bill:
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
            if payload.payment_mode == "credit":
                # Defer collection; no immediate cash/online entry for this exchange.
                r_cash, r_online = 0.0, 0.0
                b_cash, b_online = 0.0, 0.0
            elif payload.payment_mode == "cash":
                paid_total = round2(payload.payment_cash)
                pay_diff = round2(net_due - paid_total)
                if abs(pay_diff) > EXCHANGE_SETTLE_EPSILON:
                    raise HTTPException(status_code=400, detail="Payment amounts must equal net due")
                r_cash, r_online = 0.0, 0.0
                b_cash = round2(payload.payment_cash)
                b_online = round2(payload.payment_online)
                if abs(pay_diff) > MONEY_EPSILON:
                    b_cash = round2(b_cash + pay_diff)
            elif payload.payment_mode == "online":
                paid_total = round2(payload.payment_online)
                pay_diff = round2(net_due - paid_total)
                if abs(pay_diff) > EXCHANGE_SETTLE_EPSILON:
                    raise HTTPException(status_code=400, detail="Payment amounts must equal net due")
                r_cash, r_online = 0.0, 0.0
                b_cash = round2(payload.payment_cash)
                b_online = round2(payload.payment_online)
                if abs(pay_diff) > MONEY_EPSILON:
                    b_online = round2(b_online + pay_diff)
            else:  # split
                paid_total = round2(payload.payment_cash + payload.payment_online)
                pay_diff = round2(net_due - paid_total)
                if abs(pay_diff) > EXCHANGE_SETTLE_EPSILON:
                    raise HTTPException(status_code=400, detail="Payment amounts must equal net due")
                r_cash, r_online = 0.0, 0.0
                b_cash = round2(payload.payment_cash)
                b_online = round2(payload.payment_online)
                if abs(pay_diff) > MONEY_EPSILON:
                    b_cash = round2(b_cash + pay_diff)
        elif net_due < 0:
            refund_total = round2(payload.refund_cash + payload.refund_online)
            refund_diff = round2(abs(net_due) - refund_total)
            if abs(refund_diff) > EXCHANGE_SETTLE_EPSILON:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Refund amounts must equal |net due|. "
                        f"Expected ₹{abs(net_due):.2f}, got ₹{refund_total:.2f} "
                        f"(cash ₹{round2(payload.refund_cash):.2f} + online ₹{round2(payload.refund_online):.2f})."
                    ),
                )
            r_cash, r_online = round2(payload.refund_cash), round2(payload.refund_online)
            if abs(refund_diff) > MONEY_EPSILON:
                if r_online > 0 and r_cash == 0:
                    r_online = round2(r_online + refund_diff)
                else:
                    r_cash = round2(r_cash + refund_diff)
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

            if bill and itm.id in charged_unit_lookup:
                line_total = float(charged_unit_lookup[itm.id]) * qty
            else:
                base = float(itm.mrp) * qty
                line_total = base
            if bill and itm.id not in charged_unit_lookup:
                after_disc = base * (1 - disc_pct / 100.0)
                after_tax = after_disc * (1 + tax_pct / 100.0)
                line_total = after_tax * factor

            session.add(ReturnItem(
                return_id=ret.id, item_id=itm.id, item_name=itm.name,
                mrp=itm.mrp, quantity=qty, line_total=round2(line_total)
            ))
        session.commit()

        # create new bill (exchange)
        # In exchange, part of bill value can be settled by returned items.
        # For credit mode, customer owes only net_due now.
        settled_by_return = round2(max(0.0, bill_total - max(0.0, net_due)))
        if net_due > 0 and payload.payment_mode == "credit":
            is_credit = True
            paid_amount = settled_by_return
            payment_status = "PARTIAL" if paid_amount > 0 else "UNPAID"
            paid_at = now_ts() if paid_amount > 0 else None
        else:
            is_credit = False
            paid_amount = bill_total
            payment_status = "PAID"
            paid_at = now_ts()

        base_note = str(payload.notes or "").strip()
        exchange_note = f"Exchange link: source bill #{payload.source_bill_id or '-'} | return #{ret.id}"
        merged_notes = f"{base_note}\n{exchange_note}" if base_note else exchange_note

        b = Bill(
            discount_percent=payload.discount_percent,
            subtotal=bill_subtotal,
            total_amount=bill_total,
            payment_mode=payload.payment_mode,
            payment_cash=b_cash,
            payment_online=b_online,
            notes=merged_notes,
            is_credit=is_credit,
            payment_status=payment_status,
            paid_amount=paid_amount,
            paid_at=paid_at,
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

        session.add(
            ExchangeRecord(
                source_bill_id=payload.source_bill_id,
                return_id=int(ret.id),
                new_bill_id=int(b.id),
                theoretical_net=theoretical_net,
                net_due=net_due,
                rounding_adjustment=rounding_adjustment,
                payment_mode=payload.payment_mode,
                payment_cash=b_cash,
                payment_online=b_online,
                refund_cash=r_cash,
                refund_online=r_online,
                notes=merged_notes,
            )
        )
        session.commit()

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
