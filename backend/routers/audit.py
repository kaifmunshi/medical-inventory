from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from sqlmodel import select

from backend.controls import assert_financial_year_unlocked, log_audit
from backend.db import get_session
from backend.models import (
    Item,
    StockAudit,
    StockAuditCreate,
    StockAuditItem,
    StockAuditItemOut,
    StockAuditOut,
    StockMovement,
)
from backend.security import require_min_role

router = APIRouter()


def now_ts() -> str:
    return datetime.now().isoformat(timespec="seconds")


@router.post("/", response_model=StockAuditOut, status_code=201)
def create_stock_audit(payload: StockAuditCreate):
    require_min_role("MANAGER", context="Create stock audit")
    name = str(payload.name).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Audit name is required")

    with get_session() as session:
        assert_financial_year_unlocked(session, now_ts(), context="Create stock audit")

        audit = StockAudit(
            name=name,
            status="DRAFT",
            created_at=now_ts(),
        )
        session.add(audit)
        session.flush()

        # Snapshot all current non-deleted items
        items = session.exec(select(Item).where(Item.is_deleted == False)).all()  # noqa: E712
        for item in items:
            ai = StockAuditItem(
                audit_id=int(audit.id),
                item_id=int(item.id),
                system_stock=item.stock,
                physical_stock=None,
            )
            session.add(ai)

        log_audit(
            session,
            entity_type="STOCK_AUDIT",
            entity_id=int(audit.id),
            action="CREATE",
            note=f"Created Stock Audit: {name}",
            details={"item_count": len(items)},
        )

        session.commit()
        session.refresh(audit)
        return audit


@router.get("/", response_model=List[StockAuditOut])
def list_stock_audits():
    with get_session() as session:
        audits = session.exec(select(StockAudit).order_by(StockAudit.id.desc())).all()
        return audits


@router.get("/{audit_id}", response_model=StockAuditOut)
def get_stock_audit(audit_id: int):
    with get_session() as session:
        audit = session.get(StockAudit, audit_id)
        if not audit:
            raise HTTPException(status_code=404, detail="Audit not found")
        return audit


@router.get("/{audit_id}/items", response_model=List[StockAuditItemOut])
def get_stock_audit_items(audit_id: int):
    with get_session() as session:
        audit = session.get(StockAudit, audit_id)
        if not audit:
            raise HTTPException(status_code=404, detail="Audit not found")

        # Join to get Item details alongside the frozen stock numbers
        results = session.exec(
            select(StockAuditItem, Item)
            .join(Item, StockAuditItem.item_id == Item.id)
            .where(StockAuditItem.audit_id == audit_id)
        ).all()

        out = []
        for ai, item in results:
            out.append(
                StockAuditItemOut(
                    id=int(ai.id),
                    audit_id=int(ai.audit_id),
                    item_id=int(ai.item_id),
                    system_stock=ai.system_stock,
                    physical_stock=ai.physical_stock,
                    item_name=item.name,
                    item_brand=item.brand,
                    item_rack=item.rack_number,
                    item_mrp=item.mrp,
                    item_expiry=item.expiry_date,
                )
            )
        return out


@router.patch("/{audit_id}/items/{item_id}")
def update_physical_stock(audit_id: int, item_id: int, physical_stock: int):
    require_min_role("MANAGER", context="Update physical stock")
    if physical_stock < 0:
        raise HTTPException(status_code=400, detail="Physical stock cannot be negative")

    with get_session() as session:
        audit = session.get(StockAudit, audit_id)
        if not audit:
            raise HTTPException(status_code=404, detail="Audit not found")
        if audit.status != "DRAFT":
            raise HTTPException(status_code=400, detail="Cannot edit a finalized audit")

        # item_id here is actually StockAuditItem.id or Item.id? Let's assume passed param is StockAuditItem.id
        ai = session.get(StockAuditItem, item_id)
        if not ai or ai.audit_id != audit_id:
            raise HTTPException(status_code=404, detail="Audit item not found")

        ai.physical_stock = physical_stock
        session.add(ai)
        session.commit()
        return {"ok": True}


@router.post("/{audit_id}/finalize", response_model=StockAuditOut)
def finalize_stock_audit(audit_id: int):
    require_min_role("MANAGER", context="Finalize stock audit")
    with get_session() as session:
        audit = session.get(StockAudit, audit_id)
        if not audit:
            raise HTTPException(status_code=404, detail="Audit not found")
        if audit.status == "FINALIZED":
            raise HTTPException(status_code=400, detail="Audit is already finalized")

        assert_financial_year_unlocked(session, now_ts(), context="Finalize stock audit")

        items = session.exec(select(StockAuditItem).where(StockAuditItem.audit_id == audit_id)).all()
        
        adjustments_made = 0
        for ai in items:
            if ai.physical_stock is None:
                continue
            
            diff = ai.physical_stock - ai.system_stock
            if diff != 0:
                item = session.get(Item, ai.item_id)
                if item:
                    item.stock = item.stock + diff
                    item.updated_at = now_ts()
                    session.add(item)
                    
                    sm = StockMovement(
                        item_id=int(item.id),
                        ts=now_ts(),
                        delta=diff,
                        reason="ADJUST",
                        ref_type="AUDIT",
                        ref_id=audit_id,
                        note=f"Audit discrepancy: System={ai.system_stock}, Physical={ai.physical_stock}",
                        actor="SYSTEM"
                    )
                    session.add(sm)
                    adjustments_made += 1

        audit.status = "FINALIZED"
        audit.closed_at = now_ts()
        session.add(audit)

        log_audit(
            session,
            entity_type="STOCK_AUDIT",
            entity_id=int(audit.id),
            action="FINALIZE",
            note=f"Finalized Stock Audit: {audit.name}",
            details={"adjustments_made": adjustments_made},
        )

        session.commit()
        session.refresh(audit)
        return audit
