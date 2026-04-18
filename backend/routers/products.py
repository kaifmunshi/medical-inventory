from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import String as SAString, cast, func, or_
from sqlmodel import select

from backend.controls import log_audit
from backend.db import get_session
from backend.models import (
    Category,
    CategoryCreate,
    CategoryOut,
    CategoryUpdate,
    Product,
    ProductCreate,
    ProductOut,
    ProductUpdate,
)
from backend.security import require_min_role

router = APIRouter()


def _clean(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    text = " ".join(str(v).strip().split())
    return text or None


@router.get("/categories", response_model=List[CategoryOut])
def list_categories(active_only: bool = Query(True)) -> List[CategoryOut]:
    with get_session() as session:
        stmt = select(Category)
        if active_only:
            stmt = stmt.where(Category.is_active == True)  # noqa: E712
        stmt = stmt.order_by(func.lower(Category.name).asc(), Category.id.asc())
        return session.exec(stmt).all()


@router.post("/categories", response_model=CategoryOut, status_code=201)
def create_category(payload: CategoryCreate) -> CategoryOut:
    require_min_role("MANAGER", context="Category creation")
    name = _clean(payload.name)
    if not name:
        raise HTTPException(status_code=400, detail="Category name is required")
    with get_session() as session:
        existing = session.exec(select(Category).where(func.lower(Category.name) == name.lower())).first()
        if existing:
            return existing
        now = datetime.now().isoformat(timespec="seconds")
        row = Category(name=name, is_active=True, created_at=now, updated_at=now)
        session.add(row)
        session.flush()
        log_audit(
            session,
            entity_type="CATEGORY",
            entity_id=int(row.id),
            action="CREATE",
            note=f"Created category {name}",
            details={"name": name},
        )
        session.commit()
        session.refresh(row)
        return row


@router.patch("/categories/{category_id}", response_model=CategoryOut)
def update_category(category_id: int, payload: CategoryUpdate) -> CategoryOut:
    require_min_role("MANAGER", context="Category update")
    with get_session() as session:
        row = session.get(Category, category_id)
        if not row:
            raise HTTPException(status_code=404, detail="Category not found")
        data = payload.dict(exclude_unset=True)
        if "name" in data:
            name = _clean(data["name"])
            if not name:
                raise HTTPException(status_code=400, detail="Category name is required")
            row.name = name
        if "is_active" in data:
            row.is_active = bool(data["is_active"])
        row.updated_at = datetime.now().isoformat(timespec="seconds")
        session.add(row)
        log_audit(
            session,
            entity_type="CATEGORY",
            entity_id=int(row.id),
            action="UPDATE",
            note=f"Updated category {row.name}",
            details=data,
        )
        session.commit()
        session.refresh(row)
        return row


@router.get("/", response_model=List[ProductOut])
def list_products(
    q: Optional[str] = Query(None),
    category_id: Optional[int] = Query(None),
    active_only: bool = Query(True),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> List[ProductOut]:
    with get_session() as session:
        stmt = select(Product)
        if active_only:
            stmt = stmt.where(Product.is_active == True)  # noqa: E712
        if category_id is not None:
            stmt = stmt.where(Product.category_id == category_id)
        qq = _clean(q)
        if qq:
            like = f"%{qq.lower()}%"
            stmt = stmt.where(
                or_(
                    func.lower(func.coalesce(Product.name, "")).like(like),
                    func.lower(func.coalesce(Product.alias, "")).like(like),
                    func.lower(func.coalesce(Product.brand, "")).like(like),
                    cast(Product.default_rack_number, SAString).like(f"%{qq}%"),
                )
            )
        stmt = stmt.order_by(func.lower(Product.name).asc(), Product.id.asc()).offset(offset).limit(limit)
        return session.exec(stmt).all()


@router.post("/", response_model=ProductOut, status_code=201)
def create_product(payload: ProductCreate) -> ProductOut:
    require_min_role("MANAGER", context="Product creation")
    name = _clean(payload.name)
    if not name:
        raise HTTPException(status_code=400, detail="Product name is required")
    brand = _clean(payload.brand)
    alias = _clean(payload.alias)
    with get_session() as session:
        existing = session.exec(
            select(Product).where(
                func.lower(Product.name) == name.lower(),
                func.lower(func.coalesce(Product.brand, "")) == (brand or "").lower(),
            )
        ).first()
        if existing:
            raise HTTPException(status_code=400, detail="Product already exists for this name and brand")

        if payload.category_id is not None and not session.get(Category, payload.category_id):
            raise HTTPException(status_code=400, detail="Category not found")

        now = datetime.now().isoformat(timespec="seconds")
        row = Product(
            name=name,
            alias=alias,
            brand=brand,
            category_id=payload.category_id,
            default_rack_number=int(payload.default_rack_number or 0),
            parent_unit_name=_clean(payload.parent_unit_name),
            child_unit_name=_clean(payload.child_unit_name),
            loose_sale_enabled=bool(payload.loose_sale_enabled),
            default_conversion_qty=payload.default_conversion_qty,
            is_active=True,
            created_at=now,
            updated_at=now,
        )
        session.add(row)
        session.flush()
        log_audit(
            session,
            entity_type="PRODUCT",
            entity_id=int(row.id),
            action="CREATE",
            note=f"Created product {row.name}",
            details={"brand": row.brand, "category_id": row.category_id},
        )
        session.commit()
        session.refresh(row)
        return row


@router.patch("/{product_id}", response_model=ProductOut)
def update_product(product_id: int, payload: ProductUpdate) -> ProductOut:
    require_min_role("MANAGER", context="Product update")
    with get_session() as session:
        row = session.get(Product, product_id)
        if not row:
            raise HTTPException(status_code=404, detail="Product not found")
        data = payload.dict(exclude_unset=True)
        if "name" in data:
            name = _clean(data["name"])
            if not name:
                raise HTTPException(status_code=400, detail="Product name is required")
            row.name = name
        if "alias" in data:
            row.alias = _clean(data["alias"])
        if "brand" in data:
            row.brand = _clean(data["brand"])
        if "category_id" in data:
            category_id = data["category_id"]
            if category_id is not None and not session.get(Category, category_id):
                raise HTTPException(status_code=400, detail="Category not found")
            row.category_id = category_id
        if "default_rack_number" in data:
            row.default_rack_number = int(data["default_rack_number"] or 0)
        if "parent_unit_name" in data:
            row.parent_unit_name = _clean(data["parent_unit_name"])
        if "child_unit_name" in data:
            row.child_unit_name = _clean(data["child_unit_name"])
        if "loose_sale_enabled" in data:
            row.loose_sale_enabled = bool(data["loose_sale_enabled"])
        if "default_conversion_qty" in data:
            row.default_conversion_qty = data["default_conversion_qty"]
        if "is_active" in data:
            row.is_active = bool(data["is_active"])
        row.updated_at = datetime.now().isoformat(timespec="seconds")
        session.add(row)
        log_audit(
            session,
            entity_type="PRODUCT",
            entity_id=int(row.id),
            action="UPDATE",
            note=f"Updated product {row.name}",
            details=data,
        )
        session.commit()
        session.refresh(row)
        return row
