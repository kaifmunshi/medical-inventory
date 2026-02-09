# backend/utils/archive_rules.py
from typing import Optional
from sqlmodel import select
from sqlalchemy import func, or_

from backend.models import Item


def _norm(s: Optional[str]) -> str:
    return (s or "").strip()


def apply_archive_rules(session, item: Item) -> bool:
    """
    Rules:
    - If item.stock > 0 => ALWAYS unarchive (is_archived = False)
    - If item.stock == 0:
        - Check how many batches exist for same (name+brand)
        - If more than 1 batch exists => archive this batch
        - If only 1 batch => keep it unarchived (so item isn't lost)
    Returns True if it changed anything.
    """

    changed = False

    # ✅ always unarchive if stock comes back
    if int(item.stock or 0) > 0:
        if getattr(item, "is_archived", False):
            item.is_archived = False
            session.add(item)
            changed = True
        return changed

    # stock == 0 case
    n = _norm(item.name)
    b = _norm(item.brand)  # treat None/"" same

    stmt = select(func.count(Item.id)).where(func.lower(Item.name) == func.lower(n))

    if b == "":
        stmt = stmt.where(or_(Item.brand.is_(None), func.trim(Item.brand) == ""))
    else:
        stmt = stmt.where(func.lower(func.coalesce(Item.brand, "")) == func.lower(b))

    total_batches = session.exec(stmt).one() or 0

    # ✅ only archive if there are other batches
    if total_batches > 1:
        if not getattr(item, "is_archived", False):
            item.is_archived = True
            session.add(item)
            changed = True

    return changed