# F:\medical-inventory\backend\routers\returns.py

from fastapi import APIRouter, HTTPException, Query
from typing import List, Optional, Dict
from pydantic import BaseModel
from sqlmodel import select
from datetime import datetime
from backend.accounting import sync_bill_vouchers
from backend.controls import assert_financial_year_unlocked, log_audit
from backend.security import require_min_role
from backend.utils.archive_rules import apply_archive_rules
from backend.db import get_session
from backend.models import (
    Item, Bill, BillItem, BillPayment, Customer, Party, PartyReceipt, ReceiptBillAdjustment, CustomerAdvanceRefund,
    Return, ReturnItem,
    ReturnCreate, ReturnOut, ReturnItemOut,
    AuditLog, AuditLogOut,
    ExchangeCreate,
    ExchangeSettlementUpdate,
    ExchangeRecord,
    StockMovement,
)
from backend.accounting import post_party_receipt_voucher, mark_voucher_deleted
from backend.inventory_lot_sync import item_stock_meta, sync_lot_quantity_for_item

router = APIRouter()


def round2(x: float) -> float:
    return float(f"{x:.2f}")


# Allow manual round-off near the computed amount
ROUND_TOLERANCE = 20.0  # supports practical cash rounding such as Rs 239.69 -> Rs 250
MONEY_EPSILON = 0.01   # allow 1 paisa drift between FE/BE rounding paths
EXCHANGE_SETTLE_EPSILON = 0.05  # absorb small FE/BE rounding drift in exchange settlement


def exchange_customer_party(session, source_bill: Optional[Bill]) -> Optional[Party]:
    if not source_bill:
        return None
    if source_bill.party_id:
        party = session.get(Party, int(source_bill.party_id))
        if party:
            return party
    if source_bill.customer_id:
        return session.exec(select(Party).where(
            Party.party_group == "SUNDRY_DEBTOR",
            Party.legacy_customer_id == int(source_bill.customer_id),
        )).first()
    return None


def sync_exchange_customer_credit(session, exchange: ExchangeRecord, source_bill: Optional[Bill], amount: float) -> None:
    amount = round2(max(0.0, float(amount or 0.0)))
    receipt = session.exec(select(PartyReceipt).where(PartyReceipt.exchange_id == int(exchange.id or 0))).first()
    party = exchange_customer_party(session, source_bill)
    if amount > MONEY_EPSILON and not party:
        raise HTTPException(status_code=400, detail="Customer credit requires a customer linked to the source bill")
    used = 0.0
    if receipt:
        for adjustment in session.exec(select(ReceiptBillAdjustment).where(ReceiptBillAdjustment.receipt_id == int(receipt.id or 0))).all():
            payment = session.get(BillPayment, int(adjustment.bill_payment_id or 0)) if adjustment.bill_payment_id else None
            if not payment or not bool(getattr(payment, "is_deleted", False)):
                used += float(adjustment.adjusted_amount or 0.0)
        used += sum(float(row.amount or 0.0) for row in session.exec(select(CustomerAdvanceRefund).where(
            CustomerAdvanceRefund.receipt_id == int(receipt.id or 0), CustomerAdvanceRefund.is_deleted == False,  # noqa: E712
        )).all())
    used = round2(used)
    if amount + MONEY_EPSILON < used:
        raise HTTPException(status_code=409, detail=f"Credit already used: ₹{used:.2f}. Reverse its bill adjustments/refunds before reducing it.")
    if amount <= MONEY_EPSILON:
        if receipt:
            receipt.is_deleted = True
            receipt.deleted_at = now_ts()
            receipt.unallocated_amount = 0.0
            session.add(receipt)
            mark_voucher_deleted(session, source_type="PARTY_RECEIPT", source_id=int(receipt.id or 0))
        return
    if not receipt:
        receipt = PartyReceipt(
            party_id=int(party.id), received_at=str(exchange.created_at), mode="credit",
            cash_amount=0.0, online_amount=0.0, credit_amount=amount,
            total_amount=amount, unallocated_amount=amount, exchange_id=int(exchange.id or 0),
            note=f"Customer credit from exchange #{exchange.id}", is_deleted=False,
        )
        session.add(receipt); session.flush()
    else:
        receipt.party_id = int(party.id)
        receipt.received_at = str(exchange.created_at)
        receipt.mode = "credit"
        receipt.cash_amount = receipt.online_amount = 0.0
        receipt.credit_amount = amount
        receipt.total_amount = amount
        receipt.unallocated_amount = round2(amount - used)
        receipt.is_deleted = False
        receipt.deleted_at = None
        session.add(receipt); session.flush()
    post_party_receipt_voucher(session, int(receipt.id), party, receipt.received_at, amount, 0.0, 0.0, receipt.note)


class ReturnRefundUpdate(BaseModel):
    refund_mode: str
    refund_cash: float = 0.0
    refund_online: float = 0.0
    return_date: Optional[str] = None


class ReturnDashboardSummary(BaseModel):
    cash_refund: float = 0.0
    online_refund: float = 0.0
    total_refund: float = 0.0
    credit_return: float = 0.0
    count: int = 0


def now_ts() -> str:
    return datetime.now().isoformat(timespec="seconds")


def normalize_return_datetime(value: Optional[str], *, fallback: Optional[str] = None) -> str:
    raw = str(value or "").strip()
    if not raw:
        return str(fallback or now_ts())
    date_part = raw[:10]
    try:
        datetime.strptime(date_part, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Return date must be a valid YYYY-MM-DD date")
    time_part = str(fallback or now_ts())[11:19] or "00:00:00"
    return f"{date_part}T{time_part}"


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
    ts: Optional[str] = None,
):
    """
    Append-only inventory ledger row.
    +delta => stock IN, -delta => stock OUT.
    """
    session.add(
        StockMovement(
            item_id=int(item_id),
            ts=ts or now_ts(),
            delta=int(delta),
            reason=str(reason),
            ref_type=str(ref_type),
            ref_id=int(ref_id),
            note=note,
        )
    )


def return_item_to_out(session, row: ReturnItem) -> ReturnItemOut:
    item = session.get(Item, int(row.item_id or 0)) if row.item_id else None
    return ReturnItemOut(
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


def infer_refund_mode(r: Return) -> str:
    credit = round2(float(getattr(r, "credit_amount", 0.0) or 0.0))
    cash = round2(float(getattr(r, "refund_cash", 0.0) or 0.0))
    online = round2(float(getattr(r, "refund_online", 0.0) or 0.0))
    if credit > 0 and (cash > 0 or online > 0):
        return "split"
    if credit > 0:
        return "credit"
    if cash > 0 and online > 0:
        return "split"
    if cash > 0:
        return "cash"
    if online > 0:
        return "online"
    return "credit"


def return_credit_amount(r: Return) -> float:
    credit = round2(float(getattr(r, "credit_amount", 0.0) or 0.0))
    if credit > 0:
        return credit
    cash = round2(float(getattr(r, "refund_cash", 0.0) or 0.0))
    online = round2(float(getattr(r, "refund_online", 0.0) or 0.0))
    if cash <= 0 and online <= 0:
        return round2(float(getattr(r, "subtotal_return", 0.0) or 0.0))
    return 0.0


def bill_line_base_total(session, bill: Bill) -> float:
    rows = session.exec(select(BillItem).where(BillItem.bill_id == bill.id)).all()
    item_total = round2(sum(float(getattr(row, "line_total", 0.0) or 0.0) for row in rows))
    if item_total > MONEY_EPSILON:
        return item_total

    subtotal = round2(float(getattr(bill, "subtotal", 0.0) or 0.0))
    if subtotal > MONEY_EPSILON:
        return subtotal

    return round2(float(getattr(bill, "total_amount", 0.0) or 0.0))


def exchange_return_ids_for_bill(session, bill_id: int) -> set[int]:
    rows = session.exec(
        select(ExchangeRecord.return_id).where(ExchangeRecord.source_bill_id == bill_id)
    ).all()
    return {int(row) for row in rows if row is not None}


def bill_credit_return_total(session, bill_id: int) -> float:
    exchange_return_ids = exchange_return_ids_for_bill(session, bill_id)
    total = 0.0
    rows = session.exec(select(Return).where(Return.source_bill_id == bill_id)).all()
    for row in rows:
        if row.id is None:
            continue
        if int(row.id) in exchange_return_ids:
            total += round2(float(getattr(row, "credit_amount", 0.0) or 0.0))
            continue
        total += return_credit_amount(row)
    return round2(total)


def active_bill_payments(session, bill_id: int) -> List[BillPayment]:
    return session.exec(
        select(BillPayment).where(
            BillPayment.bill_id == bill_id,
            BillPayment.is_deleted == False,  # noqa: E712
        )
    ).all()


def bill_covered_amount(bill: Bill) -> float:
    return round2(
        float(getattr(bill, "paid_amount", 0.0) or 0.0)
        + float(getattr(bill, "writeoff_amount", 0.0) or 0.0)
    )


def bill_outstanding_amount(bill: Bill) -> float:
    return round2(max(0.0, float(getattr(bill, "total_amount", 0.0) or 0.0) - bill_covered_amount(bill)))


def bill_paid_channel_totals(session, bill: Bill) -> tuple[float, float]:
    payments = [p for p in active_bill_payments(session, int(bill.id or 0)) if not bool(getattr(p, "is_writeoff", False))]
    if payments:
        return (
            round2(sum(float(getattr(p, "cash_amount", 0.0) or 0.0) for p in payments)),
            round2(sum(float(getattr(p, "online_amount", 0.0) or 0.0) for p in payments)),
        )
    return (
        round2(float(getattr(bill, "payment_cash", 0.0) or 0.0)),
        round2(float(getattr(bill, "payment_online", 0.0) or 0.0)),
    )


def bill_return_refund_totals(session, bill_id: int, *, exclude_return_id: Optional[int] = None) -> tuple[float, float]:
    exchange_return_ids = exchange_return_ids_for_bill(session, bill_id)
    cash = 0.0
    online = 0.0
    for row in session.exec(select(Return).where(Return.source_bill_id == bill_id)).all():
        if row.id is None:
            continue
        row_id = int(row.id)
        if row_id in exchange_return_ids or (exclude_return_id is not None and row_id == int(exclude_return_id)):
            continue
        cash += float(getattr(row, "refund_cash", 0.0) or 0.0)
        online += float(getattr(row, "refund_online", 0.0) or 0.0)
    return round2(cash), round2(online)


def allocate_refund_channels(
    *,
    amount: float,
    cash_available: float,
    online_available: float,
    mode: str,
    requested_cash: float = 0.0,
    requested_online: float = 0.0,
) -> tuple[float, float]:
    remaining = round2(amount)
    if remaining <= MONEY_EPSILON:
        return 0.0, 0.0

    cash_avail = round2(max(0.0, cash_available))
    online_avail = round2(max(0.0, online_available))
    mode = str(mode or "").strip().lower()
    cash = 0.0
    online = 0.0

    def take(channel: str, requested: Optional[float] = None) -> None:
        nonlocal remaining, cash, online, cash_avail, online_avail
        if remaining <= MONEY_EPSILON:
            return
        cap = cash_avail if channel == "cash" else online_avail
        if cap <= MONEY_EPSILON:
            return
        target = remaining if requested is None else min(remaining, max(0.0, round2(requested)))
        taken = round2(min(target, cap))
        if channel == "cash":
            cash = round2(cash + taken)
            cash_avail = round2(cash_avail - taken)
        else:
            online = round2(online + taken)
            online_avail = round2(online_avail - taken)
        remaining = round2(remaining - taken)

    if mode == "online":
        take("online")
        take("cash")
    elif mode == "split":
        take("cash", requested_cash)
        take("online", requested_online)
        take("cash")
        take("online")
    else:
        take("cash")
        take("online")

    if remaining > MONEY_EPSILON:
        raise HTTPException(status_code=400, detail="Return exceeds available bill credit/payment balance")
    return cash, online


def calculate_return_settlement(
    session,
    bill: Optional[Bill],
    *,
    subtotal_return: float,
    refund_mode: str,
    requested_cash: float = 0.0,
    requested_online: float = 0.0,
    existing_return: Optional[Return] = None,
    rounding_adjustment: float = 0.0,
) -> tuple[float, float, float]:
    subtotal = round2(subtotal_return)
    rounding = round2(rounding_adjustment)
    settlement_total = round2(subtotal + rounding)
    if settlement_total <= MONEY_EPSILON:
        return 0.0, 0.0, 0.0
    mode = str(refund_mode or "").strip().lower()
    if not bill:
        credit = 0.0
        return (*allocate_refund_channels(
            amount=settlement_total,
            cash_available=settlement_total,
            online_available=settlement_total,
            mode=mode,
            requested_cash=requested_cash,
            requested_online=requested_online,
        ), credit)

    existing_id = int(existing_return.id) if existing_return and existing_return.id is not None else None
    old_credit = return_credit_amount(existing_return) if existing_return else 0.0
    credit_capacity = round2(bill_outstanding_amount(bill) + old_credit)

    paid_cash, paid_online = bill_paid_channel_totals(session, bill)
    used_cash, used_online = bill_return_refund_totals(session, int(bill.id or 0), exclude_return_id=existing_id)
    cash_available = round2(paid_cash - used_cash)
    online_available = round2(paid_online - used_online)
    # The original payment channels limit the total refundable amount, but the
    # user's selected refund mode controls how money is actually returned.
    # This permits an online-paid bill to be refunded in cash (and vice versa)
    # without silently changing the selected mode.
    refundable_paid = round2(max(0.0, cash_available) + max(0.0, online_available))
    if mode == "cash":
        cash_available = round2(refundable_paid + max(0.0, rounding))
        online_available = 0.0
    elif mode == "online":
        online_available = round2(refundable_paid + max(0.0, rounding))
        cash_available = 0.0
    elif rounding > 0 and mode == "split":
        if round2(requested_cash) > cash_available:
            cash_available = round2(cash_available + rounding)
        else:
            online_available = round2(online_available + rounding)

    requested_direct = round2(
        (requested_cash if mode in {"cash", "split"} else 0.0)
        + (requested_online if mode in {"online", "split"} else 0.0)
    )
    if mode in {"cash", "online", "split"} and requested_direct > MONEY_EPSILON:
        direct_refund = round2(min(settlement_total, requested_direct))
        refund_cash, refund_online = allocate_refund_channels(
            amount=direct_refund,
            cash_available=cash_available,
            online_available=online_available,
            mode=mode,
            requested_cash=requested_cash,
            requested_online=requested_online,
        )
        credit = round2(min(settlement_total - refund_cash - refund_online, credit_capacity))
        refund_needed = round2(settlement_total - refund_cash - refund_online - credit)
        if refund_needed > MONEY_EPSILON:
            extra_cash, extra_online = allocate_refund_channels(
                amount=refund_needed,
                cash_available=round2(cash_available - refund_cash),
                online_available=round2(online_available - refund_online),
                mode=mode,
                requested_cash=max(0.0, round2(requested_cash - refund_cash)),
                requested_online=max(0.0, round2(requested_online - refund_online)),
            )
            refund_cash = round2(refund_cash + extra_cash)
            refund_online = round2(refund_online + extra_online)
        return refund_cash, refund_online, credit

    credit = round2(min(settlement_total, credit_capacity))
    refund_needed = round2(settlement_total - credit)
    refund_cash, refund_online = allocate_refund_channels(
        amount=refund_needed,
        cash_available=cash_available,
        online_available=online_available,
        mode=mode,
        requested_cash=requested_cash,
        requested_online=requested_online,
    )
    return refund_cash, refund_online, credit


def apply_return_credit_to_bill(session, r: Return, old_credit_amount: float, new_credit_amount: float) -> None:
    bill_id = int(getattr(r, "source_bill_id", 0) or 0)
    old_credit = round2(float(old_credit_amount or 0.0))
    new_credit = round2(float(new_credit_amount or 0.0))
    if not bill_id and max(old_credit, new_credit) <= MONEY_EPSILON:
        return

    bill = session.get(Bill, bill_id)
    if not bill:
        raise HTTPException(status_code=404, detail="Source bill not found")
    if is_deleted_bill(bill):
        raise HTTPException(status_code=400, detail="Cannot adjust credit on deleted source bill")

    current_credit_total = bill_credit_return_total(session, bill_id)
    previous_credit_total = round2(current_credit_total - new_credit + old_credit)
    base_total = round2(float(getattr(bill, "total_amount", 0.0) or 0.0) + previous_credit_total)

    line_base_total = bill_line_base_total(session, bill)
    if (
        base_total + MONEY_EPSILON < current_credit_total
        or (
            float(getattr(bill, "total_amount", 0.0) or 0.0) <= MONEY_EPSILON
            and line_base_total > current_credit_total + MONEY_EPSILON
        )
    ):
        base_total = line_base_total

    next_total = round2(max(0.0, base_total - current_credit_total))
    bill.total_amount = next_total

    covered = round2(
        float(getattr(bill, "paid_amount", 0.0) or 0.0)
        + float(getattr(bill, "writeoff_amount", 0.0) or 0.0)
    )
    if bill.total_amount <= 0 or covered >= bill.total_amount - MONEY_EPSILON:
        bill.payment_status = "PAID"
        bill.is_credit = False
    elif covered > MONEY_EPSILON:
        bill.payment_status = "PARTIAL"
        bill.is_credit = True
        bill.paid_at = None
    else:
        bill.payment_status = "UNPAID"
        bill.is_credit = True
        bill.paid_at = None
    session.add(bill)
    session.flush()
    sync_bill_vouchers(session, bill)


def return_to_out(session, r: Return) -> ReturnOut:
    items = session.exec(select(ReturnItem).where(ReturnItem.return_id == r.id)).all()
    return ReturnOut(
        id=r.id,
        date_time=r.date_time,
        source_bill_id=r.source_bill_id,
        subtotal_return=r.subtotal_return,
        refund_mode=infer_refund_mode(r),
        credit_amount=return_credit_amount(r),
        refund_cash=r.refund_cash,
        refund_online=r.refund_online,
        notes=r.notes,
        rounding_adjustment=getattr(r, "rounding_adjustment", 0.0),
        items=[return_item_to_out(session, i) for i in items],
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


def charged_total_map_for_bill(session, bill_id: int) -> Dict[int, float]:
    """Item-level charged totals reconciled exactly to the original bill value."""
    bill = session.get(Bill, bill_id)
    current_total = round2(float(getattr(bill, "total_amount", 0.0) or 0.0)) if bill else 0.0
    credit_total = bill_credit_return_total(session, bill_id)
    final_total = round2(current_total + credit_total)
    rows = session.exec(select(BillItem).where(BillItem.bill_id == bill_id)).all()
    saved_by_item: Dict[int, float] = {}
    qty_by_item: Dict[int, int] = {}
    mrp_value_by_item: Dict[int, float] = {}
    for bi in rows:
        iid = int(bi.item_id)
        q = int(getattr(bi, "quantity", 0) or 0)
        line_total = float(getattr(bi, "line_total", 0.0) or 0.0)
        if line_total <= MONEY_EPSILON:
            line_total = float(getattr(bi, "mrp", 0.0) or 0.0) * q
        saved_by_item[iid] = saved_by_item.get(iid, 0.0) + line_total
        qty_by_item[iid] = qty_by_item.get(iid, 0) + q
        mrp_value_by_item[iid] = mrp_value_by_item.get(iid, 0.0) + float(getattr(bi, "mrp", 0.0) or 0.0) * q

    saved_line_total = round2(sum(saved_by_item.values()))
    if abs(saved_line_total - final_total) <= MONEY_EPSILON:
        return {iid: round2(value) for iid, value in saved_by_item.items()}

    # Legacy credit returns sometimes left bill lines at the post-return value (or zero).
    # Preserve the exact credited value per item, then allocate only the remaining bill
    # balance. This never inflates an existing saved SP merely because a return exists.
    credited_by_item: Dict[int, float] = {}
    credited_qty_by_item: Dict[int, int] = {}
    exchange_return_ids = exchange_return_ids_for_bill(session, bill_id)
    for ret in session.exec(select(Return).where(Return.source_bill_id == bill_id)).all():
        if ret.id is None or int(ret.id) in exchange_return_ids:
            continue
        credit_amount = return_credit_amount(ret)
        subtotal = round2(float(getattr(ret, "subtotal_return", 0.0) or 0.0))
        if credit_amount <= MONEY_EPSILON or subtotal <= MONEY_EPSILON:
            continue
        credit_ratio = min(1.0, credit_amount / subtotal)
        for item in session.exec(select(ReturnItem).where(ReturnItem.return_id == ret.id)).all():
            iid = int(item.item_id)
            credited_by_item[iid] = credited_by_item.get(iid, 0.0) + round2(float(item.line_total or 0.0) * credit_ratio)
            credited_qty_by_item[iid] = credited_qty_by_item.get(iid, 0) + int(item.quantity or 0)

    floor_total = round2(sum(credited_by_item.values()))
    residual_target = round2(max(0.0, final_total - floor_total))
    item_ids = list(saved_by_item.keys())
    remaining_ids = [
        iid for iid in item_ids
        if qty_by_item.get(iid, 0) > credited_qty_by_item.get(iid, 0)
    ]
    allocation_ids = remaining_ids or item_ids
    weights = {
        iid: max(0.0, saved_by_item.get(iid, 0.0) - credited_by_item.get(iid, 0.0))
        for iid in allocation_ids
    }
    if sum(weights.values()) <= MONEY_EPSILON:
        weights = {iid: max(0.0, mrp_value_by_item.get(iid, 0.0)) for iid in allocation_ids}

    allocated: Dict[int, float] = {iid: 0.0 for iid in item_ids}
    weight_total = sum(weights.values())
    running = 0.0
    for iid in allocation_ids[:-1]:
        amount = round2(residual_target * weights.get(iid, 0.0) / weight_total) if weight_total > 0 else 0.0
        allocated[iid] = amount
        running = round2(running + amount)
    if allocation_ids:
        allocated[allocation_ids[-1]] = round2(max(0.0, residual_target - running))

    totals = {
        iid: round2(credited_by_item.get(iid, 0.0) + allocated.get(iid, 0.0))
        for iid in item_ids
    }
    out: Dict[int, float] = {}
    running = 0.0
    for iid in item_ids[:-1]:
        out[iid] = round2(totals[iid])
        running = round2(running + out[iid])
    if item_ids:
        out[item_ids[-1]] = round2(max(0.0, final_total - running))
    return out


def charged_unit_map_for_bill(session, bill_id: int) -> Dict[int, float]:
    totals = charged_total_map_for_bill(session, bill_id)
    sold = sold_map_for_bill(session, bill_id)
    return {
        iid: round2(total / sold[iid])
        for iid, total in totals.items()
        if sold.get(iid, 0) > 0
    }


def remaining_value_map_for_bill(session, bill_id: int) -> Dict[int, float]:
    remaining = charged_total_map_for_bill(session, bill_id)
    rows = session.exec(select(Return).where(Return.source_bill_id == bill_id)).all()
    for row in rows:
        items = session.exec(select(ReturnItem).where(ReturnItem.return_id == row.id)).all()
        for item in items:
            iid = int(item.item_id)
            remaining[iid] = round2(max(0.0, remaining.get(iid, 0.0) - float(item.line_total or 0.0)))
    return remaining


# -------------------- RETURNS --------------------

@router.get("/", response_model=List[ReturnOut])
def list_returns(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)"),
    source_bill_id: Optional[int] = Query(None),
):
    with get_session() as session:
        stmt = select(Return)
        if source_bill_id:
            stmt = stmt.where(Return.source_bill_id == int(source_bill_id))
        if from_date:
            stmt = stmt.where(Return.date_time >= f"{from_date}T00:00:00")
        if to_date:
            stmt = stmt.where(Return.date_time <= f"{to_date}T23:59:59.999999")
        stmt = stmt.order_by(Return.id.desc()).limit(limit).offset(offset)
        rows = session.exec(stmt).all()

        out: List[ReturnOut] = []
        for r in rows:
            out.append(return_to_out(session, r))
        return out


@router.get("/dashboard-summary", response_model=ReturnDashboardSummary)
def returns_dashboard_summary(
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)"),
):
    with get_session() as session:
        stmt = select(Return)
        if from_date:
            stmt = stmt.where(Return.date_time >= f"{from_date}T00:00:00")
        if to_date:
            stmt = stmt.where(Return.date_time <= f"{to_date}T23:59:59")

        cash = 0.0
        online = 0.0
        credit = 0.0
        count = 0
        for row in session.exec(stmt).all():
            count += 1
            rc = float(getattr(row, "refund_cash", 0.0) or 0.0)
            ro = float(getattr(row, "refund_online", 0.0) or 0.0)
            cash += rc
            online += ro
            credit += return_credit_amount(row)

        cash = round2(cash)
        online = round2(online)
        return ReturnDashboardSummary(
            cash_refund=cash,
            online_refund=online,
            total_refund=round2(cash + online),
            credit_return=round2(credit),
            count=count,
        )


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
        charged_units = charged_unit_map_for_bill(session, bill_id)
        remaining_values = remaining_value_map_for_bill(session, bill_id)

        rows = session.exec(select(BillItem).where(BillItem.bill_id == bill_id)).all()
        out = []
        for bi in rows:
            s = sold.get(bi.item_id, 0)
            a = already.get(bi.item_id, 0)
            remaining = max(0, s - a)
            out.append({
                "item_id": bi.item_id,
                "item_name": bi.item_name,
                "brand": (str(item.brand) if (item := session.get(Item, int(bi.item_id or 0))) and item.brand else None),
                "mrp": bi.mrp,
                "charged_unit_price": charged_units.get(int(bi.item_id), round2(float(bi.mrp or 0.0))),
                "remaining_value": remaining_values.get(int(bi.item_id), 0.0),
                "sold": s,
                "already_returned": a,
                "remaining": remaining,
                **item_stock_meta(session, int(bi.item_id or 0)),
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
            stmt = stmt.where(ExchangeRecord.created_at <= f"{to_date}T23:59:59.999999")
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
                "payment_credit": r.payment_credit,
                "refund_cash": r.refund_cash,
                "refund_online": r.refund_online,
                "refund_credit": r.refund_credit,
                "theoretical_net": r.theoretical_net,
                "net_due": r.net_due,
                "rounding_adjustment": r.rounding_adjustment,
                "notes": r.notes,
            }
            for r in rows
        ]


@router.patch("/exchange/{exchange_id}", response_model=dict)
def update_exchange_settlement(exchange_id: int, payload: ExchangeSettlementUpdate):
    """Edit only an exchange's date and settlement channels, atomically."""
    require_min_role("MANAGER", context="Exchange settlement edit")
    values = [
        payload.payment_cash, payload.payment_online, payload.payment_credit,
        payload.refund_cash, payload.refund_online, payload.refund_credit,
    ]
    if any(float(value or 0) < 0 for value in values):
        raise HTTPException(status_code=400, detail="Settlement amounts cannot be negative")

    with get_session() as session:
        exchange = session.get(ExchangeRecord, exchange_id)
        if not exchange:
            raise HTTPException(status_code=404, detail="Exchange not found")
        ret = session.get(Return, int(exchange.return_id or 0))
        replacement_bill = session.get(Bill, int(exchange.new_bill_id or 0))
        source_bill = session.get(Bill, int(exchange.source_bill_id or 0)) if exchange.source_bill_id else None
        if not ret or not replacement_bill:
            raise HTTPException(status_code=409, detail="Linked exchange return or replacement bill is missing")

        old_datetime = str(exchange.created_at)
        new_datetime = normalize_return_datetime(payload.exchange_date, fallback=old_datetime)
        assert_financial_year_unlocked(session, old_datetime, context="Exchange settlement edit")
        assert_financial_year_unlocked(session, new_datetime, context="Exchange settlement edit")
        if source_bill and new_datetime[:10] < str(source_bill.date_time or "")[:10]:
            raise HTTPException(status_code=400, detail="Exchange date cannot be before the source bill date")

        net_due = round2(float(exchange.net_due or 0.0))
        pay_cash = round2(float(payload.payment_cash or 0.0))
        pay_online = round2(float(payload.payment_online or 0.0))
        pay_credit = round2(float(payload.payment_credit or 0.0))
        refund_cash = round2(float(payload.refund_cash or 0.0))
        refund_online = round2(float(payload.refund_online or 0.0))
        refund_credit = round2(float(payload.refund_credit or 0.0))

        if net_due > MONEY_EPSILON:
            if round2(pay_cash + pay_online + pay_credit) != round2(net_due):
                raise HTTPException(status_code=400, detail=f"Cash + online + credit must equal ₹{net_due:.2f}")
            if refund_cash + refund_online + refund_credit > MONEY_EPSILON:
                raise HTTPException(status_code=400, detail="Refund fields must be zero when the customer pays")
        elif net_due < -MONEY_EPSILON:
            expected = round2(abs(net_due))
            if round2(refund_cash + refund_online + refund_credit) != expected:
                raise HTTPException(status_code=400, detail=f"Cash + online + credit must equal ₹{expected:.2f}")
            if pay_cash + pay_online + pay_credit > MONEY_EPSILON:
                raise HTTPException(status_code=400, detail="Payment fields must be zero when the customer receives value")
        elif any(round2(value) > MONEY_EPSILON for value in values):
            raise HTTPException(status_code=400, detail="Settlement must be zero for an even exchange")

        active_payments = session.exec(select(BillPayment).where(
            BillPayment.bill_id == int(replacement_bill.id or 0),
            BillPayment.is_deleted == False,  # noqa: E712
        )).all()
        if active_payments:
            raise HTTPException(status_code=409, detail="This exchange bill has later receipts. Remove those allocations before editing the exchange settlement.")

        old_credit = round2(float(getattr(ret, "credit_amount", 0.0) or 0.0))
        before = {
            "date": old_datetime,
            "payment_cash": exchange.payment_cash,
            "payment_online": exchange.payment_online,
            "payment_credit": exchange.payment_credit,
            "refund_cash": exchange.refund_cash,
            "refund_online": exchange.refund_online,
            "refund_credit": exchange.refund_credit,
        }

        channels = [
            ("cash", pay_cash + refund_cash),
            ("online", pay_online + refund_online),
            ("credit", pay_credit + refund_credit),
        ]
        used_modes = [name for name, amount in channels if amount > MONEY_EPSILON]
        mode = used_modes[0] if len(used_modes) == 1 else "split" if used_modes else "credit"

        exchange.created_at = new_datetime
        exchange.payment_mode = mode
        exchange.payment_cash = pay_cash
        exchange.payment_online = pay_online
        exchange.payment_credit = pay_credit
        exchange.refund_cash = refund_cash
        exchange.refund_online = refund_online
        exchange.refund_credit = refund_credit
        if not bool(getattr(exchange, "customer_credit_migrated", False)) and old_credit > MONEY_EPSILON and source_bill:
            source_bill.total_amount = round2(float(source_bill.total_amount or 0.0) + old_credit)
            session.add(source_bill)
        exchange.customer_credit_migrated = True
        session.add(exchange)

        ret.date_time = new_datetime
        ret.refund_cash = refund_cash
        ret.refund_online = refund_online
        ret.credit_amount = refund_credit
        session.add(ret)

        replacement_bill.date_time = new_datetime
        replacement_bill.payment_mode = mode
        replacement_bill.payment_cash = pay_cash
        replacement_bill.payment_online = pay_online
        settled_by_return = round2(max(0.0, float(replacement_bill.total_amount or 0.0) - max(0.0, net_due)))
        replacement_bill.paid_amount = round2(settled_by_return + pay_cash + pay_online)
        covered = round2(replacement_bill.paid_amount + float(getattr(replacement_bill, "writeoff_amount", 0.0) or 0.0))
        total = round2(float(replacement_bill.total_amount or 0.0))
        replacement_bill.is_credit = covered + MONEY_EPSILON < total
        replacement_bill.payment_status = "PAID" if not replacement_bill.is_credit else "PARTIAL" if covered > MONEY_EPSILON else "UNPAID"
        replacement_bill.paid_at = new_datetime if not replacement_bill.is_credit else None
        session.add(replacement_bill)

        for movement in session.exec(select(StockMovement).where(StockMovement.ref_type == "EXCHANGE")).all():
            is_return_leg = str(movement.reason) == "EXCHANGE_IN" and int(movement.ref_id or 0) == int(ret.id or 0)
            is_bill_leg = str(movement.reason) == "EXCHANGE_OUT" and int(movement.ref_id or 0) == int(replacement_bill.id or 0)
            if is_return_leg or is_bill_leg:
                movement.ts = new_datetime
                session.add(movement)

        session.flush()
        sync_exchange_customer_credit(session, exchange, source_bill, refund_credit)
        if source_bill:
            sync_bill_vouchers(session, source_bill)
        sync_bill_vouchers(session, replacement_bill)
        log_audit(
            session,
            entity_type="SALES_RETURN",
            entity_id=int(ret.id or 0),
            action="UPDATE_EXCHANGE_SETTLEMENT",
            note=f"Updated exchange #{exchange.id} settlement",
            details={"exchange_id": exchange.id, "before": before, "after": {
                "date": new_datetime, "payment_mode": mode,
                "payment_cash": pay_cash, "payment_online": pay_online, "payment_credit": pay_credit,
                "refund_cash": refund_cash, "refund_online": refund_online, "refund_credit": refund_credit,
            }},
        )
        session.commit()
        return {
            "id": exchange.id, "created_at": exchange.created_at, "payment_mode": exchange.payment_mode,
            "payment_cash": exchange.payment_cash, "payment_online": exchange.payment_online,
            "payment_credit": exchange.payment_credit, "refund_cash": exchange.refund_cash,
            "refund_online": exchange.refund_online, "refund_credit": exchange.refund_credit,
            "net_due": exchange.net_due,
        }


@router.get("/{return_id}", response_model=ReturnOut)
def get_return(return_id: int):
    with get_session() as session:
        r = session.get(Return, return_id)
        if not r:
            raise HTTPException(status_code=404, detail="Return not found")
        return return_to_out(session, r)


@router.get("/{return_id}/history", response_model=List[AuditLogOut])
def get_return_history(return_id: int):
    with get_session() as session:
        if not session.get(Return, return_id):
            raise HTTPException(status_code=404, detail="Sales return not found")
        rows = session.exec(
            select(AuditLog)
            .where(AuditLog.entity_type == "SALES_RETURN", AuditLog.entity_id == return_id)
            .order_by(AuditLog.id.desc())
        ).all()
        return [AuditLogOut(**row.model_dump()) for row in rows]


@router.patch("/{return_id}/refund", response_model=ReturnOut)
def update_return_refund(return_id: int, payload: ReturnRefundUpdate):
    require_min_role("MANAGER", context="Sales return payment edit")
    mode = str(payload.refund_mode or "").strip().lower()
    if mode not in {"cash", "online", "split", "credit"}:
        raise HTTPException(status_code=400, detail="Invalid refund_mode")
    if payload.refund_cash < 0 or payload.refund_online < 0:
        raise HTTPException(status_code=400, detail="Refund amounts cannot be negative")

    with get_session() as session:
        r = session.get(Return, return_id)
        if not r:
            raise HTTPException(status_code=404, detail="Return not found")
        assert_financial_year_unlocked(session, r.date_time, context="Return refund edit")
        new_return_datetime = normalize_return_datetime(payload.return_date, fallback=r.date_time)
        assert_financial_year_unlocked(session, new_return_datetime, context="Return date edit")

        ex = session.exec(select(ExchangeRecord).where(ExchangeRecord.return_id == return_id)).first()
        if ex:
            raise HTTPException(status_code=400, detail="Exchange return refunds cannot be edited here")

        subtotal = round2(float(getattr(r, "subtotal_return", 0.0) or 0.0))
        old_mode = infer_refund_mode(r)
        old_cash = round2(float(getattr(r, "refund_cash", 0.0) or 0.0))
        old_online = round2(float(getattr(r, "refund_online", 0.0) or 0.0))
        old_credit_amount = return_credit_amount(r)
        bill = session.get(Bill, int(r.source_bill_id or 0)) if r.source_bill_id else None
        if bill and new_return_datetime[:10] < str(bill.date_time or "")[:10]:
            raise HTTPException(status_code=400, detail="Return date cannot be before the source bill date")
        rc, ro, new_credit_amount = calculate_return_settlement(
            session,
            bill,
            subtotal_return=subtotal,
            refund_mode=mode,
            requested_cash=round2(payload.refund_cash),
            requested_online=round2(payload.refund_online),
            existing_return=r,
            rounding_adjustment=round2(float(getattr(r, "rounding_adjustment", 0.0) or 0.0)),
        )

        old_return_datetime = str(r.date_time)
        if (
            old_mode == infer_refund_mode(r)
            and old_cash == rc
            and old_online == ro
            and old_credit_amount == new_credit_amount
            and old_return_datetime == new_return_datetime
        ):
            return return_to_out(session, r)

        r.date_time = new_return_datetime
        r.refund_cash = rc
        r.refund_online = ro
        r.credit_amount = new_credit_amount
        session.add(r)
        if old_return_datetime != new_return_datetime:
            for movement in session.exec(select(StockMovement).where(
                StockMovement.ref_type == "RETURN",
                StockMovement.ref_id == int(r.id or return_id),
            )).all():
                movement.ts = new_return_datetime
                session.add(movement)
        session.flush()
        apply_return_credit_to_bill(session, r, old_credit_amount, new_credit_amount)
        log_audit(
            session,
            entity_type="SALES_RETURN",
            entity_id=int(r.id or return_id),
            action="PAYMENT_UPDATE",
            note=f"Updated customer refund for sales return #{return_id}",
            details={
                "before": {
                    "refund_mode": old_mode,
                    "credit_amount": old_credit_amount,
                    "refund_cash": old_cash,
                    "refund_online": old_online,
                    "total_paid": round2(old_credit_amount + old_cash + old_online),
                    "return_date": old_return_datetime,
                },
                "after": {
                    "refund_mode": infer_refund_mode(r),
                    "credit_amount": new_credit_amount,
                    "refund_cash": rc,
                    "refund_online": ro,
                    "total_paid": round2(new_credit_amount + rc + ro),
                    "return_date": new_return_datetime,
                },
                "return_value": subtotal,
                "source_bill_id": r.source_bill_id,
            },
        )
        session.commit()
        session.refresh(r)
        return return_to_out(session, r)


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
                "refund_mode": infer_refund_mode(ret),
                "refund_cash": ret.refund_cash,
                "refund_online": ret.refund_online,
                "items": [
                    {
                        "item_id": i.item_id,
                        "item_name": i.item_name,
                        "brand": (
                            str(item.brand)
                            if (item := session.get(Item, int(i.item_id or 0))) and item.brand
                            else None
                        ),
                        "batch_number": str(item.id) if item and item.id else None,
                        "expiry_date": str(item.expiry_date) if item and item.expiry_date else None,
                        "mrp": i.mrp,
                        "quantity": i.quantity,
                        "line_total": i.line_total,
                        **item_stock_meta(session, int(i.item_id or 0)),
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
                        "brand": (
                            str(item.brand)
                            if (item := session.get(Item, int(i.item_id or 0))) and item.brand
                            else None
                        ),
                        "batch_number": str(item.id) if item and item.id else None,
                        "expiry_date": str(item.expiry_date) if item and item.expiry_date else None,
                        "mrp": i.mrp,
                        "quantity": i.quantity,
                        "line_total": i.line_total,
                        **item_stock_meta(session, int(i.item_id or 0)),
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
        return_datetime = normalize_return_datetime(payload.return_date)
        assert_financial_year_unlocked(session, return_datetime, context="Return creation")
        sold_lookup: Dict[int, int] = {}
        returned_lookup: Dict[int, int] = {}
        charged_unit_lookup: Dict[int, float] = {}
        remaining_value_lookup: Dict[int, float] = {}
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
            if return_datetime[:10] < str(bill.date_time or "")[:10]:
                raise HTTPException(status_code=400, detail="Return date cannot be before the source bill date")

            sold_lookup = sold_map_for_bill(session, bill.id)
            returned_lookup = already_returned_map_for_bill(session, bill.id)
            charged_unit_lookup = charged_unit_map_for_bill(session, bill.id)
            remaining_value_lookup = remaining_value_map_for_bill(session, bill.id)

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
        return_line_total_by_item: Dict[int, float] = {}

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
            remaining_qty = max(0, sold_lookup.get(itm.id, 0) - returned_lookup.get(itm.id, 0))
            if bill and itm.id in remaining_value_lookup and remaining_qty > 0:
                remaining_value = remaining_value_lookup[itm.id]
                line_value = remaining_value if qty == remaining_qty else round2(remaining_value * qty / remaining_qty)
                return_line_total_by_item[itm.id] = line_value
                subtotal_return += line_value
            elif bill and itm.id in charged_unit_lookup:
                line_value = round2(float(charged_unit_lookup[itm.id]) * qty)
                return_line_total_by_item[itm.id] = line_value
                subtotal_return += line_value
            elif bill:
                after_disc = base * (1 - disc_pct / 100.0)
                after_tax = after_disc * (1 + tax_pct / 100.0)
                charged = after_tax * factor
                subtotal_return += charged
            else:
                subtotal_return += base

        subtotal_return = round2(subtotal_return)
        rounding_adjustment = round2(float(payload.rounding_adjustment or 0.0))
        if abs(rounding_adjustment) > ROUND_TOLERANCE + MONEY_EPSILON:
            raise HTTPException(
                status_code=400,
                detail=f"Refund round-off cannot exceed Rs {ROUND_TOLERANCE:.2f}",
            )
        settlement_total = round2(subtotal_return + rounding_adjustment)
        if settlement_total < 0:
            raise HTTPException(status_code=400, detail="Final refund cannot be negative")
        if payload.refund_mode == "credit" and abs(rounding_adjustment) > MONEY_EPSILON:
            raise HTTPException(status_code=400, detail="Manual round-off is allowed only for cash, online, or split refunds")
        requested_refund = round2(float(payload.refund_cash or 0.0) + float(payload.refund_online or 0.0))
        if payload.refund_mode in {"cash", "online", "split"} and requested_refund > MONEY_EPSILON:
            if abs(requested_refund - settlement_total) > MONEY_EPSILON:
                raise HTTPException(
                    status_code=400,
                    detail=f"Cash and online refund must total Rs {settlement_total:.2f} after round-off",
                )

        rc, ro, credit_amount = calculate_return_settlement(
            session,
            bill,
            subtotal_return=subtotal_return,
            refund_mode=payload.refund_mode,
            requested_cash=round2(payload.refund_cash),
            requested_online=round2(payload.refund_online),
            rounding_adjustment=rounding_adjustment,
        )

        try:
            # ----- save Return header -----
            r = Return(
                date_time=return_datetime,
                source_bill_id=payload.source_bill_id,
                subtotal_return=subtotal_return,
                credit_amount=credit_amount,
                refund_cash=rc,
                refund_online=ro,
                notes=payload.notes,
                rounding_adjustment=rounding_adjustment,
            )
            session.add(r)
            session.flush()

            # ----- save Return items + restock + ledger -----
            for line in payload.items:
                itm = db_items[line.item_id]
                qty = int(line.quantity)

                # restock
                itm.stock += qty
                session.add(itm)
                # ✅ unarchive if stock came back
                apply_archive_rules(session, itm)
                sync_lot_quantity_for_item(session, itm)
                # Ledger: RETURN (stock IN)
                add_movement(
                    session,
                    item_id=itm.id,
                    delta=qty,
                    reason="RETURN",
                    ref_type="RETURN",
                    ref_id=r.id,
                    note=f"Return #{r.id}",
                    ts=return_datetime,
                )

                if itm.id in return_line_total_by_item:
                    line_total = return_line_total_by_item[itm.id]
                elif bill and itm.id in charged_unit_lookup:
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

            # If any part was credited to the source bill, adjust that bill's outstanding.
            if credit_amount > MONEY_EPSILON and payload.source_bill_id:
                apply_return_credit_to_bill(session, r, 0.0, credit_amount)

            log_audit(
                session,
                entity_type="SALES_RETURN",
                entity_id=int(r.id or 0),
                action="CREATE",
                note=f"Created sales return #{r.id}",
                details={
                    "source_bill_id": r.source_bill_id,
                    "return_value": subtotal_return,
                    "rounding_adjustment": rounding_adjustment,
                    "actual_refund_total": settlement_total,
                    "refund_mode": infer_refund_mode(r),
                    "credit_amount": credit_amount,
                    "refund_cash": rc,
                    "refund_online": ro,
                    "items": [
                        {"item_id": int(line.item_id), "quantity": int(line.quantity)}
                        for line in payload.items
                    ],
                },
            )

            session.commit()
            session.refresh(r)
        except HTTPException:
            session.rollback()
            raise
        except Exception as e:
            session.rollback()
            raise HTTPException(status_code=500, detail=f"Failed to create return: {e}")

        return return_to_out(session, r)


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
        or payload.payment_credit < 0
        or payload.refund_cash < 0
        or payload.refund_online < 0
        or payload.refund_credit < 0
    ):
        raise HTTPException(status_code=400, detail="Payment/refund amounts cannot be negative")

    exchange_datetime = normalize_return_datetime(payload.exchange_date)

    with get_session() as session:
        assert_financial_year_unlocked(session, exchange_datetime, context="Exchange creation")
        sold_lookup = {}
        returned_lookup = {}
        charged_unit_lookup = {}
        remaining_value_lookup = {}
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
            remaining_value_lookup = remaining_value_map_for_bill(session, bill.id)

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
        return_line_total_by_item: Dict[int, float] = {}
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
            remaining_qty = max(0, sold_lookup.get(itm.id, 0) - returned_lookup.get(itm.id, 0))
            if bill and itm.id in remaining_value_lookup and remaining_qty > 0:
                remaining_value = remaining_value_lookup[itm.id]
                charged = remaining_value if qty == remaining_qty else round2(remaining_value * qty / remaining_qty)
                return_line_total_by_item[itm.id] = charged
            elif bill and itm.id in charged_unit_lookup:
                charged = round2(float(charged_unit_lookup[itm.id]) * qty)
                return_line_total_by_item[itm.id] = charged
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
                paid_total = round2(payload.payment_cash + payload.payment_online + payload.payment_credit)
                pay_diff = round2(net_due - paid_total)
                if abs(pay_diff) > EXCHANGE_SETTLE_EPSILON:
                    raise HTTPException(status_code=400, detail="Cash + online + credit must equal net due")
                r_cash, r_online = 0.0, 0.0
                b_cash = round2(payload.payment_cash)
                b_online = round2(payload.payment_online)
                if abs(pay_diff) > MONEY_EPSILON:
                    b_cash = round2(b_cash + pay_diff)
        elif net_due < 0:
            if payload.payment_mode == "credit":
                # Keep the amount on the customer's account; no cash/bank movement.
                r_cash = r_online = 0.0
                b_cash = b_online = 0.0
                refund_total = 0.0
                refund_diff = 0.0
            else:
                refund_total = round2(payload.refund_cash + payload.refund_online + payload.refund_credit)
                refund_diff = round2(abs(net_due) - refund_total)
                if abs(refund_diff) > EXCHANGE_SETTLE_EPSILON:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Refund amounts must equal |net due|. "
                            f"Expected ₹{abs(net_due):.2f}, got ₹{refund_total:.2f} "
                            f"(cash ₹{round2(payload.refund_cash):.2f} + online ₹{round2(payload.refund_online):.2f} "
                            f"+ credit ₹{round2(payload.refund_credit):.2f})."
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
            date_time=exchange_datetime,
            source_bill_id=payload.source_bill_id,
            subtotal_return=return_subtotal,
            credit_amount=(round2(abs(net_due)) if net_due < 0 and payload.payment_mode == "credit" else round2(payload.refund_credit)),
            refund_cash=r_cash,
            refund_online=r_online,
            notes=payload.notes,
            rounding_adjustment=rounding_adjustment,
        )

        session.add(ret)
        session.flush()
        session.refresh(ret)

        # return items: stock IN + ledger
        for itm, qty in ret_items_map.values():
            itm.stock += qty
            session.add(itm)
            apply_archive_rules(session, itm)
            sync_lot_quantity_for_item(session, itm)

            add_movement(
                session,
                item_id=itm.id,
                delta=qty,
                reason="EXCHANGE_IN",
                ref_type="EXCHANGE",
                ref_id=ret.id,
                note=f"Exchange return #{ret.id}",
                ts=exchange_datetime,
            )

            if itm.id in return_line_total_by_item:
                line_total = return_line_total_by_item[itm.id]
            elif bill and itm.id in charged_unit_lookup:
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
        session.flush()

        # create new bill (exchange)
        # In exchange, part of bill value can be settled by returned items.
        # For credit mode, customer owes only net_due now.
        settled_by_return = round2(max(0.0, bill_total - max(0.0, net_due)))
        payment_credit = round2(net_due) if net_due > 0 and payload.payment_mode == "credit" else round2(payload.payment_credit)
        if net_due > 0 and payment_credit > 0:
            is_credit = True
            paid_amount = round2(settled_by_return + b_cash + b_online)
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
            date_time=exchange_datetime,
            customer_id=int(bill.customer_id) if bill and bill.customer_id is not None else None,
            party_id=int(bill.party_id) if bill and bill.party_id is not None else None,
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
            paid_at=exchange_datetime if paid_at else None,
        )
        session.add(b)
        session.flush()
        from backend.routers.billing import assign_bill_number
        assign_bill_number(session, b, backdated=bool(payload.exchange_date))
        session.refresh(b)

        # new items: stock OUT + ledger
        for itm, qty in new_items_map.values():
            if itm.stock < qty:
                raise HTTPException(status_code=400, detail=f"Insufficient stock during exchange for {itm.name}")
            itm.stock -= qty
            session.add(itm)
            apply_archive_rules(session, itm)
            sync_lot_quantity_for_item(session, itm)

            add_movement(
                session,
                item_id=itm.id,
                delta=-qty,
                reason="EXCHANGE_OUT",
                ref_type="EXCHANGE",
                ref_id=b.id,
                note=f"Exchange bill #{b.id}",
                ts=exchange_datetime,
            )

            session.add(BillItem(
                bill_id=b.id, item_id=itm.id, item_name=itm.name,
                mrp=itm.mrp, quantity=qty, line_total=round2(qty * itm.mrp)
            ))
        session.flush()

        ret_items = session.exec(select(ReturnItem).where(ReturnItem.return_id == ret.id)).all()
        bill_items = session.exec(select(BillItem).where(BillItem.bill_id == b.id)).all()

        exchange = ExchangeRecord(
            created_at=exchange_datetime,
            source_bill_id=payload.source_bill_id,
            return_id=int(ret.id),
            new_bill_id=int(b.id),
            theoretical_net=theoretical_net,
            net_due=net_due,
            rounding_adjustment=rounding_adjustment,
            payment_mode=payload.payment_mode,
            payment_cash=b_cash,
            payment_online=b_online,
            payment_credit=payment_credit,
            refund_cash=r_cash,
            refund_online=r_online,
            refund_credit=round2(getattr(ret, "credit_amount", 0.0) or 0.0),
            customer_credit_migrated=True,
            notes=merged_notes,
        )
        session.add(exchange)
        session.flush()
        sync_exchange_customer_credit(session, exchange, bill, float(getattr(ret, "credit_amount", 0.0) or 0.0))
        log_audit(
            session,
            entity_type="SALES_RETURN",
            entity_id=int(ret.id or 0),
            action="CREATE_EXCHANGE",
            note=f"Created sales return #{ret.id} through exchange #{exchange.id}",
            details={
                "exchange_id": exchange.id,
                "source_bill_id": ret.source_bill_id,
                "new_bill_id": b.id,
                "return_value": return_subtotal,
                "refund_cash": r_cash,
                "refund_online": r_online,
            },
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
                refund_mode=infer_refund_mode(ret),
                credit_amount=return_credit_amount(ret),
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
                        "line_total": i.line_total,
                        **item_stock_meta(session, int(i.item_id or 0)),
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
                        **item_stock_meta(session, int(i.item_id or 0)),
                    }
                    for i in bill_items
                ],
            },
        }
