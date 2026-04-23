from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func, or_
from sqlmodel import select

from backend.controls import log_audit
from backend.db import get_session
from backend.models import (
    AuditLog,
    AuditLogOut,
    FinancialYear,
    FinancialYearCreate,
    FinancialYearOut,
    FinancialYearUpdate,
)
from backend.security import require_min_role

router = APIRouter()


def _normalize_ymd(raw: str) -> str:
    text = str(raw or "").strip()[:10]
    try:
        return datetime.strptime(text, "%Y-%m-%d").date().isoformat()
    except Exception:
        raise HTTPException(status_code=400, detail="Date must be YYYY-MM-DD")


def _clean_text(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    text = " ".join(str(raw).strip().split())
    return text or None


def _expected_financial_year_label(start_date: str) -> str:
    start_year = int(start_date[:4])
    return f"FY {str(start_year)[-2:]}-{str(start_year + 1)[-2:]}"


def _validate_financial_year_range(start_date: str, end_date: str) -> None:
    if start_date > end_date:
        raise HTTPException(status_code=400, detail="start_date cannot be after end_date")
    start_dt = datetime.strptime(start_date, "%Y-%m-%d").date()
    end_dt = datetime.strptime(end_date, "%Y-%m-%d").date()
    if not (start_dt.month == 4 and start_dt.day == 1):
        raise HTTPException(status_code=400, detail="Financial year must start on 01 Apr")
    if not (end_dt.month == 3 and end_dt.day == 31):
        raise HTTPException(status_code=400, detail="Financial year must end on 31 Mar")
    if end_dt.year != start_dt.year + 1:
        raise HTTPException(status_code=400, detail="Financial year end must be 31 Mar of the next year")


@router.get("/financial-years", response_model=List[FinancialYearOut])
def list_financial_years():
    with get_session() as session:
        rows = session.exec(select(FinancialYear).order_by(FinancialYear.start_date.desc(), FinancialYear.id.desc())).all()
        return [FinancialYearOut(**row.dict()) for row in rows]


@router.post("/financial-years", response_model=FinancialYearOut, status_code=201)
def create_financial_year(payload: FinancialYearCreate):
    require_min_role("MANAGER", context="Financial year creation")
    start_date = _normalize_ymd(payload.start_date)
    end_date = _normalize_ymd(payload.end_date)
    _validate_financial_year_range(start_date, end_date)
    label = _clean_text(payload.label) or _expected_financial_year_label(start_date)

    with get_session() as session:
        overlap = session.exec(
            select(FinancialYear).where(
                FinancialYear.start_date <= end_date,
                FinancialYear.end_date >= start_date,
            )
        ).first()
        if overlap:
            raise HTTPException(status_code=400, detail="Financial year overlaps an existing range")
        ts = datetime.now().isoformat(timespec="seconds")
        if payload.is_active:
            active_rows = session.exec(select(FinancialYear).where(FinancialYear.is_active == True)).all()  # noqa: E712
            for row in active_rows:
                row.is_active = False
                row.updated_at = ts
                session.add(row)
        row = FinancialYear(
            label=label,
            start_date=start_date,
            end_date=end_date,
            is_active=bool(payload.is_active),
            is_locked=False,
            created_at=ts,
            updated_at=ts,
        )
        session.add(row)
        session.flush()
        log_audit(
            session,
            entity_type="FINANCIAL_YEAR",
            entity_id=int(row.id),
            action="CREATE",
            note=f"Created financial year {label}",
            details={"label": label, "start_date": start_date, "end_date": end_date, "is_active": bool(payload.is_active)},
        )
        session.commit()
        session.refresh(row)
        return FinancialYearOut(**row.dict())


@router.patch("/financial-years/{year_id}", response_model=FinancialYearOut)
def update_financial_year(year_id: int, payload: FinancialYearUpdate):
    require_min_role("MANAGER", context="Financial year update")
    with get_session() as session:
        row = session.get(FinancialYear, year_id)
        if not row:
            raise HTTPException(status_code=404, detail="Financial year not found")

        before = row.dict()
        data = payload.dict(exclude_unset=True)
        if "label" in data:
            label = _clean_text(data["label"])
            if not label:
                raise HTTPException(status_code=400, detail="label is required")
            row.label = label
        if "start_date" in data:
            row.start_date = _normalize_ymd(data["start_date"])
        if "end_date" in data:
            row.end_date = _normalize_ymd(data["end_date"])
        _validate_financial_year_range(row.start_date, row.end_date)
        if not _clean_text(row.label):
            row.label = _expected_financial_year_label(row.start_date)

        overlap = session.exec(
            select(FinancialYear).where(
                FinancialYear.id != year_id,
                FinancialYear.start_date <= row.end_date,
                FinancialYear.end_date >= row.start_date,
            )
        ).first()
        if overlap:
            raise HTTPException(status_code=400, detail="Financial year overlaps an existing range")

        if "is_active" in data and bool(data["is_active"]):
            active_rows = session.exec(select(FinancialYear).where(FinancialYear.is_active == True, FinancialYear.id != year_id)).all()  # noqa: E712
            for active in active_rows:
                active.is_active = False
                active.updated_at = datetime.now().isoformat(timespec="seconds")
                session.add(active)
            row.is_active = True
        elif "is_active" in data:
            next_active = bool(data["is_active"])
            if not next_active:
                other_active = session.exec(
                    select(FinancialYear).where(FinancialYear.is_active == True, FinancialYear.id != year_id)  # noqa: E712
                ).first()
                if not other_active:
                    raise HTTPException(status_code=400, detail="At least one financial year must remain active")
            row.is_active = next_active

        if "is_locked" in data:
            row.is_locked = bool(data["is_locked"])

        row.updated_at = datetime.now().isoformat(timespec="seconds")
        session.add(row)
        session.flush()
        log_audit(
            session,
            entity_type="FINANCIAL_YEAR",
            entity_id=int(row.id),
            action="UPDATE",
            note=f"Updated financial year {row.label}",
            details={"before": before, "after": row.dict()},
        )
        session.commit()
        session.refresh(row)
        return FinancialYearOut(**row.dict())


@router.get("/audit-logs", response_model=List[AuditLogOut])
def list_audit_logs(
    q: Optional[str] = Query(None),
    entity_type: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    with get_session() as session:
        stmt = select(AuditLog)
        et = _clean_text(entity_type)
        if et:
            stmt = stmt.where(AuditLog.entity_type == et.upper())
        qq = _clean_text(q)
        if qq:
            like = f"%{qq.lower()}%"
            stmt = stmt.where(
                or_(
                    func.lower(func.coalesce(AuditLog.entity_type, "")).like(like),
                    func.lower(func.coalesce(AuditLog.action, "")).like(like),
                    func.lower(func.coalesce(AuditLog.note, "")).like(like),
                    func.lower(func.coalesce(AuditLog.actor, "")).like(like),
                    func.lower(func.coalesce(AuditLog.details_json, "")).like(like),
                )
            )
        rows = session.exec(stmt.order_by(AuditLog.id.desc()).offset(offset).limit(limit)).all()
        return [AuditLogOut(**row.dict()) for row in rows]
