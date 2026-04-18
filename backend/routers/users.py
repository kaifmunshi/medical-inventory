from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func
from sqlmodel import select

from backend.controls import log_audit
from backend.db import get_session
from backend.models import AppUser, AppUserCreate, AppUserOut, AppUserUpdate
from backend.security import require_min_role

router = APIRouter()


def _clean(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    text = " ".join(str(raw).strip().split())
    return text or None


def _normalize_role(raw: Optional[str]) -> str:
    role = str(raw or "").strip().upper()
    if role not in {"OWNER", "MANAGER", "STAFF"}:
        raise HTTPException(status_code=400, detail="role must be OWNER, MANAGER, or STAFF")
    return role


@router.get("/", response_model=List[AppUserOut])
def list_users(active_only: bool = Query(True)):
    with get_session() as session:
        stmt = select(AppUser)
        if active_only:
            stmt = stmt.where(AppUser.is_active == True)  # noqa: E712
        rows = session.exec(stmt.order_by(func.lower(AppUser.name).asc(), AppUser.id.asc())).all()
        return [AppUserOut(**row.dict()) for row in rows]


@router.post("/", response_model=AppUserOut, status_code=201)
def create_user(payload: AppUserCreate):
    require_min_role("OWNER", context="User creation")
    name = _clean(payload.name)
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    role = _normalize_role(payload.role)
    with get_session() as session:
        existing = session.exec(select(AppUser).where(func.lower(AppUser.name) == name.lower())).first()
        if existing:
            raise HTTPException(status_code=400, detail="User already exists")
        ts = datetime.now().isoformat(timespec="seconds")
        row = AppUser(name=name, role=role, pin=_clean(payload.pin), is_active=True, created_at=ts, updated_at=ts)
        session.add(row)
        session.flush()
        log_audit(
            session,
            entity_type="USER",
            entity_id=int(row.id),
            action="CREATE",
            note=f"Created user {row.name}",
            details={"role": row.role},
        )
        session.commit()
        session.refresh(row)
        return AppUserOut(**row.dict())


@router.patch("/{user_id}", response_model=AppUserOut)
def update_user(user_id: int, payload: AppUserUpdate):
    require_min_role("OWNER", context="User update")
    with get_session() as session:
        row = session.get(AppUser, user_id)
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        data = payload.dict(exclude_unset=True)
        if "name" in data:
            name = _clean(data["name"])
            if not name:
                raise HTTPException(status_code=400, detail="name is required")
            row.name = name
        if "role" in data:
            row.role = _normalize_role(data["role"])
        if "pin" in data:
            row.pin = _clean(data["pin"])
        if "is_active" in data:
            row.is_active = bool(data["is_active"])
        row.updated_at = datetime.now().isoformat(timespec="seconds")
        session.add(row)
        log_audit(
            session,
            entity_type="USER",
            entity_id=int(row.id),
            action="UPDATE",
            note=f"Updated user {row.name}",
            details={"role": row.role, "is_active": row.is_active},
        )
        session.commit()
        session.refresh(row)
        return AppUserOut(**row.dict())
