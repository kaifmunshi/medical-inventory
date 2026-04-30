from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import String as SAString, cast, func, or_
from sqlmodel import select

from backend.db import get_session
from backend.models import (
    InventoryLot,
    InventoryLotBrowseOut,
    Item,
    LotOpenCreate,
    PackOpenEvent,
    PackOpenEventOut,
    Product,
    StockMovement,
)
from backend.inventory_lot_sync import ensure_lot_for_inventory_item
from backend.security import get_request_actor_name
from backend.utils.archive_rules import apply_archive_rules

router = APIRouter()


def now_ts() -> str:
    return datetime.now().isoformat(timespec="seconds")


def round2(value: float) -> float:
    return float(f"{float(value or 0):.2f}")


def clean_text(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    text = " ".join(str(v).strip().split())
    return text or None


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
            actor=actor or get_request_actor_name() or "system",
        )
    )


def lot_to_out(lot: InventoryLot, product: Product, item: Optional[Item] = None) -> InventoryLotBrowseOut:
    linked_stock = int(item.stock or 0) if item else None
    sealed_qty = linked_stock if linked_stock is not None and lot.opened_from_lot_id is None else int(lot.sealed_qty or 0)
    loose_qty = linked_stock if linked_stock is not None and lot.opened_from_lot_id is not None else int(lot.loose_qty or 0)
    return InventoryLotBrowseOut(
        id=lot.id,
        product_id=lot.product_id,
        product_name=product.name,
        alias=product.alias,
        brand=product.brand,
        category_id=product.category_id,
        expiry_date=lot.expiry_date,
        mrp=float(lot.mrp or 0),
        cost_price=lot.cost_price,
        rack_number=int(lot.rack_number or 0),
        sealed_qty=sealed_qty,
        loose_qty=loose_qty,
        conversion_qty=lot.conversion_qty or product.default_conversion_qty,
        loose_sale_enabled=bool(product.loose_sale_enabled),
        parent_unit_name=product.parent_unit_name,
        child_unit_name=product.child_unit_name,
        opened_from_lot_id=lot.opened_from_lot_id,
        legacy_item_id=lot.legacy_item_id,
        is_active=bool(lot.is_active),
        created_at=lot.created_at,
        updated_at=lot.updated_at,
    )


@router.get("/", response_model=List[InventoryLotBrowseOut])
def list_lots(
    q: Optional[str] = Query(None),
    rack_number: Optional[int] = Query(None),
    loose_only: bool = Query(False),
    openable_only: bool = Query(False),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> List[InventoryLotBrowseOut]:
    with get_session() as session:
        stmt = (
            select(InventoryLot, Product, Item)
            .join(Product, Product.id == InventoryLot.product_id)
            .outerjoin(Item, Item.id == InventoryLot.legacy_item_id)
            .where(InventoryLot.is_active == True, Product.is_active == True)  # noqa: E712
        )

        if rack_number is not None:
            stmt = stmt.where(InventoryLot.rack_number == rack_number)

        if loose_only:
            stmt = stmt.where(InventoryLot.opened_from_lot_id.is_not(None))

        if openable_only:
            stmt = stmt.where(
                Product.loose_sale_enabled == True,  # noqa: E712
                InventoryLot.opened_from_lot_id.is_(None),
                Item.stock > 0,
            )

        qq = clean_text(q)
        if qq:
            like = f"%{qq.lower()}%"
            stmt = stmt.where(
                or_(
                    func.lower(func.coalesce(Product.name, "")).like(like),
                    func.lower(func.coalesce(Product.alias, "")).like(like),
                    func.lower(func.coalesce(Product.brand, "")).like(like),
                    cast(InventoryLot.rack_number, SAString).like(f"%{qq}%"),
                )
            )

        stmt = stmt.order_by(
            func.lower(Product.name).asc(),
            InventoryLot.expiry_date.asc().nullslast(),
            InventoryLot.id.asc(),
        ).offset(offset).limit(limit)

        rows = session.exec(stmt).all()
        return [lot_to_out(lot, product, item) for lot, product, item in rows]


@router.get("/open-events", response_model=List[PackOpenEventOut])
def list_open_events(
    lot_id: Optional[int] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> List[PackOpenEventOut]:
    with get_session() as session:
        stmt = select(PackOpenEvent)
        if lot_id is not None:
            stmt = stmt.where(
                or_(PackOpenEvent.source_lot_id == lot_id, PackOpenEvent.loose_lot_id == lot_id)
            )
        stmt = stmt.order_by(PackOpenEvent.id.desc()).offset(offset).limit(limit)
        rows = session.exec(stmt).all()
        return [PackOpenEventOut(**row.dict()) for row in rows]


@router.post("/open-pack", response_model=PackOpenEventOut, status_code=201)
def open_pack(payload: LotOpenCreate) -> PackOpenEventOut:
    packs_opened = int(payload.packs_opened or 0)
    if packs_opened <= 0:
        raise HTTPException(status_code=400, detail="packs_opened must be greater than 0")

    with get_session() as session:
        source_lot = session.get(InventoryLot, payload.lot_id) if payload.lot_id else None
        if not source_lot and payload.item_id:
            source_item_for_lot = session.get(Item, payload.item_id)
            if not source_item_for_lot:
                raise HTTPException(status_code=404, detail="Item not found")
            if not source_item_for_lot.product_id:
                raise HTTPException(status_code=400, detail="Item is not linked to a product")
            source_product_for_lot = session.get(Product, source_item_for_lot.product_id)
            if not source_product_for_lot:
                raise HTTPException(status_code=400, detail="Product not found")
            source_lot = ensure_lot_for_inventory_item(
                session,
                inventory_item=source_item_for_lot,
                product=source_product_for_lot,
                conversion_qty=source_product_for_lot.default_conversion_qty,
                ts=now_ts(),
            )
            session.commit()
        if not source_lot or not source_lot.is_active:
            raise HTTPException(status_code=404, detail="Lot not found")
        if source_lot.opened_from_lot_id is not None:
            raise HTTPException(status_code=400, detail="You can only open packs from sealed lots")

        product = session.get(Product, source_lot.product_id)
        if not product or not product.is_active:
            raise HTTPException(status_code=400, detail="Product not found")
        if not product.loose_sale_enabled:
            raise HTTPException(status_code=400, detail="This product is not configured for loose sales")

        conversion_qty = int(source_lot.conversion_qty or product.default_conversion_qty or 0)
        if conversion_qty <= 0:
            raise HTTPException(status_code=400, detail="Conversion quantity is missing for this lot")

        source_item = session.get(Item, source_lot.legacy_item_id) if source_lot.legacy_item_id else None
        if not source_item:
            raise HTTPException(status_code=400, detail="Legacy item link is missing for this lot")
        if int(source_item.stock or 0) < packs_opened:
            raise HTTPException(status_code=400, detail="Not enough sealed stock to open")

        loose_units_created = packs_opened * conversion_qty
        loose_mrp = round2(float(source_lot.mrp or 0) / conversion_qty)
        loose_cost_price = round2(float(source_lot.cost_price or 0) / conversion_qty) if source_lot.cost_price is not None else None
        ts = now_ts()

        loose_lot = session.exec(
            select(InventoryLot).where(
                InventoryLot.opened_from_lot_id == source_lot.id,
                InventoryLot.is_active == True,  # noqa: E712
            )
        ).first()

        if loose_lot:
            loose_lot.updated_at = ts
            loose_item = session.get(Item, loose_lot.legacy_item_id) if loose_lot.legacy_item_id else None
            if not loose_item:
                raise HTTPException(status_code=400, detail="Loose stock legacy item is missing")
            loose_item.stock = int(loose_item.stock or 0) + loose_units_created
            loose_item.mrp = loose_mrp
            loose_item.cost_price = float(loose_cost_price or 0)
            loose_item.updated_at = ts
            apply_archive_rules(session, loose_item)
            loose_lot.loose_qty = max(0, int(loose_item.stock or 0))
            loose_lot.mrp = loose_mrp
            loose_lot.cost_price = loose_cost_price
        else:
            loose_item = Item(
                name=product.name,
                brand=product.brand,
                product_id=product.id,
                category_id=product.category_id,
                expiry_date=source_lot.expiry_date,
                mrp=loose_mrp,
                cost_price=float(loose_cost_price or 0),
                stock=loose_units_created,
                rack_number=int(source_lot.rack_number or 0),
                is_archived=False,
                created_at=ts,
                updated_at=ts,
            )
            session.add(loose_item)
            session.commit()
            session.refresh(loose_item)

            loose_lot = InventoryLot(
                product_id=product.id,
                expiry_date=source_lot.expiry_date,
                mrp=loose_mrp,
                cost_price=loose_cost_price,
                rack_number=int(source_lot.rack_number or 0),
                sealed_qty=0,
                loose_qty=loose_units_created,
                conversion_qty=conversion_qty,
                opened_from_lot_id=source_lot.id,
                legacy_item_id=loose_item.id,
                is_active=True,
                created_at=ts,
                updated_at=ts,
            )
            session.add(loose_lot)

        source_item.stock = int(source_item.stock or 0) - packs_opened
        source_item.updated_at = ts
        apply_archive_rules(session, source_item)
        source_lot.sealed_qty = max(0, int(source_item.stock or 0))
        source_lot.updated_at = ts

        note = clean_text(payload.note)
        session.add(source_lot)
        session.add(source_item)
        session.add(loose_lot)
        if loose_item:
            session.add(loose_item)
        session.commit()
        session.refresh(loose_lot)

        event = PackOpenEvent(
            source_lot_id=source_lot.id,
            loose_lot_id=loose_lot.id,
            source_item_id=source_item.id,
            loose_item_id=loose_item.id if loose_item else None,
            packs_opened=packs_opened,
            loose_units_created=loose_units_created,
            note=note,
            created_at=ts,
        )
        session.add(event)
        add_movement(
            session,
            item_id=source_item.id,
            delta=-packs_opened,
            reason="PACK_OPEN_OUT",
            ref_type="PACK_OPEN",
            note=note or f"Opened {packs_opened} pack(s) into loose stock",
            actor="system",
        )
        add_movement(
            session,
            item_id=loose_item.id,
            delta=loose_units_created,
            reason="PACK_OPEN_IN",
            ref_type="PACK_OPEN",
            note=note or f"Created {loose_units_created} loose unit(s)",
            actor="system",
        )
        session.commit()
        session.refresh(event)
        return PackOpenEventOut(**event.dict())
