from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import text
from sqlmodel import select

from backend.controls import assert_financial_year_unlocked
from backend.db import get_session
from backend.models import (
    BankbookCreate,
    BankbookEntry,
    BankbookOut,
    Bill,
    BillPayment,
    ExchangeRecord,
    Return,
)
from backend.security import require_min_role

router = APIRouter()

VALID_ENTRY_TYPES = {"RECEIPT", "WITHDRAWAL", "EXPENSE"}
VALID_MODES = {"UPI", "NEFT", "RTGS", "IMPS", "BANK_DEPOSIT"}


def today_yyyy_mm_dd() -> str:
    return datetime.now().date().isoformat()


def _range_bounds(from_date: Optional[str], to_date: Optional[str]):
    if not from_date and not to_date:
        return None, None

    f = from_date or to_date
    t = to_date or from_date
    if not f or not t:
        return None, None

    start_iso = f"{f}T00:00:00"
    end_iso = f"{t}T23:59:59.999999"
    return start_iso, end_iso


def _parse_ymd(date_str: str) -> datetime:
    try:
        return datetime.strptime(date_str, "%Y-%m-%d")
    except Exception:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")


def _sum_rows(rows: List[BankbookEntry]):
    receipts = 0.0
    withdrawals = 0.0
    expenses = 0.0
    charges = 0.0
    for r in rows:
        et = (r.entry_type or "").upper()
        amt = float(r.amount or 0)
        txn_charges = float(getattr(r, "txn_charges", 0) or 0)
        charges += txn_charges
        if et == "OPENING":
            continue
        if et == "RECEIPT":
            receipts += amt
        elif et == "WITHDRAWAL":
            withdrawals += amt
        else:
            expenses += amt

    bank_out = withdrawals + expenses + charges
    net_change = receipts - bank_out
    return {
        "bank_out": round(bank_out, 2),
        "withdrawals": round(withdrawals, 2),
        "expenses": round(expenses, 2),
        "receipts": round(receipts, 2),
        "charges": round(charges, 2),
        "net_change": round(net_change, 2),
        "count": len(rows),
    }


def _sum_bill_online(session, *, start_iso: Optional[str] = None, end_iso: Optional[str] = None) -> float:
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
        total += float(getattr(p, "online_amount", 0) or 0)
    return round(total, 2)


def _sum_return_online(session, *, start_iso: Optional[str] = None, end_iso: Optional[str] = None) -> float:
    stmt = select(Return)
    if start_iso:
        stmt = stmt.where(Return.date_time >= start_iso)
    if end_iso:
        stmt = stmt.where(Return.date_time <= end_iso)
    rows = session.exec(stmt).all()
    total = 0.0
    for r in rows:
        total += float(getattr(r, "refund_online", 0) or 0)
    return round(total, 2)


def _sum_exchange_online_in(session, *, start_iso: Optional[str] = None, end_iso: Optional[str] = None) -> float:
    stmt = select(ExchangeRecord)
    if start_iso:
        stmt = stmt.where(ExchangeRecord.created_at >= start_iso)
    if end_iso:
        stmt = stmt.where(ExchangeRecord.created_at <= end_iso)
    rows = session.exec(stmt).all()
    total = 0.0
    for r in rows:
        total += float(getattr(r, "payment_online", 0) or 0)
    return round(total, 2)


def _sum_exchange_online_out(session, *, start_iso: Optional[str] = None, end_iso: Optional[str] = None) -> float:
    stmt = select(ExchangeRecord)
    if start_iso:
        stmt = stmt.where(ExchangeRecord.created_at >= start_iso)
    if end_iso:
        stmt = stmt.where(ExchangeRecord.created_at <= end_iso)
    rows = session.exec(stmt).all()
    total = 0.0
    for r in rows:
        total += float(getattr(r, "refund_online", 0) or 0)
    return round(total, 2)


@router.post("/", response_model=BankbookOut)
def create_entry(payload: BankbookCreate):
    et = (payload.entry_type or "").strip().upper()
    if et not in VALID_ENTRY_TYPES:
        raise HTTPException(status_code=400, detail="entry_type must be RECEIPT, WITHDRAWAL or EXPENSE")

    mode = (payload.mode or "").strip().upper()
    if mode not in VALID_MODES:
        raise HTTPException(status_code=400, detail="mode must be UPI, NEFT, RTGS, IMPS or BANK_DEPOSIT")

    amt = float(payload.amount or 0)
    if amt <= 0:
        raise HTTPException(status_code=400, detail="amount must be > 0")

    txn_charges = float(payload.txn_charges or 0)
    if txn_charges < 0:
        raise HTTPException(status_code=400, detail="txn_charges cannot be negative")

    now_time = datetime.now().strftime("%H:%M:%S")
    created_at = datetime.now().isoformat(timespec="seconds")
    if payload.entry_date:
        day_dt = _parse_ymd(payload.entry_date)
        created_at = f"{day_dt.date().isoformat()}T{now_time}"

    with get_session() as session:
        assert_financial_year_unlocked(session, created_at, context="Bankbook entry")
        row = BankbookEntry(
            entry_type=et,
            mode=mode,
            amount=amt,
            txn_charges=txn_charges,
            note=(payload.note or None),
            created_at=created_at,
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        return row


@router.get("/", response_model=List[BankbookOut])
def list_entries(
    from_date: Optional[str] = Query(default=None),
    to_date: Optional[str] = Query(default=None),
    limit: int = Query(default=200, ge=1, le=2000),
    offset: int = Query(default=0, ge=0),
):
    start_iso, end_iso = _range_bounds(from_date, to_date)

    with get_session() as session:
        stmt = select(BankbookEntry)
        if start_iso and end_iso:
            stmt = stmt.where(BankbookEntry.created_at >= start_iso).where(BankbookEntry.created_at <= end_iso)

        stmt = stmt.order_by(BankbookEntry.id.desc()).offset(offset).limit(limit)
        return session.exec(stmt).all()


@router.get("/summary")
def summary(
    from_date: Optional[str] = Query(default=None),
    to_date: Optional[str] = Query(default=None),
):
    start_iso, end_iso = _range_bounds(from_date, to_date)

    with get_session() as session:
        base = select(BankbookEntry)
        if start_iso and end_iso:
            base = base.where(BankbookEntry.created_at >= start_iso).where(BankbookEntry.created_at <= end_iso)

        rows = session.exec(base).all()
        out = _sum_rows(rows)
        bill_online = _sum_bill_online(session, start_iso=start_iso, end_iso=end_iso)
        exchange_online_in = _sum_exchange_online_in(session, start_iso=start_iso, end_iso=end_iso)
        return_online = _sum_return_online(session, start_iso=start_iso, end_iso=end_iso)
        exchange_online_out = _sum_exchange_online_out(session, start_iso=start_iso, end_iso=end_iso)
        out["receipts"] = round(float(out["receipts"]) + bill_online + exchange_online_in, 2)
        out["withdrawals"] = round(float(out["withdrawals"]) + return_online + exchange_online_out, 2)
        out["bank_out"] = round(float(out["withdrawals"]) + float(out["expenses"]) + float(out["charges"]), 2)
        out["net_change"] = round(float(out["receipts"]) - float(out["bank_out"]), 2)
        return out


@router.get("/day")
def day_bankbook(date: str = Query(..., description="YYYY-MM-DD")):
    day_dt = _parse_ymd(date)
    prev_date = (day_dt - timedelta(days=1)).date().isoformat()

    day_start = f"{date}T00:00:00"
    day_end = f"{date}T23:59:59.999999"
    prev_end = f"{prev_date}T23:59:59.999999"

    with get_session() as session:
        opening_rows = session.exec(
            select(BankbookEntry).where(BankbookEntry.created_at <= prev_end)
        ).all()
        opening_summary = _sum_rows(opening_rows)
        opening_balance = (
            opening_summary["net_change"]
            + _sum_bill_online(session, end_iso=prev_end)
            + _sum_exchange_online_in(session, end_iso=prev_end)
            - _sum_return_online(session, end_iso=prev_end)
            - _sum_exchange_online_out(session, end_iso=prev_end)
        )

        day_rows = session.exec(
            select(BankbookEntry)
            .where(BankbookEntry.created_at >= day_start)
            .where(BankbookEntry.created_at <= day_end)
            .order_by(BankbookEntry.id.desc())
        ).all()
        day_summary = _sum_rows(day_rows)
        bill_online_today = _sum_bill_online(session, start_iso=day_start, end_iso=day_end)
        exchange_online_in_today = _sum_exchange_online_in(session, start_iso=day_start, end_iso=day_end)
        return_online_today = _sum_return_online(session, start_iso=day_start, end_iso=day_end)
        exchange_online_out_today = _sum_exchange_online_out(session, start_iso=day_start, end_iso=day_end)
        day_summary["receipts"] = round(float(day_summary["receipts"]) + bill_online_today + exchange_online_in_today, 2)
        day_summary["withdrawals"] = round(
            float(day_summary["withdrawals"]) + return_online_today + exchange_online_out_today,
            2,
        )
        day_summary["bank_out"] = round(
            float(day_summary["withdrawals"]) + float(day_summary["expenses"]) + float(day_summary["charges"]),
            2,
        )
        day_summary["net_change"] = round(float(day_summary["receipts"]) - float(day_summary["bank_out"]), 2)

        closing_balance = round(opening_balance + day_summary["net_change"], 2)
        return {
            "date": date,
            "opening_balance": round(opening_balance, 2),
            "closing_balance": closing_balance,
            "summary": day_summary,
            "entries": day_rows,
        }


@router.delete("/entry/{entry_id}")
def delete_bankbook_entry(entry_id: int):
    require_min_role("MANAGER", context="Bankbook entry delete")
    with get_session() as session:
        row = session.exec(select(BankbookEntry).where(BankbookEntry.id == entry_id)).first()
        if not row:
            raise HTTPException(status_code=404, detail="bankbook entry not found")
        assert_financial_year_unlocked(session, row.created_at, context="Bankbook entry delete")

        session.exec(text("DELETE FROM bankbookentry WHERE id = :id").bindparams(id=entry_id))
        session.commit()

    return {"ok": True, "deleted_id": entry_id}


@router.delete("/last")
def clear_last_bankbook_entry(
    from_date: Optional[str] = Query(default=None),
    to_date: Optional[str] = Query(default=None),
):
    require_min_role("MANAGER", context="Bankbook clear last")
    if not from_date and not to_date:
        today = today_yyyy_mm_dd()
        from_date = today
        to_date = today

    start_iso, end_iso = _range_bounds(from_date, to_date)

    with get_session() as session:
        if not start_iso or not end_iso:
            return {"ok": True, "deleted_id": None}

        q = text("""
            SELECT id
            FROM bankbookentry
            WHERE created_at >= :start AND created_at <= :end
            ORDER BY id DESC
            LIMIT 1
        """).bindparams(start=start_iso, end=end_iso)

        last_id = session.exec(q).first()
        if not last_id:
            return {"ok": True, "deleted_id": None}

        row = session.exec(select(BankbookEntry).where(BankbookEntry.id == int(last_id))).first()
        if row:
            assert_financial_year_unlocked(session, row.created_at, context="Bankbook clear last")

        session.exec(text("DELETE FROM bankbookentry WHERE id = :id").bindparams(id=int(last_id)))
        session.commit()

    return {"ok": True, "deleted_id": int(last_id), "scope": "range", "from": from_date, "to": to_date}


@router.delete("/clear-today")
def clear_today_bankbook():
    require_min_role("OWNER", context="Bankbook clear today")
    today = today_yyyy_mm_dd()

    with get_session() as session:
        rows = session.exec(select(BankbookEntry).where(BankbookEntry.created_at >= f"{today}T00:00:00").where(BankbookEntry.created_at <= f"{today}T23:59:59.999999")).all()
        for row in rows:
            assert_financial_year_unlocked(session, row.created_at, context="Bankbook clear today")
        stmt = text("DELETE FROM bankbookentry WHERE substr(created_at, 1, 10) = :d").bindparams(d=today)
        session.exec(stmt)
        session.commit()

    return {"ok": True, "scope": "today", "date": today}


@router.delete("/clear")
def clear_all_bankbook():
    require_min_role("OWNER", context="Bankbook clear all")
    with get_session() as session:
        rows = session.exec(select(BankbookEntry)).all()
        for row in rows:
            assert_financial_year_unlocked(session, row.created_at, context="Bankbook clear all")
        session.exec(text("DELETE FROM bankbookentry"))
        session.commit()

    return {"ok": True, "scope": "all"}
