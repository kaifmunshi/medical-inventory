# backend/routers/cashbook.py
from datetime import datetime
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Query
from sqlmodel import select
from sqlalchemy import text  # ✅ use sqlalchemy.text (NOT sqlmodel.text)

from backend.db import get_session
from backend.models import CashbookEntry, CashbookCreate, CashbookOut

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
    end_iso = f"{t}T23:59:59"
    return start_iso, end_iso


@router.post("/", response_model=CashbookOut)
def create_entry(payload: CashbookCreate):
    et = (payload.entry_type or "").strip().upper()
    if et not in ("WITHDRAWAL", "EXPENSE"):
        raise HTTPException(status_code=400, detail="entry_type must be WITHDRAWAL or EXPENSE")

    amt = float(payload.amount or 0)
    if amt <= 0:
        raise HTTPException(status_code=400, detail="amount must be > 0")

    with get_session() as session:
        row = CashbookEntry(
            entry_type=et,
            amount=amt,
            note=(payload.note or None),
        )
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

        withdrawals = 0.0
        expenses = 0.0
        for r in rows:
            if (r.entry_type or "").upper() == "WITHDRAWAL":
                withdrawals += float(r.amount or 0)
            else:
                expenses += float(r.amount or 0)

        cash_out = withdrawals + expenses
        return {
            "cash_out": round(cash_out, 2),
            "withdrawals": round(withdrawals, 2),
            "expenses": round(expenses, 2),
            "count": len(rows),
        }


@router.delete("/entry/{entry_id}")
def delete_cashbook_entry(entry_id: int):
    """
    Delete a particular cashbook entry by id.
    """
    with get_session() as session:
        # ensure exists
        row = session.exec(select(CashbookEntry).where(CashbookEntry.id == entry_id)).first()
        if not row:
            raise HTTPException(status_code=404, detail="cashbook entry not found")

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

        session.exec(text("DELETE FROM cashbookentry WHERE id = :id").bindparams(id=int(last_id)))
        session.commit()

    return {"ok": True, "deleted_id": int(last_id), "scope": "range", "from": from_date, "to": to_date}


@router.delete("/clear-today")
def clear_today_cashbook():
    """
    Safe delete: clears ONLY today's cashbook entries (by created_at date).
    created_at stored as ISO string like "YYYY-MM-DDTHH:MM:SS"
    """
    today = today_yyyy_mm_dd()

    with get_session() as session:
        stmt = text(
            "DELETE FROM cashbookentry WHERE substr(created_at, 1, 10) = :d"
        ).bindparams(d=today)

        session.exec(stmt)
        session.commit()

    return {"ok": True, "scope": "today", "date": today}


@router.delete("/clear")
def clear_all_cashbook():
    """Dangerous: clears ALL cashbook history."""
    with get_session() as session:
        session.exec(text("DELETE FROM cashbookentry"))
        session.commit()

    return {"ok": True, "scope": "all"}
