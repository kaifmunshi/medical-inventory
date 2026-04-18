import json
from datetime import datetime
from typing import Any, Optional

from fastapi import HTTPException
from sqlmodel import select

from backend.models import AuditLog, FinancialYear
from backend.security import get_request_actor_name


def now_ts() -> str:
    return datetime.now().isoformat(timespec="seconds")


def normalize_ymd(raw: Optional[str]) -> str:
    if not raw:
        return datetime.now().date().isoformat()
    text = str(raw).strip().replace(" ", "T")
    if len(text) >= 10:
        text = text[:10]
    try:
        return datetime.strptime(text, "%Y-%m-%d").date().isoformat()
    except Exception:
        raise HTTPException(status_code=400, detail="Date must be YYYY-MM-DD")


def assert_financial_year_unlocked(session, raw_date: Optional[str], *, context: str) -> None:
    ymd = normalize_ymd(raw_date)
    row = session.exec(
        select(FinancialYear).where(
            FinancialYear.start_date <= ymd,
            FinancialYear.end_date >= ymd,
        )
    ).first()
    if row and bool(row.is_locked):
        raise HTTPException(
            status_code=400,
            detail=f"{context} is not allowed because financial year '{row.label}' is locked",
        )


def log_audit(
    session,
    *,
    entity_type: str,
    entity_id: Optional[int],
    action: str,
    note: Optional[str] = None,
    details: Optional[Any] = None,
    actor: Optional[str] = None,
) -> AuditLog:
    row = AuditLog(
        event_ts=now_ts(),
        entity_type=str(entity_type).upper(),
        entity_id=entity_id,
        action=str(action).upper(),
        note=(str(note).strip() if note else None),
        details_json=(json.dumps(details, ensure_ascii=True, sort_keys=True) if details is not None else None),
        actor=(str(actor).strip() if actor else get_request_actor_name()),
    )
    session.add(row)
    session.flush()
    return row
