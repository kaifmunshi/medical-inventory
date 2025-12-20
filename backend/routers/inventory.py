# F:\medical-inventory\backend\routers\inventory.py

from fastapi import APIRouter, HTTPException, Query, Request
from sqlmodel import select
from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel
import logging
from sqlalchemy import func
from sqlalchemy.sql import or_

from backend.db import get_session
from backend.models import Item

logger = logging.getLogger("api.items")

router = APIRouter()

# ---------- Local Schemas (NO batch_no) ----------
class ItemIn(BaseModel):
    name: str
    brand: Optional[str] = None
    expiry_date: Optional[str] = None  # "YYYY-MM-DD"
    mrp: float
    stock: int

    class Config:
        extra = "ignore"  # ignore legacy 'batch_no' if a stale client sends it


class ItemUpdateIn(BaseModel):
    name: Optional[str] = None
    brand: Optional[str] = None
    expiry_date: Optional[str] = None
    mrp: Optional[float] = None
    stock: Optional[int] = None

    class Config:
        extra = "ignore"  # ignore legacy 'batch_no'


class ItemOut(BaseModel):
    id: int
    name: str
    brand: Optional[str] = None
    expiry_date: Optional[str] = None
    mrp: float
    stock: int
    created_at: str
    updated_at: str

    class Config:
        from_attributes = True  # pydantic v2 (orm_mode=True in v1)


# ✅ NEW: paginated response envelope for infinite scroll
class ItemPageOut(BaseModel):
    items: List[ItemOut]
    total: int
    next_offset: Optional[int] = None


# ---------- Helpers ----------
def now_ts():
    return datetime.now().isoformat(timespec="seconds")


# ---------- Endpoints ----------

@router.get("/", response_model=ItemPageOut)
def list_items(
    request: Request,
    q: Optional[str] = Query(None, description="Search in name/brand"),
    limit: Optional[int] = Query(None, ge=1, le=500),
    offset: Optional[int] = Query(None, ge=0),
):
    with get_session() as session:
        base_stmt = select(Item)

        if q:
            like = f"%{q.strip()}%"
            base_stmt = base_stmt.where(
                or_(
                    Item.name.ilike(like),
                    Item.brand.ilike(like),
                )
            )

        # ✅ If ONLY q is present (client didn't pass limit/offset), return ALL matches
        if q and limit is None and offset is None:
            stmt = base_stmt.order_by(Item.name, Item.id)
            items = session.exec(stmt).all()
            total = len(items)
            return {"items": items, "total": total, "next_offset": None}

        # ✅ Otherwise paginate (defaults if not provided)
        page_limit = limit if limit is not None else 500
        page_offset = offset if offset is not None else 0

        # total count (filtered)
        count_stmt = select(func.count()).select_from(base_stmt.subquery())
        total = session.exec(count_stmt).one()

        # paginated items (stable order)
        page_stmt = (
            base_stmt
            .order_by(Item.name, Item.id)
            .limit(page_limit)
            .offset(page_offset)
        )
        items = session.exec(page_stmt).all()

        next_offset = (
            page_offset + page_limit
            if (page_offset + page_limit) < total
            else None
        )

        return {
            "items": items,
            "total": total,
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
def create_item(payload: ItemIn):
    if payload.mrp <= 0:
        raise HTTPException(status_code=400, detail="MRP must be > 0")
    if payload.stock is not None and payload.stock < 0:
        raise HTTPException(status_code=400, detail="Stock cannot be negative")

    with get_session() as session:
        item = Item(
            name=payload.name,
            brand=payload.brand,
            expiry_date=payload.expiry_date,
            mrp=payload.mrp,
            stock=payload.stock,
            created_at=now_ts(),
            updated_at=now_ts(),
        )
        session.add(item)
        session.commit()
        session.refresh(item)
        return item


@router.patch("/{item_id}", response_model=ItemOut)
def update_item(item_id: int, payload: ItemUpdateIn):
    with get_session() as session:
        item = session.get(Item, item_id)
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")

        data = payload.model_dump(exclude_unset=True)

        # Basic validations
        if "mrp" in data and data["mrp"] is not None and data["mrp"] <= 0:
            raise HTTPException(status_code=400, detail="MRP must be > 0")
        if "stock" in data and data["stock"] is not None and data["stock"] < 0:
            raise HTTPException(status_code=400, detail="Stock cannot be negative")

        for k, v in data.items():
            setattr(item, k, v)
        item.updated_at = now_ts()

        session.add(item)
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


# ---- Optional: quick stock adjust (increase/decrease) ----
@router.post("/{item_id}/adjust", response_model=ItemOut)
def adjust_stock(
    item_id: int,
    delta: int = Query(..., description="Positive or negative integer")
):
    with get_session() as session:
        item = session.get(Item, item_id)
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")
        new_stock = item.stock + int(delta)
        if new_stock < 0:
            raise HTTPException(status_code=400, detail="Stock would go negative")
        item.stock = new_stock
        item.updated_at = now_ts()
        session.add(item)
        session.commit()
        session.refresh(item)
        return item
