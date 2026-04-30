from datetime import datetime
from typing import Optional

from sqlmodel import select

from backend.models import InventoryLot, Item, Product


def now_ts() -> str:
    return datetime.now().isoformat(timespec="seconds")


def get_lot_for_item(session, item_id: int) -> Optional[InventoryLot]:
    return session.exec(
        select(InventoryLot)
        .where(InventoryLot.legacy_item_id == int(item_id))
        .order_by(InventoryLot.id.asc())
    ).first()


def item_stock_kind(session, item: Item) -> str:
    lot = get_lot_for_item(session, int(item.id or 0)) if item and item.id else None
    return "loose" if lot and lot.opened_from_lot_id is not None else "sealed"


def item_stock_meta(session, item_id: int) -> dict:
    item = session.get(Item, int(item_id)) if item_id else None
    lot = get_lot_for_item(session, int(item_id)) if item else None
    product = session.get(Product, int(item.product_id)) if item and item.product_id else None
    is_loose = bool(lot and lot.opened_from_lot_id is not None)
    unit_label = (
        (product.child_unit_name if is_loose else product.parent_unit_name)
        if product
        else None
    ) or ("Unit" if is_loose else "Pack")
    return {
        "inventory_lot_id": int(lot.id) if lot and lot.id else None,
        "opened_from_lot_id": int(lot.opened_from_lot_id) if lot and lot.opened_from_lot_id else None,
        "is_loose_stock": is_loose,
        "stock_unit_label": unit_label,
        "parent_unit_name": product.parent_unit_name if product else None,
        "child_unit_name": product.child_unit_name if product else None,
        "conversion_qty": lot.conversion_qty if lot else (product.default_conversion_qty if product else None),
        "loose_sale_enabled": bool(product.loose_sale_enabled) if product else False,
    }


def ensure_lot_for_inventory_item(
    session,
    *,
    inventory_item: Item,
    product: Optional[Product] = None,
    conversion_qty: Optional[int] = None,
    ts: Optional[str] = None,
) -> Optional[InventoryLot]:
    if not inventory_item or not inventory_item.id or not inventory_item.product_id:
        return None

    lot = get_lot_for_item(session, int(inventory_item.id))
    if lot:
        return lot

    product = product or session.get(Product, int(inventory_item.product_id))
    if not product:
        return None

    stamp = ts or now_ts()
    lot = InventoryLot(
        product_id=int(product.id),
        expiry_date=inventory_item.expiry_date,
        mrp=float(inventory_item.mrp or 0),
        cost_price=float(getattr(inventory_item, "cost_price", 0) or 0),
        rack_number=int(inventory_item.rack_number or 0),
        sealed_qty=max(0, int(inventory_item.stock or 0)),
        loose_qty=0,
        conversion_qty=conversion_qty if conversion_qty and conversion_qty > 0 else product.default_conversion_qty,
        opened_from_lot_id=None,
        legacy_item_id=int(inventory_item.id),
        is_active=not bool(getattr(inventory_item, "is_archived", False)),
        created_at=stamp,
        updated_at=stamp,
    )
    session.add(lot)
    session.flush()
    return lot


def sync_lot_quantity_for_item(session, item: Item, *, ts: Optional[str] = None) -> Optional[InventoryLot]:
    if not item or not item.id:
        return None

    lot = get_lot_for_item(session, int(item.id))
    if not lot:
        return None

    qty = max(0, int(item.stock or 0))
    if lot.opened_from_lot_id is not None:
        lot.loose_qty = qty
    else:
        lot.sealed_qty = qty
    lot.updated_at = ts or now_ts()
    session.add(lot)
    return lot
