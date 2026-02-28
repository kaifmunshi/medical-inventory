from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query, Response
from sqlalchemy import or_, func
from sqlmodel import select

from backend.db import get_session
from backend.models import Bill, Customer, CustomerCreate, CustomerUpdate, CustomerOut

router = APIRouter()

def _normalize_phone(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    raw = str(v).strip()
    if raw == "":
        return None
    digits = "".join(ch for ch in raw if ch.isdigit())
    if len(digits) > 10:
        raise HTTPException(status_code=400, detail="Phone must be at most 10 digits")
    return digits if digits else None


def _normalize_name(v: Optional[str]) -> str:
    return " ".join(str(v or "").strip().split())


def _name_exists(session, name: str, exclude_customer_id: Optional[int] = None) -> bool:
    normalized = _normalize_name(name).lower()
    if not normalized:
        return False

    stmt = select(Customer.id).where(
        func.lower(func.trim(func.coalesce(Customer.name, ""))) == normalized
    )
    if exclude_customer_id is not None:
        stmt = stmt.where(Customer.id != int(exclude_customer_id))

    return session.exec(stmt.limit(1)).first() is not None


def _has_bills_for_customer(session, customer_name: str) -> bool:
    normalized = _normalize_name(customer_name).lower()
    if not normalized:
        return False

    # Customer note format in billing flows:
    # "Customer: <name>" OR "Customer: <name> | ..." (first line of bill notes)
    note = func.lower(func.ltrim(func.coalesce(Bill.notes, "")))
    base = f"customer: {normalized}"
    stmt = select(Bill.id).where(
        or_(
            note == base,
            note.like(f"{base} |%"),
            note.like(f"{base}\n%"),
        )
    )
    return session.exec(stmt.limit(1)).first() is not None


@router.post("/", response_model=CustomerOut, status_code=201)
def create_customer(payload: CustomerCreate) -> CustomerOut:
    name = _normalize_name(payload.name)
    if not name:
        raise HTTPException(status_code=400, detail="Customer name is required")

    phone = _normalize_phone(payload.phone)

    address_line = str(payload.address_line).strip() if payload.address_line is not None else None
    if address_line == "":
        address_line = None

    now = datetime.now().isoformat(timespec="seconds")

    with get_session() as session:
        if _name_exists(session, name):
            raise HTTPException(status_code=400, detail="Customer name already exists")

        row = Customer(
            name=name,
            phone=phone,
            address_line=address_line,
            created_at=now,
            updated_at=now,
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        return row


@router.get("/", response_model=List[CustomerOut])
def list_customers(
    q: Optional[str] = Query(None, description="Search name/phone/address"),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> List[CustomerOut]:
    with get_session() as session:
        stmt = select(Customer)
        qq = (q or "").strip()
        if qq:
            like = f"%{qq.lower()}%"
            stmt = stmt.where(
                or_(
                    func.lower(func.coalesce(Customer.name, "")).like(like),
                    func.lower(func.coalesce(Customer.phone, "")).like(like),
                    func.lower(func.coalesce(Customer.address_line, "")).like(like),
                )
            )
        stmt = (
            stmt.order_by(
                func.lower(func.coalesce(Customer.name, "")).asc(),
                Customer.id.desc(),
            )
            .offset(offset)
            .limit(limit)
        )
        return session.exec(stmt).all()


@router.patch("/{customer_id}", response_model=CustomerOut)
def update_customer(customer_id: int, payload: CustomerUpdate) -> CustomerOut:
    with get_session() as session:
        row = session.get(Customer, customer_id)
        if not row:
            raise HTTPException(status_code=404, detail="Customer not found")

        data = payload.dict(exclude_unset=True)
        if "name" in data:
            nm = _normalize_name(data.get("name"))
            if not nm:
                raise HTTPException(status_code=400, detail="Customer name is required")
            if _name_exists(session, nm, exclude_customer_id=customer_id):
                raise HTTPException(status_code=400, detail="Customer name already exists")
            row.name = nm
        if "phone" in data:
            row.phone = _normalize_phone(data.get("phone"))
        if "address_line" in data:
            addr = data.get("address_line")
            row.address_line = str(addr).strip() if addr is not None and str(addr).strip() != "" else None

        row.updated_at = datetime.now().isoformat(timespec="seconds")
        session.add(row)
        session.commit()
        session.refresh(row)
        return row


@router.delete("/{customer_id}", status_code=204)
def delete_customer(customer_id: int) -> Response:
    with get_session() as session:
        row = session.get(Customer, customer_id)
        if not row:
            raise HTTPException(status_code=404, detail="Customer not found")
        if _has_bills_for_customer(session, row.name):
            raise HTTPException(
                status_code=400,
                detail="Cannot delete customer because bills already exist for this customer",
            )
        session.delete(row)
        session.commit()
        return Response(status_code=204)
