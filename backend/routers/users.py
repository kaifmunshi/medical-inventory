from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func
from sqlmodel import select

from backend.controls import log_audit
from backend.db import get_session
from backend.models import AppUser, AppUserCreate, AppUserOut, AppUserUpdate
from backend.security import create_session_token, require_min_role

router = APIRouter()

VALID_ROLES = {"OWNER", "MANAGER", "STAFF"}


class UserSessionLoginIn(BaseModel):
    user_id: int
    pin: Optional[str] = None


class UserSessionLoginOut(BaseModel):
    token: str
    user: AppUserOut


def _clean(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    text = " ".join(str(raw).strip().split())
    return text or None


def _normalize_role(raw: Optional[str]) -> str:
    role = str(raw or "").strip().upper()
    if role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail="role must be OWNER, MANAGER, or STAFF")
    return role


def _normalize_pin(raw: Optional[str], *, required: bool = False) -> Optional[str]:
    text = "" if raw is None else str(raw).strip()
    if not text:
        if required:
            raise HTTPException(status_code=400, detail="PIN is required")
        return None
    if not text.isdigit():
        raise HTTPException(status_code=400, detail="PIN must contain digits only")
    if len(text) < 4 or len(text) > 6:
        raise HTTPException(status_code=400, detail="PIN must be 4 to 6 digits")
    return text


def _to_user_out(row: AppUser) -> AppUserOut:
    data = row.dict()
    data.pop("pin", None)
    data["has_pin"] = bool(str(getattr(row, "pin", "") or "").strip())
    return AppUserOut(**data)


def _ensure_name_available(session, *, name: str, exclude_user_id: Optional[int] = None) -> None:
    stmt = select(AppUser).where(func.lower(AppUser.name) == name.lower())
    if exclude_user_id is not None:
        stmt = stmt.where(AppUser.id != exclude_user_id)
    existing = session.exec(stmt).first()
    if existing:
        raise HTTPException(status_code=400, detail="User already exists")


def _ensure_owner_safety(session, *, target_user_id: int, next_role: str, next_is_active: bool) -> None:
    owner_rows = session.exec(
        select(AppUser).where(AppUser.is_active == True, AppUser.role == "OWNER")  # noqa: E712
    ).all()
    remaining_owner_ids = {int(row.id) for row in owner_rows if row.id is not None}
    if not next_is_active or next_role != "OWNER":
        remaining_owner_ids.discard(int(target_user_id))
    if not remaining_owner_ids:
        raise HTTPException(status_code=400, detail="At least one active OWNER user is required")


@router.post("/session/login", response_model=UserSessionLoginOut)
def login_user_session(payload: UserSessionLoginIn):
    with get_session() as session:
        row = session.get(AppUser, int(payload.user_id))
        if not row or not bool(getattr(row, "is_active", False)):
            raise HTTPException(status_code=404, detail="Active user not found")

        expected_pin = str(getattr(row, "pin", "") or "").strip()
        supplied_pin = str(payload.pin or "").strip()
        if expected_pin:
            if supplied_pin != expected_pin:
                raise HTTPException(status_code=401, detail="Invalid PIN")
        elif supplied_pin:
            raise HTTPException(status_code=400, detail="This user does not use a PIN")

        token = create_session_token(user_id=int(row.id), name=row.name, role=row.role)
        return UserSessionLoginOut(token=token, user=_to_user_out(row))


@router.get("/", response_model=List[AppUserOut])
def list_users(active_only: bool = Query(True)):
    with get_session() as session:
        stmt = select(AppUser)
        if active_only:
            stmt = stmt.where(AppUser.is_active == True)  # noqa: E712
        rows = session.exec(stmt.order_by(func.lower(AppUser.name).asc(), AppUser.id.asc())).all()
        return [_to_user_out(row) for row in rows]


@router.post("/", response_model=AppUserOut, status_code=201)
def create_user(payload: AppUserCreate):
    require_min_role("OWNER", context="User creation")
    name = _clean(payload.name)
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    role = _normalize_role(payload.role)
    pin = _normalize_pin(payload.pin)

    with get_session() as session:
        _ensure_name_available(session, name=name)
        ts = datetime.now().isoformat(timespec="seconds")
        row = AppUser(name=name, role=role, pin=pin, is_active=True, created_at=ts, updated_at=ts)
        session.add(row)
        session.flush()
        log_audit(
            session,
            entity_type="USER",
            entity_id=int(row.id),
            action="CREATE",
            note=f"Created user {row.name}",
            details={"role": row.role, "has_pin": bool(pin)},
        )
        session.commit()
        session.refresh(row)
        return _to_user_out(row)


@router.patch("/{user_id}", response_model=AppUserOut)
def update_user(user_id: int, payload: AppUserUpdate):
    require_min_role("OWNER", context="User update")
    with get_session() as session:
        row = session.get(AppUser, user_id)
        if not row:
            raise HTTPException(status_code=404, detail="User not found")

        before = row.dict()
        data = payload.dict(exclude_unset=True)

        next_name = row.name
        next_role = row.role
        next_is_active = bool(row.is_active)

        if "name" in data:
            name = _clean(data["name"])
            if not name:
                raise HTTPException(status_code=400, detail="name is required")
            _ensure_name_available(session, name=name, exclude_user_id=int(user_id))
            next_name = name

        if "role" in data:
            next_role = _normalize_role(data["role"])
        if "is_active" in data:
            next_is_active = bool(data["is_active"])

        _ensure_owner_safety(
            session,
            target_user_id=int(user_id),
            next_role=next_role,
            next_is_active=next_is_active,
        )

        row.name = next_name
        row.role = next_role
        row.is_active = next_is_active
        if "pin" in data:
            row.pin = _normalize_pin(data["pin"])
        row.updated_at = datetime.now().isoformat(timespec="seconds")
        session.add(row)
        log_audit(
            session,
            entity_type="USER",
            entity_id=int(row.id),
            action="UPDATE",
            note=f"Updated user {row.name}",
            details={"before": before, "after": row.dict()},
        )
        session.commit()
        session.refresh(row)
        return _to_user_out(row)
