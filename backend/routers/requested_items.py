# backend/routers/requested_items.py
from typing import List, Optional
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, Response
from sqlmodel import select

from backend.db import get_session
from backend.models import (
    RequestedItem,
    RequestedItemCreate,
    RequestedItemUpdate,
    RequestedItemOut,
)

router = APIRouter()


@router.post("/", response_model=RequestedItemOut)
def create_requested_item(payload: RequestedItemCreate) -> RequestedItemOut:
    with get_session() as session:
        item = RequestedItem(
            customer_name=payload.customer_name,
            mobile=payload.mobile,
            item_name=payload.item_name,
            notes=payload.notes,
        )
        session.add(item)
        session.commit()
        session.refresh(item)
        return item


@router.get("/", response_model=List[RequestedItemOut])
def list_requested_items(
    mobile: Optional[str] = None,
    only_open: bool = Query(
        False, description="If true, return only requests where is_available = False"
    ),
) -> List[RequestedItemOut]:
    with get_session() as session:
        stmt = select(RequestedItem)

        if mobile:
            stmt = stmt.where(RequestedItem.mobile == mobile)

        if only_open:
            stmt = stmt.where(RequestedItem.is_available == False)  # noqa: E712

        stmt = stmt.order_by(RequestedItem.created_at.desc())
        results = session.exec(stmt).all()
        return results


@router.patch("/{request_id}", response_model=RequestedItemOut)
def update_requested_item(request_id: int, payload: RequestedItemUpdate) -> RequestedItemOut:
    with get_session() as session:
        item = session.get(RequestedItem, request_id)
        if not item:
            raise HTTPException(status_code=404, detail="Requested item not found")

        data = payload.dict(exclude_unset=True)
        for key, value in data.items():
            setattr(item, key, value)

        # bump updated_at
        item.updated_at = datetime.now().isoformat(timespec="seconds")

        session.add(item)
        session.commit()
        session.refresh(item)
        return item


@router.delete("/{request_id}", status_code=204)
def delete_requested_item(request_id: int) -> Response:
    """
    Permanently delete a requested item row.
    """
    with get_session() as session:
        item = session.get(RequestedItem, request_id)
        if not item:
            raise HTTPException(status_code=404, detail="Requested item not found")

        session.delete(item)
        session.commit()
        return Response(status_code=204)
