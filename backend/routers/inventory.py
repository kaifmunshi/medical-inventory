# F:\medical-inventory\backend\routers\inventory.py

from collections import defaultdict
import logging
import re
from fastapi import APIRouter, HTTPException, Query, Request, Response
from sqlmodel import select
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple
from pydantic import BaseModel
from backend.utils.archive_rules import apply_archive_rules
from sqlalchemy import and_, case, func, literal, or_, exists
from sqlalchemy.orm import aliased

from backend.controls import log_audit
from backend.db import create_data_repair_backup, get_session
from backend.models import (
    Bill,
    BillItem,
    BillItemAllocation,
    ExchangeRecord,
    InventoryLot,
    Item,
    PackOpenEvent,
    Product,
    Purchase,
    PurchaseItem,
    Return,
    ReturnItem,
    StockAudit,
    StockAuditItem,
    StockMovement,
)
from backend.inventory_lot_sync import ensure_lot_for_inventory_item, sync_lot_quantity_for_item
from backend.security import require_min_role

logger = logging.getLogger("api.items")
router = APIRouter()


# ---------- Local Schemas ----------
class ItemIn(BaseModel):
    name: str
    brand: Optional[str] = None
    product_id: Optional[int] = None
    category_id: Optional[int] = None
    expiry_date: Optional[str] = None  # "YYYY-MM-DD"
    mrp: float
    cost_price: float = 0.0
    stock: int
    rack_number: int = 0
    source_item_id: Optional[int] = None

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
    product_id: Optional[int] = None
    category_id: Optional[int] = None
    expiry_date: Optional[str] = None
    mrp: float
    cost_price: float = 0.0
    stock: int
    rack_number: int
    is_archived: bool = False
    created_at: str
    updated_at: str
    last_incoming_at: Optional[str] = None
    inventory_lot_id: Optional[int] = None
    opened_from_lot_id: Optional[int] = None
    is_loose_stock: bool = False
    stock_unit_label: Optional[str] = None
    parent_unit_name: Optional[str] = None
    child_unit_name: Optional[str] = None
    conversion_qty: Optional[int] = None
    loose_sale_enabled: bool = False

    class Config:
        from_attributes = True


class ItemPageOut(BaseModel):
    items: List[ItemOut]
    total: int
    next_offset: Optional[int] = None


class IncomingStockEntryOut(BaseModel):
    movement_id: int
    item_id: int
    name: str
    brand: Optional[str] = None
    product_id: Optional[int] = None
    category_id: Optional[int] = None
    expiry_date: Optional[str] = None
    mrp: float
    cost_price: float = 0.0
    stock: int
    rack_number: int
    is_archived: bool = False
    created_at: str
    updated_at: str
    incoming_at: str
    delta: int
    reason: str
    ref_type: Optional[str] = None
    ref_id: Optional[int] = None
    note: Optional[str] = None


class IncomingStockEntryPageOut(BaseModel):
    items: List[IncomingStockEntryOut]
    total: int
    next_offset: Optional[int] = None


class InventoryDashboardStatsOut(BaseModel):
    inventory_total_qty: int
    inventory_total_types_all: int
    inventory_available_types: int
    zero_stock_types_count: int
    low_stock_count: int
    expiring_soon_count: int
    expired_count: int


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
    is_loose_stock: bool = False
    stock_unit_label: Optional[str] = None
    parent_unit_name: Optional[str] = None
    child_unit_name: Optional[str] = None
    conversion_qty: int = 0

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


class ItemGroupBatchOut(BaseModel):
    id: int
    name: str
    brand: Optional[str] = None
    product_id: Optional[int] = None
    expiry_date: Optional[str] = None
    mrp: float
    stock: int
    rack_number: int
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    is_archived: bool = False
    loose_sale_enabled: bool = False
    is_loose_stock: bool = False
    stock_unit_label: Optional[str] = None
    parent_unit_name: Optional[str] = None
    child_unit_name: Optional[str] = None
    conversion_qty: Optional[int] = None


class ItemGroupOut(BaseModel):
    key: str
    name: str
    brand: Optional[str] = None
    total_stock: int
    total_batch_count: int
    active_batch_count: int
    archived_batch_count: int
    earliest_expiry: Optional[str] = None
    latest_expiry: Optional[str] = None
    mrp_min: Optional[float] = None
    mrp_max: Optional[float] = None
    rack_numbers: List[int]
    batches: List[ItemGroupBatchOut]


class StockLedgerSummaryOut(BaseModel):
    key: str
    name: str
    brand: Optional[str] = None
    item_ids: List[int]
    batch_id: Optional[int] = None
    from_date: Optional[str] = None
    to_date: Optional[str] = None
    opening_stock: int
    inward_qty: int
    outward_qty: int
    net_qty: int
    closing_stock: int
    current_stock: int
    ledger_balance_gap: int
    movement_count: int
    last_movement_ts: Optional[str] = None
    last_purchase_ts: Optional[str] = None
    last_sale_ts: Optional[str] = None
    last_adjustment_ts: Optional[str] = None


class StockReconciliationEntryOut(BaseModel):
    reason: str
    ref_type: Optional[str] = None
    ref_id: Optional[int] = None
    source_ts: Optional[str] = None
    note: Optional[str] = None
    expected_delta: int
    actual_delta: int
    missing_delta: int
    safe_to_apply: bool


class StockReconciliationRowOut(BaseModel):
    item_id: int
    item_name: str
    brand: Optional[str] = None
    expiry_date: Optional[str] = None
    mrp: float
    rack_number: int
    is_archived: bool = False
    current_stock: int
    ledger_delta_total: int
    net_gap: int
    deterministic_gap: int
    projected_ledger_total: int
    suggested_recon_delta: int
    status: str
    missing_entries: List[StockReconciliationEntryOut]


class StockReconciliationReportOut(BaseModel):
    total_rows: int
    mismatched_rows: int
    deterministic_rows: int
    synthetic_rows: int
    items: List[StockReconciliationRowOut]


class StockReconciliationApplyIn(BaseModel):
    item_ids: Optional[List[int]] = None
    q: Optional[str] = None
    include_archived: bool = True
    include_balanced: bool = False
    apply_synthetic: bool = True


class StockReconciliationApplyOut(BaseModel):
    applied_items: int
    deterministic_rows_inserted: int
    synthetic_rows_inserted: int
    total_delta_applied: int


class OpeningDeleteOut(BaseModel):
    item: ItemOut
    deleted_movement_id: int
    removed_qty: int


class ManualAdjustmentDeleteOut(BaseModel):
    item: ItemOut
    deleted_movement_id: int
    reversed_delta: int


class OpeningClubIn(BaseModel):
    source_item_id: int
    target_item_id: int
    purchase_item_id: Optional[int] = None
    adopt_purchase_details: bool = False
    note: Optional[str] = None


class OpeningClubOut(BaseModel):
    source_item: ItemOut
    target_item: ItemOut
    purchase_id: int
    purchase_item_id: int
    source_item_id: int
    target_item_id: int
    target_stock: int
    archived_source_id: int
    moved_movement_count: int
    backup_path: Optional[str] = None


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


def _item_name_key(value: Optional[str]) -> str:
    text = " ".join(str(value or "").strip().split()).lower()
    return re.sub(r"\b(\d+)\s+(g|gm|ml|tab|tabs|tablet|tablets|cap|caps|n)\b", r"\1\2", text)


def _brand_key(value: Optional[str]) -> str:
    return " ".join(str(value or "").strip().split()).lower()


def _same_group_stmt(name: Optional[str], brand: Optional[str]):
    n = _norm_str(name) or ""
    b = _norm_str(brand)
    stmt = select(Item).where(func.lower(Item.name) == func.lower(n))
    if b is None:
        stmt = stmt.where(or_(Item.brand.is_(None), func.trim(Item.brand) == ""))
    else:
        stmt = stmt.where(func.lower(func.coalesce(Item.brand, "")) == func.lower(b))
    return stmt


def _group_key(name: Optional[str], brand: Optional[str]) -> str:
    return f"{_item_name_key(name)}__{_brand_key(brand)}"


def _apply_default_visibility(stmt):
    peer = aliased(Item)
    visible_row = or_(Item.is_archived == False, Item.is_archived.is_(None))  # noqa: E712
    same_group_visible_exists = exists(
        select(peer.id).where(
            func.lower(func.trim(func.coalesce(peer.name, "")))
            == func.lower(func.trim(func.coalesce(Item.name, ""))),
            func.lower(func.trim(func.coalesce(peer.brand, "")))
            == func.lower(func.trim(func.coalesce(Item.brand, ""))),
            or_(peer.is_archived == False, peer.is_archived.is_(None)),  # noqa: E712
        )
    )
    return stmt.where(or_(visible_row, ~same_group_visible_exists))


def _attach_last_incoming(session, items: List[Item]) -> None:
    item_ids = [int(item.id) for item in items if getattr(item, "id", None) is not None]
    if not item_ids:
        return

    rows = session.exec(
        select(StockMovement.item_id, func.max(StockMovement.ts))
        .where(StockMovement.item_id.in_(item_ids))
        .where(StockMovement.delta > 0)
        .group_by(StockMovement.item_id)
    ).all()
    latest_by_item = {int(row[0]): row[1] for row in rows}
    for item in items:
        object.__setattr__(item, "last_incoming_at", latest_by_item.get(int(item.id)))


def _attach_lot_metadata(session, items: List[Item]) -> None:
    item_ids = [int(item.id) for item in items if getattr(item, "id", None) is not None]
    if not item_ids:
        return
    product_ids = [int(item.product_id) for item in items if getattr(item, "product_id", None) is not None]

    rows = session.exec(
        select(InventoryLot, Product)
        .join(Product, Product.id == InventoryLot.product_id)
        .where(InventoryLot.legacy_item_id.in_(item_ids))
    ).all()
    lot_by_item = {int(lot.legacy_item_id): (lot, product) for lot, product in rows if lot.legacy_item_id is not None}
    product_by_id: Dict[int, Product] = {}
    if product_ids:
        product_rows = session.exec(select(Product).where(Product.id.in_(product_ids))).all()
        product_by_id = {int(product.id): product for product in product_rows if product.id is not None}

    for item in items:
        pair = lot_by_item.get(int(item.id))
        if not pair:
            product = product_by_id.get(int(item.product_id)) if getattr(item, "product_id", None) is not None else None
            is_loose_enabled = bool(product.loose_sale_enabled) if product else False
            if product and getattr(item, "category_id", None) is None and product.category_id is not None:
                object.__setattr__(item, "category_id", product.category_id)
            object.__setattr__(item, "is_loose_stock", False)
            object.__setattr__(item, "stock_unit_label", (product.parent_unit_name if product else None) or "Pack")
            object.__setattr__(item, "parent_unit_name", product.parent_unit_name if product else None)
            object.__setattr__(item, "child_unit_name", product.child_unit_name if product else None)
            object.__setattr__(item, "conversion_qty", product.default_conversion_qty if product else None)
            object.__setattr__(item, "loose_sale_enabled", is_loose_enabled)
            continue
        lot, product = pair
        is_loose = lot.opened_from_lot_id is not None
        unit_label = product.child_unit_name if is_loose else product.parent_unit_name
        if getattr(item, "product_id", None) is None and product.id is not None:
            object.__setattr__(item, "product_id", product.id)
        if getattr(item, "category_id", None) is None and product.category_id is not None:
            object.__setattr__(item, "category_id", product.category_id)
        object.__setattr__(item, "inventory_lot_id", lot.id)
        object.__setattr__(item, "opened_from_lot_id", lot.opened_from_lot_id)
        object.__setattr__(item, "is_loose_stock", bool(is_loose))
        object.__setattr__(item, "stock_unit_label", unit_label or ("Unit" if is_loose else "Pack"))
        object.__setattr__(item, "parent_unit_name", product.parent_unit_name)
        object.__setattr__(item, "child_unit_name", product.child_unit_name)
        object.__setattr__(item, "conversion_qty", lot.conversion_qty or product.default_conversion_qty)
        object.__setattr__(item, "loose_sale_enabled", bool(product.loose_sale_enabled))


def _load_group_batches(session, *, name: Optional[str], brand: Optional[str]) -> Tuple[str, Optional[str], List[Item]]:
    n = _norm_str(name)
    if not n:
        raise HTTPException(status_code=400, detail="name is required")

    b = _norm_str(brand)
    stmt = select(Item)
    if b is None:
        stmt = stmt.where(or_(Item.brand.is_(None), func.trim(Item.brand) == ""))
    else:
        stmt = stmt.where(func.lower(func.coalesce(Item.brand, "")) == b.lower())
    candidates = session.exec(stmt).all()
    wanted_key = _item_name_key(n)
    batches = [row for row in candidates if _item_name_key(row.name) == wanted_key]
    batches.sort(
        key=lambda row: (
            str(getattr(row, "expiry_date", None) or "9999-12-31"),
            float(getattr(row, "mrp", 0) or 0),
            int(getattr(row, "id", 0) or 0),
        )
    )
    if not batches:
        raise HTTPException(status_code=404, detail="No items found for this (name+brand)")
    return n, b, batches


ReconciliationKey = Tuple[int, str, Optional[str], Optional[int]]


def _movement_key(item_id: int, reason: str, ref_type: Optional[str], ref_id: Optional[int]) -> ReconciliationKey:
    return (
        int(item_id),
        str(reason or "").strip().upper(),
        str(ref_type).strip().upper() if ref_type else None,
        int(ref_id) if ref_id is not None else None,
    )


def _is_safe_backfill(expected_delta: int, actual_delta: int) -> bool:
    if int(expected_delta or 0) == 0:
        return False
    if int(actual_delta or 0) == 0:
        return True
    if expected_delta > 0 and actual_delta > 0 and abs(actual_delta) < abs(expected_delta):
        return True
    if expected_delta < 0 and actual_delta < 0 and abs(actual_delta) < abs(expected_delta):
        return True
    return False


def _load_reconciliation_items(
    session,
    *,
    q: Optional[str],
    include_archived: bool,
    item_ids: Optional[List[int]] = None,
) -> List[Item]:
    stmt = select(Item)
    if item_ids:
        stmt = stmt.where(Item.id.in_([int(x) for x in item_ids]))
    else:
        if not include_archived:
            stmt = stmt.where(or_(Item.is_archived == False, Item.is_archived.is_(None)))  # noqa: E712
        qq = _norm_str(q)
        if qq:
            like = f"%{qq.lower()}%"
            if qq.isdigit():
                stmt = stmt.where(
                    or_(
                        func.lower(func.coalesce(Item.name, "")).like(like),
                        func.lower(func.coalesce(Item.brand, "")).like(like),
                        Item.id == int(qq),
                    )
                )
            else:
                stmt = stmt.where(
                    or_(
                        func.lower(func.coalesce(Item.name, "")).like(like),
                        func.lower(func.coalesce(Item.brand, "")).like(like),
                    )
                )
        stmt = stmt.order_by(func.lower(Item.name).asc(), func.lower(func.coalesce(Item.brand, "")).asc(), Item.id.asc())
    return session.exec(stmt).all()


def _add_expected(
    expected: Dict[ReconciliationKey, int],
    meta: Dict[ReconciliationKey, Dict[str, Optional[str]]],
    *,
    item_id: int,
    reason: str,
    ref_type: Optional[str],
    ref_id: Optional[int],
    delta: int,
    source_ts: Optional[str],
    note: Optional[str],
) -> None:
    if int(delta or 0) == 0:
        return
    key = _movement_key(item_id, reason, ref_type, ref_id)
    expected[key] += int(delta)
    if key not in meta:
        meta[key] = {
            "source_ts": source_ts,
            "note": note,
        }


def _build_stock_reconciliation(
    session,
    *,
    q: Optional[str],
    include_archived: bool,
    include_balanced: bool,
    item_ids: Optional[List[int]] = None,
) -> List[StockReconciliationRowOut]:
    items = _load_reconciliation_items(session, q=q, include_archived=include_archived, item_ids=item_ids)
    if not items:
        return []

    target_item_ids = [int(item.id) for item in items if item.id is not None]
    expected: Dict[ReconciliationKey, int] = defaultdict(int)
    meta: Dict[ReconciliationKey, Dict[str, Optional[str]]] = {}

    actual_by_key: Dict[ReconciliationKey, int] = defaultdict(int)
    actual_rows = session.exec(
        select(
            StockMovement.item_id,
            StockMovement.reason,
            StockMovement.ref_type,
            StockMovement.ref_id,
            func.coalesce(func.sum(StockMovement.delta), 0),
        )
        .where(StockMovement.item_id.in_(target_item_ids))
        .group_by(StockMovement.item_id, StockMovement.reason, StockMovement.ref_type, StockMovement.ref_id)
    ).all()
    for row in actual_rows:
        key = _movement_key(int(row[0]), str(row[1] or ""), row[2], row[3])
        actual_by_key[key] = int(row[4] or 0)

    actual_total_by_item: Dict[int, int] = defaultdict(int)
    total_rows = session.exec(
        select(StockMovement.item_id, func.coalesce(func.sum(StockMovement.delta), 0))
        .where(StockMovement.item_id.in_(target_item_ids))
        .group_by(StockMovement.item_id)
    ).all()
    for row in total_rows:
        actual_total_by_item[int(row[0])] = int(row[1] or 0)

    sale_rows = session.exec(
        select(
            BillItem.item_id,
            BillItem.bill_id,
            func.coalesce(func.sum(BillItem.quantity), 0),
            Bill.is_deleted,
            func.max(Bill.date_time),
        )
        .join(Bill, Bill.id == BillItem.bill_id)
        .where(BillItem.item_id.in_(target_item_ids))
        .group_by(BillItem.item_id, BillItem.bill_id, Bill.is_deleted)
    ).all()
    for row in sale_rows:
        item_id = int(row[0])
        bill_id = int(row[1])
        qty = int(row[2] or 0)
        is_deleted = bool(row[3])
        bill_ts = row[4]
        _add_expected(
            expected,
            meta,
            item_id=item_id,
            reason="SALE",
            ref_type="BILL",
            ref_id=bill_id,
            delta=-qty,
            source_ts=bill_ts,
            note=f"Bill #{bill_id}",
        )
        if is_deleted:
            _add_expected(
                expected,
                meta,
                item_id=item_id,
                reason="BILL_DELETE",
                ref_type="BILL",
                ref_id=bill_id,
                delta=qty,
                source_ts=bill_ts,
                note=f"Bill #{bill_id} soft-deleted",
            )
        else:
            delete_key = _movement_key(item_id, "BILL_DELETE", "BILL", bill_id)
            recover_key = _movement_key(item_id, "BILL_RECOVER", "BILL", bill_id)
            actual_delete = max(0, int(actual_by_key.get(delete_key, 0)))
            actual_recover = max(0, abs(int(actual_by_key.get(recover_key, 0))))
            if actual_delete > actual_recover:
                _add_expected(
                    expected,
                    meta,
                    item_id=item_id,
                    reason="BILL_RECOVER",
                    ref_type="BILL",
                    ref_id=bill_id,
                    delta=-(actual_delete),
                    source_ts=bill_ts,
                    note=f"Bill #{bill_id} recovered",
                )

    purchase_rows = session.exec(
        select(
            PurchaseItem.inventory_item_id,
            PurchaseItem.purchase_id,
            func.coalesce(func.sum(PurchaseItem.sealed_qty + PurchaseItem.free_qty), 0),
            Purchase.is_deleted,
            func.max(Purchase.created_at),
            func.max(Purchase.invoice_number),
        )
        .join(Purchase, Purchase.id == PurchaseItem.purchase_id)
        .where(PurchaseItem.inventory_item_id.is_not(None))
        .where(PurchaseItem.inventory_item_id.in_(target_item_ids))
        .where(func.coalesce(PurchaseItem.stock_source, "CREATED") != "ATTACHED")
        .group_by(PurchaseItem.inventory_item_id, PurchaseItem.purchase_id, Purchase.is_deleted)
    ).all()
    for row in purchase_rows:
        item_id = int(row[0])
        purchase_id = int(row[1])
        qty = int(row[2] or 0)
        is_deleted = bool(row[3])
        purchase_ts = row[4]
        invoice_number = row[5]
        _add_expected(
            expected,
            meta,
            item_id=item_id,
            reason="PURCHASE",
            ref_type="PURCHASE",
            ref_id=purchase_id,
            delta=qty,
            source_ts=purchase_ts,
            note=f"Purchase {invoice_number or purchase_id}",
        )
        if is_deleted:
            _add_expected(
                expected,
                meta,
                item_id=item_id,
                reason="PURCHASE_CANCEL",
                ref_type="PURCHASE",
                ref_id=purchase_id,
                delta=-qty,
                source_ts=purchase_ts,
                note=f"Cancelled purchase {invoice_number or purchase_id}",
            )

    return_rows = session.exec(
        select(
            ReturnItem.item_id,
            ReturnItem.return_id,
            func.coalesce(func.sum(ReturnItem.quantity), 0),
            ExchangeRecord.return_id,
            func.max(Return.date_time),
        )
        .join(Return, Return.id == ReturnItem.return_id)
        .outerjoin(ExchangeRecord, ExchangeRecord.return_id == ReturnItem.return_id)
        .where(ReturnItem.item_id.in_(target_item_ids))
        .group_by(ReturnItem.item_id, ReturnItem.return_id, ExchangeRecord.return_id)
    ).all()
    for row in return_rows:
        item_id = int(row[0])
        return_id = int(row[1])
        qty = int(row[2] or 0)
        is_exchange = row[3] is not None
        return_ts = row[4]
        _add_expected(
            expected,
            meta,
            item_id=item_id,
            reason="EXCHANGE_IN" if is_exchange else "RETURN",
            ref_type="EXCHANGE" if is_exchange else "RETURN",
            ref_id=return_id,
            delta=qty,
            source_ts=return_ts,
            note=f"{'Exchange return' if is_exchange else 'Return'} #{return_id}",
        )

    exchange_out_rows = session.exec(
        select(
            BillItem.item_id,
            BillItem.bill_id,
            func.coalesce(func.sum(BillItem.quantity), 0),
            func.max(Bill.date_time),
        )
        .join(ExchangeRecord, ExchangeRecord.new_bill_id == BillItem.bill_id)
        .join(Bill, Bill.id == BillItem.bill_id)
        .where(BillItem.item_id.in_(target_item_ids))
        .group_by(BillItem.item_id, BillItem.bill_id)
    ).all()
    for row in exchange_out_rows:
        item_id = int(row[0])
        bill_id = int(row[1])
        qty = int(row[2] or 0)
        bill_ts = row[3]
        _add_expected(
            expected,
            meta,
            item_id=item_id,
            reason="EXCHANGE_OUT",
            ref_type="EXCHANGE",
            ref_id=bill_id,
            delta=-qty,
            source_ts=bill_ts,
            note=f"Exchange bill #{bill_id}",
        )

    pack_out_rows = session.exec(
        select(PackOpenEvent.source_item_id, func.coalesce(func.sum(PackOpenEvent.packs_opened), 0), func.max(PackOpenEvent.created_at))
        .where(PackOpenEvent.source_item_id.is_not(None))
        .where(PackOpenEvent.source_item_id.in_(target_item_ids))
        .group_by(PackOpenEvent.source_item_id)
    ).all()
    for row in pack_out_rows:
        _add_expected(
            expected,
            meta,
            item_id=int(row[0]),
            reason="PACK_OPEN_OUT",
            ref_type="PACK_OPEN",
            ref_id=None,
            delta=-int(row[1] or 0),
            source_ts=row[2],
            note="Pack opening outflow",
        )

    pack_in_rows = session.exec(
        select(PackOpenEvent.loose_item_id, func.coalesce(func.sum(PackOpenEvent.loose_units_created), 0), func.max(PackOpenEvent.created_at))
        .where(PackOpenEvent.loose_item_id.is_not(None))
        .where(PackOpenEvent.loose_item_id.in_(target_item_ids))
        .group_by(PackOpenEvent.loose_item_id)
    ).all()
    for row in pack_in_rows:
        _add_expected(
            expected,
            meta,
            item_id=int(row[0]),
            reason="PACK_OPEN_IN",
            ref_type="PACK_OPEN",
            ref_id=None,
            delta=int(row[1] or 0),
            source_ts=row[2],
            note="Pack opening inflow",
        )

    audit_rows = session.exec(
        select(
            StockAuditItem.item_id,
            StockAuditItem.audit_id,
            StockAudit.closed_at,
            StockAuditItem.system_stock,
            StockAuditItem.physical_stock,
        )
        .join(StockAudit, StockAudit.id == StockAuditItem.audit_id)
        .where(StockAudit.status == "FINALIZED")
        .where(StockAuditItem.item_id.in_(target_item_ids))
    ).all()
    for row in audit_rows:
        physical_stock = row[4]
        if physical_stock is None:
            continue
        diff = int(physical_stock) - int(row[3] or 0)
        if diff == 0:
            continue
        audit_id = int(row[1])
        _add_expected(
            expected,
            meta,
            item_id=int(row[0]),
            reason="ADJUST",
            ref_type="AUDIT",
            ref_id=audit_id,
            delta=diff,
            source_ts=row[2],
            note=f"Audit discrepancy for audit #{audit_id}",
        )

    rows_out: List[StockReconciliationRowOut] = []
    for item in items:
        item_id = int(item.id)
        ledger_total = int(actual_total_by_item.get(item_id, 0))
        entries: List[StockReconciliationEntryOut] = []
        deterministic_gap = 0

        item_keys = [key for key in expected.keys() if key[0] == item_id]
        item_keys.sort(key=lambda key: ((meta.get(key) or {}).get("source_ts") or "", key[1], key[3] or 0))

        for key in item_keys:
            expected_delta = int(expected.get(key, 0))
            actual_delta = int(actual_by_key.get(key, 0))
            missing_delta = expected_delta - actual_delta
            if missing_delta == 0:
                continue
            safe_to_apply = _is_safe_backfill(expected_delta, actual_delta)
            if safe_to_apply:
                deterministic_gap += missing_delta
            entries.append(
                StockReconciliationEntryOut(
                    reason=key[1],
                    ref_type=key[2],
                    ref_id=key[3],
                    source_ts=(meta.get(key) or {}).get("source_ts"),
                    note=(meta.get(key) or {}).get("note"),
                    expected_delta=expected_delta,
                    actual_delta=actual_delta,
                    missing_delta=missing_delta,
                    safe_to_apply=safe_to_apply,
                )
            )

        net_gap = int(item.stock or 0) - ledger_total
        projected_ledger_total = ledger_total + deterministic_gap
        suggested_recon_delta = int(item.stock or 0) - projected_ledger_total

        if not include_balanced and not entries and suggested_recon_delta == 0:
            continue

        if not entries and suggested_recon_delta == 0:
            status = "BALANCED"
        elif entries and suggested_recon_delta == 0:
            status = "DETERMINISTIC_ONLY"
        elif entries and suggested_recon_delta != 0:
            status = "DETERMINISTIC_PLUS_RECON"
        else:
            status = "RECON_ONLY"

        rows_out.append(
            StockReconciliationRowOut(
                item_id=item_id,
                item_name=item.name,
                brand=item.brand,
                expiry_date=item.expiry_date,
                mrp=float(item.mrp or 0),
                rack_number=int(item.rack_number or 0),
                is_archived=bool(getattr(item, "is_archived", False)),
                current_stock=int(item.stock or 0),
                ledger_delta_total=ledger_total,
                net_gap=net_gap,
                deterministic_gap=deterministic_gap,
                projected_ledger_total=projected_ledger_total,
                suggested_recon_delta=suggested_recon_delta,
                status=status,
                missing_entries=entries,
            )
        )

    rows_out.sort(
        key=lambda row: (
            row.status == "BALANCED",
            row.item_name.lower(),
            (row.brand or "").lower(),
            row.item_id,
        )
    )
    return rows_out


def _purchase_stock_movement_join_condition():
    return and_(
        func.upper(func.coalesce(StockMovement.ref_type, "")) == "PURCHASE",
        StockMovement.ref_id == Purchase.id,
    )


def _stock_movement_effective_ts_expr():
    return case(
        (
            and_(
                func.upper(func.coalesce(StockMovement.ref_type, "")) == "PURCHASE",
                Purchase.invoice_date.isnot(None),
            ),
            Purchase.invoice_date + literal("T00:00:00"),
        ),
        else_=StockMovement.ts,
    )


def _future_delta_after_effective_ts(session, item_ids: List[int], to_ts: Optional[str]) -> int:
    if not to_ts:
        return 0
    movement_ts = _stock_movement_effective_ts_expr()
    stmt = (
        select(func.coalesce(func.sum(StockMovement.delta), 0))
        .select_from(StockMovement)
        .outerjoin(Purchase, _purchase_stock_movement_join_condition())
        .where(StockMovement.item_id.in_(item_ids))
        .where(movement_ts > to_ts)
    )
    return int(session.exec(stmt).one() or 0)


def _build_group_summary(
    session,
    *,
    name: str,
    brand: Optional[str],
    item_id: Optional[int],
    from_date: Optional[str],
    to_date: Optional[str],
) -> StockLedgerSummaryOut:
    n, b, batches = _load_group_batches(session, name=name, brand=brand)
    all_item_ids = [int(batch.id) for batch in batches]
    if item_id is not None and int(item_id) not in all_item_ids:
        raise HTTPException(status_code=404, detail="Batch does not belong to this product group")

    target_batches = [batch for batch in batches if item_id is None or int(batch.id) == int(item_id)]
    item_ids = [int(batch.id) for batch in target_batches]
    current_stock = sum(int(batch.stock or 0) for batch in target_batches)

    from_ts = f"{from_date}T00:00:00" if from_date else None
    to_ts = f"{to_date}T23:59:59" if to_date else None

    movement_ts = _stock_movement_effective_ts_expr()
    period_net_expr = StockMovement.delta
    period_in_expr = case((StockMovement.delta > 0, StockMovement.delta), else_=0)
    period_out_expr = case((StockMovement.delta < 0, -StockMovement.delta), else_=0)
    period_stmt = (
        select(
            func.coalesce(func.sum(period_net_expr), 0),
            func.coalesce(func.sum(period_in_expr), 0),
            func.coalesce(func.sum(period_out_expr), 0),
            func.count(StockMovement.id),
        )
        .select_from(StockMovement)
        .outerjoin(Purchase, _purchase_stock_movement_join_condition())
        .where(StockMovement.item_id.in_(item_ids))
    )
    if from_ts:
        period_stmt = period_stmt.where(movement_ts >= from_ts)
    if to_ts:
        period_stmt = period_stmt.where(movement_ts <= to_ts)
    period_row = session.exec(period_stmt).one()
    net_qty = int(period_row[0] or 0)
    inward_qty = int(period_row[1] or 0)
    outward_qty = int(period_row[2] or 0)
    movement_count = int(period_row[3] or 0)

    future_delta = 0
    if to_ts:
        future_stmt = (
            select(func.coalesce(func.sum(StockMovement.delta), 0))
            .select_from(StockMovement)
            .outerjoin(Purchase, _purchase_stock_movement_join_condition())
            .where(StockMovement.item_id.in_(item_ids))
            .where(movement_ts > to_ts)
        )
        future_delta = int(session.exec(future_stmt).one() or 0)

    closing_stock = int(current_stock) - future_delta
    opening_stock = closing_stock - net_qty

    ledger_total_stmt = (
        select(func.coalesce(func.sum(StockMovement.delta), 0))
        .where(StockMovement.item_id.in_(item_ids))
    )
    ledger_total = int(session.exec(ledger_total_stmt).one() or 0)

    def _max_ts_for_reasons(reasons: List[str]) -> Optional[str]:
        stmt = (
            select(func.max(movement_ts))
            .select_from(StockMovement)
            .outerjoin(Purchase, _purchase_stock_movement_join_condition())
            .where(StockMovement.item_id.in_(item_ids))
            .where(func.upper(StockMovement.reason).in_([reason.upper() for reason in reasons]))
        )
        return session.exec(stmt).one()

    last_movement_ts = session.exec(
        select(func.max(movement_ts))
        .select_from(StockMovement)
        .outerjoin(Purchase, _purchase_stock_movement_join_condition())
        .where(StockMovement.item_id.in_(item_ids))
    ).one()

    return StockLedgerSummaryOut(
        key=_group_key(n, b),
        name=str(target_batches[0].name),
        brand=getattr(target_batches[0], "brand", None),
        item_ids=item_ids,
        batch_id=int(item_id) if item_id is not None else None,
        from_date=from_date,
        to_date=to_date,
        opening_stock=int(opening_stock),
        inward_qty=int(inward_qty),
        outward_qty=int(outward_qty),
        net_qty=int(net_qty),
        closing_stock=int(closing_stock),
        current_stock=int(current_stock),
        ledger_balance_gap=int(current_stock) - int(ledger_total),
        movement_count=movement_count,
        last_movement_ts=last_movement_ts,
        last_purchase_ts=_max_ts_for_reasons(["PURCHASE"]),
        last_sale_ts=_max_ts_for_reasons(["SALE", "EXCHANGE_OUT"]),
        last_adjustment_ts=_max_ts_for_reasons(["ADJUST", "RECON_ADJUST", "PACK_OPEN_IN", "PACK_OPEN_OUT"]),
    )


# ---------- Endpoints ----------
@router.get("/dashboard-stats", response_model=InventoryDashboardStatsOut)
def dashboard_stats(
    low_stock_threshold: int = Query(2, ge=0),
    expiry_window_days: int = Query(60, ge=0),
) -> InventoryDashboardStatsOut:
    with get_session() as session:
        rows = session.exec(_apply_default_visibility(select(Item))).all()

        groups: Dict[str, Dict[str, Any]] = {}
        total_qty = 0
        today = date.today()
        expiring_soon_count = 0
        expired_count = 0

        for item in rows:
            name = str(getattr(item, "name", "") or "").strip()
            brand = str(getattr(item, "brand", "") or "").strip()
            if not name:
                continue

            stock = int(getattr(item, "stock", 0) or 0)
            total_qty += stock
            key = f"{name.lower()}|{brand.lower()}"
            if key not in groups:
                groups[key] = {"stock": 0}
            groups[key]["stock"] = int(groups[key]["stock"] or 0) + stock

            expiry_raw = str(getattr(item, "expiry_date", "") or "").strip()[:10]
            if expiry_raw:
                try:
                    expiry = date.fromisoformat(expiry_raw)
                except ValueError:
                    expiry = None
                if expiry:
                    days_left = (expiry - today).days
                    if days_left < 0:
                        expired_count += 1
                    elif days_left <= expiry_window_days:
                        expiring_soon_count += 1

        zero_stock_types = 0
        available_types = 0
        low_stock_count = 0
        for group in groups.values():
            stock = int(group["stock"] or 0)
            if stock > 0:
                available_types += 1
            else:
                zero_stock_types += 1
            if stock <= low_stock_threshold:
                low_stock_count += 1

        return InventoryDashboardStatsOut(
            inventory_total_qty=total_qty,
            inventory_total_types_all=len(groups),
            inventory_available_types=available_types,
            zero_stock_types_count=zero_stock_types,
            low_stock_count=low_stock_count,
            expiring_soon_count=expiring_soon_count,
            expired_count=expired_count,
        )


@router.get("/", response_model=ItemPageOut)
def list_items(
    request: Request,
    q: Optional[str] = Query(None, description="Search in name/brand"),
    rack_number: Optional[int] = Query(None, ge=0, description="Filter by exact rack number"),
    brand: Optional[str] = Query(None, description="Filter by exact brand"),
    category_id: Optional[int] = Query(None, ge=0, description="Filter by product category"),
    created_from: Optional[str] = Query(
        None,
        description="Filter to batches created from this date or with positive stock movement from this date",
    ),
    incoming_from: Optional[str] = Query(
        None,
        description="Filter to batches with positive incoming stock from this date",
    ),
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
            base_stmt = _apply_default_visibility(base_stmt)

        if q:
            search_text = q.strip()
            like = f"%{search_text}%"
            numeric_search_id = None
            id_text = search_text[1:] if search_text.startswith("#") else search_text
            if id_text.isdigit():
                numeric_search_id = int(id_text)

            movement_search_terms = [
                StockMovement.reason.ilike(like),
                func.coalesce(StockMovement.ref_type, "").ilike(like),
                func.coalesce(StockMovement.note, "").ilike(like),
            ]
            if numeric_search_id is not None:
                movement_search_terms.append(StockMovement.ref_id == numeric_search_id)

            matching_movement_exists = exists(
                select(StockMovement.id).where(
                    StockMovement.item_id == Item.id,
                    or_(*movement_search_terms),
                )
            )
            matching_product_exists = exists(
                select(Product.id).where(
                    Product.id == Item.product_id,
                    or_(
                        Product.name.ilike(like),
                        Product.alias.ilike(like),
                        Product.brand.ilike(like),
                    ),
                )
            )
            matching_lot_product_exists = exists(
                select(InventoryLot.id)
                .join(Product, Product.id == InventoryLot.product_id)
                .where(
                    InventoryLot.legacy_item_id == Item.id,
                    or_(
                        Product.name.ilike(like),
                        Product.alias.ilike(like),
                        Product.brand.ilike(like),
                    ),
                )
            )
            item_search_terms = [
                Item.name.ilike(like),
                Item.brand.ilike(like),
                matching_movement_exists,
                matching_product_exists,
                matching_lot_product_exists,
            ]
            if numeric_search_id is not None:
                item_search_terms.append(Item.id == numeric_search_id)

            base_stmt = base_stmt.where(
                or_(*item_search_terms)
            )
        if rack_number is not None:
            base_stmt = base_stmt.where(Item.rack_number == rack_number)
        if brand:
            base_stmt = base_stmt.where(func.lower(func.coalesce(Item.brand, "")) == brand.strip().lower())
        if category_id is not None:
            product_category_exists = exists(
                select(Product.id).where(
                    Product.id == Item.product_id,
                    Product.category_id == category_id,
                )
            )
            lot_product_category_exists = exists(
                select(InventoryLot.id)
                .join(Product, Product.id == InventoryLot.product_id)
                .where(
                    InventoryLot.legacy_item_id == Item.id,
                    Product.category_id == category_id,
                )
            )
            base_stmt = base_stmt.where(
                or_(
                    Item.category_id == category_id,
                    product_category_exists,
                    lot_product_category_exists,
                )
            )
        if incoming_from:
            from_date = incoming_from.strip()[:10]
            try:
                date.fromisoformat(from_date)
            except ValueError:
                raise HTTPException(status_code=400, detail="incoming_from must be YYYY-MM-DD")

            from_ts = f"{from_date}T00:00:00"
            incoming_stock_exists = exists(
                select(StockMovement.id).where(
                    StockMovement.item_id == Item.id,
                    StockMovement.delta > 0,
                    StockMovement.ts >= from_ts,
                )
            )
            legacy_created_stock = (Item.stock > 0) & (Item.created_at >= from_date)
            base_stmt = base_stmt.where(or_(incoming_stock_exists, legacy_created_stock))
        elif created_from:
            from_date = created_from.strip()[:10]
            try:
                date.fromisoformat(from_date)
            except ValueError:
                raise HTTPException(status_code=400, detail="created_from must be YYYY-MM-DD")

            from_ts = f"{from_date}T00:00:00"
            positive_stock_exists = exists(
                select(StockMovement.id).where(
                    StockMovement.item_id == Item.id,
                    StockMovement.delta > 0,
                    StockMovement.ts >= from_ts,
                )
            )
            base_stmt = base_stmt.where(
                or_(
                    Item.created_at >= from_date,
                    Item.updated_at >= from_date,
                    positive_stock_exists,
                )
            )
        # If ONLY q is present (client didn't pass limit/offset), return ALL matches
        if q and limit is None and offset is None:
            stmt = base_stmt.order_by(Item.name, Item.id)
            items = session.exec(stmt).all()
            _attach_last_incoming(session, items)
            _attach_lot_metadata(session, items)
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
        _attach_last_incoming(session, items)
        _attach_lot_metadata(session, items)

        next_offset = (
            (page_offset + page_limit)
            if (page_offset + page_limit) < total
            else None
        )

        return {"items": items, "total": total, "next_offset": next_offset}


@router.get("/incoming", response_model=IncomingStockEntryPageOut)
def list_incoming_stock_entries(
    q: Optional[str] = Query(None, description="Search item/movement text or item/movement id"),
    incoming_from: Optional[str] = Query(None, description="YYYY-MM-DD; only positive incoming entries from this date"),
    include_archived: bool = Query(False, description="If true, include archived batches"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    with get_session() as session:
        movement_ts = _stock_movement_effective_ts_expr()
        stmt = (
            select(StockMovement, Item, movement_ts.label("effective_ts"))
            .join(Item, Item.id == StockMovement.item_id)
            .outerjoin(Purchase, _purchase_stock_movement_join_condition())
            .where(StockMovement.delta > 0)
        )

        if not include_archived:
            stmt = stmt.where(or_(Item.is_archived == False, Item.is_archived.is_(None)))  # noqa: E712

        if incoming_from:
            from_date = incoming_from.strip()[:10]
            try:
                date.fromisoformat(from_date)
            except ValueError:
                raise HTTPException(status_code=400, detail="incoming_from must be YYYY-MM-DD")
            stmt = stmt.where(movement_ts >= f"{from_date}T00:00:00")

        if q:
            search_text = q.strip()
            like = f"%{search_text}%"
            numeric_search_id = None
            id_text = search_text[1:] if search_text.startswith("#") else search_text
            if id_text.isdigit():
                numeric_search_id = int(id_text)

            terms = [
                Item.name.ilike(like),
                Item.brand.ilike(like),
                StockMovement.reason.ilike(like),
                func.coalesce(StockMovement.ref_type, "").ilike(like),
                func.coalesce(StockMovement.note, "").ilike(like),
            ]
            if numeric_search_id is not None:
                terms.extend([
                    Item.id == numeric_search_id,
                    StockMovement.id == numeric_search_id,
                    StockMovement.ref_id == numeric_search_id,
                ])
            stmt = stmt.where(or_(*terms))

        count_stmt = select(func.count()).select_from(stmt.subquery())
        total = session.exec(count_stmt).one()

        rows = session.exec(
            stmt.order_by(movement_ts.desc(), StockMovement.id.desc())
            .limit(limit)
            .offset(offset)
        ).all()

        row_items = [row[1] for row in rows]
        item_ids = [int(item.id) for item in row_items if getattr(item, "id", None) is not None]
        product_ids = [int(item.product_id) for item in row_items if getattr(item, "product_id", None) is not None]
        product_by_id: Dict[int, Product] = {}
        product_by_item_id: Dict[int, Product] = {}
        if product_ids:
            product_rows = session.exec(select(Product).where(Product.id.in_(product_ids))).all()
            product_by_id = {int(product.id): product for product in product_rows if product.id is not None}
        if item_ids:
            lot_product_rows = session.exec(
                select(InventoryLot.legacy_item_id, Product)
                .join(Product, Product.id == InventoryLot.product_id)
                .where(InventoryLot.legacy_item_id.in_(item_ids))
            ).all()
            product_by_item_id = {
                int(item_id): product
                for item_id, product in lot_product_rows
                if item_id is not None and product.id is not None
            }

        items: List[IncomingStockEntryOut] = []
        for row in rows:
            movement = row[0]
            item = row[1]
            effective_ts = row[2] or movement.ts
            product = product_by_item_id.get(int(item.id or 0))
            if product is None and getattr(item, "product_id", None) is not None:
                product = product_by_id.get(int(item.product_id))
            product_id = getattr(item, "product_id", None) or (product.id if product else None)
            category_id = getattr(item, "category_id", None)
            if category_id is None and product is not None:
                category_id = product.category_id
            items.append(
                IncomingStockEntryOut(
                    movement_id=int(movement.id or 0),
                    item_id=int(item.id or 0),
                    name=item.name,
                    brand=item.brand,
                    product_id=product_id,
                    category_id=category_id,
                    expiry_date=item.expiry_date,
                    mrp=float(item.mrp or 0),
                    cost_price=float(getattr(item, "cost_price", 0) or 0),
                    stock=int(item.stock or 0),
                    rack_number=int(item.rack_number or 0),
                    is_archived=bool(getattr(item, "is_archived", False)),
                    created_at=item.created_at,
                    updated_at=item.updated_at,
                    incoming_at=effective_ts,
                    delta=int(movement.delta or 0),
                    reason=movement.reason,
                    ref_type=getattr(movement, "ref_type", None),
                    ref_id=getattr(movement, "ref_id", None),
                    note=getattr(movement, "note", None),
                )
            )

        next_offset = (offset + limit) if (offset + limit) < total else None
        return {"items": items, "total": total, "next_offset": next_offset}


@router.get("/group", response_model=ItemGroupOut)
def get_item_group(
    name: str = Query(..., description="Item name (exact match, case-insensitive)"),
    brand: Optional[str] = Query(None, description="Brand (case-insensitive); pass empty for None"),
):
    with get_session() as session:
        n, b, batches = _load_group_batches(session, name=name, brand=brand)
        _attach_lot_metadata(session, batches)
        expiry_dates = [str(batch.expiry_date) for batch in batches if getattr(batch, "expiry_date", None)]
        mrp_values = [float(batch.mrp or 0) for batch in batches]
        rack_numbers = sorted({int(batch.rack_number or 0) for batch in batches})

        return ItemGroupOut(
            key=_group_key(n, b),
            name=str(batches[0].name),
            brand=getattr(batches[0], "brand", None),
            total_stock=sum(int(batch.stock or 0) for batch in batches),
            total_batch_count=len(batches),
            active_batch_count=sum(1 for batch in batches if int(batch.stock or 0) > 0 and not bool(getattr(batch, "is_archived", False))),
            archived_batch_count=sum(1 for batch in batches if bool(getattr(batch, "is_archived", False))),
            earliest_expiry=min(expiry_dates) if expiry_dates else None,
            latest_expiry=max(expiry_dates) if expiry_dates else None,
            mrp_min=min(mrp_values) if mrp_values else None,
            mrp_max=max(mrp_values) if mrp_values else None,
            rack_numbers=rack_numbers,
            batches=[
                ItemGroupBatchOut(
                    id=int(batch.id),
                    name=str(batch.name),
                    brand=getattr(batch, "brand", None),
                    product_id=getattr(batch, "product_id", None),
                    expiry_date=getattr(batch, "expiry_date", None),
                    mrp=float(batch.mrp or 0),
                    stock=int(batch.stock or 0),
                    rack_number=int(batch.rack_number or 0),
                    created_at=getattr(batch, "created_at", None),
                    updated_at=getattr(batch, "updated_at", None),
                    is_archived=bool(getattr(batch, "is_archived", False)),
                    loose_sale_enabled=bool(getattr(batch, "loose_sale_enabled", False)),
                    is_loose_stock=bool(getattr(batch, "is_loose_stock", False)),
                    stock_unit_label=getattr(batch, "stock_unit_label", None),
                    parent_unit_name=getattr(batch, "parent_unit_name", None),
                    child_unit_name=getattr(batch, "child_unit_name", None),
                    conversion_qty=getattr(batch, "conversion_qty", None),
                )
                for batch in batches
            ],
        )


@router.get("/group/summary", response_model=StockLedgerSummaryOut)
def get_item_group_summary(
    name: str = Query(..., description="Item name (exact match, case-insensitive)"),
    brand: Optional[str] = Query(None, description="Brand (case-insensitive); pass empty for None"),
    item_id: Optional[int] = Query(None, description="Optional batch id inside this product group"),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)"),
):
    with get_session() as session:
        return _build_group_summary(
            session,
            name=name,
            brand=brand,
            item_id=item_id,
            from_date=from_date,
            to_date=to_date,
        )

@router.get("/ledger/group", response_model=StockLedgerGroupPageOut)
def group_ledger(
    name: str = Query(..., description="Item name (exact match, case-insensitive)"),
    brand: Optional[str] = Query(None, description="Brand (case-insensitive); pass empty for None"),
    item_id: Optional[int] = Query(None, description="Optional batch/item id inside this group"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)"),
    reason: Optional[str] = Query(None, description="Filter by reason"),
):
    with get_session() as session:
        n, b, batches = _load_group_batches(session, name=name, brand=brand)

        all_item_ids = [int(x.id) for x in batches]
        if item_id is not None and int(item_id) not in all_item_ids:
            raise HTTPException(status_code=404, detail="Batch does not belong to this product group")

        ledger_batches = [x for x in batches if item_id is None or int(x.id) == int(item_id)]
        _attach_lot_metadata(session, ledger_batches)
        item_ids = [int(x.id) for x in ledger_batches]
        items_by_id = {int(x.id): x for x in ledger_batches}

        current_stock = sum(int(x.stock or 0) for x in ledger_batches)
        key = _group_key(n, b)

        movement_ts = _stock_movement_effective_ts_expr()
        stmt = (
            select(StockMovement, movement_ts.label("effective_ts"))
            .select_from(StockMovement)
            .outerjoin(Purchase, _purchase_stock_movement_join_condition())
            .where(StockMovement.item_id.in_(item_ids))
        )

        if from_date:
            stmt = stmt.where(movement_ts >= f"{from_date}T00:00:00")
        if to_date:
            stmt = stmt.where(movement_ts <= f"{to_date}T23:59:59")

        if reason:
            stmt = stmt.where(func.lower(StockMovement.reason) == reason.strip().lower())

        stmt = stmt.order_by(movement_ts.desc(), StockMovement.id.desc()).limit(offset + limit + 1)
        rows = session.exec(stmt).all()

        has_more = len(rows) > offset + limit
        rows_to_balance = rows[:offset + limit]

        to_ts = f"{to_date}T23:59:59" if to_date else None
        running = int(current_stock) - _future_delta_after_effective_ts(session, item_ids, to_ts)
        out: List[StockMovementGroupOut] = []

        for index, row in enumerate(rows_to_balance):
            m = row[0]
            effective_ts = row[1] or m.ts
            after = running
            before = after - int(m.delta or 0)

            it = items_by_id.get(int(m.item_id))

            if index >= offset:
                out.append(
                    StockMovementGroupOut(
                        id=m.id,
                        ts=effective_ts,
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
                        is_loose_stock=bool(getattr(it, "is_loose_stock", False)) if it else False,
                        stock_unit_label=getattr(it, "stock_unit_label", None) if it else None,
                        parent_unit_name=getattr(it, "parent_unit_name", None) if it else None,
                        child_unit_name=getattr(it, "child_unit_name", None) if it else None,
                        conversion_qty=int(getattr(it, "conversion_qty", 0) or 0) if it else 0,
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


@router.get("/ledger/reconciliation", response_model=StockReconciliationReportOut)
def stock_ledger_reconciliation(
    q: Optional[str] = Query(None, description="Search by item name, brand, or exact item id"),
    item_ids: Optional[List[int]] = Query(None, description="Optional exact item ids to reconcile"),
    include_archived: bool = Query(True),
    include_balanced: bool = Query(False),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    with get_session() as session:
        all_rows = _build_stock_reconciliation(
            session,
            q=q,
            include_archived=include_archived,
            include_balanced=include_balanced,
            item_ids=item_ids,
        )
        total_rows = len(all_rows)
        page_rows = all_rows[offset: offset + limit]
        return StockReconciliationReportOut(
            total_rows=total_rows,
            mismatched_rows=sum(1 for row in all_rows if row.status != "BALANCED"),
            deterministic_rows=sum(
                1 for row in all_rows for entry in row.missing_entries if entry.safe_to_apply and entry.missing_delta != 0
            ),
            synthetic_rows=sum(1 for row in all_rows if row.suggested_recon_delta != 0),
            items=page_rows,
        )


@router.post("/ledger/reconciliation/apply", response_model=StockReconciliationApplyOut)
def apply_stock_ledger_reconciliation(payload: StockReconciliationApplyIn) -> StockReconciliationApplyOut:
    with get_session() as session:
        rows = _build_stock_reconciliation(
            session,
            q=payload.q,
            include_archived=bool(payload.include_archived),
            include_balanced=bool(payload.include_balanced),
            item_ids=payload.item_ids or None,
        )

        deterministic_rows_inserted = 0
        synthetic_rows_inserted = 0
        total_delta_applied = 0

        for row in rows:
            for entry in row.missing_entries:
                if not entry.safe_to_apply or entry.missing_delta == 0:
                    continue
                add_movement(
                    session,
                    item_id=row.item_id,
                    delta=int(entry.missing_delta),
                    reason=entry.reason,
                    ref_type=entry.ref_type,
                    ref_id=entry.ref_id,
                    note=f"Backfilled from source: {entry.note or entry.reason}",
                    actor="reconciliation",
                )
                deterministic_rows_inserted += 1
                total_delta_applied += int(entry.missing_delta)

            if payload.apply_synthetic and int(row.suggested_recon_delta or 0) != 0:
                add_movement(
                    session,
                    item_id=row.item_id,
                    delta=int(row.suggested_recon_delta),
                    reason="RECON_ADJUST",
                    ref_type="RECON",
                    ref_id=None,
                    note=(
                        "Reconciliation adjustment to align ledger with stock. "
                        f"Stock was {row.current_stock}, ledger was {row.projected_ledger_total} before repair."
                    ),
                    actor="reconciliation",
                )
                synthetic_rows_inserted += 1
                total_delta_applied += int(row.suggested_recon_delta)

        session.commit()
        return StockReconciliationApplyOut(
            applied_items=len(rows),
            deterministic_rows_inserted=deterministic_rows_inserted,
            synthetic_rows_inserted=synthetic_rows_inserted,
            total_delta_applied=total_delta_applied,
        )


@router.delete("/ledger/opening/{movement_id}", response_model=OpeningDeleteOut)
def delete_opening_stock_movement(
    movement_id: int,
    note: Optional[str] = Query(None, description="Optional audit note"),
) -> OpeningDeleteOut:
    require_min_role("MANAGER", context="Opening stock delete")
    with get_session() as session:
        movement = session.get(StockMovement, movement_id)
        if not movement:
            raise HTTPException(status_code=404, detail="Opening movement not found")

        reason_key = str(movement.reason or "").upper()
        ref_type_key = str(getattr(movement, "ref_type", "") or "").upper()
        opening_qty = int(movement.delta or 0)
        if reason_key != "OPENING" or ref_type_key != "ITEM_CREATE" or opening_qty <= 0:
            raise HTTPException(status_code=400, detail="Only positive Opening / ITEM_CREATE rows can be removed")

        item = session.get(Item, int(movement.item_id))
        if not item:
            raise HTTPException(status_code=404, detail="Inventory batch not found")

        other_movements = session.exec(
            select(StockMovement)
            .where(StockMovement.item_id == int(item.id))
            .where(StockMovement.id != int(movement.id))
            .order_by(StockMovement.ts.asc(), StockMovement.id.asc())
            .limit(3)
        ).all()
        if other_movements:
            examples = ", ".join(
                f"{row.reason}{f' #{row.ref_id}' if getattr(row, 'ref_id', None) else ''}"
                for row in other_movements
            )
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Cannot remove opening for batch #{item.id} because it has other stock movements"
                    f" ({examples}). Fix this with Stock Audit/Adjust Stock, or edit the related bills first."
                ),
            )

        current_stock = int(item.stock or 0)
        if current_stock != opening_qty:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Cannot remove opening for batch #{item.id} because current stock is {current_stock}, "
                    f"but opening quantity is {opening_qty}. Use Stock Audit/Adjust Stock instead."
                ),
            )

        item.stock = 0
        item.updated_at = now_ts()
        session.add(item)
        session.delete(movement)
        apply_archive_rules(session, item)
        lot = sync_lot_quantity_for_item(session, item, ts=item.updated_at)
        if lot:
            lot.is_active = False
            session.add(lot)
        log_audit(
            session,
            entity_type="ITEM",
            entity_id=int(item.id),
            action="OPENING_DELETE",
            note=note or f"Removed opening stock movement #{movement_id}",
            details={
                "movement_id": int(movement_id),
                "item_id": int(item.id),
                "item_name": item.name,
                "brand": item.brand,
                "expiry_date": item.expiry_date,
                "mrp": item.mrp,
                "removed_qty": opening_qty,
            },
        )
        session.commit()
        session.refresh(item)
        _attach_last_incoming(session, [item])
        _attach_lot_metadata(session, [item])
        return OpeningDeleteOut(item=item, deleted_movement_id=int(movement_id), removed_qty=opening_qty)


@router.delete("/ledger/adjust/{movement_id}", response_model=ManualAdjustmentDeleteOut)
def delete_manual_stock_adjustment(
    movement_id: int,
    note: Optional[str] = Query(None, description="Optional audit note"),
) -> ManualAdjustmentDeleteOut:
    require_min_role("MANAGER", context="Manual stock adjustment delete")
    with get_session() as session:
        movement = session.get(StockMovement, movement_id)
        if not movement:
            raise HTTPException(status_code=404, detail="Manual stock adjustment not found")

        reason_key = str(movement.reason or "").upper()
        ref_type_key = str(getattr(movement, "ref_type", "") or "").upper()
        adjust_delta = int(movement.delta or 0)
        if reason_key != "ADJUST" or ref_type_key != "MANUAL" or adjust_delta == 0:
            raise HTTPException(status_code=400, detail="Only manual stock adjust rows can be deleted")

        item = session.get(Item, int(movement.item_id))
        if not item:
            raise HTTPException(status_code=404, detail="Inventory batch not found")

        new_stock = int(item.stock or 0) - adjust_delta
        if new_stock < 0:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Deleting this adjustment would make batch #{item.id} stock negative "
                    f"({new_stock}). Add/correct stock first if this adjustment is still needed historically."
                ),
            )

        running_stock = 0
        replay_rows = session.exec(
            select(StockMovement)
            .where(StockMovement.item_id == int(item.id))
            .where(StockMovement.id != int(movement.id))
            .order_by(StockMovement.ts.asc(), StockMovement.id.asc())
        ).all()
        for row in replay_rows:
            running_stock += int(row.delta or 0)
            if running_stock < 0:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Deleting this adjustment would make batch #{item.id} ledger negative "
                        f"after {row.reason} #{row.ref_id or row.id}."
                    ),
                )

        item.stock = int(new_stock)
        item.updated_at = now_ts()
        session.add(item)
        session.delete(movement)
        apply_archive_rules(session, item)
        sync_lot_quantity_for_item(session, item, ts=item.updated_at)
        log_audit(
            session,
            entity_type="ITEM",
            entity_id=int(item.id),
            action="ADJUST_DELETE",
            note=note or f"Deleted manual stock adjustment #{movement_id}",
            details={
                "movement_id": int(movement_id),
                "item_id": int(item.id),
                "item_name": item.name,
                "brand": item.brand,
                "expiry_date": item.expiry_date,
                "mrp": item.mrp,
                "deleted_delta": int(adjust_delta),
                "new_stock": int(new_stock),
            },
        )
        session.commit()
        session.refresh(item)
        _attach_last_incoming(session, [item])
        _attach_lot_metadata(session, [item])
        return ManualAdjustmentDeleteOut(
            item=item,
            deleted_movement_id=int(movement_id),
            reversed_delta=int(-adjust_delta),
        )


def _club_name_key(value: Optional[str]) -> str:
    return _item_name_key(value)


def _round2(value: Any) -> float:
    return round(float(value or 0) + 1e-9, 2)


def _club_group_key(item: Item) -> Tuple[str, str]:
    return (_club_name_key(item.name), _brand_key(item.brand))


def _date_part(value: Optional[str]) -> str:
    return str(value or "")[:10]


def _historical_opening_ts(movements: List[StockMovement]) -> str:
    dated = sorted(str(row.ts or "") for row in movements if str(row.ts or ""))
    if not dated:
        return now_ts()
    date = _date_part(dated[0])
    return f"{date}T00:00:00" if date else dated[0]


def _active_purchase_refs_for_item(session, item_id: int) -> List[Tuple[PurchaseItem, Purchase]]:
    return session.exec(
        select(PurchaseItem, Purchase)
        .join(Purchase, Purchase.id == PurchaseItem.purchase_id)
        .where(
            PurchaseItem.inventory_item_id == int(item_id),
            Purchase.is_deleted == False,  # noqa: E712
        )
        .order_by(PurchaseItem.id.asc())
    ).all()


def _lot_for_item(session, item_id: int) -> Optional[InventoryLot]:
    return session.exec(
        select(InventoryLot)
        .where(InventoryLot.legacy_item_id == int(item_id))
        .order_by(InventoryLot.id.asc())
    ).first()


def _purchase_item_qty(purchase_item: PurchaseItem) -> int:
    return int(purchase_item.sealed_qty or 0) + int(purchase_item.free_qty or 0)


def _retarget_moved_item_ref(row: StockMovement, *, source_item_id: int, target_item_id: int) -> None:
    ref_type = str(row.ref_type or "").upper()
    if ref_type in {"ITEM", "ITEM_CREATE", "ITEM_MERGE", "ITEM_COPY"} and int(row.ref_id or 0) == int(source_item_id):
        row.ref_id = int(target_item_id)


def _move_or_merge_stock_audit_items(session, *, source_item_id: int, target_item_id: int, target_stock: int) -> None:
    for row in session.exec(select(StockAuditItem).where(StockAuditItem.item_id == int(source_item_id))).all():
        existing = session.exec(
            select(StockAuditItem).where(
                StockAuditItem.audit_id == int(row.audit_id),
                StockAuditItem.item_id == int(target_item_id),
            )
        ).first()
        if existing:
            existing.system_stock = int(target_stock)
            if existing.physical_stock is None and row.physical_stock is not None:
                existing.physical_stock = row.physical_stock
            elif existing.physical_stock is not None and row.physical_stock is not None:
                existing.physical_stock = int(existing.physical_stock or 0) + int(row.physical_stock or 0)
            session.add(existing)
            session.delete(row)
        else:
            row.item_id = int(target_item_id)
            row.system_stock = int(target_stock)
            session.add(row)


@router.post("/ledger/club-opening", response_model=OpeningClubOut)
def club_purchase_batch_to_opening(payload: OpeningClubIn) -> OpeningClubOut:
    require_min_role("MANAGER", context="Club purchase batch")
    if int(payload.source_item_id) == int(payload.target_item_id):
        raise HTTPException(status_code=400, detail="Choose a different OP batch to keep")

    with get_session() as session:
        source = session.get(Item, int(payload.source_item_id))
        target = session.get(Item, int(payload.target_item_id))
        if not source or not target:
            raise HTTPException(status_code=404, detail="Source or target batch not found")
        if _club_group_key(source) != _club_group_key(target):
            raise HTTPException(status_code=400, detail="Source and OP batch must be the same product and brand")

        source_active_purchase_refs = _active_purchase_refs_for_item(session, int(source.id))
        target_active_purchase_refs = _active_purchase_refs_for_item(session, int(target.id))
        if len(source_active_purchase_refs) == 1 and len(target_active_purchase_refs) == 1:
            source_purchase_item, source_purchase = source_active_purchase_refs[0]
            target_purchase_item, target_purchase = target_active_purchase_refs[0]
            source_stock_source = str(source_purchase_item.stock_source or "").upper()
            target_stock_source = str(target_purchase_item.stock_source or "").upper()
            if source_stock_source == "ATTACHED" and target_stock_source == "CREATED":
                if source.product_id and target.product_id and int(source.product_id) != int(target.product_id):
                    raise HTTPException(status_code=400, detail="Source and kept batch product links do not match")
                if source.expiry_date != target.expiry_date:
                    raise HTTPException(status_code=400, detail="Source and kept batch expiry must match")
                if abs(float(source.mrp or 0) - float(target.mrp or 0)) > 0.001:
                    raise HTTPException(status_code=400, detail="Source and kept batch MRP must match")

                source_attached_qty = _purchase_item_qty(source_purchase_item)
                target_purchase_qty = _purchase_item_qty(target_purchase_item)
                if source_attached_qty <= 0 or target_purchase_qty <= 0:
                    raise HTTPException(status_code=400, detail="Purchase line quantities must be positive")

                source_lot = _lot_for_item(session, int(source.id))
                target_lot = _lot_for_item(session, int(target.id))
                if not target_lot:
                    target_product = session.get(Product, int(target_purchase_item.product_id)) if target_purchase_item.product_id else None
                    target_lot = ensure_lot_for_inventory_item(
                        session,
                        inventory_item=target,
                        product=target_product,
                        ts=now_ts(),
                    )
                if not target_lot:
                    raise HTTPException(status_code=400, detail="Could not prepare kept batch lot")

                lot_ids = [
                    int(row.id)
                    for row in (source_lot, target_lot)
                    if row is not None and getattr(row, "id", None) is not None
                ]
                pack_filters = [
                    PackOpenEvent.source_item_id.in_([int(source.id), int(target.id)]),
                    PackOpenEvent.loose_item_id.in_([int(source.id), int(target.id)]),
                ]
                if lot_ids:
                    pack_filters.extend(
                        [
                            PackOpenEvent.source_lot_id.in_(lot_ids),
                            PackOpenEvent.loose_lot_id.in_(lot_ids),
                        ]
                    )
                pack_open_refs = session.exec(select(func.count(PackOpenEvent.id)).where(or_(*pack_filters))).first()
                child_lot_refs = (
                    session.exec(select(func.count(InventoryLot.id)).where(InventoryLot.opened_from_lot_id.in_(lot_ids))).first()
                    if lot_ids
                    else 0
                )
                if int(pack_open_refs or 0) > 0 or int(child_lot_refs or 0) > 0:
                    raise HTTPException(status_code=400, detail="Loose/pack-open batches must be handled manually")

                source_movements = session.exec(
                    select(StockMovement)
                    .where(StockMovement.item_id == int(source.id))
                    .order_by(StockMovement.ts.asc(), StockMovement.id.asc())
                ).all()
                target_movements = session.exec(
                    select(StockMovement)
                    .where(StockMovement.item_id == int(target.id))
                    .order_by(StockMovement.ts.asc(), StockMovement.id.asc())
                ).all()

                target_purchase_movements = [
                    row
                    for row in target_movements
                    if str(row.reason or "").upper() == "PURCHASE"
                    and str(row.ref_type or "").upper() == "PURCHASE"
                    and int(row.ref_id or 0) == int(target_purchase.id)
                    and int(row.delta or 0) == target_purchase_qty
                ]
                if len(target_purchase_movements) != 1:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Kept batch #{target.id} must have exactly one purchase stock entry "
                            f"for qty {target_purchase_qty}; found {len(target_purchase_movements)}"
                        ),
                    )

                target_invoice_date = _date_part(target_purchase.invoice_date)
                duplicate_openings = [
                    row
                    for row in source_movements
                    if str(row.reason or "").upper() in {"OPENING", "INVENTORY_ADD"}
                    and str(row.ref_type or "").upper() in {"ITEM", "ITEM_CREATE", "ITEM_MERGE", "ITEM_COPY", "MANUAL"}
                    and int(row.delta or 0) == target_purchase_qty
                    and (not target_invoice_date or _date_part(row.ts) >= target_invoice_date)
                ]
                if len(duplicate_openings) != 1:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Source batch #{source.id} must have exactly one duplicate OP placeholder "
                            f"for kept purchase qty {target_purchase_qty} on/after {target_invoice_date or '-'}; "
                            f"found {len(duplicate_openings)}"
                        ),
                    )

                source_invoice_date = _date_part(source_purchase.invoice_date)
                attached_purchase_openings = [
                    row
                    for row in source_movements
                    if int(row.id or 0) != int(duplicate_openings[0].id or 0)
                    and str(row.reason or "").upper() in {"OPENING", "INVENTORY_ADD"}
                    and str(row.ref_type or "").upper() in {"ITEM", "ITEM_CREATE", "ITEM_MERGE", "ITEM_COPY", "MANUAL"}
                    and int(row.delta or 0) == source_attached_qty
                    and (not source_invoice_date or _date_part(row.ts) >= source_invoice_date)
                ]
                if len(attached_purchase_openings) > 1:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Attached purchase #{source_purchase.id} has multiple matching OP placeholders "
                            f"of qty {source_attached_qty}; found {len(attached_purchase_openings)}"
                        ),
                    )
                attached_purchase_opening_id = int(attached_purchase_openings[0].id or 0) if attached_purchase_openings else None

                source_purchase_link_movements = [
                    row
                    for row in source_movements
                    if str(row.reason or "").upper() == "PURCHASE_LINK"
                    and str(row.ref_type or "").upper() == "PURCHASE"
                    and int(row.ref_id or 0) == int(source_purchase.id)
                    and int(row.delta or 0) == 0
                ]

                movable_reasons = {
                    "OPENING",
                    "INVENTORY_ADD",
                    "SALE",
                    "BILL_DELETE",
                    "BILL_EDIT",
                    "BILL_RECOVER",
                    "RETURN",
                    "EXCHANGE_IN",
                    "EXCHANGE_OUT",
                    "ADJUST",
                    "RECON_ADJUST",
                    "PURCHASE_LINK",
                }
                duplicate_opening_id = int(duplicate_openings[0].id or 0)
                purchase_link_ids = {int(row.id or 0) for row in source_purchase_link_movements}
                movable_source_movements = [
                    row
                    for row in source_movements
                    if int(row.id or 0) != duplicate_opening_id
                    and int(row.id or 0) not in purchase_link_ids
                ]
                blocked_movements = [
                    row for row in movable_source_movements if str(row.reason or "").upper() not in movable_reasons
                ]
                if blocked_movements:
                    examples = ", ".join(
                        f"{row.reason}{f' #{row.ref_id}' if getattr(row, 'ref_id', None) else ''}"
                        for row in blocked_movements[:3]
                    )
                    raise HTTPException(status_code=400, detail=f"Source batch has unsupported movement(s): {examples}")

                target_stock_after = int(target.stock or 0) + int(source.stock or 0) - int(duplicate_openings[0].delta or 0)
                if target_stock_after < 0:
                    raise HTTPException(status_code=400, detail="Club would make kept batch stock negative")

                backup_path = create_data_repair_backup("before_manual_attached_op_into_purchase_club")
                ts = now_ts()
                session.delete(duplicate_openings[0])
                deleted_purchase_link_ids: List[int] = []
                for row in source_purchase_link_movements:
                    deleted_purchase_link_ids.append(int(row.id or 0))
                    session.delete(row)

                moved_movement_ids: List[int] = []
                converted_opening_id: Optional[int] = None
                for row in movable_source_movements:
                    if int(row.id or 0) == attached_purchase_opening_id:
                        row.reason = "PURCHASE"
                        row.ref_type = "PURCHASE"
                        row.ref_id = int(source_purchase.id)
                        row.note = f"Purchase {source_purchase.invoice_number or source_purchase.id}"
                        row.actor = "SYSTEM"
                        converted_opening_id = int(row.id or 0)
                    row.item_id = int(target.id)
                    _retarget_moved_item_ref(row, source_item_id=int(source.id), target_item_id=int(target.id))
                    session.add(row)
                    moved_movement_ids.append(int(row.id or 0))

                source_purchase_item.inventory_item_id = int(target.id)
                source_purchase_item.lot_id = int(target_lot.id) if target_lot.id is not None else None
                if converted_opening_id is not None:
                    source_purchase_item.stock_source = "CREATED"
                session.add(source_purchase_item)

                for row in session.exec(select(BillItem).where(BillItem.item_id == int(source.id))).all():
                    row.item_id = int(target.id)
                    session.add(row)
                allocation_filter = BillItemAllocation.item_id == int(source.id)
                if source_lot and source_lot.id is not None:
                    allocation_filter = or_(allocation_filter, BillItemAllocation.lot_id == int(source_lot.id))
                for row in session.exec(select(BillItemAllocation).where(allocation_filter)).all():
                    row.item_id = int(target.id)
                    row.lot_id = int(target_lot.id) if target_lot.id is not None else None
                    session.add(row)
                for row in session.exec(select(ReturnItem).where(ReturnItem.item_id == int(source.id))).all():
                    row.item_id = int(target.id)
                    session.add(row)

                target.stock = int(target_stock_after)
                target.is_archived = bool(target_stock_after <= 0)
                target.updated_at = ts
                target.cost_price = float(target_purchase_item.effective_cost_price or target_purchase_item.cost_price or target.cost_price or 0)
                session.add(target)
                source.stock = 0
                source.is_archived = True
                source.updated_at = ts
                session.add(source)
                _move_or_merge_stock_audit_items(
                    session,
                    source_item_id=int(source.id),
                    target_item_id=int(target.id),
                    target_stock=int(target_stock_after),
                )
                session.flush()

                remaining_allocation_filter = BillItemAllocation.item_id == int(source.id)
                if source_lot and source_lot.id is not None:
                    remaining_allocation_filter = or_(remaining_allocation_filter, BillItemAllocation.lot_id == int(source_lot.id))
                remaining_purchase_filter = PurchaseItem.inventory_item_id == int(source.id)
                if source_lot and source_lot.id is not None:
                    remaining_purchase_filter = or_(remaining_purchase_filter, PurchaseItem.lot_id == int(source_lot.id))
                remaining_refs = {
                    "purchase_items": int(session.exec(select(func.count(PurchaseItem.id)).where(remaining_purchase_filter)).first() or 0),
                    "stock_movements": int(session.exec(select(func.count(StockMovement.id)).where(StockMovement.item_id == int(source.id))).first() or 0),
                    "bill_items": int(session.exec(select(func.count(BillItem.id)).where(BillItem.item_id == int(source.id))).first() or 0),
                    "bill_allocations": int(session.exec(select(func.count(BillItemAllocation.id)).where(remaining_allocation_filter)).first() or 0),
                    "return_items": int(session.exec(select(func.count(ReturnItem.id)).where(ReturnItem.item_id == int(source.id))).first() or 0),
                    "stock_audit_items": int(session.exec(select(func.count(StockAuditItem.id)).where(StockAuditItem.item_id == int(source.id))).first() or 0),
                    "pack_open_events": int(session.exec(select(func.count(PackOpenEvent.id)).where(or_(*pack_filters))).first() or 0),
                    "child_lots": int(
                        session.exec(select(func.count(InventoryLot.id)).where(InventoryLot.opened_from_lot_id.in_(lot_ids))).first() or 0
                    )
                    if lot_ids
                    else 0,
                }
                uncleared_refs = {key: value for key, value in remaining_refs.items() if value}
                if uncleared_refs:
                    raise HTTPException(status_code=400, detail=f"Source batch still has references after club validation: {uncleared_refs}")

                sync_lot_quantity_for_item(session, target, ts=ts)
                if source_lot:
                    source_lot.sealed_qty = 0
                    source_lot.loose_qty = 0
                    source_lot.is_active = False
                    source_lot.updated_at = ts
                    session.add(source_lot)
                sync_lot_quantity_for_item(session, source, ts=ts)
                apply_archive_rules(session, target)
                apply_archive_rules(session, source)

                target_stock_check = session.exec(
                    select(func.coalesce(func.sum(StockMovement.delta), 0)).where(StockMovement.item_id == int(target.id))
                ).first()
                if int(target_stock_check or 0) != int(target_stock_after):
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Clubbed kept batch ledger would be {int(target_stock_check or 0)}, "
                            f"expected {int(target_stock_after)}"
                        ),
                    )

                log_audit(
                    session,
                    entity_type="ITEM",
                    entity_id=int(target.id),
                    action="OPENING_CLUB",
                    note=payload.note
                    or f"Clubbed attached OP batch #{source.id} into purchase batch #{target.id}",
                    details={
                        "direction": "ATTACHED_OPENING_TO_PURCHASE",
                        "source_item_id": int(source.id),
                        "target_item_id": int(target.id),
                        "source_purchase_id": int(source_purchase.id),
                        "source_purchase_item_id": int(source_purchase_item.id),
                        "target_purchase_id": int(target_purchase.id),
                        "target_purchase_item_id": int(target_purchase_item.id),
                        "deleted_duplicate_opening_movement_id": duplicate_opening_id,
                        "converted_attached_opening_movement_id": converted_opening_id,
                        "deleted_purchase_link_movement_ids": deleted_purchase_link_ids,
                        "moved_movement_ids": moved_movement_ids,
                        "remaining_source_refs": remaining_refs,
                        "target_stock": int(target_stock_after),
                        "backup": backup_path,
                    },
                )
                session.commit()
                session.refresh(source)
                session.refresh(target)
                _attach_last_incoming(session, [source, target])
                _attach_lot_metadata(session, [source, target])
                return OpeningClubOut(
                    source_item=source,
                    target_item=target,
                    purchase_id=int(target_purchase.id),
                    purchase_item_id=int(target_purchase_item.id),
                    source_item_id=int(source.id),
                    target_item_id=int(target.id),
                    target_stock=int(target_stock_after),
                    archived_source_id=int(source.id),
                    moved_movement_count=len(moved_movement_ids),
                    backup_path=backup_path,
                )

        if len(source_active_purchase_refs) == 1 and len(target_active_purchase_refs) == 1:
            source_purchase_item, source_purchase = source_active_purchase_refs[0]
            target_purchase_item, target_purchase = target_active_purchase_refs[0]
            if int(source_purchase_item.id or 0) == int(target_purchase_item.id or 0):
                raise HTTPException(status_code=400, detail="Source and target are linked to the same purchase line")
            if str(source_purchase_item.stock_source or "").upper() != "CREATED":
                raise HTTPException(status_code=400, detail="Source purchase batch must be purchase-created")
            if str(target_purchase_item.stock_source or "").upper() != "CREATED":
                raise HTTPException(status_code=400, detail="Target purchase batch must be purchase-created")

            target_purchase_qty = _purchase_item_qty(target_purchase_item)
            if target_purchase_qty <= 0:
                raise HTTPException(status_code=400, detail="Target purchase line quantity must be positive")

            source_lot = _lot_for_item(session, int(source.id))
            target_lot = _lot_for_item(session, int(target.id))
            if not target_lot:
                target_product = session.get(Product, int(target_purchase_item.product_id)) if target_purchase_item.product_id else None
                target_lot = ensure_lot_for_inventory_item(
                    session,
                    inventory_item=target,
                    product=target_product,
                    ts=now_ts(),
                )
            if not target_lot:
                raise HTTPException(status_code=400, detail="Could not prepare target lot")

            lot_ids = [
                int(row.id)
                for row in (source_lot, target_lot)
                if row is not None and getattr(row, "id", None) is not None
            ]
            pack_filters = [
                PackOpenEvent.source_item_id.in_([int(source.id), int(target.id)]),
                PackOpenEvent.loose_item_id.in_([int(source.id), int(target.id)]),
            ]
            if lot_ids:
                pack_filters.extend(
                    [
                        PackOpenEvent.source_lot_id.in_(lot_ids),
                        PackOpenEvent.loose_lot_id.in_(lot_ids),
                    ]
                )
            pack_open_refs = session.exec(select(func.count(PackOpenEvent.id)).where(or_(*pack_filters))).first()
            child_lot_refs = (
                session.exec(
                    select(func.count(InventoryLot.id)).where(InventoryLot.opened_from_lot_id.in_(lot_ids))
                ).first()
                if lot_ids
                else 0
            )
            if int(pack_open_refs or 0) > 0 or int(child_lot_refs or 0) > 0:
                raise HTTPException(status_code=400, detail="Loose/pack-open batches must be handled manually")

            source_movements = session.exec(
                select(StockMovement)
                .where(StockMovement.item_id == int(source.id))
                .order_by(StockMovement.ts.asc(), StockMovement.id.asc())
            ).all()
            target_movements = session.exec(
                select(StockMovement)
                .where(StockMovement.item_id == int(target.id))
                .order_by(StockMovement.ts.asc(), StockMovement.id.asc())
            ).all()
            target_purchase_movements = [
                row
                for row in target_movements
                if str(row.reason or "").upper() == "PURCHASE"
                and str(row.ref_type or "").upper() == "PURCHASE"
                and int(row.ref_id or 0) == int(target_purchase.id)
                and int(row.delta or 0) == target_purchase_qty
            ]
            if len(target_purchase_movements) != 1:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Target batch #{target.id} must have exactly one purchase stock entry "
                        f"for qty {target_purchase_qty}; found {len(target_purchase_movements)}"
                    ),
                )

            target_invoice_date = _date_part(target_purchase.invoice_date)
            replacement_openings = [
                row
                for row in source_movements
                if str(row.reason or "").upper() in {"OPENING", "INVENTORY_ADD"}
                and str(row.ref_type or "").upper() in {"ITEM", "ITEM_CREATE", "ITEM_MERGE", "ITEM_COPY", "MANUAL"}
                and int(row.delta or 0) == target_purchase_qty
                and (not target_invoice_date or _date_part(row.ts) >= target_invoice_date)
            ]
            if len(replacement_openings) != 1:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Source purchase batch #{source.id} must have exactly one OP placeholder of qty "
                        f"{target_purchase_qty} on/after target purchase date {target_invoice_date or '-'}; "
                        f"found {len(replacement_openings)}"
                    ),
                )

            replacement_opening = replacement_openings[0]
            movable_reasons = {
                "SALE",
                "BILL_DELETE",
                "BILL_EDIT",
                "BILL_RECOVER",
                "RETURN",
                "EXCHANGE_IN",
                "EXCHANGE_OUT",
                "ADJUST",
                "RECON_ADJUST",
            }
            replacement_key = (str(replacement_opening.ts or ""), int(replacement_opening.id or 0))
            source_purchase_movements = [
                row
                for row in source_movements
                if str(row.reason or "").upper() == "PURCHASE"
                and str(row.ref_type or "").upper() == "PURCHASE"
                and int(row.ref_id or 0) == int(source_purchase.id)
                and int(row.delta or 0) == _purchase_item_qty(source_purchase_item)
            ]
            stop_before_key: Optional[Tuple[str, int]] = None
            if len(source_purchase_movements) == 1:
                source_purchase_key = (
                    str(source_purchase_movements[0].ts or ""),
                    int(source_purchase_movements[0].id or 0),
                )
                if replacement_key < source_purchase_key:
                    stop_before_key = source_purchase_key
            movable_source_movements = [
                row
                for row in source_movements
                if (str(row.ts or ""), int(row.id or 0)) > replacement_key
                and int(row.id or 0) != int(replacement_opening.id or 0)
                and (stop_before_key is None or (str(row.ts or ""), int(row.id or 0)) < stop_before_key)
            ]
            blocked_movements = [
                row for row in movable_source_movements if str(row.reason or "").upper() not in movable_reasons
            ]
            if blocked_movements:
                examples = ", ".join(
                    f"{row.reason}{f' #{row.ref_id}' if getattr(row, 'ref_id', None) else ''}"
                    for row in blocked_movements[:3]
                )
                raise HTTPException(
                    status_code=400,
                    detail=f"Source batch has unsupported movement(s) after the OP placeholder: {examples}",
                )

            moved_delta = sum(int(row.delta or 0) for row in movable_source_movements)
            source_stock_after = (
                sum(int(row.delta or 0) for row in source_movements)
                - int(replacement_opening.delta or 0)
                - moved_delta
            )
            target_stock_after = sum(int(row.delta or 0) for row in target_movements) + moved_delta
            if source_stock_after < 0 or target_stock_after < 0:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Placeholder move would make stock negative "
                        f"(source {source_stock_after}, target {target_stock_after})"
                    ),
                )

            backup_path = create_data_repair_backup("before_manual_purchase_placeholder_move")
            deleted_source_opening_movement_id = int(replacement_opening.id or 0)
            session.delete(replacement_opening)

            bill_targets: Dict[int, int] = {}
            return_targets: Dict[int, int] = {}
            for row in movable_source_movements:
                row.item_id = int(target.id)
                _retarget_moved_item_ref(row, source_item_id=int(source.id), target_item_id=int(target.id))
                if str(row.ref_type or "").upper() == "BILL" and row.ref_id is not None:
                    bill_targets[int(row.ref_id)] = int(target.id)
                if str(row.ref_type or "").upper() == "RETURN" and row.ref_id is not None:
                    return_targets[int(row.ref_id)] = int(target.id)
                session.add(row)

            for bill_id, item_id in bill_targets.items():
                for row in session.exec(
                    select(BillItem).where(BillItem.item_id == int(source.id), BillItem.bill_id == int(bill_id))
                ).all():
                    row.item_id = int(item_id)
                    session.add(row)
                allocation_filter = and_(BillItemAllocation.item_id == int(source.id), BillItemAllocation.bill_id == int(bill_id))
                if source_lot and source_lot.id is not None:
                    allocation_filter = or_(
                        allocation_filter,
                        and_(BillItemAllocation.lot_id == int(source_lot.id), BillItemAllocation.bill_id == int(bill_id)),
                    )
                for row in session.exec(select(BillItemAllocation).where(allocation_filter)).all():
                    row.item_id = int(item_id)
                    row.lot_id = int(target_lot.id) if target_lot.id is not None else None
                    session.add(row)

            for return_id, item_id in return_targets.items():
                for row in session.exec(
                    select(ReturnItem).where(ReturnItem.item_id == int(source.id), ReturnItem.return_id == int(return_id))
                ).all():
                    row.item_id = int(item_id)
                    session.add(row)

            target.stock = int(target_stock_after)
            target.is_archived = bool(target_stock_after <= 0)
            target.updated_at = now_ts()
            target.cost_price = float(target_purchase_item.effective_cost_price or target_purchase_item.cost_price or target.cost_price or 0)
            session.add(target)
            source.stock = int(source_stock_after)
            source.is_archived = bool(source_stock_after <= 0)
            source.updated_at = target.updated_at
            session.add(source)
            session.flush()

            sync_lot_quantity_for_item(session, target, ts=target.updated_at)
            sync_lot_quantity_for_item(session, source, ts=source.updated_at)
            apply_archive_rules(session, target)
            apply_archive_rules(session, source)

            log_audit(
                session,
                entity_type="ITEM",
                entity_id=int(target.id),
                action="OPENING_CLUB",
                note=payload.note
                or f"Moved duplicate OP placeholder from purchase batch #{source.id} to purchase batch #{target.id}",
                details={
                    "direction": "PURCHASE_PLACEHOLDER_TO_PURCHASE",
                    "source_item_id": int(source.id),
                    "target_item_id": int(target.id),
                    "source_purchase_id": int(source_purchase.id),
                    "source_purchase_item_id": int(source_purchase_item.id),
                    "target_purchase_id": int(target_purchase.id),
                    "target_purchase_item_id": int(target_purchase_item.id),
                    "deleted_source_opening_movement_id": deleted_source_opening_movement_id,
                    "moved_movement_ids": [int(row.id) for row in movable_source_movements if row.id is not None],
                    "source_stock": int(source_stock_after),
                    "target_stock": int(target_stock_after),
                    "backup": backup_path,
                },
            )
            session.commit()
            session.refresh(source)
            session.refresh(target)
            _attach_last_incoming(session, [source, target])
            _attach_lot_metadata(session, [source, target])
            return OpeningClubOut(
                source_item=source,
                target_item=target,
                purchase_id=int(target_purchase.id),
                purchase_item_id=int(target_purchase_item.id),
                source_item_id=int(source.id),
                target_item_id=int(target.id),
                target_stock=int(target_stock_after),
                archived_source_id=int(source.id) if source.is_archived else 0,
                moved_movement_count=len(movable_source_movements),
                backup_path=backup_path,
            )

        if len(source_active_purchase_refs) == 0 and len(target_active_purchase_refs) == 1:
            purchase_item, purchase = target_active_purchase_refs[0]
            if str(purchase_item.stock_source or "").upper() != "CREATED":
                raise HTTPException(
                    status_code=400,
                    detail="Only purchase-created kept batches can receive an OP batch",
                )

            purchase_qty = _purchase_item_qty(purchase_item)
            if purchase_qty <= 0:
                raise HTTPException(status_code=400, detail="Purchase line quantity must be positive")

            if source.product_id and purchase_item.product_id and int(source.product_id) != int(purchase_item.product_id):
                raise HTTPException(status_code=400, detail="OP batch product link does not match the purchase line")
            if target.product_id and purchase_item.product_id and int(target.product_id) != int(purchase_item.product_id):
                raise HTTPException(status_code=400, detail="Purchase batch product link does not match the purchase line")

            source_lot = _lot_for_item(session, int(source.id))
            target_lot = _lot_for_item(session, int(target.id))
            source_product = session.get(Product, int(purchase_item.product_id)) if purchase_item.product_id else None
            if not source_product:
                raise HTTPException(status_code=400, detail="Purchase product link is missing")
            if not source.product_id:
                source.product_id = int(purchase_item.product_id)
            if not target.product_id:
                target.product_id = int(purchase_item.product_id)
            if not target_lot:
                target_lot = ensure_lot_for_inventory_item(
                    session,
                    inventory_item=target,
                    product=source_product,
                    ts=now_ts(),
                )
            if not target_lot:
                raise HTTPException(status_code=400, detail="Could not prepare inventory lot for kept purchase batch")

            source_purchase_ref_filter = PurchaseItem.inventory_item_id == int(source.id)
            if source_lot and source_lot.id is not None:
                source_purchase_ref_filter = or_(source_purchase_ref_filter, PurchaseItem.lot_id == int(source_lot.id))
            source_purchase_ref_count = session.exec(
                select(func.count(PurchaseItem.id)).where(source_purchase_ref_filter)
            ).first()
            if int(source_purchase_ref_count or 0) > 0:
                raise HTTPException(status_code=400, detail="Source OP batch is already referenced by a purchase line")

            target_other_purchase_ref_filter = and_(
                PurchaseItem.id != int(purchase_item.id),
                PurchaseItem.inventory_item_id == int(target.id),
            )
            if target_lot and target_lot.id is not None:
                target_other_purchase_ref_filter = or_(
                    target_other_purchase_ref_filter,
                    and_(PurchaseItem.id != int(purchase_item.id), PurchaseItem.lot_id == int(target_lot.id)),
                )
            target_other_purchase_refs = session.exec(
                select(func.count(PurchaseItem.id)).where(target_other_purchase_ref_filter)
            ).first()
            if int(target_other_purchase_refs or 0) > 0:
                raise HTTPException(status_code=400, detail="Kept purchase batch is referenced by another purchase line")

            source_movements = session.exec(
                select(StockMovement)
                .where(StockMovement.item_id == int(source.id))
                .order_by(StockMovement.ts.asc(), StockMovement.id.asc())
            ).all()
            invoice_date = _date_part(purchase.invoice_date)
            if not source_movements and int(source.stock or 0) == 0:
                target_movements_for_cleanup = session.exec(
                    select(StockMovement)
                    .where(StockMovement.item_id == int(target.id))
                    .order_by(StockMovement.ts.asc(), StockMovement.id.asc())
                ).all()
                target_purchase_movements_for_cleanup = [
                    row
                    for row in target_movements_for_cleanup
                    if str(row.reason or "").upper() == "PURCHASE"
                    and str(row.ref_type or "").upper() == "PURCHASE"
                    and int(row.ref_id or 0) == int(purchase.id)
                    and int(row.delta or 0) == purchase_qty
                ]
                if len(target_purchase_movements_for_cleanup) != 1:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Kept batch #{target.id} must have exactly one purchase stock entry "
                            f"for qty {purchase_qty}; found {len(target_purchase_movements_for_cleanup)}"
                        ),
                    )
                target_replacement_openings = [
                    row
                    for row in target_movements_for_cleanup
                    if str(row.reason or "").upper() in {"OPENING", "INVENTORY_ADD"}
                    and str(row.ref_type or "").upper() in {"ITEM", "ITEM_CREATE", "ITEM_MERGE", "ITEM_COPY", "MANUAL"}
                    and int(row.delta or 0) == purchase_qty
                    and (not invoice_date or _date_part(row.ts) >= invoice_date)
                ]
                if len(target_replacement_openings) != 1:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Source batch #{source.id} is already empty, but kept batch #{target.id} does not have "
                            f"exactly one replaceable OP placeholder of qty {purchase_qty} on/after {invoice_date or '-'}; "
                            f"found {len(target_replacement_openings)}"
                        ),
                    )

                lot_ids = [
                    int(row.id)
                    for row in (source_lot, target_lot)
                    if row is not None and getattr(row, "id", None) is not None
                ]
                remaining_allocation_filter = BillItemAllocation.item_id == int(source.id)
                if source_lot and source_lot.id is not None:
                    remaining_allocation_filter = or_(remaining_allocation_filter, BillItemAllocation.lot_id == int(source_lot.id))
                remaining_purchase_filter = PurchaseItem.inventory_item_id == int(source.id)
                if source_lot and source_lot.id is not None:
                    remaining_purchase_filter = or_(remaining_purchase_filter, PurchaseItem.lot_id == int(source_lot.id))
                pack_open_filters = [
                    PackOpenEvent.source_item_id == int(source.id),
                    PackOpenEvent.loose_item_id == int(source.id),
                ]
                if source_lot and source_lot.id is not None:
                    pack_open_filters.extend(
                        [
                            PackOpenEvent.source_lot_id == int(source_lot.id),
                            PackOpenEvent.loose_lot_id == int(source_lot.id),
                        ]
                    )
                remaining_refs = {
                    "purchase_items": int(session.exec(select(func.count(PurchaseItem.id)).where(remaining_purchase_filter)).first() or 0),
                    "stock_movements": 0,
                    "bill_items": int(session.exec(select(func.count(BillItem.id)).where(BillItem.item_id == int(source.id))).first() or 0),
                    "bill_allocations": int(session.exec(select(func.count(BillItemAllocation.id)).where(remaining_allocation_filter)).first() or 0),
                    "return_items": int(session.exec(select(func.count(ReturnItem.id)).where(ReturnItem.item_id == int(source.id))).first() or 0),
                    "stock_audit_items": int(session.exec(select(func.count(StockAuditItem.id)).where(StockAuditItem.item_id == int(source.id))).first() or 0),
                    "pack_open_events": int(session.exec(select(func.count(PackOpenEvent.id)).where(or_(*pack_open_filters))).first() or 0),
                    "child_lots": int(
                        session.exec(select(func.count(InventoryLot.id)).where(InventoryLot.opened_from_lot_id.in_(lot_ids))).first() or 0
                    )
                    if lot_ids
                    else 0,
                }
                uncleared_refs = {key: value for key, value in remaining_refs.items() if value}
                if uncleared_refs:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Source batch still has references before OP cleanup: {uncleared_refs}",
                    )

                target_placeholder = target_replacement_openings[0]
                target_stock_after = sum(int(row.delta or 0) for row in target_movements_for_cleanup) - int(target_placeholder.delta or 0)
                if target_stock_after < 0:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Removing the replaced OP entry would make kept batch #{target.id} negative",
                    )

                backup_path = create_data_repair_backup("before_manual_op_placeholder_cleanup")
                deleted_target_opening_movement_id = int(target_placeholder.id or 0)
                session.delete(target_placeholder)
                retargeted_item_ref_ids: List[int] = []
                for row in target_movements_for_cleanup:
                    if int(row.id or 0) == deleted_target_opening_movement_id:
                        continue
                    before_ref_id = int(row.ref_id or 0) if row.ref_id is not None else None
                    _retarget_moved_item_ref(row, source_item_id=int(source.id), target_item_id=int(target.id))
                    if before_ref_id is not None and int(row.ref_id or 0) != before_ref_id:
                        retargeted_item_ref_ids.append(int(row.id or 0))
                    session.add(row)

                target.stock = int(target_stock_after)
                target.is_archived = bool(target_stock_after <= 0)
                target.updated_at = now_ts()
                target.cost_price = float(purchase_item.effective_cost_price or purchase_item.cost_price or target.cost_price or 0)
                session.add(target)
                source.stock = 0
                source.is_archived = True
                source.updated_at = target.updated_at
                session.add(source)
                session.flush()
                sync_lot_quantity_for_item(session, target, ts=target.updated_at)
                if source_lot:
                    source_lot.sealed_qty = 0
                    source_lot.loose_qty = 0
                    source_lot.is_active = False
                    source_lot.updated_at = target.updated_at
                    session.add(source_lot)
                sync_lot_quantity_for_item(session, source, ts=source.updated_at)
                apply_archive_rules(session, target)
                log_audit(
                    session,
                    entity_type="ITEM",
                    entity_id=int(target.id),
                    action="OPENING_CLUB",
                    note=payload.note
                    or f"Cleaned replaced OP placeholder on purchase batch #{target.id}",
                    details={
                        "direction": "OPENING_TO_PURCHASE_CLEANUP",
                        "source_item_id": int(source.id),
                        "target_item_id": int(target.id),
                        "purchase_id": int(purchase.id),
                        "purchase_item_id": int(purchase_item.id),
                        "purchase_qty": int(purchase_qty),
                        "deleted_target_opening_movement_id": deleted_target_opening_movement_id,
                        "retargeted_item_ref_ids": retargeted_item_ref_ids,
                        "remaining_source_refs": remaining_refs,
                        "target_stock": int(target_stock_after),
                        "backup": backup_path,
                    },
                )
                session.commit()
                session.refresh(source)
                session.refresh(target)
                _attach_last_incoming(session, [source, target])
                _attach_lot_metadata(session, [source, target])
                return OpeningClubOut(
                    source_item=source,
                    target_item=target,
                    purchase_id=int(purchase.id),
                    purchase_item_id=int(purchase_item.id),
                    source_item_id=int(source.id),
                    target_item_id=int(target.id),
                    target_stock=int(target_stock_after),
                    archived_source_id=int(source.id),
                    moved_movement_count=0,
                    backup_path=backup_path,
                )

            source_openings = [
                row
                for row in source_movements
                if str(row.reason or "").upper() == "OPENING"
                and str(row.ref_type or "").upper() == "ITEM_CREATE"
                and int(row.delta or 0) == purchase_qty
            ]
            source_ledger_total = sum(int(row.delta or 0) for row in source_movements)
            move_balanced_source_history = False
            preserve_current_stock_with_adjustment = False
            source_opening: Optional[StockMovement] = None
            replacement_openings = [
                row
                for row in source_movements
                if str(row.reason or "").upper() in {"OPENING", "INVENTORY_ADD"}
                and str(row.ref_type or "").upper() in {"ITEM", "ITEM_CREATE", "ITEM_MERGE", "ITEM_COPY", "MANUAL"}
                and int(row.delta or 0) == purchase_qty
                and (not invoice_date or _date_part(row.ts) >= invoice_date)
            ]
            same_qty_openings = [
                row
                for row in source_movements
                if str(row.reason or "").upper() in {"OPENING", "INVENTORY_ADD"}
                and str(row.ref_type or "").upper() in {"ITEM", "ITEM_CREATE", "ITEM_MERGE", "ITEM_COPY", "MANUAL"}
                and int(row.delta or 0) == purchase_qty
            ]
            same_qty_purchase_targets: List[Dict[str, Any]] = []
            all_purchase_placeholders = []
            same_purchase_refs = session.exec(
                select(PurchaseItem, Purchase)
                .join(Purchase, Purchase.id == PurchaseItem.purchase_id)
                .where(
                    Purchase.is_deleted == False,  # noqa: E712
                    PurchaseItem.inventory_item_id.is_not(None),
                    PurchaseItem.inventory_item_id != int(source.id),
                    func.upper(func.coalesce(PurchaseItem.stock_source, "CREATED")) == "CREATED",
                )
                .order_by(Purchase.invoice_date.asc(), PurchaseItem.id.asc())
            ).all()
            candidate_records: List[Dict[str, Any]] = []
            for candidate_item, candidate_purchase in same_purchase_refs:
                candidate_target = session.get(Item, int(candidate_item.inventory_item_id or 0))
                if not candidate_target or _club_group_key(candidate_target) != _club_group_key(source):
                    continue
                if str(candidate_item.expiry_date or "") != str(source.expiry_date or ""):
                    continue
                if abs(float(candidate_item.mrp or 0) - float(source.mrp or 0)) > 0.001:
                    continue
                candidate_qty = _purchase_item_qty(candidate_item)
                candidate_date = _date_part(candidate_purchase.invoice_date)
                if candidate_qty == purchase_qty:
                    same_qty_purchase_targets.append(
                        {
                            "target_item_id": int(candidate_target.id or 0),
                            "invoice_number": str(candidate_purchase.invoice_number or candidate_purchase.id),
                            "invoice_date": candidate_date,
                            "qty": int(candidate_qty),
                        }
                    )
                candidate_records.append(
                    {
                        "purchase_item": candidate_item,
                        "purchase": candidate_purchase,
                        "target": candidate_target,
                        "qty": int(candidate_qty),
                        "invoice_date": candidate_date,
                    }
                )

            for index, candidate in enumerate(candidate_records):
                candidate_item = candidate["purchase_item"]
                candidate_purchase = candidate["purchase"]
                candidate_target = candidate["target"]
                candidate_qty = int(candidate["qty"])
                candidate_date = str(candidate["invoice_date"] or "")
                next_candidate_date = ""
                for later in candidate_records[index + 1 :]:
                    later_date = str(later["invoice_date"] or "")
                    if later_date and later_date != candidate_date:
                        next_candidate_date = later_date
                        break
                candidate_openings = [
                    row
                    for row in source_movements
                    if str(row.reason or "").upper() in {"OPENING", "INVENTORY_ADD"}
                    and str(row.ref_type or "").upper() in {"ITEM", "ITEM_CREATE", "ITEM_MERGE", "ITEM_COPY", "MANUAL"}
                    and int(row.delta or 0) == candidate_qty
                    and (not candidate_date or _date_part(row.ts) >= candidate_date)
                    and (not next_candidate_date or _date_part(row.ts) < next_candidate_date)
                ]
                if len(candidate_openings) == 1:
                    all_purchase_placeholders.append(
                        {
                            "purchase_item_id": int(candidate_item.id or 0),
                            "target_item_id": int(candidate_target.id or 0),
                            "invoice_number": str(candidate_purchase.invoice_number or candidate_purchase.id),
                            "invoice_date": candidate_date,
                            "qty": int(candidate_qty),
                            "opening_movement_id": int(candidate_openings[0].id or 0),
                        }
                    )
            if len(same_qty_openings) > 1 and len(same_qty_purchase_targets) > 1:
                same_qty_target_ids = {int(row["target_item_id"]) for row in same_qty_purchase_targets}
                same_qty_planned_target_ids = {
                    int(row["target_item_id"])
                    for row in all_purchase_placeholders
                    if int(row["qty"]) == int(purchase_qty)
                }
                if same_qty_planned_target_ids != same_qty_target_ids:
                    opening_plan = ", ".join(
                        f"movement #{int(row.id or 0)} qty {int(row.delta or 0)} on {_date_part(row.ts) or '-'}"
                        for row in same_qty_openings
                    )
                    target_plan = ", ".join(
                        f"#{row['target_item_id']} qty {row['qty']} ({row['invoice_number']} {row['invoice_date'] or '-'})"
                        for row in same_qty_purchase_targets
                    )
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Batch #{source.id} has multiple same-qty OP placeholders and multiple purchase batches. "
                            f"Manual split required. OP rows: {opening_plan}. Purchase batches: {target_plan}"
                        ),
                    )
            unique_placeholder_ids = {row["opening_movement_id"] for row in all_purchase_placeholders}
            unique_purchase_targets = {row["target_item_id"] for row in all_purchase_placeholders}
            if len(source_openings) == 1 and not replacement_openings and invoice_date:
                source_opening_date = _date_part(source_openings[0].ts)
                pre_invoice_activity = [
                    row
                    for row in source_movements
                    if int(row.id or 0) != int(source_openings[0].id or 0)
                    and int(row.delta or 0) != 0
                    and _date_part(row.ts)
                    and _date_part(row.ts) < invoice_date
                ]
                if source_opening_date and source_opening_date < invoice_date and pre_invoice_activity:
                    examples = ", ".join(
                        f"{row.reason}{f' #{row.ref_id}' if getattr(row, 'ref_id', None) else ''}"
                        for row in pre_invoice_activity[:3]
                    )
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Source OP batch #{source.id} has stock movement before purchase date {invoice_date}. "
                            f"Refusing to attach it to later purchase batch #{target.id}: {examples}"
                        ),
                    )
            if all_purchase_placeholders and int(target.id) in unique_purchase_targets:
                placeholder_ids = {int(row["opening_movement_id"]) for row in all_purchase_placeholders}
                if len(placeholder_ids) != len(all_purchase_placeholders):
                    raise HTTPException(status_code=400, detail="Duplicate OP placeholders are ambiguous; manual repair required")

                placeholder_by_id = {
                    int(row.id or 0): row
                    for row in source_movements
                    if int(row.id or 0) in placeholder_ids
                }
                if len(placeholder_by_id) != len(placeholder_ids):
                    raise HTTPException(status_code=400, detail="Could not load every OP placeholder for split repair")

                repair_targets: List[Dict[str, Any]] = []
                for plan in sorted(
                    all_purchase_placeholders,
                    key=lambda row: (
                        str(placeholder_by_id[int(row["opening_movement_id"])].ts or ""),
                        int(row["opening_movement_id"]),
                    ),
                ):
                    repair_target = session.get(Item, int(plan["target_item_id"]))
                    repair_purchase_item = session.get(PurchaseItem, int(plan["purchase_item_id"]))
                    if not repair_target or not repair_purchase_item:
                        raise HTTPException(status_code=400, detail="Could not load split repair purchase target")
                    repair_purchase = session.get(Purchase, int(repair_purchase_item.purchase_id))
                    if not repair_purchase or repair_purchase.is_deleted:
                        raise HTTPException(status_code=400, detail="Split repair purchase is missing or deleted")
                    if str(repair_purchase_item.stock_source or "").upper() != "CREATED":
                        raise HTTPException(status_code=400, detail="Split repair requires purchase-created target batches")
                    repair_qty = _purchase_item_qty(repair_purchase_item)
                    target_movements_for_repair = session.exec(
                        select(StockMovement)
                        .where(StockMovement.item_id == int(repair_target.id))
                        .order_by(StockMovement.ts.asc(), StockMovement.id.asc())
                    ).all()
                    repair_purchase_movements = [
                        row
                        for row in target_movements_for_repair
                        if str(row.reason or "").upper() == "PURCHASE"
                        and str(row.ref_type or "").upper() == "PURCHASE"
                        and int(row.ref_id or 0) == int(repair_purchase.id)
                        and int(row.delta or 0) == int(repair_qty)
                    ]
                    if len(repair_purchase_movements) != 1:
                        raise HTTPException(
                            status_code=400,
                            detail=(
                                f"Kept batch #{repair_target.id} must have exactly one purchase stock entry "
                                f"for qty {repair_qty}; found {len(repair_purchase_movements)}"
                            ),
                        )
                    repair_lot = _lot_for_item(session, int(repair_target.id))
                    if not repair_lot:
                        repair_product = session.get(Product, int(repair_purchase_item.product_id)) if repair_purchase_item.product_id else None
                        repair_lot = ensure_lot_for_inventory_item(
                            session,
                            inventory_item=repair_target,
                            product=repair_product,
                            ts=now_ts(),
                        )
                    if not repair_lot:
                        raise HTTPException(status_code=400, detail=f"Could not prepare lot for batch #{repair_target.id}")
                    repair_targets.append(
                        {
                            "item": repair_target,
                            "purchase": repair_purchase,
                            "purchase_item": repair_purchase_item,
                            "lot": repair_lot,
                            "placeholder": placeholder_by_id[int(plan["opening_movement_id"])],
                            "remaining": int(repair_target.stock or 0),
                            "moved_delta": 0,
                            "allocations": [],
                        }
                    )

                lot_ids = [
                    int(row.id)
                    for row in [source_lot, *[entry["lot"] for entry in repair_targets]]
                    if row is not None and getattr(row, "id", None) is not None
                ]
                target_ids = [int(entry["item"].id) for entry in repair_targets]
                pack_open_filters = [
                    PackOpenEvent.source_item_id.in_([int(source.id), *target_ids]),
                    PackOpenEvent.loose_item_id.in_([int(source.id), *target_ids]),
                ]
                if lot_ids:
                    pack_open_filters.extend(
                        [
                            PackOpenEvent.source_lot_id.in_(lot_ids),
                            PackOpenEvent.loose_lot_id.in_(lot_ids),
                        ]
                    )
                pack_open_refs = session.exec(select(func.count(PackOpenEvent.id)).where(or_(*pack_open_filters))).first()
                child_lot_refs = (
                    session.exec(
                        select(func.count(InventoryLot.id)).where(InventoryLot.opened_from_lot_id.in_(lot_ids))
                    ).first()
                    if lot_ids
                    else 0
                )
                if int(pack_open_refs or 0) > 0 or int(child_lot_refs or 0) > 0:
                    raise HTTPException(status_code=400, detail="Loose/pack-open batches must be handled manually")

                movable_reasons = {
                    "SALE",
                    "BILL_DELETE",
                    "BILL_RECOVER",
                    "RETURN",
                    "EXCHANGE_IN",
                    "EXCHANGE_OUT",
                    "ADJUST",
                    "RECON_ADJUST",
                }
                placeholder_keys = [
                    (str(entry["placeholder"].ts or ""), int(entry["placeholder"].id or 0))
                    for entry in repair_targets
                ]
                first_placeholder_key = min(placeholder_keys)
                post_placeholder_movements = [
                    row
                    for row in source_movements
                    if (str(row.ts or ""), int(row.id or 0)) > first_placeholder_key
                    and int(row.id or 0) not in placeholder_ids
                ]
                bill_edit_net: Dict[int, int] = {}
                for row in post_placeholder_movements:
                    reason_key = str(row.reason or "").upper()
                    if reason_key == "BILL_EDIT" and str(row.ref_type or "").upper() == "BILL" and row.ref_id is not None:
                        bill_edit_net[int(row.ref_id)] = bill_edit_net.get(int(row.ref_id), 0) + int(row.delta or 0)
                        continue
                    if reason_key not in movable_reasons:
                        raise HTTPException(
                            status_code=400,
                            detail=f"Source OP batch has unsupported movement after split placeholder: {row.reason} #{row.ref_id or ''}",
                        )
                nonzero_bill_edits = {bill_id: delta for bill_id, delta in bill_edit_net.items() if delta != 0}
                if nonzero_bill_edits:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Bill edit movements are not balanced for split repair: {nonzero_bill_edits}",
                    )

                def split_bill_item_for_allocations(
                    movement: StockMovement,
                    *,
                    source_qty: int,
                    target_allocations: List[Dict[str, Any]],
                    original_qty: int,
                ) -> None:
                    if str(movement.ref_type or "").upper() != "BILL" or movement.ref_id is None:
                        return
                    bill_item = session.exec(
                        select(BillItem)
                        .where(BillItem.bill_id == int(movement.ref_id), BillItem.item_id == int(source.id))
                        .order_by(BillItem.id.asc())
                    ).first()
                    if not bill_item:
                        raise HTTPException(
                            status_code=400,
                            detail=f"Bill #{movement.ref_id} item row for split repair was not found",
                        )
                    if int(bill_item.quantity or 0) != int(original_qty):
                        raise HTTPException(
                            status_code=400,
                            detail=(
                                f"Bill #{movement.ref_id} item quantity {bill_item.quantity} does not match "
                                f"movement qty {original_qty}"
                            ),
                        )
                    original_total = float(bill_item.line_total or 0)
                    pieces: List[Dict[str, Any]] = []
                    if source_qty > 0:
                        pieces.append({"item": source, "qty": int(source_qty), "existing": True})
                    for allocation in target_allocations:
                        pieces.append({"item": allocation["bucket"]["item"], "qty": int(allocation["qty"]), "existing": False})
                    if not pieces:
                        raise HTTPException(status_code=400, detail="Split repair produced no bill pieces")
                    allocated_total = 0.0
                    for index, piece in enumerate(pieces):
                        is_last = index == len(pieces) - 1
                        line_total = _round2(original_total - allocated_total) if is_last else _round2(original_total * piece["qty"] / original_qty)
                        allocated_total = _round2(allocated_total + line_total)
                        item_for_piece: Item = piece["item"]
                        if index == 0:
                            bill_item.item_id = int(item_for_piece.id)
                            bill_item.item_name = item_for_piece.name
                            bill_item.mrp = float(item_for_piece.mrp or bill_item.mrp or 0)
                            bill_item.quantity = int(piece["qty"])
                            bill_item.line_total = line_total
                            session.add(bill_item)
                        else:
                            session.add(
                                BillItem(
                                    bill_id=int(movement.ref_id),
                                    item_id=int(item_for_piece.id),
                                    item_name=item_for_piece.name,
                                    mrp=float(item_for_piece.mrp or bill_item.mrp or 0),
                                    quantity=int(piece["qty"]),
                                    line_total=line_total,
                                )
                            )

                def clone_movement_for_target(original: StockMovement, bucket: Dict[str, Any], delta: int) -> StockMovement:
                    item_for_bucket: Item = bucket["item"]
                    copy = StockMovement(
                        item_id=int(item_for_bucket.id),
                        ts=original.ts,
                        delta=int(delta),
                        reason=original.reason,
                        ref_type=original.ref_type,
                        ref_id=original.ref_id,
                        note=original.note,
                        actor=original.actor,
                    )
                    _retarget_moved_item_ref(copy, source_item_id=int(source.id), target_item_id=int(item_for_bucket.id))
                    session.add(copy)
                    return copy

                backup_path = create_data_repair_backup("before_manual_split_op_placeholder_club")
                deleted_placeholder_ids: List[int] = []
                moved_movement_ids: List[int] = []
                created_movement_ids: List[int] = []
                source_placeholder_delta = sum(int(row.delta or 0) for row in placeholder_by_id.values())
                moved_delta_total = 0

                for row in placeholder_by_id.values():
                    deleted_placeholder_ids.append(int(row.id or 0))
                    session.delete(row)

                for row in post_placeholder_movements:
                    reason_key = str(row.reason or "").upper()
                    if reason_key == "BILL_EDIT":
                        continue
                    delta = int(row.delta or 0)
                    if delta == 0:
                        continue
                    target_allocations: List[Dict[str, Any]] = []
                    source_qty = 0
                    if delta < 0:
                        qty_to_allocate = abs(delta)
                        row_key = (str(row.ts or ""), int(row.id or 0))
                        eligible_buckets = [
                            bucket
                            for bucket in repair_targets
                            if (
                                str(bucket["placeholder"].ts or ""),
                                int(bucket["placeholder"].id or 0),
                            )
                            < row_key
                        ]
                        for bucket in reversed(eligible_buckets):
                            if qty_to_allocate <= 0:
                                break
                            available = max(0, int(bucket["remaining"]))
                            take = min(available, qty_to_allocate)
                            if take <= 0:
                                continue
                            bucket["remaining"] = int(bucket["remaining"]) - take
                            bucket["moved_delta"] = int(bucket["moved_delta"]) - take
                            bucket["allocations"].append({"movement_id": int(row.id or 0), "qty": take, "delta": -take})
                            target_allocations.append({"bucket": bucket, "qty": take})
                            moved_delta_total -= take
                            qty_to_allocate -= take
                        source_qty = qty_to_allocate
                        if target_allocations:
                            if source_qty > 0:
                                row.delta = -source_qty
                                session.add(row)
                                for allocation in target_allocations:
                                    created = clone_movement_for_target(row, allocation["bucket"], -int(allocation["qty"]))
                                    session.flush()
                                    if created.id is not None:
                                        created_movement_ids.append(int(created.id))
                            else:
                                first = target_allocations[0]
                                first_item: Item = first["bucket"]["item"]
                                row.item_id = int(first_item.id)
                                row.delta = -int(first["qty"])
                                _retarget_moved_item_ref(row, source_item_id=int(source.id), target_item_id=int(first_item.id))
                                session.add(row)
                                moved_movement_ids.append(int(row.id or 0))
                                for allocation in target_allocations[1:]:
                                    created = clone_movement_for_target(row, allocation["bucket"], -int(allocation["qty"]))
                                    session.flush()
                                    if created.id is not None:
                                        created_movement_ids.append(int(created.id))
                            if reason_key == "SALE":
                                split_bill_item_for_allocations(
                                    row,
                                    source_qty=int(source_qty),
                                    target_allocations=target_allocations,
                                    original_qty=abs(delta),
                                )
                    else:
                        eligible_buckets = [
                            bucket
                            for bucket in repair_targets
                            if (str(bucket["placeholder"].ts or ""), int(bucket["placeholder"].id or 0))
                            < (str(row.ts or ""), int(row.id or 0))
                        ]
                        bucket = eligible_buckets[-1] if eligible_buckets else repair_targets[-1]
                        bucket["remaining"] = int(bucket["remaining"]) + delta
                        bucket["moved_delta"] = int(bucket["moved_delta"]) + delta
                        moved_delta_total += delta
                        target_item_for_positive: Item = bucket["item"]
                        row.item_id = int(target_item_for_positive.id)
                        _retarget_moved_item_ref(row, source_item_id=int(source.id), target_item_id=int(target_item_for_positive.id))
                        session.add(row)
                        moved_movement_ids.append(int(row.id or 0))

                source_stock_after = int(source.stock or 0) - int(source_placeholder_delta) - int(moved_delta_total)
                if source_stock_after < 0:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Split placeholder repair would make source batch #{source.id} negative ({source_stock_after})",
                    )
                source.stock = int(source_stock_after)
                source.is_archived = bool(source_stock_after <= 0)
                source.updated_at = now_ts()
                session.add(source)

                for bucket in repair_targets:
                    bucket_item: Item = bucket["item"]
                    if int(bucket["remaining"]) < 0:
                        raise HTTPException(
                            status_code=400,
                            detail=f"Split placeholder repair would make target batch #{bucket_item.id} negative",
                        )
                    bucket_item.stock = int(bucket["remaining"])
                    bucket_item.is_archived = bool(int(bucket["remaining"]) <= 0)
                    bucket_item.updated_at = source.updated_at
                    bucket_item.cost_price = float(
                        bucket["purchase_item"].effective_cost_price
                        or bucket["purchase_item"].cost_price
                        or bucket_item.cost_price
                        or 0
                    )
                    session.add(bucket_item)

                session.flush()
                source_ledger_after = int(
                    session.exec(
                        select(func.coalesce(func.sum(StockMovement.delta), 0)).where(StockMovement.item_id == int(source.id))
                    ).first()
                    or 0
                )
                source_balance_adjustment = int(source_stock_after) - int(source_ledger_after)
                if source_balance_adjustment:
                    if source_balance_adjustment < 0:
                        raise HTTPException(
                            status_code=400,
                            detail=(
                                f"Split placeholder repair would require a negative source balance correction "
                                f"({source_balance_adjustment})"
                            ),
                        )
                    session.add(
                        StockMovement(
                            item_id=int(source.id),
                            ts=_historical_opening_ts(source_movements),
                            delta=int(source_balance_adjustment),
                            reason="OPENING",
                            ref_type="ITEM",
                            ref_id=int(source.id),
                            note=(
                                "Opening balance retained after duplicate OP placeholder(s) "
                                "were replaced by purchase batch(es)"
                            ),
                            actor="SYSTEM",
                        )
                    )
                    session.flush()

                sync_lot_quantity_for_item(session, source, ts=source.updated_at)
                apply_archive_rules(session, source)
                for bucket in repair_targets:
                    sync_lot_quantity_for_item(session, bucket["item"], ts=source.updated_at)
                    apply_archive_rules(session, bucket["item"])

                log_audit(
                    session,
                    entity_type="ITEM",
                    entity_id=int(target.id),
                    action="OPENING_CLUB",
                    note=payload.note
                    or f"Split-clubbed duplicate OP placeholder(s) from batch #{source.id}",
                    details={
                        "direction": "SPLIT_OPENING_PLACEHOLDERS_TO_PURCHASES",
                        "source_item_id": int(source.id),
                        "target_item_ids": target_ids,
                        "deleted_source_opening_movement_ids": deleted_placeholder_ids,
                        "moved_movement_ids": moved_movement_ids,
                        "created_movement_ids": created_movement_ids,
                        "source_stock": int(source_stock_after),
                        "source_balance_adjustment": int(source_balance_adjustment),
                        "target_stocks": {str(bucket["item"].id): int(bucket["item"].stock or 0) for bucket in repair_targets},
                        "backup": backup_path,
                    },
                )
                session.commit()
                session.refresh(source)
                session.refresh(target)
                _attach_last_incoming(session, [source, target])
                _attach_lot_metadata(session, [source, target])
                return OpeningClubOut(
                    source_item=source,
                    target_item=target,
                    purchase_id=int(target_active_purchase_refs[0][1].id),
                    purchase_item_id=int(target_active_purchase_refs[0][0].id),
                    source_item_id=int(source.id),
                    target_item_id=int(target.id),
                    target_stock=int(target.stock or 0),
                    archived_source_id=int(source.id) if source.is_archived else 0,
                    moved_movement_count=len(moved_movement_ids) + len(created_movement_ids),
                    backup_path=backup_path,
                )
            if len(replacement_openings) == 1:
                source_opening = replacement_openings[0]
                target_movements = session.exec(
                    select(StockMovement)
                    .where(StockMovement.item_id == int(target.id))
                    .order_by(StockMovement.ts.asc(), StockMovement.id.asc())
                ).all()
                target_purchase_movements = [
                    row
                    for row in target_movements
                    if str(row.reason or "").upper() == "PURCHASE"
                    and str(row.ref_type or "").upper() == "PURCHASE"
                    and int(row.ref_id or 0) == int(purchase.id)
                    and int(row.delta or 0) == purchase_qty
                ]
                if len(target_purchase_movements) != 1:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Kept batch #{target.id} must have exactly one purchase stock entry "
                            f"for qty {purchase_qty}; found {len(target_purchase_movements)}"
                        ),
                    )

                movable_reasons = {
                    "SALE",
                    "BILL_DELETE",
                    "BILL_EDIT",
                    "BILL_RECOVER",
                    "RETURN",
                    "EXCHANGE_IN",
                    "EXCHANGE_OUT",
                    "ADJUST",
                    "RECON_ADJUST",
                }
                source_opening_key = (str(source_opening.ts or ""), int(source_opening.id or 0))
                movable_source_movements = [
                    row
                    for row in source_movements
                    if (str(row.ts or ""), int(row.id or 0)) > source_opening_key
                    and int(row.id or 0) != int(source_opening.id or 0)
                ]
                blocked_source_movements = [
                    row for row in movable_source_movements if str(row.reason or "").upper() not in movable_reasons
                ]
                if blocked_source_movements:
                    examples = ", ".join(
                        f"{row.reason}{f' #{row.ref_id}' if getattr(row, 'ref_id', None) else ''}"
                        for row in blocked_source_movements[:3]
                    )
                    raise HTTPException(
                        status_code=400,
                        detail=f"Source OP batch has unsupported movement(s) after replacement OP: {examples}",
                    )

                moved_delta = sum(int(row.delta or 0) for row in movable_source_movements)
                source_stock_after = int(source.stock or 0) - int(source_opening.delta or 0) - int(moved_delta)
                target_stock_after = int(target.stock or 0) + int(moved_delta)
                if source_stock_after < 0 or target_stock_after < 0:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Replacement OP cleanup would make stock negative "
                            f"(source {source_stock_after}, target {target_stock_after})"
                        ),
                    )

                lot_ids = [
                    int(row.id)
                    for row in (source_lot, target_lot)
                    if row is not None and getattr(row, "id", None) is not None
                ]
                pack_open_filters = [
                    PackOpenEvent.source_item_id.in_([int(source.id), int(target.id)]),
                    PackOpenEvent.loose_item_id.in_([int(source.id), int(target.id)]),
                ]
                if lot_ids:
                    pack_open_filters.extend(
                        [
                            PackOpenEvent.source_lot_id.in_(lot_ids),
                            PackOpenEvent.loose_lot_id.in_(lot_ids),
                        ]
                    )
                pack_open_refs = session.exec(select(func.count(PackOpenEvent.id)).where(or_(*pack_open_filters))).first()
                child_lot_refs = (
                    session.exec(
                        select(func.count(InventoryLot.id)).where(InventoryLot.opened_from_lot_id.in_(lot_ids))
                    ).first()
                    if lot_ids
                    else 0
                )
                if int(pack_open_refs or 0) > 0 or int(child_lot_refs or 0) > 0:
                    raise HTTPException(status_code=400, detail="Loose/pack-open batches must be handled manually")

                backup_path = create_data_repair_backup("before_manual_op_placeholder_to_purchase")
                deleted_source_opening_movement_id = int(source_opening.id or 0)
                session.delete(source_opening)

                bill_targets: Dict[int, int] = {}
                return_targets: Dict[int, int] = {}
                for row in movable_source_movements:
                    row.item_id = int(target.id)
                    _retarget_moved_item_ref(row, source_item_id=int(source.id), target_item_id=int(target.id))
                    if str(row.ref_type or "").upper() == "BILL" and row.ref_id is not None:
                        bill_targets[int(row.ref_id)] = int(target.id)
                    if str(row.ref_type or "").upper() == "RETURN" and row.ref_id is not None:
                        return_targets[int(row.ref_id)] = int(target.id)
                    session.add(row)

                for bill_id, item_id in bill_targets.items():
                    for row in session.exec(
                        select(BillItem).where(BillItem.item_id == int(source.id), BillItem.bill_id == int(bill_id))
                    ).all():
                        row.item_id = int(item_id)
                        session.add(row)
                    allocation_filter = and_(BillItemAllocation.item_id == int(source.id), BillItemAllocation.bill_id == int(bill_id))
                    if source_lot and source_lot.id is not None:
                        allocation_filter = or_(
                            allocation_filter,
                            and_(BillItemAllocation.lot_id == int(source_lot.id), BillItemAllocation.bill_id == int(bill_id)),
                        )
                    for row in session.exec(select(BillItemAllocation).where(allocation_filter)).all():
                        row.item_id = int(item_id)
                        row.lot_id = int(target_lot.id) if target_lot.id is not None else None
                        session.add(row)

                for return_id, item_id in return_targets.items():
                    for row in session.exec(
                        select(ReturnItem).where(ReturnItem.item_id == int(source.id), ReturnItem.return_id == int(return_id))
                    ).all():
                        row.item_id = int(item_id)
                        session.add(row)

                target.stock = int(target_stock_after)
                target.is_archived = bool(target_stock_after <= 0)
                target.updated_at = now_ts()
                target.cost_price = float(purchase_item.effective_cost_price or purchase_item.cost_price or target.cost_price or 0)
                session.add(target)
                source.stock = int(source_stock_after)
                source.is_archived = bool(source_stock_after <= 0)
                source.updated_at = target.updated_at
                session.add(source)
                session.flush()

                sync_lot_quantity_for_item(session, target, ts=target.updated_at)
                sync_lot_quantity_for_item(session, source, ts=source.updated_at)
                apply_archive_rules(session, target)
                apply_archive_rules(session, source)

                log_audit(
                    session,
                    entity_type="ITEM",
                    entity_id=int(target.id),
                    action="OPENING_CLUB",
                    note=payload.note
                    or f"Removed duplicate OP placeholder from batch #{source.id} and kept purchase batch #{target.id}",
                    details={
                        "direction": "OPENING_PLACEHOLDER_TO_PURCHASE",
                        "source_item_id": int(source.id),
                        "target_item_id": int(target.id),
                        "purchase_id": int(purchase.id),
                        "purchase_item_id": int(purchase_item.id),
                        "purchase_qty": int(purchase_qty),
                        "deleted_source_opening_movement_id": deleted_source_opening_movement_id,
                        "moved_movement_ids": [int(row.id) for row in movable_source_movements if row.id is not None],
                        "source_stock": int(source_stock_after),
                        "target_stock": int(target_stock_after),
                        "backup": backup_path,
                    },
                )
                session.commit()
                session.refresh(source)
                session.refresh(target)
                _attach_last_incoming(session, [source, target])
                _attach_lot_metadata(session, [source, target])
                return OpeningClubOut(
                    source_item=source,
                    target_item=target,
                    purchase_id=int(purchase.id),
                    purchase_item_id=int(purchase_item.id),
                    source_item_id=int(source.id),
                    target_item_id=int(target.id),
                    target_stock=int(target_stock_after),
                    archived_source_id=int(source.id) if source.is_archived else 0,
                    moved_movement_count=len(movable_source_movements),
                    backup_path=backup_path,
                )
            if len(source_openings) == 1:
                source_opening = source_openings[0]
            elif int(source.stock or 0) == 0 and source_ledger_total == 0:
                if len(replacement_openings) != 1:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Source history batch #{source.id} is balanced, but could not identify exactly one "
                            f"OP placeholder of qty {purchase_qty} on/after purchase date {invoice_date or '-'}; "
                            f"found {len(replacement_openings)}"
                        ),
                    )
                source_opening = replacement_openings[0]
                move_balanced_source_history = True
            elif len(replacement_openings) == 1:
                source_opening = replacement_openings[0]
                move_balanced_source_history = True
                preserve_current_stock_with_adjustment = True
            else:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Source OP batch #{source.id} must have exactly one Opening / ITEM_CREATE entry "
                        f"for qty {purchase_qty}, a zero-balanced history batch, or exactly one replacement OP "
                        f"placeholder on/after purchase date {invoice_date or '-'}; found "
                        f"{len(source_openings)} matching ITEM_CREATE rows and {len(replacement_openings)} replacement rows"
                    ),
                )

            movable_reasons = {
                "SALE",
                "BILL_DELETE",
                "BILL_EDIT",
                "BILL_RECOVER",
                "RETURN",
                "EXCHANGE_IN",
                "EXCHANGE_OUT",
                "ADJUST",
                "RECON_ADJUST",
            }
            if move_balanced_source_history:
                movable_source_movements = [
                    row for row in source_movements if int(row.id or 0) != int(source_opening.id or 0)
                ]
                allowed_source_reasons = set(movable_reasons) | {"OPENING", "INVENTORY_ADD"}
            else:
                movable_source_movements = [
                    row for row in source_movements if int(row.id or 0) != int(source_opening.id or 0)
                ]
                allowed_source_reasons = set(movable_reasons)
            blocked_source_movements = [
                row for row in movable_source_movements if str(row.reason or "").upper() not in allowed_source_reasons
            ]
            if blocked_source_movements:
                examples = ", ".join(
                    f"{row.reason}{f' #{row.ref_id}' if getattr(row, 'ref_id', None) else ''}"
                    for row in blocked_source_movements[:3]
                )
                raise HTTPException(
                    status_code=400,
                    detail=f"Source OP batch has unsupported movement(s): {examples}",
                )

            target_movements = session.exec(
                select(StockMovement)
                .where(StockMovement.item_id == int(target.id))
                .order_by(StockMovement.ts.asc(), StockMovement.id.asc())
            ).all()
            target_purchase_movements = [
                row
                for row in target_movements
                if str(row.reason or "").upper() == "PURCHASE"
                and str(row.ref_type or "").upper() == "PURCHASE"
                and int(row.ref_id or 0) == int(purchase.id)
                and int(row.delta or 0) == purchase_qty
            ]
            if len(target_purchase_movements) != 1:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Kept batch #{target.id} must have exactly one purchase stock entry "
                        f"for qty {purchase_qty}; found {len(target_purchase_movements)}"
                    ),
                )

            moved_delta = sum(int(row.delta or 0) for row in movable_source_movements)
            target_delta_before = sum(int(row.delta or 0) for row in target_movements)
            target_stock_after = target_delta_before + moved_delta
            target_stock_from_current_rows = (
                int(target.stock or 0)
                + int(source.stock or 0)
                - int(source_opening.delta or 0)
            )
            balance_adjustment_delta = 0
            if preserve_current_stock_with_adjustment and target_stock_after != target_stock_from_current_rows:
                balance_adjustment_delta = int(target_stock_from_current_rows) - int(target_stock_after)
                target_stock_after = int(target_stock_from_current_rows)
            if target_stock_after < 0:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Clubbing would make kept purchase batch #{target.id} negative "
                        f"({target_stock_after}). Check sales/returns first."
                    ),
                )

            lot_ids = [
                int(row.id)
                for row in (source_lot, target_lot)
                if row is not None and getattr(row, "id", None) is not None
            ]
            pack_open_filters = [
                PackOpenEvent.source_item_id.in_([int(source.id), int(target.id)]),
                PackOpenEvent.loose_item_id.in_([int(source.id), int(target.id)]),
            ]
            if lot_ids:
                pack_open_filters.extend(
                    [
                        PackOpenEvent.source_lot_id.in_(lot_ids),
                        PackOpenEvent.loose_lot_id.in_(lot_ids),
                    ]
                )
            pack_open_refs = session.exec(select(func.count(PackOpenEvent.id)).where(or_(*pack_open_filters))).first()
            child_lot_refs = (
                session.exec(
                    select(func.count(InventoryLot.id)).where(InventoryLot.opened_from_lot_id.in_(lot_ids))
                ).first()
                if lot_ids
                else 0
            )
            if int(pack_open_refs or 0) > 0 or int(child_lot_refs or 0) > 0:
                raise HTTPException(status_code=400, detail="Loose/pack-open batches must be handled manually")

            backup_path = create_data_repair_backup("before_manual_op_into_purchase_club")
            deleted_source_opening_movement_id = int(source_opening.id or 0) if source_opening else None
            if source_opening:
                session.delete(source_opening)
            for row in movable_source_movements:
                row.item_id = int(target.id)
                _retarget_moved_item_ref(row, source_item_id=int(source.id), target_item_id=int(target.id))
                session.add(row)
            if balance_adjustment_delta:
                if balance_adjustment_delta < 0:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Clubbing would require a negative balance correction "
                            f"({balance_adjustment_delta}) on kept batch #{target.id}"
                        ),
                    )
                session.add(
                    StockMovement(
                        item_id=int(target.id),
                        ts=_historical_opening_ts(source_movements),
                        delta=int(balance_adjustment_delta),
                        reason="OPENING",
                        ref_type="ITEM",
                        ref_id=int(target.id),
                        note=(
                            "Opening balance retained while replacing duplicate OP "
                            f"batch #{source.id} with purchase batch #{target.id}"
                        ),
                        actor="SYSTEM",
                    )
                )

            purchase_item.inventory_item_id = int(target.id)
            purchase_item.lot_id = int(target_lot.id) if target_lot.id is not None else None
            purchase_item.stock_source = "CREATED"
            session.add(purchase_item)

            if payload.adopt_purchase_details:
                target.expiry_date = purchase_item.expiry_date
                target.mrp = float(purchase_item.mrp or target.mrp or 0)
                target.rack_number = int(purchase_item.rack_number or target.rack_number or 0)
            target.cost_price = float(purchase_item.effective_cost_price or purchase_item.cost_price or target.cost_price or 0)
            target.stock = int(target_stock_after)
            target.is_archived = bool(target_stock_after <= 0)
            target.updated_at = now_ts()
            session.add(target)

            source.stock = 0
            source.is_archived = True
            source.updated_at = target.updated_at
            session.add(source)

            for row in session.exec(select(BillItem).where(BillItem.item_id == int(source.id))).all():
                row.item_id = int(target.id)
                session.add(row)
            allocation_filter = BillItemAllocation.item_id == int(source.id)
            if source_lot and source_lot.id is not None:
                allocation_filter = or_(allocation_filter, BillItemAllocation.lot_id == int(source_lot.id))
            for row in session.exec(select(BillItemAllocation).where(allocation_filter)).all():
                row.item_id = int(target.id)
                row.lot_id = int(target_lot.id) if target_lot.id is not None else None
                session.add(row)
            for row in session.exec(select(ReturnItem).where(ReturnItem.item_id == int(source.id))).all():
                row.item_id = int(target.id)
                session.add(row)
            for row in session.exec(select(StockAuditItem).where(StockAuditItem.item_id == int(source.id))).all():
                row.item_id = int(target.id)
                session.add(row)

            session.flush()
            remaining_purchase_filter = PurchaseItem.inventory_item_id == int(source.id)
            if source_lot and source_lot.id is not None:
                remaining_purchase_filter = or_(remaining_purchase_filter, PurchaseItem.lot_id == int(source_lot.id))
            remaining_allocation_filter = BillItemAllocation.item_id == int(source.id)
            if source_lot and source_lot.id is not None:
                remaining_allocation_filter = or_(remaining_allocation_filter, BillItemAllocation.lot_id == int(source_lot.id))
            remaining_refs = {
                "purchase_items": int(session.exec(select(func.count(PurchaseItem.id)).where(remaining_purchase_filter)).first() or 0),
                "stock_movements": int(session.exec(select(func.count(StockMovement.id)).where(StockMovement.item_id == int(source.id))).first() or 0),
                "bill_items": int(session.exec(select(func.count(BillItem.id)).where(BillItem.item_id == int(source.id))).first() or 0),
                "bill_allocations": int(session.exec(select(func.count(BillItemAllocation.id)).where(remaining_allocation_filter)).first() or 0),
                "return_items": int(session.exec(select(func.count(ReturnItem.id)).where(ReturnItem.item_id == int(source.id))).first() or 0),
                "stock_audit_items": int(session.exec(select(func.count(StockAuditItem.id)).where(StockAuditItem.item_id == int(source.id))).first() or 0),
                "pack_open_events": int(session.exec(select(func.count(PackOpenEvent.id)).where(or_(*pack_open_filters))).first() or 0),
                "child_lots": int(
                    session.exec(select(func.count(InventoryLot.id)).where(InventoryLot.opened_from_lot_id.in_(lot_ids))).first() or 0
                )
                if lot_ids
                else 0,
            }
            uncleared_refs = {key: value for key, value in remaining_refs.items() if value}
            if uncleared_refs:
                raise HTTPException(
                    status_code=400,
                    detail=f"Source batch still has references after club validation: {uncleared_refs}",
                )

            sync_lot_quantity_for_item(session, target, ts=target.updated_at)
            if source_lot:
                source_lot.sealed_qty = 0
                source_lot.loose_qty = 0
                source_lot.is_active = False
                source_lot.updated_at = target.updated_at
                session.add(source_lot)
            sync_lot_quantity_for_item(session, source, ts=source.updated_at)
            apply_archive_rules(session, target)

            target_stock_check = session.exec(
                select(func.coalesce(func.sum(StockMovement.delta), 0)).where(StockMovement.item_id == int(target.id))
            ).first()
            if int(target_stock_check or 0) < 0:
                raise HTTPException(status_code=400, detail="Clubbed kept purchase batch would be negative after repair")
            if int(target_stock_check or 0) != int(target_stock_after):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Clubbed kept purchase batch ledger would be {int(target_stock_check or 0)}, "
                        f"expected {int(target_stock_after)}"
                    ),
                )

            log_audit(
                session,
                entity_type="ITEM",
                entity_id=int(target.id),
                action="OPENING_CLUB",
                note=payload.note
                or f"Clubbed OP batch #{source.id} into purchase batch #{target.id}",
                details={
                    "direction": "OPENING_TO_PURCHASE",
                    "source_item_id": int(source.id),
                    "target_item_id": int(target.id),
                    "purchase_id": int(purchase.id),
                    "purchase_item_id": int(purchase_item.id),
                    "purchase_qty": int(purchase_qty),
                    "move_balanced_source_history": bool(move_balanced_source_history),
                    "preserve_current_stock_with_adjustment": bool(preserve_current_stock_with_adjustment),
                    "balance_adjustment_delta": int(balance_adjustment_delta),
                    "moved_movement_ids": [int(row.id) for row in movable_source_movements if row.id is not None],
                    "deleted_source_opening_movement_id": deleted_source_opening_movement_id,
                    "remaining_source_refs": remaining_refs,
                    "target_stock": int(target_stock_after),
                    "adopt_purchase_details": bool(payload.adopt_purchase_details),
                    "backup": backup_path,
                },
            )
            session.commit()
            session.refresh(source)
            session.refresh(target)
            _attach_last_incoming(session, [source, target])
            _attach_lot_metadata(session, [source, target])
            return OpeningClubOut(
                source_item=source,
                target_item=target,
                purchase_id=int(purchase.id),
                purchase_item_id=int(purchase_item.id),
                source_item_id=int(source.id),
                target_item_id=int(target.id),
                target_stock=int(target_stock_after),
                archived_source_id=int(source.id),
                moved_movement_count=len(movable_source_movements),
                backup_path=backup_path,
            )

        purchase_stmt = (
            select(PurchaseItem, Purchase)
            .join(Purchase, Purchase.id == PurchaseItem.purchase_id)
            .where(
                PurchaseItem.inventory_item_id == int(source.id),
                Purchase.is_deleted == False,  # noqa: E712
            )
        )
        if payload.purchase_item_id is not None:
            purchase_stmt = purchase_stmt.where(PurchaseItem.id == int(payload.purchase_item_id))
        purchase_refs = session.exec(purchase_stmt).all()
        if len(purchase_refs) != 1:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Batch #{source.id} must be linked to exactly one active purchase line; "
                    f"found {len(purchase_refs)}"
                ),
            )
        purchase_item, purchase = purchase_refs[0]
        if str(purchase_item.stock_source or "").upper() != "CREATED":
            raise HTTPException(
                status_code=400,
                detail="Only purchase-created duplicate batches can be clubbed into an OP batch",
            )

        purchase_qty = int(purchase_item.sealed_qty or 0) + int(purchase_item.free_qty or 0)
        if purchase_qty <= 0:
            raise HTTPException(status_code=400, detail="Purchase line quantity must be positive")

        if source.product_id and purchase_item.product_id and int(source.product_id) != int(purchase_item.product_id):
            raise HTTPException(status_code=400, detail="Source batch product link does not match the purchase line")
        if target.product_id and purchase_item.product_id and int(target.product_id) != int(purchase_item.product_id):
            raise HTTPException(status_code=400, detail="OP batch product link does not match the purchase line")

        target_purchase_refs = session.exec(
            select(func.count(PurchaseItem.id))
            .join(Purchase, Purchase.id == PurchaseItem.purchase_id)
            .where(
                PurchaseItem.inventory_item_id == int(target.id),
                Purchase.is_deleted == False,  # noqa: E712
            )
        ).first()
        if int(target_purchase_refs or 0) > 0:
            raise HTTPException(
                status_code=400,
                detail=f"OP batch #{target.id} is already linked to a purchase line",
            )

        source_other_purchase_refs = session.exec(
            select(func.count(PurchaseItem.id)).where(
                PurchaseItem.inventory_item_id == int(source.id),
                PurchaseItem.id != int(purchase_item.id),
            )
        ).first()
        if int(source_other_purchase_refs or 0) > 0:
            raise HTTPException(status_code=400, detail="Source batch is linked to another purchase line")

        source_movements = session.exec(
            select(StockMovement)
            .where(StockMovement.item_id == int(source.id))
            .order_by(StockMovement.ts.asc(), StockMovement.id.asc())
        ).all()
        source_purchase_movements = [
            row
            for row in source_movements
            if str(row.reason or "").upper() == "PURCHASE"
            and str(row.ref_type or "").upper() == "PURCHASE"
            and int(row.ref_id or 0) == int(purchase.id)
            and int(row.delta or 0) == purchase_qty
        ]
        if len(source_purchase_movements) != 1:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Source batch #{source.id} must have exactly one purchase stock entry "
                    f"for qty {purchase_qty}; found {len(source_purchase_movements)}"
                ),
            )
        source_purchase_movement = source_purchase_movements[0]
        if any(
            str(row.reason or "").upper() == "PURCHASE_DUPLICATE_REPAIR"
            and str(row.ref_type or "").upper() == "PURCHASE"
            and int(row.ref_id or 0) == int(purchase.id)
            for row in source_movements
        ):
            raise HTTPException(status_code=400, detail="This source batch already has a duplicate repair entry")

        movable_reasons = {
            "SALE",
            "BILL_DELETE",
            "BILL_EDIT",
            "BILL_RECOVER",
            "RETURN",
            "EXCHANGE_IN",
            "EXCHANGE_OUT",
            "ADJUST",
            "RECON_ADJUST",
        }
        movable_source_movements = [
            row for row in source_movements if int(row.id or 0) != int(source_purchase_movement.id or 0)
        ]
        blocked_source_movements = [
            row for row in movable_source_movements if str(row.reason or "").upper() not in movable_reasons
        ]
        if blocked_source_movements:
            examples = ", ".join(
                f"{row.reason}{f' #{row.ref_id}' if getattr(row, 'ref_id', None) else ''}"
                for row in blocked_source_movements[:3]
            )
            raise HTTPException(
                status_code=400,
                detail=f"Source batch has unsupported movement(s): {examples}",
            )

        target_movements = session.exec(
            select(StockMovement)
            .where(StockMovement.item_id == int(target.id))
            .order_by(StockMovement.ts.asc(), StockMovement.id.asc())
        ).all()
        target_openings = [
            row
            for row in target_movements
            if str(row.reason or "").upper() == "OPENING"
            and str(row.ref_type or "").upper() == "ITEM_CREATE"
            and int(row.delta or 0) == purchase_qty
        ]
        if len(target_openings) != 1:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"OP batch #{target.id} must have exactly one Opening / ITEM_CREATE entry "
                    f"for qty {purchase_qty}; found {len(target_openings)}"
                ),
            )
        target_opening = target_openings[0]
        target_purchase_movements = [
            row
            for row in target_movements
            if str(row.reason or "").upper() == "PURCHASE" or str(row.ref_type or "").upper() == "PURCHASE"
        ]
        if target_purchase_movements:
            raise HTTPException(status_code=400, detail="OP batch already has purchase-linked movement history")

        invoice_date = _date_part(purchase.invoice_date)
        if not invoice_date:
            raise HTTPException(status_code=400, detail="Purchase invoice date is missing")
        if _date_part(target_opening.ts) < invoice_date:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"OP entry date {_date_part(target_opening.ts)} is before purchase invoice date {invoice_date}; "
                    "manual audit is required"
                ),
            )
        pre_invoice_movements = [
            row for row in target_movements if int(row.id or 0) != int(target_opening.id or 0) and _date_part(row.ts) < invoice_date
        ]
        if pre_invoice_movements:
            examples = ", ".join(
                f"{_date_part(row.ts)} {row.reason}{f' #{row.ref_id}' if getattr(row, 'ref_id', None) else ''}"
                for row in pre_invoice_movements[:3]
            )
            raise HTTPException(
                status_code=400,
                detail=f"OP batch has movement before purchase date {invoice_date}: {examples}",
            )

        moved_delta = sum(int(row.delta or 0) for row in movable_source_movements)
        target_delta_before = sum(int(row.delta or 0) for row in target_movements)
        target_stock_after = target_delta_before + moved_delta
        if target_stock_after < 0:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Clubbing would make OP batch #{target.id} negative "
                    f"({target_stock_after}). Check sales/returns first."
                ),
            )

        source_product = session.get(Product, int(purchase_item.product_id)) if purchase_item.product_id else None
        if not source_product:
            raise HTTPException(status_code=400, detail="Purchase product link is missing")
        if not source.product_id:
            source.product_id = int(purchase_item.product_id)
        if not target.product_id:
            target.product_id = int(purchase_item.product_id)

        target_lot = session.exec(
            select(InventoryLot)
            .where(InventoryLot.legacy_item_id == int(target.id))
            .order_by(InventoryLot.id.asc())
        ).first()
        if not target_lot:
            target_lot = ensure_lot_for_inventory_item(
                session,
                inventory_item=target,
                product=source_product,
                ts=now_ts(),
            )
        if not target_lot:
            raise HTTPException(status_code=400, detail="Could not prepare inventory lot for selected OP batch")

        source_lot = session.exec(
            select(InventoryLot)
            .where(InventoryLot.legacy_item_id == int(source.id))
            .order_by(InventoryLot.id.asc())
        ).first()
        lot_ids = [
            int(row.id)
            for row in (source_lot, target_lot)
            if row is not None and getattr(row, "id", None) is not None
        ]
        pack_open_filters = [
            PackOpenEvent.source_item_id.in_([int(source.id), int(target.id)]),
            PackOpenEvent.loose_item_id.in_([int(source.id), int(target.id)]),
        ]
        if lot_ids:
            pack_open_filters.extend(
                [
                    PackOpenEvent.source_lot_id.in_(lot_ids),
                    PackOpenEvent.loose_lot_id.in_(lot_ids),
                ]
            )
        pack_open_refs = session.exec(select(func.count(PackOpenEvent.id)).where(or_(*pack_open_filters))).first()
        child_lot_refs = (
            session.exec(
                select(func.count(InventoryLot.id)).where(InventoryLot.opened_from_lot_id.in_(lot_ids))
            ).first()
            if lot_ids
            else 0
        )
        if int(pack_open_refs or 0) > 0 or int(child_lot_refs or 0) > 0:
            raise HTTPException(status_code=400, detail="Loose/pack-open batches must be handled manually")

        backup_path = create_data_repair_backup("before_manual_opening_purchase_club")

        target_opening.reason = "PURCHASE"
        target_opening.ref_type = "PURCHASE"
        target_opening.ref_id = int(purchase.id)
        target_opening.ts = f"{invoice_date}T00:00:00"
        target_opening.note = (
            f"Manual club: converted OP batch #{target.id} to purchase {purchase.invoice_number or purchase.id}"
        )
        target_opening.actor = "SYSTEM"
        session.add(target_opening)

        for row in movable_source_movements:
            row.item_id = int(target.id)
            _retarget_moved_item_ref(row, source_item_id=int(source.id), target_item_id=int(target.id))
            session.add(row)

        deleted_source_purchase_movement_id = int(source_purchase_movement.id or 0)
        session.delete(source_purchase_movement)

        purchase_item.inventory_item_id = int(target.id)
        purchase_item.lot_id = int(target_lot.id) if target_lot.id is not None else None
        purchase_item.stock_source = "CREATED"
        session.add(purchase_item)

        if payload.adopt_purchase_details:
            target.expiry_date = purchase_item.expiry_date
            target.mrp = float(purchase_item.mrp or target.mrp or 0)
            target.rack_number = int(purchase_item.rack_number or target.rack_number or 0)
        target.cost_price = float(purchase_item.effective_cost_price or purchase_item.cost_price or target.cost_price or 0)
        target.stock = int(target_stock_after)
        target.is_archived = bool(target_stock_after <= 0)
        target.updated_at = now_ts()
        session.add(target)

        source.stock = 0
        source.is_archived = True
        source.updated_at = target.updated_at
        session.add(source)

        for row in session.exec(select(BillItem).where(BillItem.item_id == int(source.id))).all():
            row.item_id = int(target.id)
            session.add(row)
        allocation_filter = BillItemAllocation.item_id == int(source.id)
        if source_lot and source_lot.id is not None:
            allocation_filter = or_(allocation_filter, BillItemAllocation.lot_id == int(source_lot.id))
        for row in session.exec(select(BillItemAllocation).where(allocation_filter)).all():
            row.item_id = int(target.id)
            row.lot_id = int(target_lot.id) if target_lot.id is not None else None
            session.add(row)
        for row in session.exec(select(ReturnItem).where(ReturnItem.item_id == int(source.id))).all():
            row.item_id = int(target.id)
            session.add(row)
        for row in session.exec(select(StockAuditItem).where(StockAuditItem.item_id == int(source.id))).all():
            row.item_id = int(target.id)
            session.add(row)

        session.flush()
        remaining_purchase_filter = PurchaseItem.inventory_item_id == int(source.id)
        if source_lot and source_lot.id is not None:
            remaining_purchase_filter = or_(remaining_purchase_filter, PurchaseItem.lot_id == int(source_lot.id))
        remaining_allocation_filter = BillItemAllocation.item_id == int(source.id)
        if source_lot and source_lot.id is not None:
            remaining_allocation_filter = or_(remaining_allocation_filter, BillItemAllocation.lot_id == int(source_lot.id))
        remaining_refs = {
            "purchase_items": int(session.exec(select(func.count(PurchaseItem.id)).where(remaining_purchase_filter)).first() or 0),
            "stock_movements": int(session.exec(select(func.count(StockMovement.id)).where(StockMovement.item_id == int(source.id))).first() or 0),
            "bill_items": int(session.exec(select(func.count(BillItem.id)).where(BillItem.item_id == int(source.id))).first() or 0),
            "bill_allocations": int(session.exec(select(func.count(BillItemAllocation.id)).where(remaining_allocation_filter)).first() or 0),
            "return_items": int(session.exec(select(func.count(ReturnItem.id)).where(ReturnItem.item_id == int(source.id))).first() or 0),
            "stock_audit_items": int(session.exec(select(func.count(StockAuditItem.id)).where(StockAuditItem.item_id == int(source.id))).first() or 0),
            "pack_open_events": int(session.exec(select(func.count(PackOpenEvent.id)).where(or_(*pack_open_filters))).first() or 0),
            "child_lots": int(
                session.exec(select(func.count(InventoryLot.id)).where(InventoryLot.opened_from_lot_id.in_(lot_ids))).first() or 0
            )
            if lot_ids
            else 0,
        }
        uncleared_refs = {key: value for key, value in remaining_refs.items() if value}
        if uncleared_refs:
            raise HTTPException(
                status_code=400,
                detail=f"Source batch still has references after club validation: {uncleared_refs}",
            )
        sync_lot_quantity_for_item(session, target, ts=target.updated_at)
        if source_lot:
            source_lot.sealed_qty = 0
            source_lot.loose_qty = 0
            source_lot.is_active = False
            source_lot.updated_at = target.updated_at
            session.add(source_lot)
        sync_lot_quantity_for_item(session, source, ts=source.updated_at)
        apply_archive_rules(session, target)

        target_stock_check = session.exec(
            select(func.coalesce(func.sum(StockMovement.delta), 0)).where(StockMovement.item_id == int(target.id))
        ).first()
        if int(target_stock_check or 0) < 0:
            raise HTTPException(status_code=400, detail="Clubbed target batch would be negative after repair")

        log_audit(
            session,
            entity_type="ITEM",
            entity_id=int(target.id),
            action="OPENING_CLUB",
            note=payload.note
            or f"Clubbed duplicate purchase batch #{source.id} into OP batch #{target.id}",
            details={
                "source_item_id": int(source.id),
                "target_item_id": int(target.id),
                "purchase_id": int(purchase.id),
                "purchase_item_id": int(purchase_item.id),
                "purchase_qty": int(purchase_qty),
                "moved_movement_ids": [int(row.id) for row in movable_source_movements if row.id is not None],
                "deleted_source_purchase_movement_id": deleted_source_purchase_movement_id,
                "remaining_source_refs": remaining_refs,
                "target_stock": int(target_stock_after),
                "adopt_purchase_details": bool(payload.adopt_purchase_details),
                "backup": backup_path,
            },
        )
        session.commit()
        session.refresh(source)
        session.refresh(target)
        _attach_last_incoming(session, [source, target])
        _attach_lot_metadata(session, [source, target])
        return OpeningClubOut(
            source_item=source,
            target_item=target,
            purchase_id=int(purchase.id),
            purchase_item_id=int(purchase_item.id),
            source_item_id=int(source.id),
            target_item_id=int(target.id),
            target_stock=int(target_stock_after),
            archived_source_id=int(source.id),
            moved_movement_count=len(movable_source_movements),
            backup_path=backup_path,
        )


@router.get("/{item_id}", response_model=ItemOut)
def get_item(item_id: int):
    with get_session() as session:
        item = session.get(Item, item_id)
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")
        _attach_last_incoming(session, [item])
        _attach_lot_metadata(session, [item])
        return item


@router.post("/", response_model=ItemOut, status_code=201)
def create_item(
    payload: ItemIn,
    response: Response,
    force_new: bool = Query(True, description="Deprecated; inventory adds always create a separate batch"),
):
    if payload.mrp <= 0:
        raise HTTPException(status_code=400, detail="MRP must be > 0")
    if float(payload.cost_price or 0) < 0:
        raise HTTPException(status_code=400, detail="Cost price cannot be negative")
    if payload.stock is not None and payload.stock < 0:
        raise HTTPException(status_code=400, detail="Stock cannot be negative")
    if payload.rack_number is not None and int(payload.rack_number) < 0:
        raise HTTPException(status_code=400, detail="Rack number cannot be negative")

    name = _norm_str(payload.name) or ""
    brand = _norm_str(payload.brand)
    expiry = _norm_str(payload.expiry_date)
    mrp = float(payload.mrp)
    cost_price = float(payload.cost_price or 0)
    delta_stock = int(payload.stock or 0)
    rack_no = int(payload.rack_number or 0)
    product_id = int(payload.product_id) if payload.product_id is not None else None
    category_id = int(payload.category_id) if payload.category_id is not None else None
    source_item_id = int(payload.source_item_id) if payload.source_item_id is not None else None

    with get_session() as session:
        try:
            source_item: Optional[Item] = None
            source_conversion_qty: Optional[int] = None
            if source_item_id is not None:
                source_item = session.get(Item, source_item_id)
                if not source_item:
                    raise HTTPException(status_code=400, detail=f"Source batch #{source_item_id} not found")
                if product_id is None:
                    product_id = getattr(source_item, "product_id", None)
                if category_id is None:
                    category_id = getattr(source_item, "category_id", None)
                if cost_price <= 0:
                    cost_price = float(getattr(source_item, "cost_price", 0) or 0)
                source_lot = session.exec(
                    select(InventoryLot)
                    .where(InventoryLot.legacy_item_id == source_item_id)
                    .order_by(InventoryLot.id.asc())
                ).first()
                if source_lot:
                    source_conversion_qty = source_lot.conversion_qty

            ts = now_ts()
            item = Item(
                name=name,
                brand=brand,
                product_id=product_id,
                category_id=category_id,
                expiry_date=expiry,
                mrp=mrp,
                cost_price=cost_price,
                stock=delta_stock,
                rack_number=rack_no,
                created_at=ts,
                updated_at=ts,
            )
            session.add(item)
            apply_archive_rules(session, item)
            session.commit()
            session.refresh(item)

            product = session.get(Product, int(product_id)) if product_id is not None else None
            ensure_lot_for_inventory_item(
                session,
                inventory_item=item,
                product=product,
                conversion_qty=source_conversion_qty,
                ts=ts,
            )
            session.commit()
            session.refresh(item)

            if int(item.stock or 0) != 0:
                try:
                    add_movement(
                        session,
                        item_id=item.id,
                        delta=int(item.stock),
                        reason="INVENTORY_ADD",
                        ref_type="ITEM_COPY" if source_item_id is not None else "ITEM_CREATE",
                        ref_id=source_item_id if source_item_id is not None else item.id,
                        note=(
                            f"Separate inventory add copied from batch #{source_item_id}"
                            if source_item_id is not None
                            else "Manual inventory add"
                        ),
                    )
                    session.commit()
                except Exception as e:
                    session.rollback()
                    logger.exception("Ledger insert failed (ignored). Error: %s", e)

            _attach_last_incoming(session, [item])
            _attach_lot_metadata(session, [item])
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
        if "stock" in data:
            raise HTTPException(
                status_code=400,
                detail="Direct stock edits are locked. Use Adjust Stock, purchases, billing, returns, exchanges, loose stock, or stock audit.",
            )

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
        _attach_last_incoming(session, [item])
        _attach_lot_metadata(session, [item])
        return item


@router.delete("/{item_id}", status_code=204)
def delete_item(item_id: int):
    with get_session() as session:
        item = session.get(Item, item_id)
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")
        if int(item.stock or 0) != 0:
            raise HTTPException(
                status_code=400,
                detail="Only zero-stock batches can be archived. Adjust stock to zero first if you really want to retire this batch.",
            )
        item.is_archived = True
        item.updated_at = now_ts()
        session.add(item)
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
            sync_lot_quantity_for_item(session, item, ts=item.updated_at)
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
            _attach_last_incoming(session, [item])
            _attach_lot_metadata(session, [item])
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

        movement_ts = _stock_movement_effective_ts_expr()
        stmt = (
            select(StockMovement, movement_ts.label("effective_ts"))
            .select_from(StockMovement)
            .outerjoin(Purchase, _purchase_stock_movement_join_condition())
            .where(StockMovement.item_id == item_id)
        )

        if from_date:
            stmt = stmt.where(movement_ts >= f"{from_date}T00:00:00")
        if to_date:
            stmt = stmt.where(movement_ts <= f"{to_date}T23:59:59")

        if reason:
            stmt = stmt.where(func.lower(StockMovement.reason) == reason.strip().lower())

        stmt = stmt.order_by(movement_ts.desc(), StockMovement.id.desc()).limit(offset + limit + 1)
        rows = session.exec(stmt).all()

        has_more = len(rows) > offset + limit
        rows_to_balance = rows[:offset + limit]

        to_ts = f"{to_date}T23:59:59" if to_date else None
        running = int(item.stock or 0) - _future_delta_after_effective_ts(session, [int(item_id)], to_ts)
        out: List[StockMovementOut] = []

        for index, row in enumerate(rows_to_balance):
            m = row[0]
            effective_ts = row[1] or m.ts
            after = running
            before = after - int(m.delta or 0)

            if index >= offset:
                out.append(
                    StockMovementOut(
                        id=m.id,
                        ts=effective_ts,
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
