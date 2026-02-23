from typing import Optional

from sqlalchemy import func, or_
from sqlmodel import select

from backend.models import Item


def _norm(s: Optional[str]) -> str:
    return (s or "").strip()


def apply_archive_rules(session, item: Item) -> bool:
    """
    Deterministic visibility rules for a (name+brand) group:
    - If any batch has stock > 0:
      - show only in-stock batches (unarchive them)
      - hide zero-stock batches (archive them)
    - If all batches have stock == 0:
      - show exactly one batch (earliest expiry; tie by lowest id)
      - archive all other zero-stock batches
    Returns True if anything changed.
    """

    changed = False

    n = _norm(item.name)
    b = _norm(item.brand)  # treat None/"" same

    group_stmt = select(Item).where(func.lower(Item.name) == func.lower(n))
    if b == "":
        group_stmt = group_stmt.where(or_(Item.brand.is_(None), func.trim(Item.brand) == ""))
    else:
        group_stmt = group_stmt.where(func.lower(func.coalesce(Item.brand, "")) == func.lower(b))

    group = session.exec(group_stmt).all()
    if not group:
        return changed

    in_stock = [x for x in group if int(getattr(x, "stock", 0) or 0) > 0]
    if in_stock:
        visible_ids = {int(x.id) for x in in_stock}
    else:
        def _exp_key(x: Item):
            exp = str(getattr(x, "expiry_date", "") or "").strip()
            # date text is YYYY-MM-DD; blank expiry goes last
            return (exp == "", exp, int(getattr(x, "id", 0) or 0))

        chosen = sorted(group, key=_exp_key)[0]
        visible_ids = {int(chosen.id)}

    for x in group:
        should_archive = int(x.id) not in visible_ids
        if bool(getattr(x, "is_archived", False)) != should_archive:
            x.is_archived = should_archive
            session.add(x)
            changed = True

    return changed
