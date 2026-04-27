# F:\medical-inventory\backend\routers\inventory.py

from collections import defaultdict
import logging
from fastapi import APIRouter, HTTPException, Query, Request, Response
from sqlmodel import select
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from pydantic import BaseModel
from backend.utils.archive_rules import apply_archive_rules
from sqlalchemy import case, func, or_, exists
from sqlalchemy.orm import aliased

from backend.db import get_session
from backend.models import (
    Bill,
    BillItem,
    ExchangeRecord,
    Item,
    PackOpenEvent,
    Purchase,
    PurchaseItem,
    Return,
    ReturnItem,
    StockAudit,
    StockAuditItem,
    StockMovement,
)

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
    product_id: Optional[int] = None
    category_id: Optional[int] = None
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


class ItemGroupBatchOut(BaseModel):
    id: int
    name: str
    brand: Optional[str] = None
    expiry_date: Optional[str] = None
    mrp: float
    stock: int
    rack_number: int
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    is_archived: bool = False


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


def _group_key(name: Optional[str], brand: Optional[str]) -> str:
    return f"{(_norm_str(name) or '').lower()}__{(_norm_str(brand) or '').lower()}"


def _load_group_batches(session, *, name: Optional[str], brand: Optional[str]) -> Tuple[str, Optional[str], List[Item]]:
    n = _norm_str(name)
    if not n:
        raise HTTPException(status_code=400, detail="name is required")

    b = _norm_str(brand)
    stmt = _same_group_stmt(n, b).order_by(
        func.coalesce(Item.expiry_date, "9999-12-31").asc(),
        Item.mrp.asc(),
        Item.id.asc(),
    )
    batches = session.exec(stmt).all()
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

    period_stmt = (
        select(
            func.coalesce(func.sum(StockMovement.delta), 0),
            func.coalesce(func.sum(case((StockMovement.delta > 0, StockMovement.delta), else_=0)), 0),
            func.coalesce(func.sum(case((StockMovement.delta < 0, -StockMovement.delta), else_=0)), 0),
            func.count(StockMovement.id),
        )
        .where(StockMovement.item_id.in_(item_ids))
    )
    if from_ts:
        period_stmt = period_stmt.where(StockMovement.ts >= from_ts)
    if to_ts:
        period_stmt = period_stmt.where(StockMovement.ts <= to_ts)
    period_row = session.exec(period_stmt).one()
    net_qty = int(period_row[0] or 0)
    inward_qty = int(period_row[1] or 0)
    outward_qty = int(period_row[2] or 0)
    movement_count = int(period_row[3] or 0)

    future_delta = 0
    if to_ts:
        future_stmt = (
            select(func.coalesce(func.sum(StockMovement.delta), 0))
            .where(StockMovement.item_id.in_(item_ids))
            .where(StockMovement.ts > to_ts)
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
            select(func.max(StockMovement.ts))
            .where(StockMovement.item_id.in_(item_ids))
            .where(func.upper(StockMovement.reason).in_([reason.upper() for reason in reasons]))
        )
        return session.exec(stmt).one()

    last_movement_ts = session.exec(
        select(func.max(StockMovement.ts)).where(StockMovement.item_id.in_(item_ids))
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
@router.get("/", response_model=ItemPageOut)
def list_items(
    request: Request,
    q: Optional[str] = Query(None, description="Search in name/brand"),
    rack_number: Optional[int] = Query(None, ge=0, description="Filter by exact rack number"),
    brand: Optional[str] = Query(None, description="Filter by exact brand"),
    category_id: Optional[int] = Query(None, ge=0, description="Filter by product category"),
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
        if brand:
            base_stmt = base_stmt.where(func.lower(func.coalesce(Item.brand, "")) == brand.strip().lower())
        if category_id is not None:
            base_stmt = base_stmt.where(Item.category_id == category_id)
        

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


@router.get("/group", response_model=ItemGroupOut)
def get_item_group(
    name: str = Query(..., description="Item name (exact match, case-insensitive)"),
    brand: Optional[str] = Query(None, description="Brand (case-insensitive); pass empty for None"),
):
    with get_session() as session:
        n, b, batches = _load_group_batches(session, name=name, brand=brand)
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
                    expiry_date=getattr(batch, "expiry_date", None),
                    mrp=float(batch.mrp or 0),
                    stock=int(batch.stock or 0),
                    rack_number=int(batch.rack_number or 0),
                    created_at=getattr(batch, "created_at", None),
                    updated_at=getattr(batch, "updated_at", None),
                    is_archived=bool(getattr(batch, "is_archived", False)),
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


# ✅✅ IMPORTANT: THIS MUST BE BEFORE /{item_id}
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
        item_ids = [int(x.id) for x in ledger_batches]
        items_by_id = {int(x.id): x for x in ledger_batches}

        current_stock = sum(int(x.stock or 0) for x in ledger_batches)
        key = _group_key(n, b)

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
