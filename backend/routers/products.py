from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import or_, func
from sqlmodel import select

from backend.controls import log_audit
from backend.db import get_session
from backend.models import (
    Brand,
    BrandCreate,
    BrandOut,
    BrandUpdate,
    Category,
    CategoryCreate,
    CategoryOut,
    CategoryUpdate,
    Product,
    ProductCreate,
    ProductOut,
    ProductUpdate,
    Item,
)

router = APIRouter()


def _clean(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    text = " ".join(str(v).strip().split())
    return text or None


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _ensure_brand_row(session, raw_brand: Optional[str]) -> None:
    name = _clean(raw_brand)
    if not name:
        return
    existing = session.exec(select(Brand).where(func.lower(Brand.name) == name.lower())).first()
    if existing:
        if not existing.is_active:
            existing.is_active = True
            existing.updated_at = _now()
            session.add(existing)
        return
    row = Brand(name=name, is_active=True, created_at=_now(), updated_at=_now())
    session.add(row)
    session.flush()
    log_audit(
        session,
        entity_type="BRAND",
        entity_id=int(row.id),
        action="AUTO_CREATE",
        note=f"Auto-created brand {name}",
        details={"name": name},
    )


def _sync_brands_from_products(session) -> None:
    names = session.exec(select(Product.brand).where(Product.brand.is_not(None))).all()
    for raw in names:
        _ensure_brand_row(session, raw)
    item_names = session.exec(select(Item.brand).where(Item.brand.is_not(None))).all()
    for raw in item_names:
        _ensure_brand_row(session, raw)


def _list_master_rows(model, *, active_only: bool):
    with get_session() as session:
        stmt = select(model)
        if active_only:
            stmt = stmt.where(model.is_active == True)  # noqa: E712
        stmt = stmt.order_by(func.lower(model.name).asc(), model.id.asc())
        return session.exec(stmt).all()


@router.get("/brands", response_model=List[BrandOut])
def list_brands(active_only: bool = Query(True)) -> List[BrandOut]:
    with get_session() as session:
        _sync_brands_from_products(session)
        session.commit()
    return _list_master_rows(Brand, active_only=active_only)


@router.post("/brands", response_model=BrandOut, status_code=201)
def create_brand(payload: BrandCreate) -> BrandOut:
    name = _clean(payload.name)
    if not name:
        raise HTTPException(status_code=400, detail="Brand name is required")

    with get_session() as session:
        existing = session.exec(select(Brand).where(func.lower(Brand.name) == name.lower())).first()
        if existing:
            return existing

        now = _now()
        row = Brand(name=name, is_active=True, created_at=now, updated_at=now)
        session.add(row)
        log_audit(
            session,
            entity_type="BRAND",
            entity_id=None,
            action="CREATE",
            note=f"Created brand {name}",
            details={"name": name},
        )
        session.commit()
        session.refresh(row)
        return row


@router.patch("/brands/{brand_id}", response_model=BrandOut)
def update_brand(brand_id: int, payload: BrandUpdate) -> BrandOut:
    with get_session() as session:
        row = session.get(Brand, brand_id)
        if not row:
            raise HTTPException(status_code=404, detail="Brand not found")

        data = payload.dict(exclude_unset=True)
        if "name" in data:
            name = _clean(data["name"])
            if not name:
                raise HTTPException(status_code=400, detail="Brand name is required")
            existing = session.exec(
                select(Brand).where(func.lower(Brand.name) == name.lower(), Brand.id != brand_id)
            ).first()
            if existing:
                raise HTTPException(status_code=400, detail="Brand name already exists")
            row.name = name
        if "is_active" in data:
            row.is_active = bool(data["is_active"])

        row.updated_at = _now()
        session.add(row)
        log_audit(
            session,
            entity_type="BRAND",
            entity_id=int(row.id),
            action="UPDATE",
            note=f"Updated brand {row.name}",
            details=data,
        )
        session.commit()
        session.refresh(row)
        return row


@router.get("/categories", response_model=List[CategoryOut])
def list_categories(active_only: bool = Query(True)) -> List[CategoryOut]:
    return _list_master_rows(Category, active_only=active_only)


@router.post("/categories", response_model=CategoryOut, status_code=201)
def create_category(payload: CategoryCreate) -> CategoryOut:
    name = _clean(payload.name)
    if not name:
        raise HTTPException(status_code=400, detail="Category name is required")

    with get_session() as session:
        existing = session.exec(select(Category).where(func.lower(Category.name) == name.lower())).first()
        if existing:
            return existing

        now = _now()
        row = Category(name=name, is_active=True, created_at=now, updated_at=now)
        session.add(row)
        log_audit(
            session,
            entity_type="CATEGORY",
            entity_id=None,
            action="CREATE",
            note=f"Created category {name}",
            details={"name": name},
        )
        session.commit()
        session.refresh(row)
        return row


@router.patch("/categories/{category_id}", response_model=CategoryOut)
def update_category(category_id: int, payload: CategoryUpdate) -> CategoryOut:
    with get_session() as session:
        row = session.get(Category, category_id)
        if not row:
            raise HTTPException(status_code=404, detail="Category not found")

        data = payload.dict(exclude_unset=True)
        if "name" in data:
            name = _clean(data["name"])
            if not name:
                raise HTTPException(status_code=400, detail="Category name is required")
            existing = session.exec(
                select(Category).where(func.lower(Category.name) == name.lower(), Category.id != category_id)
            ).first()
            if existing:
                raise HTTPException(status_code=400, detail="Category name already exists")
            row.name = name
        if "is_active" in data:
            row.is_active = bool(data["is_active"])

        row.updated_at = _now()
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
    brand: Optional[str] = Query(None),
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
        brand_name = _clean(brand)
        if brand_name:
            stmt = stmt.where(func.lower(func.coalesce(Product.brand, "")) == brand_name.lower())
        qq = _clean(q)
        if qq:
            like = f"%{qq.lower()}%"
            stmt = stmt.where(
                or_(
                    func.lower(func.coalesce(Product.name, "")).like(like),
                    func.lower(func.coalesce(Product.alias, "")).like(like),
                    func.lower(func.coalesce(Product.brand, "")).like(like),
                )
            )

        stmt = stmt.order_by(func.lower(Product.name).asc(), Product.id.asc()).offset(offset).limit(limit)
        return session.exec(stmt).all()


@router.post("/", response_model=ProductOut, status_code=201)
def create_product(payload: ProductCreate) -> ProductOut:
    name = _clean(payload.name)
    if not name:
        raise HTTPException(status_code=400, detail="Product name is required")

    alias = _clean(payload.alias)
    brand = _clean(payload.brand)
    parent_unit_name = _clean(payload.parent_unit_name)
    child_unit_name = _clean(payload.child_unit_name)
    default_rack_number = int(payload.default_rack_number or 0)
    printed_price = float(payload.printed_price or 0)
    if default_rack_number < 0:
        raise HTTPException(status_code=400, detail="Default rack cannot be negative")
    if printed_price < 0:
        raise HTTPException(status_code=400, detail="Printed price cannot be negative")

    with get_session() as session:
        _ensure_brand_row(session, brand)
        if payload.category_id is not None and not session.get(Category, payload.category_id):
            raise HTTPException(status_code=400, detail="Category not found")

        existing = session.exec(
            select(Product).where(
                func.lower(Product.name) == name.lower(),
                func.lower(func.coalesce(Product.brand, "")) == (brand or "").lower(),
            )
        ).first()
        if existing:
            raise HTTPException(status_code=400, detail="Product already exists for this name and brand")

        now = _now()
        row = Product(
            name=name,
            alias=alias,
            brand=brand,
            category_id=payload.category_id,
            default_rack_number=default_rack_number,
            printed_price=printed_price,
            parent_unit_name=parent_unit_name,
            child_unit_name=child_unit_name,
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
            _ensure_brand_row(session, row.brand)
        if "category_id" in data:
            category_id = data["category_id"]
            if category_id is not None and not session.get(Category, category_id):
                raise HTTPException(status_code=400, detail="Category not found")
            row.category_id = category_id
        if "default_rack_number" in data:
            rack = int(data["default_rack_number"] or 0)
            if rack < 0:
                raise HTTPException(status_code=400, detail="Default rack cannot be negative")
            row.default_rack_number = rack
        if "printed_price" in data:
            printed_price = float(data["printed_price"] or 0)
            if printed_price < 0:
                raise HTTPException(status_code=400, detail="Printed price cannot be negative")
            row.printed_price = printed_price
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

        duplicate = session.exec(
            select(Product).where(
                func.lower(Product.name) == func.lower(row.name),
                func.lower(func.coalesce(Product.brand, "")) == func.lower(row.brand or ""),
                Product.id != product_id,
            )
        ).first()
        if duplicate:
            raise HTTPException(status_code=400, detail="Product already exists for this name and brand")

        row.updated_at = _now()
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
