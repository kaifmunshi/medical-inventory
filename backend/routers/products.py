from datetime import datetime
import re
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import or_, func, text
from sqlmodel import select

from backend.controls import log_audit
from backend.db import create_data_repair_backup, get_session
from backend.models import (
    Brand,
    BrandCreate,
    BrandOut,
    BrandUpdate,
    Category,
    CategoryCreate,
    CategoryOut,
    CategoryUpdate,
    InventoryLot,
    Product,
    ProductCreate,
    ProductOut,
    ProductUpdate,
    Item,
    PurchaseItem,
)

router = APIRouter()


class ProductMergeOut(BaseModel):
    product: ProductOut
    deactivated_product_id: int
    moved_items: int
    moved_lots: int
    moved_purchase_items: int
    backup_path: Optional[str] = None


class ProductPageOut(BaseModel):
    items: List[ProductOut]
    total: int
    limit: int
    offset: int


def _clean(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    text = " ".join(str(v).strip().split())
    return text or None


def _product_name_key(v: Optional[str]) -> str:
    text = (_clean(v) or "").lower()
    return re.sub(r"\b(\d+)\s+(g|gm|ml|tab|tabs|tablet|tablets|cap|caps|n)\b", r"\1\2", text)


def _brand_key(v: Optional[str]) -> str:
    return (_clean(v) or "").lower()


def _category_key(v: Optional[int]) -> int:
    return int(v or 0)


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


def _sync_brands_from_products_once(session) -> None:
    key = "product_brand_master_synced_v1"
    row = session.exec(text("SELECT value FROM appmeta WHERE key = :key").bindparams(key=key)).first()
    if row and str(row[0]) == "done":
        return
    _sync_brands_from_products(session)
    session.exec(
        text("""
            INSERT INTO appmeta (key, value, updated_at)
            VALUES (:key, 'done', datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        """).bindparams(key=key)
    )


def _list_master_rows(model, *, active_only: bool):
    with get_session() as session:
        stmt = select(model)
        if active_only:
            stmt = stmt.where(model.is_active == True)  # noqa: E712
        stmt = stmt.order_by(func.lower(model.name).asc(), model.id.asc())
        return session.exec(stmt).all()


def _sync_product_to_inventory_items(
    session,
    product: Product,
    *,
    previous_name: Optional[str],
    previous_brand: Optional[str],
) -> int:
    if product.id is None:
        return 0

    target_ids = {
        int(row.id)
        for row in session.exec(select(Item).where(Item.product_id == int(product.id))).all()
        if row.id is not None
    }
    lot_item_ids = session.exec(
        select(InventoryLot.legacy_item_id).where(
            InventoryLot.product_id == int(product.id),
            InventoryLot.legacy_item_id.is_not(None),
        )
    ).all()
    target_ids.update(int(item_id) for item_id in lot_item_ids if item_id is not None)

    previous_name_key = _product_name_key(previous_name)
    previous_brand_key = _brand_key(previous_brand)
    if previous_name_key:
        legacy_stmt = select(Item).where(Item.product_id.is_(None))
        if previous_brand_key:
            legacy_stmt = legacy_stmt.where(func.lower(func.coalesce(Item.brand, "")) == previous_brand_key)
        else:
            legacy_stmt = legacy_stmt.where(or_(Item.brand.is_(None), func.trim(func.coalesce(Item.brand, "")) == ""))
        legacy_candidates = session.exec(legacy_stmt).all()
        target_ids.update(
            int(item.id)
            for item in legacy_candidates
            if item.id is not None and _product_name_key(item.name) == previous_name_key
        )

    if not target_ids:
        return 0

    items = session.exec(select(Item).where(Item.id.in_(sorted(target_ids)))).all()
    now = _now()
    for item in items:
        item.product_id = int(product.id)
        item.name = product.name
        item.brand = product.brand
        item.category_id = product.category_id
        item.updated_at = now
        session.add(item)
    return len(items)


def _sync_product_conversion_to_lots(session, product: Product) -> dict:
    conversion_qty = int(product.default_conversion_qty or 0)
    if not product.id or not bool(product.loose_sale_enabled) or conversion_qty <= 0:
        return {"sealed_lots": 0, "loose_lots": 0, "loose_items": 0}

    now = _now()
    sealed_count = 0
    loose_count = 0
    loose_item_count = 0

    sealed_lots = session.exec(
        select(InventoryLot).where(
            InventoryLot.product_id == int(product.id),
            InventoryLot.opened_from_lot_id.is_(None),
        )
    ).all()
    for sealed_lot in sealed_lots:
        if int(sealed_lot.conversion_qty or 0) != conversion_qty:
            sealed_lot.conversion_qty = conversion_qty
            sealed_lot.updated_at = now
            session.add(sealed_lot)
            sealed_count += 1

        loose_lots = session.exec(
            select(InventoryLot).where(InventoryLot.opened_from_lot_id == int(sealed_lot.id or 0))
        ).all()
        loose_mrp = round(float(sealed_lot.mrp or 0) / conversion_qty, 2)
        loose_cost = (
            round(float(sealed_lot.cost_price or 0) / conversion_qty, 2)
            if sealed_lot.cost_price is not None
            else None
        )
        for loose_lot in loose_lots:
            lot_changed = False
            if int(loose_lot.conversion_qty or 0) != conversion_qty:
                loose_lot.conversion_qty = conversion_qty
                lot_changed = True
            if abs(float(loose_lot.mrp or 0) - loose_mrp) > 0.001:
                loose_lot.mrp = loose_mrp
                lot_changed = True
            if loose_cost is not None and abs(float(loose_lot.cost_price or 0) - loose_cost) > 0.001:
                loose_lot.cost_price = loose_cost
                lot_changed = True
            if lot_changed:
                loose_lot.updated_at = now
                session.add(loose_lot)
                loose_count += 1

            loose_item = session.get(Item, int(loose_lot.legacy_item_id or 0)) if loose_lot.legacy_item_id else None
            if loose_item:
                item_changed = False
                if loose_item.name != product.name:
                    loose_item.name = product.name
                    item_changed = True
                if loose_item.brand != product.brand:
                    loose_item.brand = product.brand
                    item_changed = True
                if loose_item.category_id != product.category_id:
                    loose_item.category_id = product.category_id
                    item_changed = True
                if abs(float(loose_item.mrp or 0) - loose_mrp) > 0.001:
                    loose_item.mrp = loose_mrp
                    item_changed = True
                if loose_cost is not None and abs(float(loose_item.cost_price or 0) - loose_cost) > 0.001:
                    loose_item.cost_price = loose_cost
                    item_changed = True
                if item_changed:
                    loose_item.updated_at = now
                    session.add(loose_item)
                    loose_item_count += 1

    return {"sealed_lots": sealed_count, "loose_lots": loose_count, "loose_items": loose_item_count}


def _product_ref_counts(session, product_id: int) -> dict:
    return {
        "items": int(session.exec(select(func.count()).select_from(Item).where(Item.product_id == int(product_id))).one() or 0),
        "lots": int(
            session.exec(select(func.count()).select_from(InventoryLot).where(InventoryLot.product_id == int(product_id))).one() or 0
        ),
        "purchase_items": int(
            session.exec(select(func.count()).select_from(PurchaseItem).where(PurchaseItem.product_id == int(product_id))).one() or 0
        ),
    }


@router.get("/brands", response_model=List[BrandOut])
def list_brands(active_only: bool = Query(True)) -> List[BrandOut]:
    with get_session() as session:
        _sync_brands_from_products_once(session)
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
    uncategorized_only: bool = Query(False),
    active_only: bool = Query(True),
    inactive_only: bool = Query(False),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> List[ProductOut]:
    with get_session() as session:
        stmt = select(Product)
        if inactive_only:
            stmt = stmt.where(Product.is_active == False)  # noqa: E712
        elif active_only:
            stmt = stmt.where(Product.is_active == True)  # noqa: E712
        if uncategorized_only:
            stmt = stmt.where(Product.category_id.is_(None))
        elif category_id is not None:
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


@router.get("/page", response_model=ProductPageOut)
def list_products_page(
    q: Optional[str] = Query(None),
    brand: Optional[str] = Query(None),
    category_id: Optional[int] = Query(None),
    uncategorized_only: bool = Query(False),
    active_only: bool = Query(True),
    inactive_only: bool = Query(False),
    limit: int = Query(25, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> ProductPageOut:
    with get_session() as session:
        filters = []
        if inactive_only:
            filters.append(Product.is_active == False)  # noqa: E712
        elif active_only:
            filters.append(Product.is_active == True)  # noqa: E712
        if uncategorized_only:
            filters.append(Product.category_id.is_(None))
        elif category_id is not None:
            filters.append(Product.category_id == category_id)
        brand_name = _clean(brand)
        if brand_name:
            filters.append(func.lower(func.coalesce(Product.brand, "")) == brand_name.lower())
        qq = _clean(q)
        if qq:
            like = f"%{qq.lower()}%"
            filters.append(
                or_(
                    func.lower(func.coalesce(Product.name, "")).like(like),
                    func.lower(func.coalesce(Product.alias, "")).like(like),
                    func.lower(func.coalesce(Product.brand, "")).like(like),
                )
            )

        total_stmt = select(func.count()).select_from(Product)
        rows_stmt = select(Product)
        for condition in filters:
            total_stmt = total_stmt.where(condition)
            rows_stmt = rows_stmt.where(condition)

        total = int(session.exec(total_stmt).one() or 0)
        items = session.exec(
            rows_stmt.order_by(func.lower(Product.name).asc(), Product.id.asc()).offset(offset).limit(limit)
        ).all()
        return ProductPageOut(items=items, total=total, limit=limit, offset=offset)


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

        existing_stmt = select(Product).where(func.lower(func.coalesce(Product.brand, "")) == (brand or "").lower())
        if payload.category_id is None:
            existing_stmt = existing_stmt.where(Product.category_id.is_(None))
        else:
            existing_stmt = existing_stmt.where(Product.category_id == payload.category_id)
        existing_rows = session.exec(existing_stmt).all()
        matching_existing = [
            row for row in existing_rows
            if _product_name_key(row.name) == _product_name_key(name)
            and _category_key(row.category_id) == _category_key(payload.category_id)
        ]
        active_existing = next((row for row in matching_existing if row.is_active), None)
        existing = active_existing or (matching_existing[0] if matching_existing else None)
        if active_existing:
            raise HTTPException(status_code=400, detail="Product already exists for this name, brand, and category")
        if existing:
            previous_name = existing.name
            previous_brand = existing.brand
            existing.name = name
            existing.alias = alias
            existing.brand = brand
            existing.category_id = payload.category_id
            existing.default_rack_number = default_rack_number
            existing.printed_price = printed_price
            existing.parent_unit_name = parent_unit_name
            existing.child_unit_name = child_unit_name
            existing.loose_sale_enabled = bool(payload.loose_sale_enabled)
            existing.default_conversion_qty = payload.default_conversion_qty
            existing.is_active = True
            existing.updated_at = _now()
            session.add(existing)
            synced_items = _sync_product_to_inventory_items(
                session,
                existing,
                previous_name=previous_name,
                previous_brand=previous_brand,
            )
            synced_conversion = _sync_product_conversion_to_lots(session, existing)
            log_audit(
                session,
                entity_type="PRODUCT",
                entity_id=int(existing.id),
                action="RESTORE",
                note=f"Restored product {existing.name}",
                details={
                    "brand": existing.brand,
                    "category_id": existing.category_id,
                    "synced_inventory_items": synced_items,
                    "synced_conversion": synced_conversion,
                },
            )
            session.commit()
            session.refresh(existing)
            return existing

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

        previous_name = row.name
        previous_brand = row.brand
        previous_category_id = row.category_id
        previous_loose_sale_enabled = bool(row.loose_sale_enabled)
        previous_conversion_qty = row.default_conversion_qty
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

        unique_key_changed = (
            "name" in data
            or "brand" in data
            or "category_id" in data
            or ("is_active" in data and bool(row.is_active))
        )
        if row.is_active and unique_key_changed:
            duplicate_stmt = select(Product).where(
                func.lower(func.coalesce(Product.brand, "")) == func.lower(row.brand or ""),
                Product.id != product_id,
                Product.is_active == True,  # noqa: E712
            )
            if row.category_id is None:
                duplicate_stmt = duplicate_stmt.where(Product.category_id.is_(None))
            else:
                duplicate_stmt = duplicate_stmt.where(Product.category_id == row.category_id)
            duplicate_rows = session.exec(duplicate_stmt).all()
            duplicate = next(
                (
                    candidate for candidate in duplicate_rows
                    if _product_name_key(candidate.name) == _product_name_key(row.name)
                ),
                None,
            )
            if duplicate:
                raise HTTPException(status_code=400, detail="Product already exists for this name, brand, and category")

        row.updated_at = _now()
        session.add(row)
        inventory_identity_changed = (
            _product_name_key(previous_name) != _product_name_key(row.name)
            or _brand_key(previous_brand) != _brand_key(row.brand)
            or _category_key(previous_category_id) != _category_key(row.category_id)
        )
        conversion_changed = (
            previous_loose_sale_enabled != bool(row.loose_sale_enabled)
            or int(previous_conversion_qty or 0) != int(row.default_conversion_qty or 0)
        )
        synced_items = (
            _sync_product_to_inventory_items(
                session,
                row,
                previous_name=previous_name,
                previous_brand=previous_brand,
            )
            if inventory_identity_changed
            else 0
        )
        synced_conversion = (
            _sync_product_conversion_to_lots(session, row)
            if conversion_changed
            else {"sealed_lots": 0, "loose_lots": 0, "loose_items": 0}
        )
        log_audit(
            session,
            entity_type="PRODUCT",
            entity_id=int(row.id),
            action="UPDATE",
            note=f"Updated product {row.name}",
            details={**data, "synced_inventory_items": synced_items, "synced_conversion": synced_conversion},
        )
        session.commit()
        session.refresh(row)
        return row


@router.delete("/{product_id}", response_model=ProductOut)
def delete_product(product_id: int) -> ProductOut:
    with get_session() as session:
        row = session.get(Product, product_id)
        if not row:
            raise HTTPException(status_code=404, detail="Product not found")

        ref_counts = _product_ref_counts(session, product_id)
        if any(ref_counts.values()):
            raise HTTPException(
                status_code=400,
                detail=(
                    "This product has stock, lot, or purchase links. "
                    "Use Merge to move those records into the real product before deleting it."
                ),
            )

        row.is_active = False
        row.updated_at = _now()
        session.add(row)
        log_audit(
            session,
            entity_type="PRODUCT",
            entity_id=int(row.id),
            action="DELETE",
            note=f"Deactivated product {row.name}",
            details={"name": row.name, "brand": row.brand, "ref_counts": ref_counts},
        )
        session.commit()
        session.refresh(row)
        return row


@router.post("/{source_product_id}/merge-into/{target_product_id}", response_model=ProductMergeOut)
def merge_product(source_product_id: int, target_product_id: int) -> ProductMergeOut:
    if int(source_product_id) == int(target_product_id):
        raise HTTPException(status_code=400, detail="Choose two different products to merge")

    with get_session() as session:
        source = session.get(Product, source_product_id)
        target = session.get(Product, target_product_id)
        if not source:
            raise HTTPException(status_code=404, detail="Duplicate product not found")
        if not target:
            raise HTTPException(status_code=404, detail="Target product not found")

        backup_path = create_data_repair_backup(f"before_product_merge_{source_product_id}_into_{target_product_id}")
        ts = _now()

        moved_items = session.exec(select(Item).where(Item.product_id == int(source.id))).all()
        moved_lots = session.exec(select(InventoryLot).where(InventoryLot.product_id == int(source.id))).all()
        moved_purchase_items = session.exec(select(PurchaseItem).where(PurchaseItem.product_id == int(source.id))).all()

        if target.category_id is None and source.category_id is not None:
            target.category_id = source.category_id
        if not target.alias and source.alias:
            target.alias = source.alias
        if int(target.default_rack_number or 0) == 0 and int(source.default_rack_number or 0) > 0:
            target.default_rack_number = int(source.default_rack_number or 0)
        if float(target.printed_price or 0) == 0 and float(source.printed_price or 0) > 0:
            target.printed_price = float(source.printed_price or 0)
        if not target.loose_sale_enabled and source.loose_sale_enabled:
            target.loose_sale_enabled = True
            target.parent_unit_name = target.parent_unit_name or source.parent_unit_name
            target.child_unit_name = target.child_unit_name or source.child_unit_name
            target.default_conversion_qty = target.default_conversion_qty or source.default_conversion_qty

        target.is_active = True
        target.updated_at = ts
        session.add(target)
        session.flush()

        for item in moved_items:
            item.product_id = int(target.id)
            item.name = target.name
            item.brand = target.brand
            item.category_id = target.category_id
            item.updated_at = ts
            session.add(item)

        for lot in moved_lots:
            lot.product_id = int(target.id)
            lot.updated_at = ts
            session.add(lot)

        for purchase_item in moved_purchase_items:
            purchase_item.product_id = int(target.id)
            purchase_item.product_name = target.name
            purchase_item.brand = target.brand
            session.add(purchase_item)

        synced_items = _sync_product_to_inventory_items(
            session,
            target,
            previous_name=source.name,
            previous_brand=source.brand,
        )

        source.is_active = False
        source.updated_at = ts
        session.add(source)

        details = {
            "source_product_id": int(source.id),
            "source_name": source.name,
            "target_product_id": int(target.id),
            "target_name": target.name,
            "moved_items": len(moved_items),
            "moved_lots": len(moved_lots),
            "moved_purchase_items": len(moved_purchase_items),
            "synced_inventory_items": synced_items,
            "backup_path": backup_path,
        }
        log_audit(
            session,
            entity_type="PRODUCT",
            entity_id=int(target.id),
            action="MERGE",
            note=f"Merged duplicate product {source.name} into {target.name}",
            details=details,
        )
        session.commit()
        session.refresh(target)
        return ProductMergeOut(
            product=target,
            deactivated_product_id=int(source.id),
            moved_items=len(moved_items),
            moved_lots=len(moved_lots),
            moved_purchase_items=len(moved_purchase_items),
            backup_path=backup_path,
        )
