# backend/routers/cashbook.py
from datetime import datetime, timedelta
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Query
from sqlmodel import select
from sqlalchemy import text  # ✅ use sqlalchemy.text (NOT sqlmodel.text)

from backend.controls import assert_financial_year_unlocked
from backend.db import get_session
from backend.models import BankbookEntry, CashbookEntry, CashbookCreate, CashbookOut, Bill, BillPayment, Return, ExchangeRecord, Purchase, PurchasePayment
from backend.security import require_min_role

router = APIRouter()


def today_yyyy_mm_dd() -> str:
    return datetime.now().date().isoformat()  # "YYYY-MM-DD"


def _range_bounds(from_date: Optional[str], to_date: Optional[str]):
    # Works with ISO strings in SQLite ("YYYY-MM-DDTHH:MM:SS")
    if not from_date and not to_date:
        return None, None

    f = from_date or to_date
    t = to_date or from_date
    if not f or not t:
        return None, None

    start_iso = f"{f}T00:00:00"
    # Include any sub-second timestamps on the end date (string compare on ISO datetimes).
    end_iso = f"{t}T23:59:59.999999"
    return start_iso, end_iso


VALID_ENTRY_TYPES = {"RECEIPT", "WITHDRAWAL", "EXPENSE", "CONTRA", "OPENING"}


def _sum_rows(rows: List[CashbookEntry]):
    receipts = 0.0
    withdrawals = 0.0
    expenses = 0.0
    for r in rows:
        et = (r.entry_type or "").upper()
        amt = float(r.amount or 0)
        if et == "OPENING":
            continue
        if et == "RECEIPT":
            receipts += amt
        elif et in ("WITHDRAWAL", "CONTRA"):
            withdrawals += amt
        else:
            expenses += amt

    cash_out = withdrawals + expenses
    net_change = receipts - cash_out
    return {
        "cash_out": round(cash_out, 2),
        "withdrawals": round(withdrawals, 2),
        "expenses": round(expenses, 2),
        "receipts": round(receipts, 2),
        "net_change": round(net_change, 2),
        "count": len(rows),
    }


def _parse_ymd(date_str: str) -> datetime:
    try:
        return datetime.strptime(date_str, "%Y-%m-%d")
    except Exception:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")


def _sum_bill_cash(session, *, start_iso: Optional[str] = None, end_iso: Optional[str] = None) -> float:
    stmt = (
        select(BillPayment)
        .join(Bill, Bill.id == BillPayment.bill_id)
        .where(Bill.is_deleted == False)  # noqa: E712
        .where(BillPayment.is_deleted == False)  # noqa: E712
    )
    if start_iso:
        stmt = stmt.where(BillPayment.received_at >= start_iso)
    if end_iso:
        stmt = stmt.where(BillPayment.received_at <= end_iso)
    rows = session.exec(stmt).all()
    total = 0.0
    for p in rows:
        total += float(getattr(p, "cash_amount", 0) or 0)
    return round(total, 2)


def _sum_purchase_cash_out(session, *, start_iso: Optional[str] = None, end_iso: Optional[str] = None) -> float:
    stmt = (
        select(PurchasePayment)
        .join(Purchase, Purchase.id == PurchasePayment.purchase_id)
        .where(Purchase.is_deleted == False)  # noqa: E712
        .where(PurchasePayment.is_deleted == False)  # noqa: E712
        .where(PurchasePayment.is_writeoff == False)  # noqa: E712
    )
    if start_iso:
        stmt = stmt.where(PurchasePayment.paid_at >= start_iso)
    if end_iso:
        stmt = stmt.where(PurchasePayment.paid_at <= end_iso)
    rows = session.exec(stmt).all()
    total = 0.0
    for payment in rows:
        total += float(getattr(payment, "cash_amount", 0) or 0)
    return round(total, 2)


def _sum_return_cash(session, *, start_iso: Optional[str] = None, end_iso: Optional[str] = None) -> float:
    stmt = select(Return)
    if start_iso:
        stmt = stmt.where(Return.date_time >= start_iso)
    if end_iso:
        stmt = stmt.where(Return.date_time <= end_iso)
    rows = session.exec(stmt).all()
    total = 0.0
    for r in rows:
        total += float(getattr(r, "refund_cash", 0) or 0)
    return round(total, 2)


def _sum_exchange_cash_in(session, *, start_iso: Optional[str] = None, end_iso: Optional[str] = None) -> float:
    stmt = select(ExchangeRecord)
    if start_iso:
        stmt = stmt.where(ExchangeRecord.created_at >= start_iso)
    if end_iso:
        stmt = stmt.where(ExchangeRecord.created_at <= end_iso)
    rows = session.exec(stmt).all()
    total = 0.0
    for r in rows:
        total += float(getattr(r, "payment_cash", 0) or 0)
    return round(total, 2)


def _sum_bankbook_contra(session, *, start_iso: Optional[str] = None, end_iso: Optional[str] = None):
    stmt = select(BankbookEntry).where(BankbookEntry.mode == "BANK_DEPOSIT")
    if start_iso:
        stmt = stmt.where(BankbookEntry.created_at >= start_iso)
    if end_iso:
        stmt = stmt.where(BankbookEntry.created_at <= end_iso)
    rows = session.exec(stmt).all()
    out = {"receipts": 0.0, "withdrawals": 0.0, "expenses": 0.0}
    for row in rows:
        entry_type = str(getattr(row, "entry_type", "") or "").upper()
        amount = float(getattr(row, "amount", 0) or 0)
        if entry_type == "RECEIPT":
            out["withdrawals"] += amount
        elif entry_type in ("WITHDRAWAL", "CONTRA"):
            out["receipts"] += amount
        else:
            out["expenses"] += amount
    return {key: round(value, 2) for key, value in out.items()}


def _opening_anchor(session, *, day_end: str):
    return session.exec(
        select(CashbookEntry)
        .where(CashbookEntry.entry_type == "OPENING")
        .where(CashbookEntry.created_at <= day_end)
        .order_by(CashbookEntry.created_at.desc(), CashbookEntry.id.desc())
    ).first()


def _day_snapshot(session, date: str, *, include_entries: bool = False):
    day_dt = _parse_ymd(date)
    prev_date = (day_dt - timedelta(days=1)).date().isoformat()

    day_start = f"{date}T00:00:00"
    day_end = f"{date}T23:59:59.999999"
    prev_end = f"{prev_date}T23:59:59.999999"

    anchor = _opening_anchor(session, day_end=day_end)
    anchor_amount = float(getattr(anchor, "amount", 0) or 0) if anchor else 0.0
    anchor_ts = str(getattr(anchor, "created_at", "") or "") if anchor else None
    anchor_effective_start = f"{anchor_ts[:10]}T00:00:00" if anchor_ts and len(anchor_ts) >= 10 else None

    opening_stmt = select(CashbookEntry).where(CashbookEntry.created_at <= prev_end)
    if anchor_effective_start:
        opening_stmt = opening_stmt.where(CashbookEntry.created_at >= anchor_effective_start)
    opening_rows = session.exec(opening_stmt).all()
    opening_balance = (
        anchor_amount
        + _sum_rows(opening_rows)["net_change"]
        + _sum_bill_cash(session, start_iso=anchor_effective_start, end_iso=prev_end)
        + _sum_exchange_cash_in(session, start_iso=anchor_effective_start, end_iso=prev_end)
        - _sum_return_cash(session, start_iso=anchor_effective_start, end_iso=prev_end)
        - _sum_purchase_cash_out(session, start_iso=anchor_effective_start, end_iso=prev_end)
    )
    bankbook_contra_opening = _sum_bankbook_contra(session, start_iso=anchor_effective_start, end_iso=prev_end)
    opening_balance += (
        float(bankbook_contra_opening["receipts"])
        - float(bankbook_contra_opening["withdrawals"])
        - float(bankbook_contra_opening["expenses"])
    )

    day_rows = session.exec(
        select(CashbookEntry)
        .where(CashbookEntry.created_at >= day_start)
        .where(CashbookEntry.created_at <= day_end)
        .order_by(CashbookEntry.id.desc())
    ).all()
    day_summary = _sum_rows(day_rows)
    bill_cash_today = _sum_bill_cash(session, start_iso=day_start, end_iso=day_end)
    exchange_cash_in_today = _sum_exchange_cash_in(session, start_iso=day_start, end_iso=day_end)
    return_cash_today = _sum_return_cash(session, start_iso=day_start, end_iso=day_end)
    purchase_cash_today = _sum_purchase_cash_out(session, start_iso=day_start, end_iso=day_end)
    bankbook_contra_today = _sum_bankbook_contra(session, start_iso=day_start, end_iso=day_end)
    day_summary["receipts"] = round(
        float(day_summary["receipts"]) + bill_cash_today + exchange_cash_in_today + float(bankbook_contra_today["receipts"]),
        2,
    )
    day_summary["withdrawals"] = round(
        float(day_summary["withdrawals"]) + return_cash_today + purchase_cash_today + float(bankbook_contra_today["withdrawals"]),
        2,
    )
    day_summary["expenses"] = round(float(day_summary["expenses"]) + float(bankbook_contra_today["expenses"]), 2)
    day_summary["cash_out"] = round(float(day_summary["withdrawals"]) + float(day_summary["expenses"]), 2)
    day_summary["net_change"] = round(float(day_summary["receipts"]) - float(day_summary["cash_out"]), 2)

    closing_balance = round(opening_balance + day_summary["net_change"], 2)
    out = {
        "date": date,
        "opening_balance": round(opening_balance, 2),
        "closing_balance": closing_balance,
        "summary": day_summary,
    }
    if include_entries:
        out["entries"] = day_rows
    return out


def _iter_dates(from_date: str, to_date: str):
    start = _parse_ymd(from_date)
    end = _parse_ymd(to_date)
    if start > end:
        raise HTTPException(status_code=400, detail="from_date must be before or equal to to_date")
    day = start
    while day <= end:
        yield day.date().isoformat()
        day += timedelta(days=1)


@router.post("/", response_model=CashbookOut)
def create_entry(payload: CashbookCreate):
    et = (payload.entry_type or "").strip().upper()
    if et not in VALID_ENTRY_TYPES:
        raise HTTPException(
            status_code=400,
            detail="entry_type must be RECEIPT, WITHDRAWAL, EXPENSE, CONTRA or OPENING",
        )

    amt = float(payload.amount or 0)
    if amt <= 0:
        raise HTTPException(status_code=400, detail="amount must be > 0")

    now_time = datetime.now().strftime("%H:%M:%S")
    created_at = datetime.now().isoformat(timespec="seconds")
    if payload.entry_date:
        day_dt = _parse_ymd(payload.entry_date)
        created_at = f"{day_dt.date().isoformat()}T{now_time}"

    with get_session() as session:
        assert_financial_year_unlocked(session, created_at, context="Cashbook entry")
        row = CashbookEntry(
            entry_type=et,
            amount=amt,
            note=(payload.note or None),
            created_at=created_at,
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        return row


@router.patch("/entry/{entry_id}", response_model=CashbookOut)
def update_entry(entry_id: int, payload: CashbookCreate):
    require_min_role("MANAGER", context="Cashbook entry edit")
    et = (payload.entry_type or "").strip().upper()
    if et not in VALID_ENTRY_TYPES:
        raise HTTPException(
            status_code=400,
            detail="entry_type must be RECEIPT, WITHDRAWAL, EXPENSE, CONTRA or OPENING",
        )

    amt = float(payload.amount or 0)
    if amt <= 0:
        raise HTTPException(status_code=400, detail="amount must be > 0")

    with get_session() as session:
        row = session.exec(select(CashbookEntry).where(CashbookEntry.id == entry_id)).first()
        if not row:
            raise HTTPException(status_code=404, detail="cashbook entry not found")

        assert_financial_year_unlocked(session, row.created_at, context="Cashbook entry edit")
        created_at = row.created_at
        if payload.entry_date:
            day_dt = _parse_ymd(payload.entry_date)
            time_part = str(row.created_at or "")[11:19] if len(str(row.created_at or "")) >= 19 else datetime.now().strftime("%H:%M:%S")
            created_at = f"{day_dt.date().isoformat()}T{time_part}"
            assert_financial_year_unlocked(session, created_at, context="Cashbook entry edit")

        row.entry_type = et
        row.amount = amt
        row.note = payload.note or None
        row.created_at = created_at
        session.add(row)
        session.commit()
        session.refresh(row)
        return row


@router.get("/", response_model=List[CashbookOut])
def list_entries(
    from_date: Optional[str] = Query(default=None),
    to_date: Optional[str] = Query(default=None),
    limit: int = Query(default=200, ge=1, le=2000),
    offset: int = Query(default=0, ge=0),
):
    start_iso, end_iso = _range_bounds(from_date, to_date)

    with get_session() as session:
        stmt = select(CashbookEntry)
        if start_iso and end_iso:
            stmt = stmt.where(CashbookEntry.created_at >= start_iso).where(CashbookEntry.created_at <= end_iso)

        stmt = stmt.order_by(CashbookEntry.id.desc()).offset(offset).limit(limit)
        rows = session.exec(stmt).all()
        return rows


@router.get("/summary")
def summary(
    from_date: Optional[str] = Query(default=None),
    to_date: Optional[str] = Query(default=None),
):
    start_iso, end_iso = _range_bounds(from_date, to_date)

    with get_session() as session:
        base = select(CashbookEntry)
        if start_iso and end_iso:
            base = base.where(CashbookEntry.created_at >= start_iso).where(CashbookEntry.created_at <= end_iso)

        rows = session.exec(base).all()
        out = _sum_rows(rows)
        bill_cash = _sum_bill_cash(session, start_iso=start_iso, end_iso=end_iso)
        exchange_cash_in = _sum_exchange_cash_in(session, start_iso=start_iso, end_iso=end_iso)
        return_cash = _sum_return_cash(session, start_iso=start_iso, end_iso=end_iso)
        purchase_cash = _sum_purchase_cash_out(session, start_iso=start_iso, end_iso=end_iso)
        bankbook_contra = _sum_bankbook_contra(session, start_iso=start_iso, end_iso=end_iso)
        out["receipts"] = round(float(out["receipts"]) + bill_cash + exchange_cash_in + float(bankbook_contra["receipts"]), 2)
        out["withdrawals"] = round(float(out["withdrawals"]) + return_cash + purchase_cash + float(bankbook_contra["withdrawals"]), 2)
        out["expenses"] = round(float(out["expenses"]) + float(bankbook_contra["expenses"]), 2)
        out["cash_out"] = round(float(out["withdrawals"]) + float(out["expenses"]), 2)
        out["net_change"] = round(float(out["receipts"]) - float(out["cash_out"]), 2)

        return out


@router.get("/daily-summary")
def daily_summary(
    from_date: Optional[str] = Query(default=None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(default=None, description="YYYY-MM-DD"),
    dates: Optional[str] = Query(default=None, description="Comma-separated YYYY-MM-DD values"),
):
    if dates:
        requested_dates = sorted({d.strip() for d in dates.split(",") if d.strip()})
    elif from_date and to_date:
        requested_dates = list(_iter_dates(from_date, to_date))
    else:
        raise HTTPException(status_code=400, detail="provide dates or from_date/to_date")

    for date in requested_dates:
        _parse_ymd(date)

    with get_session() as session:
        return [_day_snapshot(session, date, include_entries=False) for date in requested_dates]


@router.get("/day")
def day_cashbook(date: str = Query(..., description="YYYY-MM-DD")):
    with get_session() as session:
        return _day_snapshot(session, date, include_entries=True)


@router.delete("/entry/{entry_id}")
def delete_cashbook_entry(entry_id: int):
    """
    Delete a particular cashbook entry by id.
    """
    require_min_role("MANAGER", context="Cashbook entry delete")
    with get_session() as session:
        # ensure exists
        row = session.exec(select(CashbookEntry).where(CashbookEntry.id == entry_id)).first()
        if not row:
            raise HTTPException(status_code=404, detail="cashbook entry not found")
        assert_financial_year_unlocked(session, row.created_at, context="Cashbook entry delete")

        session.exec(text("DELETE FROM cashbookentry WHERE id = :id").bindparams(id=entry_id))
        session.commit()

    return {"ok": True, "deleted_id": entry_id}


@router.delete("/last")
def clear_last_cashbook_entry(
    from_date: Optional[str] = Query(default=None),
    to_date: Optional[str] = Query(default=None),
):
    """
    Delete the last cashbook entry (most recent by id).
    - If no from/to provided: defaults to TODAY only (safe).
    - If from/to provided: deletes last entry within that range.
    """
    # default safe scope = today
    if not from_date and not to_date:
        today = today_yyyy_mm_dd()
        from_date = today
        to_date = today

    start_iso, end_iso = _range_bounds(from_date, to_date)

    with get_session() as session:
        if not start_iso or not end_iso:
            return {"ok": True, "deleted_id": None}

        # get last id in range
        q = text("""
            SELECT id
            FROM cashbookentry
            WHERE created_at >= :start AND created_at <= :end
            ORDER BY id DESC
            LIMIT 1
        """).bindparams(start=start_iso, end=end_iso)

        last_id = session.exec(q).first()
        if not last_id:
            return {"ok": True, "deleted_id": None}

        row = session.exec(select(CashbookEntry).where(CashbookEntry.id == int(last_id))).first()
        if row:
            assert_financial_year_unlocked(session, row.created_at, context="Cashbook clear last")

        session.exec(text("DELETE FROM cashbookentry WHERE id = :id").bindparams(id=int(last_id)))
        session.commit()

    return {"ok": True, "deleted_id": int(last_id), "scope": "range", "from": from_date, "to": to_date}


@router.delete("/clear-today")
def clear_today_cashbook():
    """
    Safe delete: clears ONLY today's cashbook entries (by created_at date).
    created_at stored as ISO string like "YYYY-MM-DDTHH:MM:SS"
    """
    require_min_role("OWNER", context="Cashbook clear today")
    today = today_yyyy_mm_dd()

    with get_session() as session:
        rows = session.exec(select(CashbookEntry).where(CashbookEntry.created_at >= f"{today}T00:00:00").where(CashbookEntry.created_at <= f"{today}T23:59:59.999999")).all()
        for row in rows:
            assert_financial_year_unlocked(session, row.created_at, context="Cashbook clear today")
        stmt = text(
            "DELETE FROM cashbookentry WHERE substr(created_at, 1, 10) = :d"
        ).bindparams(d=today)

        session.exec(stmt)
        session.commit()

    return {"ok": True, "scope": "today", "date": today}


@router.delete("/clear")
def clear_all_cashbook():
    """Dangerous: clears ALL cashbook history."""
    require_min_role("OWNER", context="Cashbook clear all")
    with get_session() as session:
        rows = session.exec(select(CashbookEntry)).all()
        for row in rows:
            assert_financial_year_unlocked(session, row.created_at, context="Cashbook clear all")
        session.exec(text("DELETE FROM cashbookentry"))
        session.commit()

    return {"ok": True, "scope": "all"}
    require_min_role("MANAGER", context="Cashbook clear last")
