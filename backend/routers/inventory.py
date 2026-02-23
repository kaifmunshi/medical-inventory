# F:\medical-inventory\backend\routers\inventory.py

from fastapi import APIRouter, HTTPException, Query, Request, Response
from sqlmodel import select
from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel
import logging
from backend.utils.archive_rules import apply_archive_rules
from sqlalchemy import func, or_, exists
from sqlalchemy.orm import aliased

from backend.db import get_session
from backend.models import Item, StockMovement

logger = logging.getLogger("api.items")
router = APIRouter()


# ---------- Local Schemas ----------
class ItemIn(BaseModel):
    name: str
    brand: Optional[str] = None
    expiry_date: Optional[str] = None  # "YYYY-MM-DD"
    mrp: float
    stock: int
    rack_number: int = 0

    class Config:
        extra = "ignore"


class ItemUpdateIn(BaseModel):
    name: Optional[str] = None
    brand: Optional[str] = None
    expiry_date: Optional[str] = None
    mrp: Optional[float] = None
    stock: Optional[int] = None
    rack_number: Optional[int] = None

    class Config:
        extra = "ignore"


class ItemOut(BaseModel):
    id: int
    name: str
    brand: Optional[str] = None
    expiry_date: Optional[str] = None
    mrp: float
    stock: int
    rack_number: int
    created_at: str
    updated_at: str

    class Config:
        from_attributes = True


class ItemPageOut(BaseModel):
    items: List[ItemOut]
    total: int
    next_offset: Optional[int] = None


# ---------- Ledger Response Models ----------
class StockMovementOut(BaseModel):
    id: int
    ts: str
    delta: int
    reason: str
    ref_type: Optional[str] = None
    ref_id: Optional[int] = None
    note: Optional[str] = None
    actor: Optional[str] = None
    balance_after: int
    balance_before: int

    class Config:
        from_attributes = True


class StockLedgerPageOut(BaseModel):
    item_id: int
    item_name: str
    current_stock: int
    items: List[StockMovementOut]
    next_offset: Optional[int] = None


# ---------- Group Ledger Response Models ----------
class StockMovementGroupOut(BaseModel):
    id: int
    ts: str
    delta: int
    reason: str
    ref_type: Optional[str] = None
    ref_id: Optional[int] = None
    note: Optional[str] = None
    actor: Optional[str] = None

    # ✅ batch info
    item_id: int
    expiry_date: Optional[str] = None
    mrp: Optional[float] = None
    rack_number: Optional[int] = None

    balance_after: int
    balance_before: int

    class Config:
        from_attributes = True


class StockLedgerGroupPageOut(BaseModel):
    key: str
    name: str
    brand: Optional[str] = None
    current_stock: int
    item_ids: List[int]
    items: List[StockMovementGroupOut]
    next_offset: Optional[int] = None


# ---------- Helpers ----------
def now_ts():
    return datetime.now().isoformat(timespec="seconds")


def add_movement(
    session,
    *,
    item_id: int,
    delta: int,
    reason: str,
    ref_type: Optional[str] = None,
    ref_id: Optional[int] = None,
    note: Optional[str] = None,
    actor: Optional[str] = None,
):
    session.add(
        StockMovement(
            item_id=int(item_id),
            ts=now_ts(),
            delta=int(delta),
            reason=str(reason),
            ref_type=ref_type,
            ref_id=ref_id,
            note=note,
            actor=actor,
        )
    )


def _norm_str(s: Optional[str]) -> Optional[str]:
    if s is None:
        return None
    v = str(s).strip()
    return v if v != "" else None


def _same_group_stmt(name: Optional[str], brand: Optional[str]):
    n = _norm_str(name) or ""
    b = _norm_str(brand)
    stmt = select(Item).where(func.lower(Item.name) == func.lower(n))
    if b is None:
        stmt = stmt.where(or_(Item.brand.is_(None), func.trim(Item.brand) == ""))
    else:
        stmt = stmt.where(func.lower(func.coalesce(Item.brand, "")) == func.lower(b))
    return stmt


# ---------- Endpoints ----------
@router.get("/", response_model=ItemPageOut)
def list_items(
    request: Request,
    q: Optional[str] = Query(None, description="Search in name/brand"),
    rack_number: Optional[int] = Query(None, ge=0, description="Filter by exact rack number"),
    limit: Optional[int] = Query(None, ge=1, le=500),
    offset: Optional[int] = Query(None, ge=0),

    # ✅ NEW
    include_archived: bool = Query(False, description="If true, include archived batches"),
):
    with get_session() as session:
        base_stmt = select(Item)

        # ✅ hide archived by default, but keep at least one row visible per (name+brand) group.
        # This prevents fully sold-out groups from disappearing when every batch became archived.
        if not include_archived:
            peer = aliased(Item)
            visible_row = or_(Item.is_archived == False, Item.is_archived.is_(None))
            same_group_visible_exists = exists(
                select(peer.id).where(
                    func.lower(func.trim(func.coalesce(peer.name, "")))
                    == func.lower(func.trim(func.coalesce(Item.name, ""))),
                    func.lower(func.trim(func.coalesce(peer.brand, "")))
                    == func.lower(func.trim(func.coalesce(Item.brand, ""))),
                    or_(peer.is_archived == False, peer.is_archived.is_(None)),
                )
            )
            base_stmt = base_stmt.where(or_(visible_row, ~same_group_visible_exists))

        if q:
            like = f"%{q.strip()}%"
            base_stmt = base_stmt.where(
                or_(
                    Item.name.ilike(like),
                    Item.brand.ilike(like),
                )
            )
        if rack_number is not None:
            base_stmt = base_stmt.where(Item.rack_number == rack_number)

        ...

        # If ONLY q is present (client didn't pass limit/offset), return ALL matches
        if q and limit is None and offset is None:
            stmt = base_stmt.order_by(Item.name, Item.id)
            items = session.exec(stmt).all()
            total = len(items)
            return {"items": items, "total": total, "next_offset": None}

        # Otherwise paginate (defaults if not provided)
        page_limit = limit if limit is not None else 500
        page_offset = offset if offset is not None else 0

        count_stmt = select(func.count()).select_from(base_stmt.subquery())
        total = session.exec(count_stmt).one()

        page_stmt = (
            base_stmt.order_by(Item.name, Item.id).limit(page_limit).offset(page_offset)
        )
        items = session.exec(page_stmt).all()

        next_offset = (
            (page_offset + page_limit)
            if (page_offset + page_limit) < total
            else None
        )

        return {"items": items, "total": total, "next_offset": next_offset}


# ✅✅ IMPORTANT: THIS MUST BE BEFORE /{item_id}
@router.get("/ledger/group", response_model=StockLedgerGroupPageOut)
def group_ledger(
    name: str = Query(..., description="Item name (exact match, case-insensitive)"),
    brand: Optional[str] = Query(None, description="Brand (case-insensitive); pass empty for None"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)"),
    reason: Optional[str] = Query(None, description="Filter by reason"),
):
    with get_session() as session:
        n = _norm_str(name)
        if not n:
            raise HTTPException(status_code=400, detail="name is required")

        b = _norm_str(brand)  # None allowed

        stmt_items = select(Item).where(func.lower(Item.name) == func.lower(n))

        # brand handling:
        # - if brand missing/empty -> match NULL/empty brand
        # - else match lower(brand)
        if b is None:
            stmt_items = stmt_items.where(
                or_(Item.brand.is_(None), func.trim(Item.brand) == "")
            )
        else:
            stmt_items = stmt_items.where(
                func.lower(func.coalesce(Item.brand, "")) == func.lower(b)
            )

        batches = session.exec(stmt_items).all()
        if not batches:
            raise HTTPException(status_code=404, detail="No items found for this (name+brand)")

        item_ids = [int(x.id) for x in batches]
        items_by_id = {int(x.id): x for x in batches}

        current_stock = sum(int(x.stock or 0) for x in batches)
        key = f"{n.strip().lower()}__{(b or '').strip().lower()}"

        stmt = select(StockMovement).where(StockMovement.item_id.in_(item_ids))

        if from_date:
            stmt = stmt.where(StockMovement.ts >= f"{from_date}T00:00:00")
        if to_date:
            stmt = stmt.where(StockMovement.ts <= f"{to_date}T23:59:59")

        if reason:
            stmt = stmt.where(func.lower(StockMovement.reason) == reason.strip().lower())

        stmt = stmt.order_by(StockMovement.id.desc()).limit(limit + 1).offset(offset)
        rows = session.exec(stmt).all()

        has_more = len(rows) > limit
        if has_more:
            rows = rows[:limit]

        running = int(current_stock)
        out: List[StockMovementGroupOut] = []

        for m in rows:
            after = running
            before = after - int(m.delta or 0)

            it = items_by_id.get(int(m.item_id))

            out.append(
                StockMovementGroupOut(
                    id=m.id,
                    ts=m.ts,
                    delta=int(m.delta or 0),
                    reason=m.reason,
                    ref_type=getattr(m, "ref_type", None),
                    ref_id=getattr(m, "ref_id", None),
                    note=getattr(m, "note", None),
                    actor=getattr(m, "actor", None),
                    item_id=int(m.item_id),
                    expiry_date=getattr(it, "expiry_date", None) if it else None,
                    mrp=float(getattr(it, "mrp", 0) or 0) if it else None,
                    rack_number=int(getattr(it, "rack_number", 0) or 0) if it else None,
                    balance_after=after,
                    balance_before=before,
                )
            )

            running = before

        next_offset = (offset + limit) if has_more else None

        return {
            "key": key,
            "name": str(batches[0].name),
            "brand": getattr(batches[0], "brand", None),
            "current_stock": int(current_stock),
            "item_ids": item_ids,
            "items": out,
            "next_offset": next_offset,
        }


@router.get("/{item_id}", response_model=ItemOut)
def get_item(item_id: int):
    with get_session() as session:
        item = session.get(Item, item_id)
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")
        return item


@router.post("/", response_model=ItemOut, status_code=201)
def create_item(
    payload: ItemIn,
    response: Response,
    force_new: bool = Query(False, description="If true, always create a new row (no merge)"),
):
    if payload.mrp <= 0:
        raise HTTPException(status_code=400, detail="MRP must be > 0")
    if payload.stock is not None and payload.stock < 0:
        raise HTTPException(status_code=400, detail="Stock cannot be negative")
    if payload.rack_number is not None and int(payload.rack_number) < 0:
        raise HTTPException(status_code=400, detail="Rack number cannot be negative")

    name = _norm_str(payload.name) or ""
    brand = _norm_str(payload.brand)
    expiry = _norm_str(payload.expiry_date)
    mrp = float(payload.mrp)
    delta_stock = int(payload.stock or 0)
    rack_no = int(payload.rack_number or 0)

    with get_session() as session:
        try:
            existing = None
            if not force_new:
                stmt = select(Item).where(
                    func.lower(Item.name) == func.lower(name),
                    func.coalesce(func.lower(Item.brand), "") == func.coalesce(func.lower(brand), ""),
                    func.coalesce(Item.expiry_date, "") == (expiry or ""),
                    Item.mrp == mrp,
                )
                existing = session.exec(stmt).first()

            if existing:
                existing.stock = int(existing.stock or 0) + delta_stock

                if rack_no and int(existing.rack_number or 0) == 0:
                    existing.rack_number = rack_no

                existing.updated_at = now_ts()
                session.add(existing)
                apply_archive_rules(session, existing)

                if delta_stock != 0:
                    add_movement(
                        session,
                        item_id=existing.id,
                        delta=delta_stock,
                        reason="OPENING",
                        ref_type="ITEM_MERGE",
                        ref_id=existing.id,
                        note="Merged add into existing batch (same name/brand/expiry/MRP)",
                    )

                session.commit()
                session.refresh(existing)
                response.status_code = 200
                return existing

            item = Item(
                name=name,
                brand=brand,
                expiry_date=expiry,
                mrp=mrp,
                stock=delta_stock,
                rack_number=rack_no,
                created_at=now_ts(),
                updated_at=now_ts(),
            )
            session.add(item)
            apply_archive_rules(session, item)
            session.commit()
            session.refresh(item)

            if int(item.stock or 0) != 0:
                try:
                    add_movement(
                        session,
                        item_id=item.id,
                        delta=int(item.stock),
                        reason="OPENING",
                        ref_type="ITEM_CREATE",
                        ref_id=item.id,
                        note="Initial stock on item creation",
                    )
                    session.commit()
                except Exception as e:
                    session.rollback()
                    logger.exception("Ledger insert failed (ignored). Error: %s", e)

            return item

        except HTTPException:
            raise
        except Exception as e:
            session.rollback()
            raise HTTPException(status_code=500, detail=f"Failed to create item: {e}")


@router.patch("/{item_id}", response_model=ItemOut)
def update_item(item_id: int, payload: ItemUpdateIn):
    with get_session() as session:
        item = session.get(Item, item_id)
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")

        old_name = item.name
        old_brand = item.brand

        data = payload.model_dump(exclude_unset=True)

        if "mrp" in data and data["mrp"] is not None and data["mrp"] <= 0:
            raise HTTPException(status_code=400, detail="MRP must be > 0")
        if "stock" in data and data["stock"] is not None and data["stock"] < 0:
            raise HTTPException(status_code=400, detail="Stock cannot be negative")
        if "rack_number" in data and data["rack_number"] is not None and int(data["rack_number"]) < 0:
            raise HTTPException(status_code=400, detail="Rack number cannot be negative")

        for k, v in data.items():
            if k == "rack_number" and v is not None:
                setattr(item, k, int(v))
            else:
                setattr(item, k, v)

        item.updated_at = now_ts()
        session.add(item)
        apply_archive_rules(session, item)

        old_name_norm = _norm_str(old_name) or ""
        old_brand_norm = _norm_str(old_brand)
        new_name_norm = _norm_str(item.name) or ""
        new_brand_norm = _norm_str(item.brand)
        if old_name_norm != new_name_norm or old_brand_norm != new_brand_norm:
            old_peer = session.exec(_same_group_stmt(old_name, old_brand).limit(1)).first()
            if old_peer:
                apply_archive_rules(session, old_peer)

        session.commit()
        session.refresh(item)
        return item


@router.delete("/{item_id}", status_code=204)
def delete_item(item_id: int):
    with get_session() as session:
        item = session.get(Item, item_id)
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")
        session.delete(item)
        session.commit()
        return


@router.post("/{item_id}/adjust", response_model=ItemOut)
def adjust_stock(
    item_id: int,
    delta: int = Query(..., description="Positive or negative integer"),
    note: Optional[str] = Query(None, description="Optional note for ledger"),
):
    with get_session() as session:
        try:
            item = session.get(Item, item_id)
            if not item:
                raise HTTPException(status_code=404, detail="Item not found")

            new_stock = item.stock + int(delta)
            if new_stock < 0:
                raise HTTPException(status_code=400, detail="Stock would go negative")

            item.stock = new_stock
            item.updated_at = now_ts()
            session.add(item)
            # ✅ archive/unarchive logic
            apply_archive_rules(session, item)
            if int(delta) != 0:
                add_movement(
                    session,
                    item_id=item.id,
                    delta=int(delta),
                    reason="ADJUST",
                    ref_type="MANUAL",
                    ref_id=None,
                    note=(note.strip() if note else None),
                )

            session.commit()
            session.refresh(item)
            return item

        except HTTPException:
            raise
        except Exception as e:
            session.rollback()
            raise HTTPException(status_code=500, detail=f"Adjust stock failed: {e}")


@router.get("/{item_id}/ledger", response_model=StockLedgerPageOut)
def item_ledger(
    item_id: int,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)"),
    reason: Optional[str] = Query(None, description="Filter by reason"),
):
    with get_session() as session:
        item = session.get(Item, item_id)
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")

        stmt = select(StockMovement).where(StockMovement.item_id == item_id)

        if from_date:
            stmt = stmt.where(StockMovement.ts >= f"{from_date}T00:00:00")
        if to_date:
            stmt = stmt.where(StockMovement.ts <= f"{to_date}T23:59:59")

        if reason:
            stmt = stmt.where(func.lower(StockMovement.reason) == reason.strip().lower())

        stmt = stmt.order_by(StockMovement.id.desc()).limit(limit + 1).offset(offset)
        rows = session.exec(stmt).all()

        has_more = len(rows) > limit
        if has_more:
            rows = rows[:limit]

        running = int(item.stock or 0)
        out: List[StockMovementOut] = []

        for m in rows:
            after = running
            before = after - int(m.delta or 0)

            out.append(
                StockMovementOut(
                    id=m.id,
                    ts=m.ts,
                    delta=int(m.delta or 0),
                    reason=m.reason,
                    ref_type=getattr(m, "ref_type", None),
                    ref_id=getattr(m, "ref_id", None),
                    note=getattr(m, "note", None),
                    actor=getattr(m, "actor", None),
                    balance_after=after,
                    balance_before=before,
                )
            )

            running = before

        next_offset = (offset + limit) if has_more else None

        return {
            "item_id": item.id,
            "item_name": item.name,
            "current_stock": int(item.stock or 0),
            "items": out,
            "next_offset": next_offset,
        }
