from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func
from sqlmodel import select

from backend.accounting import mark_voucher_deleted, post_purchase_return_voucher
from backend.controls import assert_financial_year_unlocked, log_audit
from backend.db import get_session
from backend.models import (
    AuditLog,
    AuditLogOut,
    InventoryLot,
    Item,
    Party,
    Purchase,
    PurchaseItem,
    PurchaseReturn,
    PurchaseReturnCreate,
    PurchaseReturnItem,
    PurchaseReturnItemOut,
    PurchaseReturnOut,
    PurchaseReturnUpdate,
    PurchasePayment,
    StockMovement,
)
from backend.security import require_min_role

router = APIRouter()


def now_ts() -> str:
    return datetime.now().isoformat(timespec="seconds")


def round2(value: float) -> float:
    return float(f"{float(value or 0):.2f}")


def _supplier(session, party_id: int) -> Party:
    party = session.get(Party, party_id)
    if not party or party.party_group != "SUNDRY_CREDITOR":
        raise HTTPException(status_code=400, detail="Purchase supplier is not available")
    return party


def _out(session, row: PurchaseReturn) -> PurchaseReturnOut:
    items = session.exec(
        select(PurchaseReturnItem)
        .where(PurchaseReturnItem.purchase_return_id == row.id)
        .order_by(PurchaseReturnItem.id.asc())
    ).all()
    data = row.model_dump()
    data["purchase_id"] = int(row.purchase_id or 0) or None
    out_items = []
    for item in items:
        item_data = item.model_dump()
        item_data["purchase_item_id"] = int(item.purchase_item_id or 0) or None
        out_items.append(PurchaseReturnItemOut(**item_data))
    return PurchaseReturnOut(**data, items=out_items)


def _snapshot(session, row: PurchaseReturn, items: Optional[List[PurchaseReturnItem]] = None) -> dict:
    if items is None:
        items = session.exec(
            select(PurchaseReturnItem)
            .where(PurchaseReturnItem.purchase_return_id == row.id)
            .order_by(PurchaseReturnItem.id.asc())
        ).all()
    return {
        "purchase_return": {
            "id": int(row.id),
            "purchase_id": int(row.purchase_id or 0) or None,
            "party_id": int(row.party_id),
            "return_number": row.return_number,
            "return_date": row.return_date,
            "notes": row.notes,
            "total_amount": round2(row.total_amount),
            "is_deleted": bool(row.is_deleted),
        },
        "items": [
            {
                "purchase_item_id": int(item.purchase_item_id or 0) or None,
                "inventory_item_id": int(item.inventory_item_id),
                "lot_id": int(item.lot_id) if item.lot_id else None,
                "product_id": int(item.product_id),
                "product_name": item.product_name,
                "quantity": int(item.quantity),
                "unit_cost": round2(item.unit_cost),
                "line_total": round2(item.line_total),
            }
            for item in items
        ],
    }


def active_return_qty(session, purchase_item_id: int, exclude_return_id: Optional[int] = None) -> int:
    stmt = (
        select(func.coalesce(func.sum(PurchaseReturnItem.quantity), 0))
        .join(PurchaseReturn, PurchaseReturn.id == PurchaseReturnItem.purchase_return_id)
        .where(
            PurchaseReturnItem.purchase_item_id == purchase_item_id,
            PurchaseReturn.is_deleted == False,  # noqa: E712
        )
    )
    if exclude_return_id is not None:
        stmt = stmt.where(PurchaseReturn.id != exclude_return_id)
    return int(session.exec(stmt).one() or 0)


def _refresh_purchase_payment_status(session, purchase: Purchase) -> None:
    active_return_total = float(session.exec(
        select(func.coalesce(func.sum(PurchaseReturn.total_amount), 0)).where(
            PurchaseReturn.purchase_id == purchase.id,
            PurchaseReturn.is_deleted == False,  # noqa: E712
        )
    ).one() or 0)
    payments = session.exec(select(PurchasePayment).where(
        PurchasePayment.purchase_id == purchase.id,
        PurchasePayment.is_deleted == False,  # noqa: E712
    )).all()
    paid = round2(sum(float(item.amount or 0) for item in payments if not item.is_writeoff))
    writeoff = round2(sum(float(item.amount or 0) for item in payments if item.is_writeoff))
    net = round2(max(0, float(purchase.total_amount or 0) - active_return_total))
    covered = round2(paid + writeoff)
    purchase.paid_amount = paid
    purchase.writeoff_amount = writeoff
    purchase.payment_status = "PAID" if net <= 0 or covered + 0.0001 >= net else ("UNPAID" if covered <= 0 else "PARTIAL")
    purchase.updated_at = now_ts()
    session.add(purchase)


@router.get("/", response_model=List[PurchaseReturnOut])
def list_purchase_returns(
    purchase_id: Optional[int] = Query(None),
    party_id: Optional[int] = Query(None),
    from_date: Optional[str] = Query(None),
    to_date: Optional[str] = Query(None),
    include_deleted: bool = Query(False),
    limit: int = Query(200, ge=1, le=1000),
) -> List[PurchaseReturnOut]:
    with get_session() as session:
        stmt = select(PurchaseReturn)
        if purchase_id is not None:
            stmt = stmt.where(PurchaseReturn.purchase_id == purchase_id)
        if party_id is not None:
            stmt = stmt.where(PurchaseReturn.party_id == party_id)
        if from_date:
            stmt = stmt.where(PurchaseReturn.return_date >= str(from_date)[:10])
        if to_date:
            stmt = stmt.where(PurchaseReturn.return_date <= str(to_date)[:10])
        if not include_deleted:
            stmt = stmt.where(PurchaseReturn.is_deleted == False)  # noqa: E712
        rows = session.exec(stmt.order_by(PurchaseReturn.return_date.desc(), PurchaseReturn.id.desc()).limit(limit)).all()
        return [_out(session, row) for row in rows]


@router.get("/{return_id}", response_model=PurchaseReturnOut)
def get_purchase_return(return_id: int) -> PurchaseReturnOut:
    with get_session() as session:
        row = session.get(PurchaseReturn, return_id)
        if not row:
            raise HTTPException(status_code=404, detail="Purchase return not found")
        return _out(session, row)


@router.get("/{return_id}/history", response_model=List[AuditLogOut])
def get_purchase_return_history(return_id: int) -> List[AuditLogOut]:
    with get_session() as session:
        if not session.get(PurchaseReturn, return_id):
            raise HTTPException(status_code=404, detail="Purchase return not found")
        return session.exec(
            select(AuditLog).where(
                AuditLog.entity_type == "PURCHASE_RETURN",
                AuditLog.entity_id == return_id,
            ).order_by(AuditLog.id.desc())
        ).all()


@router.post("/", response_model=PurchaseReturnOut, status_code=201)
def create_purchase_return(payload: PurchaseReturnCreate) -> PurchaseReturnOut:
    require_min_role("MANAGER", context="Purchase return")
    with get_session() as session:
        purchase_id = int(payload.purchase_id or 0)
        purchase = session.get(Purchase, purchase_id) if purchase_id > 0 else None
        if purchase_id > 0 and (not purchase or purchase.is_deleted):
            raise HTTPException(status_code=404, detail="Purchase not found")

        return_date = str(payload.return_date or "")[:10]
        assert_financial_year_unlocked(session, return_date, context="Purchase return")
        if purchase and return_date < str(purchase.invoice_date or "")[:10]:
            raise HTTPException(status_code=400, detail="Return date cannot be before the purchase invoice date")
        if not payload.items:
            raise HTTPException(status_code=400, detail="Select at least one item to return")

        party_id = int(purchase.party_id) if purchase else int(payload.party_id or 0)
        if party_id <= 0:
            raise HTTPException(status_code=400, detail="Supplier is required for a no-invoice purchase return")
        supplier = _supplier(session, party_id)
        requested_number = " ".join(str(payload.return_number or "").strip().split())
        if requested_number:
            duplicate = session.exec(
                select(PurchaseReturn).where(func.lower(PurchaseReturn.return_number) == requested_number.lower())
            ).first()
            if duplicate:
                raise HTTPException(status_code=400, detail="Purchase return number already exists")

        row = PurchaseReturn(
            purchase_id=int(purchase.id) if purchase else 0,
            party_id=party_id,
            return_number=requested_number or "PENDING",
            return_date=return_date,
            notes=(str(payload.notes).strip() or None) if payload.notes else None,
            total_amount=0,
        )
        session.add(row)
        session.flush()
        if not requested_number:
            row.return_number = f"PR-{int(row.id):06d}"

        seen = set()
        total = 0.0
        movement_ts = f"{return_date}T00:00:00"
        for raw in payload.items:
            purchase_item_id = int(raw.purchase_item_id or 0)
            if purchase:
                if purchase_item_id <= 0:
                    raise HTTPException(status_code=400, detail="Invoice-linked returns require a purchase item")
                key = ("purchase", purchase_item_id)
                purchase_item = session.get(PurchaseItem, purchase_item_id)
                if not purchase_item or int(purchase_item.purchase_id) != int(purchase.id):
                    raise HTTPException(status_code=400, detail=f"Purchase item #{purchase_item_id} does not belong to this purchase")
                inventory_item = session.get(Item, purchase_item.inventory_item_id)
                lot = session.get(InventoryLot, purchase_item.lot_id) if purchase_item.lot_id else None
                product_id = int(purchase_item.product_id)
                product_name = purchase_item.product_name
                default_cost = purchase_item.effective_cost_price
                purchased_qty = int(purchase_item.sealed_qty or 0) + int(purchase_item.free_qty or 0)
                remaining_returnable = purchased_qty - active_return_qty(session, purchase_item_id)
            else:
                if purchase_item_id > 0:
                    raise HTTPException(status_code=400, detail="No-invoice returns must select an inventory batch")
                inventory_item_id = int(raw.inventory_item_id or 0)
                lot_id = int(raw.lot_id or 0)
                if inventory_item_id <= 0 or lot_id <= 0:
                    raise HTTPException(status_code=400, detail="Inventory item and lot are required for a no-invoice return")
                key = ("inventory", inventory_item_id)
                purchase_item = None
                inventory_item = session.get(Item, inventory_item_id)
                lot = session.get(InventoryLot, lot_id)
                product_id = int(inventory_item.product_id or 0) if inventory_item else 0
                product_name = str(inventory_item.name or "") if inventory_item else "Inventory item"
                default_cost = float(lot.cost_price or inventory_item.cost_price or 0) if lot and inventory_item else 0
                remaining_returnable = min(int(inventory_item.stock or 0), int(lot.sealed_qty or 0)) if inventory_item and lot else 0

            if key in seen:
                raise HTTPException(status_code=400, detail=f"{product_name} was submitted more than once")
            seen.add(key)
            quantity = int(raw.quantity or 0)
            if quantity <= 0:
                raise HTTPException(status_code=400, detail=f"Return quantity for {product_name} must be greater than 0")
            if purchase and quantity > remaining_returnable:
                raise HTTPException(status_code=400, detail=f"Only {remaining_returnable} unit(s) of {product_name} remain returnable")
            if not inventory_item or not lot:
                raise HTTPException(status_code=400, detail=f"{product_name} is missing its inventory batch linkage")
            if int(lot.legacy_item_id or 0) != int(inventory_item.id):
                raise HTTPException(status_code=400, detail=f"{product_name} has inconsistent lot linkage")
            if lot.opened_from_lot_id is not None:
                raise HTTPException(status_code=400, detail=f"{product_name} is loose/opened stock and cannot be returned as a sealed purchase item")
            if quantity > int(inventory_item.stock or 0) or quantity > int(lot.sealed_qty or 0):
                available = min(int(inventory_item.stock or 0), int(lot.sealed_qty or 0))
                raise HTTPException(
                    status_code=400,
                    detail=f"Only {available} unit(s) of {product_name} are currently in stock; sold or opened units cannot be returned",
                )

            unit_cost = round2(raw.unit_cost if raw.unit_cost is not None else default_cost)
            if unit_cost < 0:
                raise HTTPException(status_code=400, detail="Return unit cost cannot be negative")
            line_total = round2(quantity * unit_cost)
            inventory_item.stock = int(inventory_item.stock or 0) - quantity
            inventory_item.is_archived = inventory_item.stock <= 0
            inventory_item.updated_at = now_ts()
            lot.sealed_qty = int(lot.sealed_qty or 0) - quantity
            lot.is_active = lot.sealed_qty > 0 or int(lot.loose_qty or 0) > 0
            lot.updated_at = inventory_item.updated_at
            session.add(inventory_item)
            session.add(lot)
            session.add(
                PurchaseReturnItem(
                    purchase_return_id=int(row.id),
                    purchase_item_id=int(purchase_item.id) if purchase_item else 0,
                    inventory_item_id=int(inventory_item.id),
                    lot_id=int(lot.id),
                    product_id=product_id,
                    product_name=product_name,
                    quantity=quantity,
                    unit_cost=unit_cost,
                    line_total=line_total,
                )
            )
            session.add(
                StockMovement(
                    item_id=int(inventory_item.id),
                    ts=movement_ts,
                    delta=-quantity,
                    reason="PURCHASE_RETURN",
                    ref_type="PURCHASE_RETURN",
                    ref_id=int(row.id),
                    note=(
                        f"Purchase return {row.return_number} against {purchase.invoice_number}"
                        if purchase
                        else f"No-invoice purchase return {row.return_number} to {supplier.name}"
                    ),
                    actor="SYSTEM",
                )
            )
            total = round2(total + line_total)

        if purchase:
            prior_total = float(session.exec(
                select(func.coalesce(func.sum(PurchaseReturn.total_amount), 0)).where(
                    PurchaseReturn.purchase_id == purchase.id,
                    PurchaseReturn.is_deleted == False,  # noqa: E712
                    PurchaseReturn.id != row.id,
                )
            ).one() or 0)
            if round2(prior_total + total) > float(purchase.total_amount or 0) + 0.0001:
                raise HTTPException(status_code=400, detail="Purchase return value cannot exceed the original purchase total")
        row.total_amount = total
        row.updated_at = now_ts()
        session.add(row)
        session.flush()
        log_audit(
            session,
            entity_type="PURCHASE_RETURN",
            entity_id=int(row.id),
            action="CREATE",
            note=f"Created purchase return {row.return_number}",
            details={"after": _snapshot(session, row)},
        )
        if total > 0:
            post_purchase_return_voucher(session, row, supplier)
        if purchase:
            _refresh_purchase_payment_status(session, purchase)
        session.commit()
        session.refresh(row)
        return _out(session, row)


@router.put("/{return_id}", response_model=PurchaseReturnOut)
def update_purchase_return(return_id: int, payload: PurchaseReturnUpdate) -> PurchaseReturnOut:
    require_min_role("MANAGER", context="Purchase return update")
    with get_session() as session:
        row = session.get(PurchaseReturn, return_id)
        if not row:
            raise HTTPException(status_code=404, detail="Purchase return not found")
        if row.is_deleted:
            raise HTTPException(status_code=400, detail="Cancelled purchase returns cannot be edited")
        if not payload.items:
            raise HTTPException(status_code=400, detail="Select at least one item to return")

        assert_financial_year_unlocked(session, row.return_date, context="Purchase return update")
        return_date = str(payload.return_date or row.return_date or "")[:10]
        assert_financial_year_unlocked(session, return_date, context="Purchase return update")

        purchase = session.get(Purchase, row.purchase_id) if int(row.purchase_id or 0) > 0 else None
        if int(row.purchase_id or 0) > 0 and (not purchase or purchase.is_deleted):
            raise HTTPException(status_code=400, detail="The source purchase is not active")
        if purchase and return_date < str(purchase.invoice_date or "")[:10]:
            raise HTTPException(status_code=400, detail="Return date cannot be before the purchase invoice date")

        party_id = int(purchase.party_id) if purchase else int(payload.party_id or row.party_id or 0)
        supplier = _supplier(session, party_id)
        return_number = " ".join(str(payload.return_number or row.return_number or "").strip().split())
        if not return_number:
            raise HTTPException(status_code=400, detail="Purchase return number is required")
        duplicate = session.exec(
            select(PurchaseReturn).where(
                func.lower(PurchaseReturn.return_number) == return_number.lower(),
                PurchaseReturn.id != row.id,
            )
        ).first()
        if duplicate:
            raise HTTPException(status_code=400, detail="Purchase return number already exists")

        old_items = session.exec(
            select(PurchaseReturnItem)
            .where(PurchaseReturnItem.purchase_return_id == row.id)
            .order_by(PurchaseReturnItem.id.asc())
        ).all()
        before_snapshot = _snapshot(session, row, old_items)
        reverse_ts = f"{str(row.return_date)[:10]}T00:00:00"
        edit_ts = f"{return_date}T00:00:00"
        for old_item in old_items:
            inventory_item = session.get(Item, old_item.inventory_item_id)
            lot = session.get(InventoryLot, old_item.lot_id) if old_item.lot_id else None
            if not inventory_item or not lot or int(lot.legacy_item_id or 0) != int(inventory_item.id):
                raise HTTPException(status_code=400, detail=f"Cannot edit {old_item.product_name}; inventory linkage is missing")
            quantity = int(old_item.quantity or 0)
            inventory_item.stock = int(inventory_item.stock or 0) + quantity
            inventory_item.is_archived = False
            inventory_item.updated_at = now_ts()
            lot.sealed_qty = int(lot.sealed_qty or 0) + quantity
            lot.is_active = True
            lot.updated_at = inventory_item.updated_at
            session.add(inventory_item)
            session.add(lot)
            session.add(StockMovement(
                item_id=int(inventory_item.id),
                ts=reverse_ts,
                delta=quantity,
                reason="PURCHASE_RETURN_EDIT_REVERSE",
                ref_type="PURCHASE_RETURN",
                ref_id=int(row.id),
                note=f"Reversed previous lines while editing purchase return {row.return_number}",
                actor="SYSTEM",
            ))
            session.delete(old_item)
        session.flush()

        seen = set()
        total = 0.0
        for raw in payload.items:
            purchase_item_id = int(raw.purchase_item_id or 0)
            if purchase:
                if purchase_item_id <= 0:
                    raise HTTPException(status_code=400, detail="Invoice-linked returns require a purchase item")
                key = ("purchase", purchase_item_id)
                purchase_item = session.get(PurchaseItem, purchase_item_id)
                if not purchase_item or int(purchase_item.purchase_id) != int(purchase.id):
                    raise HTTPException(status_code=400, detail=f"Purchase item #{purchase_item_id} does not belong to this purchase")
                inventory_item = session.get(Item, purchase_item.inventory_item_id)
                lot = session.get(InventoryLot, purchase_item.lot_id) if purchase_item.lot_id else None
                product_id = int(purchase_item.product_id)
                product_name = purchase_item.product_name
                default_cost = purchase_item.effective_cost_price
                purchased_qty = int(purchase_item.sealed_qty or 0) + int(purchase_item.free_qty or 0)
                remaining_returnable = purchased_qty - active_return_qty(session, purchase_item_id, exclude_return_id=int(row.id))
            else:
                if purchase_item_id > 0:
                    raise HTTPException(status_code=400, detail="No-invoice returns must select an inventory batch")
                inventory_item_id = int(raw.inventory_item_id or 0)
                lot_id = int(raw.lot_id or 0)
                if inventory_item_id <= 0 or lot_id <= 0:
                    raise HTTPException(status_code=400, detail="Inventory item and lot are required for a no-invoice return")
                key = ("inventory", inventory_item_id)
                purchase_item = None
                inventory_item = session.get(Item, inventory_item_id)
                lot = session.get(InventoryLot, lot_id)
                product_id = int(inventory_item.product_id or 0) if inventory_item else 0
                product_name = str(inventory_item.name or "") if inventory_item else "Inventory item"
                default_cost = float(lot.cost_price or inventory_item.cost_price or 0) if lot and inventory_item else 0
                remaining_returnable = min(int(inventory_item.stock or 0), int(lot.sealed_qty or 0)) if inventory_item and lot else 0

            if key in seen:
                raise HTTPException(status_code=400, detail=f"{product_name} was submitted more than once")
            seen.add(key)
            quantity = int(raw.quantity or 0)
            if quantity <= 0:
                raise HTTPException(status_code=400, detail=f"Return quantity for {product_name} must be greater than 0")
            if purchase and quantity > remaining_returnable:
                raise HTTPException(status_code=400, detail=f"Only {remaining_returnable} unit(s) of {product_name} remain returnable")
            if not inventory_item or not lot:
                raise HTTPException(status_code=400, detail=f"{product_name} is missing its inventory batch linkage")
            if int(lot.legacy_item_id or 0) != int(inventory_item.id):
                raise HTTPException(status_code=400, detail=f"{product_name} has inconsistent lot linkage")
            if lot.opened_from_lot_id is not None:
                raise HTTPException(status_code=400, detail=f"{product_name} is loose/opened stock and cannot be returned as a sealed purchase item")
            if quantity > int(inventory_item.stock or 0) or quantity > int(lot.sealed_qty or 0):
                available = min(int(inventory_item.stock or 0), int(lot.sealed_qty or 0))
                raise HTTPException(status_code=400, detail=f"Only {available} unit(s) of {product_name} are currently in stock; sold or opened units cannot be returned")

            unit_cost = round2(raw.unit_cost if raw.unit_cost is not None else default_cost)
            if unit_cost < 0:
                raise HTTPException(status_code=400, detail="Return unit cost cannot be negative")
            line_total = round2(quantity * unit_cost)
            inventory_item.stock = int(inventory_item.stock or 0) - quantity
            inventory_item.is_archived = inventory_item.stock <= 0
            inventory_item.updated_at = now_ts()
            lot.sealed_qty = int(lot.sealed_qty or 0) - quantity
            lot.is_active = lot.sealed_qty > 0 or int(lot.loose_qty or 0) > 0
            lot.updated_at = inventory_item.updated_at
            session.add(inventory_item)
            session.add(lot)
            session.add(PurchaseReturnItem(
                purchase_return_id=int(row.id),
                purchase_item_id=int(purchase_item.id) if purchase_item else 0,
                inventory_item_id=int(inventory_item.id),
                lot_id=int(lot.id),
                product_id=product_id,
                product_name=product_name,
                quantity=quantity,
                unit_cost=unit_cost,
                line_total=line_total,
            ))
            session.add(StockMovement(
                item_id=int(inventory_item.id),
                ts=edit_ts,
                delta=-quantity,
                reason="PURCHASE_RETURN_EDIT",
                ref_type="PURCHASE_RETURN",
                ref_id=int(row.id),
                note=f"Edited purchase return {return_number}",
                actor="SYSTEM",
            ))
            total = round2(total + line_total)

        if purchase:
            prior_total = float(session.exec(
                select(func.coalesce(func.sum(PurchaseReturn.total_amount), 0)).where(
                    PurchaseReturn.purchase_id == purchase.id,
                    PurchaseReturn.is_deleted == False,  # noqa: E712
                    PurchaseReturn.id != row.id,
                )
            ).one() or 0)
            if round2(prior_total + total) > float(purchase.total_amount or 0) + 0.0001:
                raise HTTPException(status_code=400, detail="Purchase return value cannot exceed the original purchase total")

        row.party_id = party_id
        row.return_date = return_date
        row.return_number = return_number
        row.notes = (str(payload.notes).strip() or None) if payload.notes else None
        row.total_amount = total
        row.updated_at = now_ts()
        session.add(row)
        if total > 0:
            post_purchase_return_voucher(session, row, supplier)
        else:
            mark_voucher_deleted(session, source_type="PURCHASE_RETURN", source_id=int(row.id))
        if purchase:
            _refresh_purchase_payment_status(session, purchase)
        session.flush()
        log_audit(
            session,
            entity_type="PURCHASE_RETURN",
            entity_id=int(row.id),
            action="UPDATE",
            note=f"Updated purchase return {row.return_number}",
            details={"before": before_snapshot, "after": _snapshot(session, row)},
        )
        session.commit()
        session.refresh(row)
        return _out(session, row)


@router.post("/{return_id}/cancel", response_model=PurchaseReturnOut)
def cancel_purchase_return(return_id: int) -> PurchaseReturnOut:
    require_min_role("MANAGER", context="Purchase return cancel")
    with get_session() as session:
        row = session.get(PurchaseReturn, return_id)
        if not row:
            raise HTTPException(status_code=404, detail="Purchase return not found")
        if row.is_deleted:
            raise HTTPException(status_code=400, detail="Purchase return is already cancelled")
        assert_financial_year_unlocked(session, row.return_date, context="Purchase return cancel")
        purchase = session.get(Purchase, row.purchase_id) if int(row.purchase_id or 0) > 0 else None
        if int(row.purchase_id or 0) > 0 and (not purchase or purchase.is_deleted):
            raise HTTPException(status_code=400, detail="The source purchase is not active")

        items = session.exec(
            select(PurchaseReturnItem)
            .where(PurchaseReturnItem.purchase_return_id == row.id)
            .order_by(PurchaseReturnItem.id.asc())
        ).all()
        before_snapshot = _snapshot(session, row, items)
        movement_ts = f"{str(row.return_date)[:10]}T00:00:00"
        for returned in items:
            inventory_item = session.get(Item, returned.inventory_item_id)
            lot = session.get(InventoryLot, returned.lot_id) if returned.lot_id else None
            if not inventory_item or not lot or int(lot.legacy_item_id or 0) != int(inventory_item.id):
                raise HTTPException(status_code=400, detail=f"Cannot restore {returned.product_name}; inventory linkage is missing")
            quantity = int(returned.quantity or 0)
            inventory_item.stock = int(inventory_item.stock or 0) + quantity
            inventory_item.is_archived = False
            inventory_item.updated_at = now_ts()
            lot.sealed_qty = int(lot.sealed_qty or 0) + quantity
            lot.is_active = True
            lot.updated_at = inventory_item.updated_at
            session.add(inventory_item)
            session.add(lot)
            session.add(
                StockMovement(
                    item_id=int(inventory_item.id),
                    ts=movement_ts,
                    delta=quantity,
                    reason="PURCHASE_RETURN_CANCEL",
                    ref_type="PURCHASE_RETURN",
                    ref_id=int(row.id),
                    note=f"Cancelled purchase return {row.return_number}",
                    actor="SYSTEM",
                )
            )

        row.is_deleted = True
        row.deleted_at = now_ts()
        row.updated_at = row.deleted_at
        session.add(row)
        mark_voucher_deleted(session, source_type="PURCHASE_RETURN", source_id=int(row.id))
        if purchase:
            _refresh_purchase_payment_status(session, purchase)
        session.flush()
        log_audit(
            session,
            entity_type="PURCHASE_RETURN",
            entity_id=int(row.id),
            action="CANCEL",
            note=f"Cancelled purchase return {row.return_number}",
            details={"before": before_snapshot, "after": _snapshot(session, row, items)},
        )
        session.commit()
        session.refresh(row)
        return _out(session, row)
