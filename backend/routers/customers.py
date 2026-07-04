from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query, Response
from sqlalchemy import or_, func
from pydantic import BaseModel
from sqlmodel import select

from backend.db import get_session
from backend.inventory_lot_sync import item_stock_meta
from backend.controls import log_audit
from backend.models import (
    Bill,
    BillItem,
    BillItemOut,
    BillOut,
    BillPayment,
    Customer,
    CustomerCreate,
    CustomerUpdate,
    CustomerOut,
    Ledger,
    Party,
    PartyReceipt,
    ReceiptBillAdjustment,
)

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


def _customer_note_conditions(customer: Customer):
    name = _normalize_name(customer.name).lower()
    phone = str(customer.phone or "").strip()
    address = _normalize_name(getattr(customer, "address_line", None)).lower()
    note = func.lower(func.ltrim(func.coalesce(Bill.notes, "")))

    if phone:
        base = f"customer: {name} | {phone}"
        return or_(
            note == base,
            note.like(f"{base} |%"),
            note.like(f"{base}\n%"),
        )
    if address:
        base = f"customer: {name} | {address}"
        return or_(
            note == base,
            note.like(f"{base}\n%"),
        )
    else:
        base = f"customer: {name}"
        return or_(
            note == base,
            note.like(f"{base}\n%"),
        )


def _customer_unlinked_note_candidate_condition(
    customers: List[Customer],
    exclude_matched_customer_notes: bool = True,
):
    note = func.lower(func.ltrim(func.coalesce(Bill.notes, "")))
    conditions = []
    matched_conditions = []
    seen_names = set()
    for customer in customers:
        name = _normalize_name(getattr(customer, "name", None)).lower()
        if not name:
            continue
        matched_conditions.append(_customer_note_conditions(customer))
        if name in seen_names:
            continue
        seen_names.add(name)
        conditions.extend([
            note == name,
            note.like(f"{name} %"),
            note.like(f"{name}\n%"),
            note == f"customer: {name}",
            note.like(f"customer: {name} |%"),
            note.like(f"customer: {name}\n%"),
        ])
    if not conditions:
        return None
    candidate_condition = or_(*conditions)
    if exclude_matched_customer_notes and matched_conditions:
        return candidate_condition & ~(or_(*matched_conditions))
    return candidate_condition


def _unlinked_bill_filter():
    return (
        (Bill.customer_id == None) &  # noqa: E711
        (Bill.party_id == None) &  # noqa: E711
        (Bill.is_deleted == False)  # noqa: E712
    )


def _customer_bill_conditions(session, customer: Customer, include_unlinked_notes: bool = True):
    customer_id = int(customer.id or 0)
    customer_party_id = _customer_party_id(session, customer)
    conditions = [
        Bill.customer_id == customer_id,
    ]
    if include_unlinked_notes:
        conditions.append(
            (Bill.customer_id == None) &  # noqa: E711
            (Bill.party_id == None) &  # noqa: E711
            _customer_note_conditions(customer)
        )
    if customer_party_id is not None:
        conditions.append(Bill.party_id == int(customer_party_id))
    return or_(*conditions)

def _customer_party_id(session, customer: Customer) -> Optional[int]:
    if not customer or not customer.id:
        return None
    party = session.exec(
        select(Party)
        .where(
            Party.party_group == "SUNDRY_DEBTOR",
            Party.legacy_customer_id == int(customer.id),
        )
        .order_by(Party.id.asc())
    ).first()
    if not party:
        customer_name = _normalize_name(customer.name).lower()
        if customer_name:
            party = session.exec(
                select(Party)
                .where(
                    Party.party_group == "SUNDRY_DEBTOR",
                    func.lower(func.trim(func.coalesce(Party.name, ""))) == customer_name,
                )
                .order_by(Party.id.asc())
            ).first()
    return int(party.id) if party and party.id else None


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
        customer_id=getattr(bill, "customer_id", None),
        party_id=getattr(bill, "party_id", None),
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
                **item_stock_meta(session, int(item.item_id or 0)),
            )
            for item in items
        ],
    )


def _round2(value: float) -> float:
    return float(f"{float(value or 0):.2f}")


def _signed_opening_balance(party: Optional[Party]) -> float:
    if not party:
        return 0.0
    amount = _round2(float(getattr(party, "opening_balance", 0.0) or 0.0))
    return -amount if str(getattr(party, "opening_balance_type", "DR") or "DR").upper() == "CR" else amount


def _balance_type(amount: float) -> str:
    return "CR" if _round2(amount) < 0 else "DR"


def _active_receipt_adjusted_amount(session, receipt: PartyReceipt) -> float:
    if not receipt or not receipt.id:
        return 0.0
    rows = session.exec(
        select(ReceiptBillAdjustment).where(ReceiptBillAdjustment.receipt_id == int(receipt.id))
    ).all()
    total = 0.0
    for row in rows:
        if row.bill_payment_id is not None:
            payment = session.get(BillPayment, int(row.bill_payment_id))
            if payment and bool(getattr(payment, "is_deleted", False)):
                continue
        total += float(row.adjusted_amount or 0.0)
    return _round2(total)


def _customer_account_balance_out(session, customer: Customer) -> CustomerOut:
    party_id = _customer_party_id(session, customer)
    party = session.get(Party, int(party_id)) if party_id is not None else None
    bills = session.exec(
        select(Bill)
        .where(_customer_bill_conditions(session, customer))
        .where(Bill.is_deleted == False)  # noqa: E712
    ).all()
    outstanding = _round2(
        sum(
            max(
                0.0,
                float(bill.total_amount or 0.0)
                - float(bill.paid_amount or 0.0)
                - float(getattr(bill, "writeoff_amount", 0.0) or 0.0),
            )
            for bill in bills
        )
    )
    advance = 0.0
    if party_id is not None:
        receipts = session.exec(
            select(PartyReceipt)
            .where(PartyReceipt.party_id == int(party_id))
            .where(PartyReceipt.is_deleted == False)  # noqa: E712
        ).all()
        advance = _round2(
            sum(
                max(
                    0.0,
                    float(receipt.total_amount or 0.0) - _active_receipt_adjusted_amount(session, receipt),
                )
                for receipt in receipts
            )
        )
    opening = _signed_opening_balance(party)
    closing = _round2(opening + outstanding - advance)
    return CustomerOut(
        id=int(customer.id or 0),
        name=customer.name,
        phone=customer.phone,
        address_line=customer.address_line,
        created_at=customer.created_at,
        updated_at=customer.updated_at,
        is_active=bool(getattr(customer, "is_active", True)),
        merged_into_customer_id=getattr(customer, "merged_into_customer_id", None),
        merged_at=getattr(customer, "merged_at", None),
        deleted_at=getattr(customer, "deleted_at", None),
        party_id=int(party_id) if party_id is not None else None,
        opening_balance=abs(_round2(opening)),
        opening_balance_type=_balance_type(opening),
        outstanding_amount=outstanding,
        advance_amount=advance,
        closing_balance=abs(closing),
        closing_balance_type=_balance_type(closing),
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


class MergeCustomersIn(BaseModel):
    keep_customer_id: int
    remove_customer_id: int
    extra_bill_ids: List[int] = []


class MergeCustomersOut(BaseModel):
    keep_customer_id: int
    removed_customer_id: int
    moved_bills: int
    moved_receipts: int
    moved_ledgers: int
    deactivated_party_id: Optional[int] = None


class UnlinkedBillCandidateOut(BaseModel):
    id: int
    date_time: str
    total_amount: float
    payment_status: str
    notes: Optional[str] = None


def _name_exists(session, name: str, exclude_customer_id: Optional[int] = None) -> bool:
    normalized = _normalize_name(name).lower()
    if not normalized:
        return False

    stmt = select(Customer.id).where(
        func.lower(func.trim(func.coalesce(Customer.name, ""))) == normalized,
        Customer.is_active == True,  # noqa: E712
    )
    if exclude_customer_id is not None:
        stmt = stmt.where(Customer.id != int(exclude_customer_id))

    return session.exec(stmt.limit(1)).first() is not None


def _has_bills_for_customer(session, customer: Customer) -> bool:
    normalized = _normalize_name(customer.name).lower()
    if not normalized and not customer.id:
        return False

    stmt = select(Bill.id).where(_customer_bill_conditions(session, customer))
    return session.exec(stmt.limit(1)).first() is not None


def _ensure_customer_party(session, customer: Customer) -> Party:
    party = session.exec(
        select(Party)
        .where(
            Party.party_group == "SUNDRY_DEBTOR",
            Party.legacy_customer_id == int(customer.id or 0),
        )
        .order_by(Party.id.asc())
    ).first()
    now = datetime.now().isoformat(timespec="seconds")
    if party:
        changed = False
        if not party.is_active:
            party.is_active = True
            changed = True
        if party.name != customer.name:
            party.name = customer.name
            changed = True
        if party.phone != customer.phone:
            party.phone = customer.phone
            changed = True
        if party.address_line != customer.address_line:
            party.address_line = customer.address_line
            changed = True
        if changed:
            party.updated_at = now
            session.add(party)
            session.flush()
        return party

    party = session.exec(
        select(Party)
        .where(
            Party.party_group == "SUNDRY_DEBTOR",
            func.lower(func.trim(func.coalesce(Party.name, ""))) == _normalize_name(customer.name).lower(),
        )
        .order_by(Party.id.asc())
    ).first()
    if party:
        party.legacy_customer_id = int(customer.id or 0)
        party.is_active = True
        party.updated_at = now
        session.add(party)
        session.flush()
        return party

    party = Party(
        name=_normalize_name(customer.name) or f"Customer #{customer.id}",
        party_group="SUNDRY_DEBTOR",
        phone=customer.phone,
        address_line=customer.address_line,
        opening_balance=0.0,
        opening_balance_type="DR",
        legacy_customer_id=int(customer.id or 0),
        is_active=True,
        created_at=now,
        updated_at=now,
    )
    session.add(party)
    session.flush()
    return party


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
        return _customer_account_balance_out(session, row)


@router.get("/", response_model=List[CustomerOut])
def list_customers(
    q: Optional[str] = Query(None, description="Search name/phone/address"),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    archived_only: bool = Query(False),
) -> List[CustomerOut]:
    with get_session() as session:
        stmt = select(Customer)
        if archived_only:
            stmt = stmt.where(Customer.is_active == False)  # noqa: E712
        else:
            stmt = stmt.where(Customer.is_active == True)  # noqa: E712
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
        rows = session.exec(stmt).all()
        return [_customer_account_balance_out(session, row) for row in rows]


@router.patch("/{customer_id}", response_model=CustomerOut)
def update_customer(customer_id: int, payload: CustomerUpdate) -> CustomerOut:
    with get_session() as session:
        row = session.get(Customer, customer_id)
        if not row:
            raise HTTPException(status_code=404, detail="Customer not found")

        data = payload.dict(exclude_unset=True)
        if not bool(getattr(row, "is_active", True)):
            raise HTTPException(status_code=400, detail="Archived customer cannot be edited")
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
        return _customer_account_balance_out(session, row)


@router.delete("/{customer_id}", status_code=204)
def delete_customer(customer_id: int) -> Response:
    with get_session() as session:
        row = session.get(Customer, customer_id)
        if not row:
            raise HTTPException(status_code=404, detail="Customer not found")
        if _has_bills_for_customer(session, row):
            raise HTTPException(
                status_code=400,
                detail="Cannot delete customer because bills already exist for this customer",
            )
        row.is_active = False
        row.deleted_at = datetime.now().isoformat(timespec="seconds")
        row.updated_at = row.deleted_at
        session.add(row)
        session.commit()
        return Response(status_code=204)


@router.get("/unlinked-bill-candidates", response_model=List[UnlinkedBillCandidateOut])
def list_unlinked_bill_candidates(
    keep_customer_id: Optional[int] = Query(None),
    remove_customer_id: Optional[int] = Query(None),
) -> List[UnlinkedBillCandidateOut]:
    ids = [int(v) for v in [keep_customer_id, remove_customer_id] if v is not None]
    if not ids:
        return []

    with get_session() as session:
        customers = []
        for customer_id in ids:
            customer = session.get(Customer, customer_id)
            if customer and bool(getattr(customer, "is_active", True)):
                customers.append(customer)

        note_condition = _customer_unlinked_note_candidate_condition(customers)
        if note_condition is None:
            return []

        bills = session.exec(
            select(Bill)
            .where(_unlinked_bill_filter())
            .where(note_condition)
            .order_by(Bill.id.desc())
        ).all()

        return [
            UnlinkedBillCandidateOut(
                id=int(bill.id or 0),
                date_time=bill.date_time,
                total_amount=float(bill.total_amount or 0),
                payment_status=str(bill.payment_status or ""),
                notes=bill.notes,
            )
            for bill in bills
        ]


@router.get("/{customer_id}/summary", response_model=CustomerSummaryOut)
def get_customer_summary(
    customer_id: int,
    include_unlinked_notes: bool = Query(True),
) -> CustomerSummaryOut:
    with get_session() as session:
        customer = session.get(Customer, customer_id)
        if not customer:
            raise HTTPException(status_code=404, detail="Customer not found")

        bills = session.exec(
            select(Bill)
            .where(_customer_bill_conditions(session, customer, include_unlinked_notes=include_unlinked_notes))
            .where(Bill.is_deleted == False)  # noqa: E712
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
            customer=_customer_account_balance_out(session, customer),
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

        bills = session.exec(
            select(Bill)
            .where(_customer_bill_conditions(session, source))
            .where(Bill.is_deleted == False)  # noqa: E712
        ).all()
        if not bills:
            return {
                "moved_count": 0,
                "source_customer_id": source.id,
                "destination_customer_id": destination.id,
            }

        for bill in bills:
            bill.customer_id = int(destination.id)
            bill.party_id = _customer_party_id(session, destination)
            bill.notes = _replace_customer_note(bill.notes, destination)
            session.add(bill)

        session.commit()
        return {
            "moved_count": len(bills),
            "source_customer_id": source.id,
            "destination_customer_id": destination.id,
        }


@router.post("/merge", response_model=MergeCustomersOut)
def merge_customers(payload: MergeCustomersIn) -> MergeCustomersOut:
    keep_id = int(payload.keep_customer_id)
    remove_id = int(payload.remove_customer_id)
    if keep_id == remove_id:
        raise HTTPException(status_code=400, detail="Keep and remove customer must be different")

    with get_session() as session:
        keep = session.get(Customer, keep_id)
        remove = session.get(Customer, remove_id)
        if not keep:
            raise HTTPException(status_code=404, detail="Keep customer not found")
        if not remove:
            raise HTTPException(status_code=404, detail="Remove customer not found")
        if not bool(getattr(keep, "is_active", True)):
            raise HTTPException(status_code=400, detail="Keep customer is archived")
        if not bool(getattr(remove, "is_active", True)):
            raise HTTPException(status_code=400, detail="Remove customer is already archived")

        now = datetime.now().isoformat(timespec="seconds")
        keep_party = _ensure_customer_party(session, keep)
        remove_party = session.exec(
            select(Party)
            .where(
                Party.party_group == "SUNDRY_DEBTOR",
                Party.legacy_customer_id == remove_id,
            )
            .order_by(Party.id.asc())
        ).first()

        bill_conditions = [_customer_bill_conditions(session, remove)]
        if remove_party and remove_party.id:
            bill_conditions.append(Bill.party_id == int(remove_party.id))
        bills = session.exec(select(Bill).where(or_(*bill_conditions))).all()

        extra_bill_ids = sorted({int(bill_id) for bill_id in payload.extra_bill_ids if int(bill_id) > 0})
        if extra_bill_ids:
            note_condition = _customer_unlinked_note_candidate_condition([keep, remove])
            if note_condition is None:
                raise HTTPException(status_code=400, detail="Selected unlinked bills do not match these customers")

            allowed_extra_ids = set(
                int(bill_id)
                for bill_id in session.exec(
                    select(Bill.id)
                    .where(Bill.id.in_(extra_bill_ids))
                    .where(_unlinked_bill_filter())
                    .where(note_condition)
                ).all()
                if bill_id is not None
            )
            invalid_extra_ids = [bill_id for bill_id in extra_bill_ids if bill_id not in allowed_extra_ids]
            if invalid_extra_ids:
                raise HTTPException(
                    status_code=400,
                    detail=f"Selected unlinked bills are no longer available: {', '.join(str(v) for v in invalid_extra_ids)}",
                )

            existing_bill_ids = {int(bill.id or 0) for bill in bills}
            extra_bills = session.exec(select(Bill).where(Bill.id.in_(extra_bill_ids))).all()
            bills.extend([bill for bill in extra_bills if int(bill.id or 0) not in existing_bill_ids])

        keep_bill_ids = set(
            int(bill_id)
            for bill_id in session.exec(
                select(Bill.id).where(_customer_bill_conditions(session, keep, include_unlinked_notes=False))
            ).all()
            if bill_id is not None
        )

        moved_bills = 0
        normalized_overlapping_bills = 0

        for bill in bills:
            bill_id = int(bill.id or 0)
            already_visible_under_keep = bill_id in keep_bill_ids
            old_customer_id = getattr(bill, "customer_id", None)
            old_party_id = getattr(bill, "party_id", None)
            old_notes = bill.notes

            bill.customer_id = keep_id
            bill.party_id = int(keep_party.id or 0)
            bill.notes = _replace_customer_note(bill.notes, keep)
            session.add(bill)
            if already_visible_under_keep:
                if old_customer_id != bill.customer_id or old_party_id != bill.party_id or old_notes != bill.notes:
                    normalized_overlapping_bills += 1
            else:
                moved_bills += 1

        moved_receipts = 0
        if remove_party and remove_party.id:
            receipts = session.exec(
                select(PartyReceipt).where(PartyReceipt.party_id == int(remove_party.id))
            ).all()
            for receipt in receipts:
                receipt.party_id = int(keep_party.id or 0)
                session.add(receipt)
                moved_receipts += 1

        moved_ledgers = 0
        if remove_party and remove_party.id:
            ledgers = session.exec(select(Ledger).where(Ledger.party_id == int(remove_party.id))).all()
            for ledger in ledgers:
                ledger.party_id = int(keep_party.id or 0)
                ledger.updated_at = datetime.now().isoformat(timespec="seconds")
                session.add(ledger)
                moved_ledgers += 1

            remove_party.legacy_customer_id = None
            remove_party.is_active = False
            remove_party.notes = (
                f"{remove_party.notes or ''}\nMerged into customer #{keep_id} on {now}"
            ).strip()
            remove_party.updated_at = now
            session.add(remove_party)

        log_audit(
            session,
            entity_type="CUSTOMER",
            entity_id=keep_id,
            action="MERGE",
            note=f"Merged customer #{remove_id} into #{keep_id}",
            details={
                "keep_customer_id": keep_id,
                "remove_customer_id": remove_id,
                "keep_name": keep.name,
                "remove_name": remove.name,
                "moved_bills": moved_bills,
                "normalized_overlapping_bills": normalized_overlapping_bills,
                "moved_receipts": moved_receipts,
                "moved_ledgers": moved_ledgers,
                "removed_party_id": int(remove_party.id) if remove_party and remove_party.id else None,
                "keep_party_id": int(keep_party.id or 0),
            },
        )
        remove.is_active = False
        remove.merged_into_customer_id = keep_id
        remove.merged_at = now
        remove.deleted_at = now
        remove.updated_at = now

        session.add(remove)

        session.commit()
        return MergeCustomersOut(
            keep_customer_id=keep_id,
            removed_customer_id=remove_id,
            moved_bills=moved_bills,
            moved_receipts=moved_receipts,
            moved_ledgers=moved_ledgers,
            deactivated_party_id=int(remove_party.id) if remove_party and remove_party.id else None,
        )
