# F:\medical-inventory\backend\routers\inventory.py

from fastapi import APIRouter, HTTPException, Query
from sqlmodel import select
from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel

from backend.db import get_session
from backend.models import Item

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

# ---------- Helpers ----------
def now_ts():
    return datetime.now().isoformat(timespec="seconds")

# ---------- Endpoints ----------

@router.get("/", response_model=List[ItemOut])
def list_items(
    q: Optional[str] = Query(None, description="Search in name/brand"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    with get_session() as session:
        stmt = select(Item)
        if q:
            like = f"%{q.strip()}%"
            stmt = stmt.where(
                (Item.name.ilike(like)) |
                (Item.brand.ilike(like))
                # batch_no removed
            )
        stmt = stmt.order_by(Item.name).limit(limit).offset(offset)
        return session.exec(stmt).all()

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
def adjust_stock(item_id: int, delta: int = Query(..., description="Positive or negative integer")):
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
