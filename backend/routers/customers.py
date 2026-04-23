from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query, Response
from sqlalchemy import or_, func
from pydantic import BaseModel
from sqlmodel import select

from backend.db import get_session
from backend.models import Bill, BillItem, BillItemOut, BillOut, Customer, CustomerCreate, CustomerUpdate, CustomerOut

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


def _customer_note_conditions(customer_name: str):
    normalized = _normalize_name(customer_name).lower()
    note = func.lower(func.ltrim(func.coalesce(Bill.notes, "")))
    base = f"customer: {normalized}"
    return or_(
        note == base,
        note.like(f"{base} |%"),
        note.like(f"{base}\n%"),
    )


def _extract_free_notes(raw: Optional[str]) -> str:
    lines = str(raw or "").splitlines()
    if not lines:
        return ""
    first = str(lines[0] or "").strip()
    if not first.lower().startswith("customer:"):
        return str(raw or "").strip()
    return "\n".join(lines[1:]).strip()


def _build_customer_note(customer: Customer) -> str:
    parts = [str(customer.name or "").strip()]
    if customer.phone:
        parts.append(str(customer.phone).strip())
    if customer.address_line:
        parts.append(str(customer.address_line).strip())
    return f"Customer: {' | '.join([part for part in parts if part])}"


def _replace_customer_note(raw: Optional[str], customer: Customer) -> str:
    customer_line = _build_customer_note(customer)
    free_notes = _extract_free_notes(raw)
    return f"{customer_line}\n{free_notes}".strip() if free_notes else customer_line


def _to_bill_out(session, bill: Bill) -> BillOut:
    items = session.exec(select(BillItem).where(BillItem.bill_id == bill.id)).all()
    return BillOut(
        id=bill.id,
        date_time=bill.date_time,
        discount_percent=bill.discount_percent,
        subtotal=bill.subtotal,
        total_amount=bill.total_amount,
        payment_mode=bill.payment_mode,
        payment_cash=bill.payment_cash,
        payment_online=bill.payment_online,
        notes=bill.notes,
        is_credit=bill.is_credit,
        payment_status=bill.payment_status,
        paid_amount=bill.paid_amount,
        paid_at=bill.paid_at,
        is_deleted=bill.is_deleted,
        deleted_at=bill.deleted_at,
        items=[
            BillItemOut(
                item_id=item.item_id,
                item_name=item.item_name,
                mrp=item.mrp,
                quantity=item.quantity,
                line_total=item.line_total,
            )
            for item in items
        ],
    )


class CustomerSummaryTotalsOut(BaseModel):
    total_bills: int
    active_bills: int
    deleted_bills: int
    paid_bills: int
    partial_bills: int
    unpaid_bills: int
    total_sales: float
    total_paid: float
    total_pending: float


class CustomerSummaryOut(BaseModel):
    customer: CustomerOut
    totals: CustomerSummaryTotalsOut
    bills: List[BillOut]


class MoveCustomerBillsIn(BaseModel):
    source_customer_id: int
    destination_customer_id: int


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

    stmt = select(Bill.id).where(_customer_note_conditions(customer_name))
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


@router.get("/{customer_id}/summary", response_model=CustomerSummaryOut)
def get_customer_summary(customer_id: int) -> CustomerSummaryOut:
    with get_session() as session:
        customer = session.get(Customer, customer_id)
        if not customer:
            raise HTTPException(status_code=404, detail="Customer not found")

        bills = session.exec(
            select(Bill)
            .where(_customer_note_conditions(customer.name))
            .order_by(Bill.id.desc())
        ).all()

        total_sales = round(sum(float(b.total_amount or 0) for b in bills), 2)
        total_paid = round(sum(float(b.paid_amount or 0) for b in bills), 2)
        total_pending = round(
            sum(
                max(
                    0.0,
                    float(b.total_amount or 0) - float(b.paid_amount or 0) - float(getattr(b, "writeoff_amount", 0.0) or 0),
                )
                for b in bills
            ),
            2,
        )

        totals = CustomerSummaryTotalsOut(
            total_bills=len(bills),
            active_bills=sum(1 for b in bills if not bool(getattr(b, "is_deleted", False))),
            deleted_bills=sum(1 for b in bills if bool(getattr(b, "is_deleted", False))),
            paid_bills=sum(1 for b in bills if str(getattr(b, "payment_status", "")).upper() == "PAID"),
            partial_bills=sum(1 for b in bills if str(getattr(b, "payment_status", "")).upper() == "PARTIAL"),
            unpaid_bills=sum(1 for b in bills if str(getattr(b, "payment_status", "")).upper() == "UNPAID"),
            total_sales=total_sales,
            total_paid=total_paid,
            total_pending=total_pending,
        )

        return CustomerSummaryOut(
            customer=CustomerOut(
                id=customer.id,
                name=customer.name,
                phone=customer.phone,
                address_line=customer.address_line,
                created_at=customer.created_at,
                updated_at=customer.updated_at,
            ),
            totals=totals,
            bills=[_to_bill_out(session, bill) for bill in bills],
        )


@router.post("/move-bills")
def move_customer_bills(payload: MoveCustomerBillsIn):
    if int(payload.source_customer_id) == int(payload.destination_customer_id):
        raise HTTPException(status_code=400, detail="Source and destination customer must be different")

    with get_session() as session:
        source = session.get(Customer, int(payload.source_customer_id))
        destination = session.get(Customer, int(payload.destination_customer_id))
        if not source:
            raise HTTPException(status_code=404, detail="Source customer not found")
        if not destination:
            raise HTTPException(status_code=404, detail="Destination customer not found")

        bills = session.exec(select(Bill).where(_customer_note_conditions(source.name))).all()
        if not bills:
            return {
                "moved_count": 0,
                "source_customer_id": source.id,
                "destination_customer_id": destination.id,
            }

        for bill in bills:
            bill.notes = _replace_customer_note(bill.notes, destination)
            session.add(bill)

        session.commit()
        return {
            "moved_count": len(bills),
            "source_customer_id": source.id,
            "destination_customer_id": destination.id,
        }
