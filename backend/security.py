import base64
import hashlib
import hmac
import json
import os
import time
from contextvars import ContextVar
from typing import Dict, Iterable, Optional

from fastapi import HTTPException

_actor_name: ContextVar[Optional[str]] = ContextVar("actor_name", default=None)
_actor_role: ContextVar[Optional[str]] = ContextVar("actor_role", default=None)
_actor_id: ContextVar[Optional[int]] = ContextVar("actor_id", default=None)

ROLE_ORDER = {"STAFF": 1, "MANAGER": 2, "OWNER": 3}
SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
SESSION_SECRET = os.environ.get("APP_SESSION_SECRET", "medical-inventory-local-secret")


def set_request_actor(name: Optional[str], role: Optional[str], user_id: Optional[int] = None) -> None:
    normalized_name = " ".join(str(name or "").strip().split()) or None
    normalized_role = str(role or "").strip().upper() or None
    normalized_id = int(user_id) if user_id is not None else None
    _actor_name.set(normalized_name)
    _actor_role.set(normalized_role)
    _actor_id.set(normalized_id)


def get_request_actor_name() -> Optional[str]:
    return _actor_name.get()


def get_request_actor_role() -> Optional[str]:
    return _actor_role.get()


def get_request_actor_id() -> Optional[int]:
    return _actor_id.get()


def _urlsafe_b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _urlsafe_b64decode(raw: str) -> bytes:
    text = str(raw or "")
    padded = text + "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def create_session_token(*, user_id: int, name: str, role: str, ttl_seconds: int = SESSION_TTL_SECONDS) -> str:
    payload = {
        "uid": int(user_id),
        "name": " ".join(str(name or "").strip().split()),
        "role": str(role or "").strip().upper(),
        "exp": int(time.time()) + int(ttl_seconds),
    }
    raw_payload = json.dumps(payload, separators=(",", ":"), ensure_ascii=True, sort_keys=True).encode("utf-8")
    payload_part = _urlsafe_b64encode(raw_payload)
    signature = hmac.new(SESSION_SECRET.encode("utf-8"), payload_part.encode("ascii"), hashlib.sha256).digest()
    return f"{payload_part}.{_urlsafe_b64encode(signature)}"


def verify_session_token(token: str) -> Optional[Dict[str, object]]:
    text = str(token or "").strip()
    if not text or "." not in text:
        return None
    payload_part, signature_part = text.split(".", 1)
    try:
        expected_sig = hmac.new(SESSION_SECRET.encode("utf-8"), payload_part.encode("ascii"), hashlib.sha256).digest()
        actual_sig = _urlsafe_b64decode(signature_part)
        if not hmac.compare_digest(expected_sig, actual_sig):
            return None
        payload = json.loads(_urlsafe_b64decode(payload_part).decode("utf-8"))
    except Exception:
        return None

    if not isinstance(payload, dict):
        return None
    try:
        exp = int(payload.get("exp", 0))
        user_id = int(payload.get("uid"))
    except Exception:
        return None
    if exp <= int(time.time()):
        return None

    role = str(payload.get("role") or "").strip().upper()
    if role not in ROLE_ORDER:
        return None
    name = " ".join(str(payload.get("name") or "").strip().split())
    if not name:
        return None

    return {"uid": user_id, "name": name, "role": role, "exp": exp}


def require_roles(allowed_roles: Iterable[str], *, context: str) -> None:
    current = str(get_request_actor_role() or "").upper()
    if not current:
        raise HTTPException(status_code=401, detail=f"{context} requires sign-in")
    normalized_allowed = {str(role).upper() for role in allowed_roles}
    if current not in normalized_allowed:
        allowed = ", ".join(sorted(normalized_allowed))
        raise HTTPException(status_code=403, detail=f"{context} requires one of these roles: {allowed}")


def require_min_role(min_role: str, *, context: str) -> None:
    current = str(get_request_actor_role() or "").upper()
    if not current:
        raise HTTPException(status_code=401, detail=f"{context} requires sign-in")
    wanted = str(min_role or "").strip().upper()
    if ROLE_ORDER.get(current, 0) < ROLE_ORDER.get(wanted, 0):
        raise HTTPException(status_code=403, detail=f"{context} requires role {wanted} or higher")
