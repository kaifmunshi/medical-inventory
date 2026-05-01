from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query, Response
from sqlalchemy import func, or_
from sqlmodel import select

from backend.accounting import mark_voucher_deleted, post_party_receipt_voucher
from backend.controls import assert_financial_year_unlocked, log_audit
from backend.db import get_session
from backend.models import (
    Bill,
    BillPayment,
    Customer,
    DebtorLedgerRow,
    OpenBillOut,
    Party,
    PartyCreate,
    PartyOut,
    PartyReceipt,
    PartyReceiptCreate,
    PartyReceiptOut,
    PartyUpdate,
    ReceiptBillAdjustment,
    ReceiptBillAdjustmentOut,
)
from backend.security import require_min_role

router = APIRouter()


def _normalize_text(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    value = " ".join(str(v).strip().split())
    return value or None


def _normalize_name(v: Optional[str]) -> str:
    return _normalize_text(v) or ""


def _normalize_phone(v: Optional[str]) -> Optional[str]:
    raw = _normalize_text(v)
    if not raw:
        return None
    digits = "".join(ch for ch in raw if ch.isdigit())
    if len(digits) > 10:
        raise HTTPException(status_code=400, detail="Phone must be at most 10 digits")
    return digits or None


def _normalize_group(v: Optional[str]) -> str:
    group = _normalize_name(v).upper()
    if group not in {"SUNDRY_DEBTOR", "SUNDRY_CREDITOR"}:
        raise HTTPException(status_code=400, detail="party_group must be SUNDRY_DEBTOR or SUNDRY_CREDITOR")
    return group


def _party_exists(session, *, name: str, party_group: str, exclude_id: Optional[int] = None) -> bool:
    stmt = select(Party.id).where(
        func.lower(func.trim(func.coalesce(Party.name, ""))) == name.lower(),
        Party.party_group == party_group,
    )
    if exclude_id is not None:
        stmt = stmt.where(Party.id != int(exclude_id))
    return session.exec(stmt.limit(1)).first() is not None


def _customer_note_matches_expr(name: str):
    normalized = _normalize_name(name).lower()
    note = func.lower(func.ltrim(func.coalesce(Bill.notes, "")))
    base = f"customer: {normalized}"
    return or_(
        note == base,
        note.like(f"{base} |%"),
        note.like(f"{base}\n%"),
    )


def _round2(x: float) -> float:
    return float(f"{float(x or 0):.2f}")


def _as_float(value) -> float:
    try:
        if value is None:
            return 0.0
        return float(value)
    except Exception:
        return 0.0


def _recalculate_bill_payment_state(session, bill: Bill) -> None:
    payments = session.exec(
        select(BillPayment).where(
            BillPayment.bill_id == bill.id,
            BillPayment.is_deleted == False,  # noqa: E712
        )
    ).all()
    receipt_payments = [payment for payment in payments if not bool(getattr(payment, "is_writeoff", False))]
    writeoff_payments = [payment for payment in payments if bool(getattr(payment, "is_writeoff", False))]

    total_cash = _round2(sum(_as_float(payment.cash_amount) for payment in receipt_payments))
    total_online = _round2(sum(_as_float(payment.online_amount) for payment in receipt_payments))
    total_paid = _round2(total_cash + total_online)
    total_writeoff = _round2(sum(_as_float(getattr(payment, "writeoff_amount", 0.0)) for payment in writeoff_payments))
    bill_total = _round2(_as_float(bill.total_amount))
    covered = _round2(total_paid + total_writeoff)

    bill.payment_cash = total_cash
    bill.payment_online = total_online
    bill.paid_amount = total_paid
    bill.writeoff_amount = total_writeoff

    if covered <= 0:
        bill.payment_status = "UNPAID"
        bill.paid_at = None
        bill.is_credit = True
    elif covered + 0.0001 < bill_total:
        bill.payment_status = "PARTIAL"
        bill.paid_at = None
        bill.is_credit = True
    else:
        bill.payment_status = "PAID"
        latest_paid_at = max((str(payment.received_at or "") for payment in payments), default="")
        bill.paid_at = latest_paid_at or None
        bill.is_credit = False


def _sync_customer_debtor_parties(session) -> None:
    customers = session.exec(select(Customer).order_by(Customer.id.asc())).all()
    dirty = False
    ts = datetime.now().isoformat(timespec="seconds")
    for customer in customers:
        customer_name = _normalize_name(customer.name)
        if not customer_name:
            continue
        party = session.exec(
            select(Party).where(
                Party.party_group == "SUNDRY_DEBTOR",
                Party.legacy_customer_id == int(customer.id),
            )
        ).first()
        if not party:
            party = session.exec(
                select(Party).where(
                    Party.party_group == "SUNDRY_DEBTOR",
                    func.lower(func.trim(func.coalesce(Party.name, ""))) == customer_name.lower(),
                )
            ).first()
        next_phone = _normalize_phone(customer.phone)
        next_address = _normalize_text(customer.address_line)
        if not party:
            session.add(
                Party(
                    name=customer_name,
                    party_group="SUNDRY_DEBTOR",
                    phone=next_phone,
                    address_line=next_address,
                    gst_number=None,
                    notes=None,
                    opening_balance=0.0,
                    opening_balance_type="DR",
                    legacy_customer_id=int(customer.id),
                    is_active=True,
                    created_at=ts,
                    updated_at=ts,
                )
            )
            dirty = True
            continue
        changed = False
        if int(getattr(party, "legacy_customer_id", 0) or 0) != int(customer.id):
            party.legacy_customer_id = int(customer.id)
            changed = True
        if _normalize_name(party.name) != customer_name:
            party.name = customer_name
            changed = True
        if _normalize_phone(party.phone) != next_phone:
            party.phone = next_phone
            changed = True
        if _normalize_text(party.address_line) != next_address:
            party.address_line = next_address
            changed = True
        if changed:
            party.updated_at = ts
            session.add(party)
            dirty = True
    if dirty:
        session.commit()


def _party_customer_name(session, party: Party) -> str:
    customer_id = int(getattr(party, "legacy_customer_id", 0) or 0)
    if customer_id > 0:
        customer = session.get(Customer, customer_id)
        if customer and _normalize_name(customer.name):
            return _normalize_name(customer.name)
    return _normalize_name(party.name)


def _normalize_payment_ts(raw: Optional[str]) -> str:
    if not raw:
        return datetime.now().isoformat(timespec="seconds")
    s = str(raw).strip().replace(" ", "T")
    if len(s) == 10:
        s = f"{s}T00:00:00"
    try:
        return datetime.fromisoformat(s).isoformat(timespec="seconds")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid payment_date. Use YYYY-MM-DD")


def _validate_receipt_mode(mode: str, cash_amount: float, online_amount: float) -> tuple[float, float, float]:
    normalized = str(mode or "").strip().lower()
    cash = _round2(cash_amount)
    online = _round2(online_amount)
    if normalized not in {"cash", "online", "split"}:
        raise HTTPException(status_code=400, detail="mode must be cash, online, or split")
    if normalized == "cash" and online != 0:
        raise HTTPException(status_code=400, detail="online_amount must be 0 for cash mode")
    if normalized == "online" and cash != 0:
        raise HTTPException(status_code=400, detail="cash_amount must be 0 for online mode")
    total = _round2(cash + online)
    if total <= 0:
        raise HTTPException(status_code=400, detail="Receipt total must be greater than 0")
    return cash, online, total


@router.post("/", response_model=PartyOut, status_code=201)
def create_party(payload: PartyCreate) -> PartyOut:
    require_min_role("MANAGER", context="Party creation")
    name = _normalize_name(payload.name)
    if not name:
        raise HTTPException(status_code=400, detail="Party name is required")

    party_group = _normalize_group(payload.party_group)
    now = datetime.now().isoformat(timespec="seconds")

    with get_session() as session:
        if _party_exists(session, name=name, party_group=party_group):
            raise HTTPException(status_code=400, detail="Party already exists in this group")

        row = Party(
            name=name,
            party_group=party_group,
            phone=_normalize_phone(payload.phone),
            address_line=_normalize_text(payload.address_line),
            gst_number=_normalize_text(payload.gst_number),
            notes=_normalize_text(payload.notes),
            opening_balance=float(payload.opening_balance or 0),
            opening_balance_type=(payload.opening_balance_type or "DR").upper(),
            is_active=True,
            created_at=now,
            updated_at=now,
        )
        session.add(row)
        log_audit(
            session,
            entity_type="PARTY",
            entity_id=None,
            action="CREATE",
            note=f"Created party {name}",
            details={"name": name, "party_group": party_group},
        )
        session.commit()
        session.refresh(row)
        return row


@router.get("/", response_model=List[PartyOut])
def list_parties(
    q: Optional[str] = Query(None),
    party_group: Optional[str] = Query(None),
    is_active: Optional[bool] = Query(None),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> List[PartyOut]:
    with get_session() as session:
        _sync_customer_debtor_parties(session)
        stmt = select(Party)
        if party_group:
            stmt = stmt.where(Party.party_group == _normalize_group(party_group))
        if is_active is not None:
            stmt = stmt.where(Party.is_active == is_active)
        qq = _normalize_text(q)
        if qq:
            like = f"%{qq.lower()}%"
            stmt = stmt.where(
                or_(
                    func.lower(func.coalesce(Party.name, "")).like(like),
                    func.lower(func.coalesce(Party.phone, "")).like(like),
                    func.lower(func.coalesce(Party.address_line, "")).like(like),
                    func.lower(func.coalesce(Party.gst_number, "")).like(like),
                )
            )
        stmt = stmt.order_by(func.lower(Party.name).asc(), Party.id.desc()).offset(offset).limit(limit)
        return session.exec(stmt).all()


@router.patch("/{party_id}", response_model=PartyOut)
def update_party(party_id: int, payload: PartyUpdate) -> PartyOut:
    require_min_role("MANAGER", context="Party update")
    with get_session() as session:
        row = session.get(Party, party_id)
        if not row:
            raise HTTPException(status_code=404, detail="Party not found")

        data = payload.dict(exclude_unset=True)
        if "name" in data:
            name = _normalize_name(data["name"])
            if not name:
                raise HTTPException(status_code=400, detail="Party name is required")
            group = _normalize_group(data.get("party_group", row.party_group))
            if _party_exists(session, name=name, party_group=group, exclude_id=party_id):
                raise HTTPException(status_code=400, detail="Party already exists in this group")
            row.name = name
        if "party_group" in data:
            row.party_group = _normalize_group(data["party_group"])
        if "phone" in data:
            row.phone = _normalize_phone(data["phone"])
        if "address_line" in data:
            row.address_line = _normalize_text(data["address_line"])
        if "gst_number" in data:
            row.gst_number = _normalize_text(data["gst_number"])
        if "notes" in data:
            row.notes = _normalize_text(data["notes"])
        if "opening_balance" in data:
            row.opening_balance = float(data["opening_balance"] or 0)
        if "opening_balance_type" in data:
            row.opening_balance_type = str(data["opening_balance_type"] or "DR").upper()
        if "is_active" in data:
            row.is_active = bool(data["is_active"])
        row.updated_at = datetime.now().isoformat(timespec="seconds")
        session.add(row)
        log_audit(
            session,
            entity_type="PARTY",
            entity_id=int(row.id),
            action="UPDATE",
            note=f"Updated party {row.name}",
            details=row.dict(),
        )
        session.commit()
        session.refresh(row)
        return row


@router.delete("/{party_id}", status_code=204)
def deactivate_party(party_id: int) -> Response:
    require_min_role("MANAGER", context="Party deactivation")
    with get_session() as session:
        row = session.get(Party, party_id)
        if not row:
            raise HTTPException(status_code=404, detail="Party not found")
        row.is_active = False
        row.updated_at = datetime.now().isoformat(timespec="seconds")
        session.add(row)
        log_audit(
            session,
            entity_type="PARTY",
            entity_id=int(row.id),
            action="DEACTIVATE",
            note=f"Deactivated party {row.name}",
            details={"party_group": row.party_group},
        )
        session.commit()
        return Response(status_code=204)


@router.get("/{party_id}/debtor-ledger", response_model=List[DebtorLedgerRow])
def debtor_ledger(party_id: int) -> List[DebtorLedgerRow]:
    with get_session() as session:
        _sync_customer_debtor_parties(session)
        party = session.get(Party, party_id)
        if not party or party.party_group != "SUNDRY_DEBTOR":
            raise HTTPException(status_code=404, detail="Debtor party not found")
        customer_name = _party_customer_name(session, party)

        stmt = (
            select(Bill)
            .where(Bill.is_deleted == False)  # noqa: E712
            .where(_customer_note_matches_expr(customer_name))
            .order_by(Bill.date_time.desc(), Bill.id.desc())
        )
        rows = session.exec(stmt).all()
        out: List[DebtorLedgerRow] = []
        for bill in rows:
            total = float(bill.total_amount or 0)
            paid = float(bill.paid_amount or 0)
            writeoff = float(getattr(bill, "writeoff_amount", 0.0) or 0)
            outstanding = max(0.0, total - paid - writeoff)
            out.append(
                DebtorLedgerRow(
                    bill_id=bill.id,
                    bill_date=bill.date_time,
                    customer_name=customer_name,
                    total_amount=round(total, 2),
                    paid_amount=round(paid, 2),
                    writeoff_amount=round(writeoff, 2),
                    outstanding_amount=round(outstanding, 2),
                    payment_status=str(bill.payment_status or "UNPAID"),
                    notes=bill.notes,
                )
            )
        return out


@router.get("/{party_id}/open-bills", response_model=List[OpenBillOut])
def debtor_open_bills(party_id: int) -> List[OpenBillOut]:
    with get_session() as session:
        _sync_customer_debtor_parties(session)
        party = session.get(Party, party_id)
        if not party or party.party_group != "SUNDRY_DEBTOR":
            raise HTTPException(status_code=404, detail="Debtor party not found")
        customer_name = _party_customer_name(session, party)

        rows = session.exec(
            select(Bill)
            .where(Bill.is_deleted == False)  # noqa: E712
            .where(_customer_note_matches_expr(customer_name))
            .order_by(Bill.date_time.desc(), Bill.id.desc())
        ).all()
        out: List[OpenBillOut] = []
        for bill in rows:
            total = float(bill.total_amount or 0)
            paid = float(bill.paid_amount or 0)
            writeoff = float(getattr(bill, "writeoff_amount", 0.0) or 0)
            outstanding = max(0.0, total - paid - writeoff)
            if outstanding <= 0.0001:
                continue
            out.append(
                OpenBillOut(
                    bill_id=bill.id,
                    bill_date=bill.date_time,
                    total_amount=_round2(total),
                    paid_amount=_round2(paid),
                    writeoff_amount=_round2(writeoff),
                    outstanding_amount=_round2(outstanding),
                    payment_status=str(bill.payment_status or "UNPAID"),
                    notes=bill.notes,
                )
            )
        return out


@router.get("/{party_id}/receipts", response_model=List[PartyReceiptOut])
def list_party_receipts(party_id: int) -> List[PartyReceiptOut]:
    with get_session() as session:
        _sync_customer_debtor_parties(session)
        party = session.get(Party, party_id)
        if not party or party.party_group != "SUNDRY_DEBTOR":
            raise HTTPException(status_code=404, detail="Debtor party not found")
        rows = session.exec(
            select(PartyReceipt)
            .where(PartyReceipt.party_id == party_id)
            .where(PartyReceipt.is_deleted == False)  # noqa: E712
            .order_by(PartyReceipt.id.desc())
        ).all()
        return [PartyReceiptOut(**row.dict()) for row in rows]


@router.get("/{party_id}/receipt-adjustments", response_model=List[ReceiptBillAdjustmentOut])
def list_receipt_adjustments(party_id: int) -> List[ReceiptBillAdjustmentOut]:
    with get_session() as session:
        _sync_customer_debtor_parties(session)
        party = session.get(Party, party_id)
        if not party or party.party_group != "SUNDRY_DEBTOR":
            raise HTTPException(status_code=404, detail="Debtor party not found")
        rows = session.exec(
            select(ReceiptBillAdjustment)
            .join(PartyReceipt, PartyReceipt.id == ReceiptBillAdjustment.receipt_id)
            .where(PartyReceipt.party_id == party_id)
            .where(PartyReceipt.is_deleted == False)  # noqa: E712
            .order_by(ReceiptBillAdjustment.id.desc())
        ).all()
        return [ReceiptBillAdjustmentOut(**row.dict()) for row in rows]


@router.post("/{party_id}/receipts", response_model=PartyReceiptOut, status_code=201)
def create_party_receipt(party_id: int, payload: PartyReceiptCreate) -> PartyReceiptOut:
    with get_session() as session:
        _sync_customer_debtor_parties(session)
        party = session.get(Party, party_id)
        if not party or party.party_group != "SUNDRY_DEBTOR":
            raise HTTPException(status_code=404, detail="Debtor party not found")
        customer_name = _party_customer_name(session, party)

        cash, online, total_amount = _validate_receipt_mode(payload.mode, payload.cash_amount, payload.online_amount)
        receipt_ts = _normalize_payment_ts(payload.payment_date)
        assert_financial_year_unlocked(session, receipt_ts, context="Customer receipt")

        open_bills = {
            int(bill.id): bill
            for bill in session.exec(
                select(Bill)
                .where(Bill.is_deleted == False)  # noqa: E712
                .where(_customer_note_matches_expr(customer_name))
            ).all()
        }

        adjustment_total = 0.0
        normalized_adjustments = []
        for adj in payload.adjustments:
            bill = open_bills.get(int(adj.bill_id))
            if not bill:
                raise HTTPException(status_code=400, detail=f"Bill {adj.bill_id} does not belong to this customer")
            outstanding = max(
                0.0,
                float(bill.total_amount or 0) - float(bill.paid_amount or 0) - float(getattr(bill, "writeoff_amount", 0.0) or 0),
            )
            amount = _round2(adj.amount)
            if amount <= 0:
                raise HTTPException(status_code=400, detail="Adjustment amounts must be greater than 0")
            if amount > outstanding + 0.0001:
                raise HTTPException(status_code=400, detail=f"Adjustment for bill {adj.bill_id} exceeds outstanding amount")
            adjustment_total = _round2(adjustment_total + amount)
            normalized_adjustments.append((bill, amount))

        if adjustment_total > total_amount + 0.0001:
            raise HTTPException(status_code=400, detail="Adjusted amount cannot exceed receipt total")

        unallocated = _round2(total_amount - adjustment_total)
        receipt = PartyReceipt(
            party_id=party.id,
            received_at=receipt_ts,
            mode=str(payload.mode).strip().lower(),
            cash_amount=cash,
            online_amount=online,
            total_amount=total_amount,
            unallocated_amount=unallocated,
            note=_normalize_text(payload.note),
            is_deleted=False,
            deleted_at=None,
        )
        session.add(receipt)
        session.commit()
        session.refresh(receipt)
        post_party_receipt_voucher(
            session,
            int(receipt.id),
            party,
            receipt.received_at,
            float(receipt.total_amount or 0),
            float(receipt.cash_amount or 0),
            float(receipt.online_amount or 0),
            receipt.note,
        )
        log_audit(
            session,
            entity_type="PARTY_RECEIPT",
            entity_id=int(receipt.id),
            action="CREATE",
            note=f"Created customer receipt #{receipt.id}",
            details={"party_id": party.id, "total_amount": receipt.total_amount, "unallocated_amount": receipt.unallocated_amount},
        )

        for bill, amount in normalized_adjustments:
            cash_share = _round2((cash / total_amount) * amount) if total_amount > 0 else 0.0
            online_share = _round2(amount - cash_share)
            bill_payment = BillPayment(
                bill_id=bill.id,
                received_at=receipt_ts,
                mode=str(payload.mode).strip().lower(),
                cash_amount=cash_share,
                online_amount=online_share,
                writeoff_amount=0.0,
                note=f"party receipt #{receipt.id}",
                is_writeoff=False,
                is_deleted=False,
                deleted_at=None,
            )
            session.add(bill_payment)
            session.commit()
            session.refresh(bill_payment)

            session.add(
                ReceiptBillAdjustment(
                    receipt_id=receipt.id,
                    bill_id=bill.id,
                    bill_payment_id=bill_payment.id,
                    adjusted_amount=amount,
                    created_at=receipt_ts,
                )
            )

            bill.paid_amount = _round2(float(bill.paid_amount or 0) + amount)
            outstanding = _round2(
                float(bill.total_amount or 0)
                - float(bill.paid_amount or 0)
                - float(getattr(bill, "writeoff_amount", 0.0) or 0)
            )
            if bill.paid_amount <= 0:
                bill.payment_status = "UNPAID"
            elif outstanding > 0.0001:
                bill.payment_status = "PARTIAL"
            else:
                bill.payment_status = "PAID"
                bill.paid_at = receipt_ts
            bill.is_credit = outstanding > 0.0001
            session.add(bill)
            session.commit()

        session.commit()
        return PartyReceiptOut(**receipt.dict())


@router.delete("/{party_id}/receipts/{receipt_id}", response_model=PartyReceiptOut)
def delete_party_receipt(party_id: int, receipt_id: int) -> PartyReceiptOut:
    require_min_role("MANAGER", context="Customer receipt delete")
    with get_session() as session:
        _sync_customer_debtor_parties(session)
        party = session.get(Party, party_id)
        if not party or party.party_group != "SUNDRY_DEBTOR":
            raise HTTPException(status_code=404, detail="Debtor party not found")

        receipt = session.get(PartyReceipt, receipt_id)
        if not receipt or int(receipt.party_id) != int(party_id):
            raise HTTPException(status_code=404, detail="Receipt not found")
        if bool(getattr(receipt, "is_deleted", False)):
            return PartyReceiptOut(**receipt.dict())

        assert_financial_year_unlocked(session, receipt.received_at, context="Customer receipt delete")
        deleted_at = datetime.now().isoformat(timespec="seconds")
        receipt.is_deleted = True
        receipt.deleted_at = deleted_at
        session.add(receipt)

        affected_bill_ids = set()
        adjustments = session.exec(
            select(ReceiptBillAdjustment).where(ReceiptBillAdjustment.receipt_id == receipt.id)
        ).all()
        for adjustment in adjustments:
            affected_bill_ids.add(int(adjustment.bill_id))
            if adjustment.bill_payment_id is None:
                continue
            payment = session.get(BillPayment, int(adjustment.bill_payment_id))
            if payment and not bool(getattr(payment, "is_deleted", False)):
                payment.is_deleted = True
                payment.deleted_at = deleted_at
                session.add(payment)
            mark_voucher_deleted(session, source_type="BILL_PAYMENT", source_id=int(adjustment.bill_payment_id))

        for bill_id in affected_bill_ids:
            bill = session.get(Bill, int(bill_id))
            if not bill:
                continue
            _recalculate_bill_payment_state(session, bill)
            session.add(bill)

        mark_voucher_deleted(session, source_type="PARTY_RECEIPT", source_id=int(receipt.id))
        log_audit(
            session,
            entity_type="PARTY_RECEIPT",
            entity_id=int(receipt.id),
            action="DELETE",
            note=f"Deleted customer receipt #{receipt.id}",
            details={"party_id": party.id, "total_amount": receipt.total_amount, "affected_bill_ids": sorted(affected_bill_ids)},
        )
        session.commit()
        session.refresh(receipt)
        return PartyReceiptOut(**receipt.dict())
