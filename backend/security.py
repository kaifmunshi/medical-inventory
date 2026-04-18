from contextvars import ContextVar
from datetime import datetime
from typing import Iterable, Optional

from fastapi import HTTPException
from sqlmodel import select

from backend.models import AppUser

_actor_name: ContextVar[Optional[str]] = ContextVar("actor_name", default=None)
_actor_role: ContextVar[Optional[str]] = ContextVar("actor_role", default=None)

ROLE_ORDER = {"STAFF": 1, "MANAGER": 2, "OWNER": 3}


def set_request_actor(name: Optional[str], role: Optional[str]) -> None:
    normalized_name = " ".join(str(name or "").strip().split()) or None
    normalized_role = str(role or "").strip().upper() or None
    _actor_name.set(normalized_name)
    _actor_role.set(normalized_role)


def get_request_actor_name() -> Optional[str]:
    return _actor_name.get()


def get_request_actor_role() -> Optional[str]:
    return _actor_role.get()


def require_roles(allowed_roles: Iterable[str], *, context: str) -> None:
    current = str(get_request_actor_role() or "").upper()
    normalized_allowed = {str(role).upper() for role in allowed_roles}
    if current not in normalized_allowed:
        allowed = ", ".join(sorted(normalized_allowed))
        raise HTTPException(status_code=403, detail=f"{context} requires one of these roles: {allowed}")


def require_min_role(min_role: str, *, context: str) -> None:
    current = str(get_request_actor_role() or "").upper()
    wanted = str(min_role or "").upper()
    if ROLE_ORDER.get(current, 0) < ROLE_ORDER.get(wanted, 0):
        raise HTTPException(status_code=403, detail=f"{context} requires role {wanted} or higher")


def ensure_default_user(session) -> AppUser:
    existing = session.exec(select(AppUser).where(AppUser.is_active == True)).first()  # noqa: E712
    if existing:
        return existing
    ts = datetime.now().isoformat(timespec="seconds")
    row = AppUser(
        name="Owner",
        role="OWNER",
        pin=None,
        is_active=True,
        created_at=ts,
        updated_at=ts,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row
