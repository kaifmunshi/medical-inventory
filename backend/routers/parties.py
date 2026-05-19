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
    CustomerReturnLedgerRow,
    DebtorLedgerRow,
    ExchangeRecord,
    OpenBillOut,
    Party,
    PartyCreate,
    PartyOut,
    PartyReceipt,
    PartyReceiptApply,
    PartyReceiptCreate,
    PartyReceiptOut,
    PartyReceiptUpdate,
    PartyUpdate,
    Return,
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


def _bill_matches_party_expr(party: Party, customer_name: str):
    matches = [
        _customer_note_matches_expr(customer_name),
        Bill.party_id == int(party.id or 0),
    ]
    if party.legacy_customer_id is not None:
        matches.append(Bill.customer_id == int(party.legacy_customer_id))
    return or_(*matches)


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

    if bill_total <= 0:
        bill.payment_status = "PAID"
        bill.paid_at = bill.paid_at or getattr(bill, "date_time", None)
        bill.is_credit = False
    elif covered <= 0:
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


def _sync_bill_payment_states(session, bills: List[Bill]) -> None:
    changed = False
    for bill in bills:
        before = (
            _round2(_as_float(getattr(bill, "payment_cash", 0.0))),
            _round2(_as_float(getattr(bill, "payment_online", 0.0))),
            _round2(_as_float(getattr(bill, "paid_amount", 0.0))),
            _round2(_as_float(getattr(bill, "writeoff_amount", 0.0))),
            str(getattr(bill, "payment_status", "") or ""),
            bool(getattr(bill, "is_credit", False)),
            getattr(bill, "paid_at", None),
        )
        _recalculate_bill_payment_state(session, bill)
        after = (
            _round2(_as_float(getattr(bill, "payment_cash", 0.0))),
            _round2(_as_float(getattr(bill, "payment_online", 0.0))),
            _round2(_as_float(getattr(bill, "paid_amount", 0.0))),
            _round2(_as_float(getattr(bill, "writeoff_amount", 0.0))),
            str(getattr(bill, "payment_status", "") or ""),
            bool(getattr(bill, "is_credit", False)),
            getattr(bill, "paid_at", None),
        )
        if after != before:
            session.add(bill)
            changed = True
    if changed:
        session.commit()


def _active_receipt_adjustments(session, receipt_id: int) -> List[ReceiptBillAdjustment]:
    rows = session.exec(
        select(ReceiptBillAdjustment).where(ReceiptBillAdjustment.receipt_id == int(receipt_id))
    ).all()
    active: List[ReceiptBillAdjustment] = []
    for adjustment in rows:
        if adjustment.bill_payment_id is not None:
            payment = session.get(BillPayment, int(adjustment.bill_payment_id))
            if payment and bool(getattr(payment, "is_deleted", False)):
                continue
        active.append(adjustment)
    return active


def _sync_party_receipt_unallocated(session, receipt: PartyReceipt) -> None:
    adjusted = _round2(sum(_as_float(row.adjusted_amount) for row in _active_receipt_adjustments(session, int(receipt.id or 0))))
    receipt.unallocated_amount = _round2(max(0.0, _as_float(receipt.total_amount) - adjusted))
    session.add(receipt)


def _receipt_remaining_channels(session, receipt: PartyReceipt) -> tuple[float, float]:
    used_cash = 0.0
    used_online = 0.0
    for adjustment in _active_receipt_adjustments(session, int(receipt.id or 0)):
        if adjustment.bill_payment_id is None:
            continue
        payment = session.get(BillPayment, int(adjustment.bill_payment_id))
        if not payment or bool(getattr(payment, "is_deleted", False)):
            continue
        used_cash += _as_float(payment.cash_amount)
        used_online += _as_float(payment.online_amount)
    return (
        _round2(max(0.0, _as_float(receipt.cash_amount) - used_cash)),
        _round2(max(0.0, _as_float(receipt.online_amount) - used_online)),
    )


def _allocate_receipt_channels(amount: float, remaining_cash: float, remaining_online: float) -> tuple[float, float]:
    amount = _round2(amount)
    remaining_cash = _round2(max(0.0, remaining_cash))
    remaining_online = _round2(max(0.0, remaining_online))
    remaining_total = _round2(remaining_cash + remaining_online)
    if amount <= 0 or remaining_total <= 0:
        return 0.0, 0.0
    if remaining_online <= 0:
        return amount, 0.0
    if remaining_cash <= 0:
        return 0.0, amount
    cash_share = _round2((remaining_cash / remaining_total) * amount)
    cash_share = _round2(min(remaining_cash, max(0.0, cash_share)))
    online_share = _round2(amount - cash_share)
    if online_share > remaining_online:
        online_share = remaining_online
        cash_share = _round2(amount - online_share)
    return cash_share, online_share


def _receipt_adjustment_outs_by_receipt(
    session,
    receipt_ids: List[int],
    include_deleted_for_receipts: Optional[set[int]] = None,
) -> dict[int, List[ReceiptBillAdjustmentOut]]:
    ids = [int(receipt_id) for receipt_id in receipt_ids if int(receipt_id or 0) > 0]
    if not ids:
        return {}
    include_deleted_for_receipts = include_deleted_for_receipts or set()

    adjustments = session.exec(
        select(ReceiptBillAdjustment)
        .where(ReceiptBillAdjustment.receipt_id.in_(ids))
        .order_by(ReceiptBillAdjustment.created_at.asc(), ReceiptBillAdjustment.id.asc())
    ).all()
    payment_ids = [
        int(adjustment.bill_payment_id)
        for adjustment in adjustments
        if adjustment.bill_payment_id is not None
    ]
    payments_by_id = {
        int(payment.id): payment
        for payment in session.exec(select(BillPayment).where(BillPayment.id.in_(payment_ids))).all()
        if payment.id is not None
    } if payment_ids else {}

    out: dict[int, List[ReceiptBillAdjustmentOut]] = {}
    for adjustment in adjustments:
        if _as_float(adjustment.adjusted_amount) <= 0:
            continue
        payment = payments_by_id.get(int(adjustment.bill_payment_id or 0))
        if adjustment.bill_payment_id is not None:
            if (
                payment
                and bool(getattr(payment, "is_deleted", False))
                and int(adjustment.receipt_id) not in include_deleted_for_receipts
            ):
                continue
            cash_amount = _round2(_as_float(payment.cash_amount)) if payment else 0.0
            online_amount = _round2(_as_float(payment.online_amount)) if payment else 0.0
        else:
            cash_amount = 0.0
            online_amount = 0.0

        receipt_id = int(adjustment.receipt_id)
        out.setdefault(receipt_id, []).append(
            ReceiptBillAdjustmentOut(
                **adjustment.dict(),
                cash_amount=cash_amount,
                online_amount=online_amount,
            )
        )
    return out


def _party_receipt_outs(session, receipts: List[PartyReceipt]) -> List[PartyReceiptOut]:
    receipt_ids = [int(receipt.id) for receipt in receipts if receipt.id is not None]
    deleted_receipt_ids = {
        int(receipt.id)
        for receipt in receipts
        if receipt.id is not None and bool(getattr(receipt, "is_deleted", False))
    }
    adjustments_by_receipt = _receipt_adjustment_outs_by_receipt(
        session,
        receipt_ids,
        include_deleted_for_receipts=deleted_receipt_ids,
    )
    out: List[PartyReceiptOut] = []
    for receipt in receipts:
        data = receipt.dict()
        data["adjustments"] = adjustments_by_receipt.get(int(receipt.id or 0), [])
        out.append(PartyReceiptOut(**data))
    return out


def _party_receipt_out(session, receipt: PartyReceipt) -> PartyReceiptOut:
    return _party_receipt_outs(session, [receipt])[0]


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


def _infer_return_refund_mode(row: Return) -> str:
    cash = _round2(float(getattr(row, "refund_cash", 0.0) or 0.0))
    online = _round2(float(getattr(row, "refund_online", 0.0) or 0.0))
    if cash > 0 and online > 0:
        return "split"
    if cash > 0:
        return "cash"
    if online > 0:
        return "online"
    return "credit"


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
            .where(_bill_matches_party_expr(party, customer_name))
            .order_by(Bill.date_time.desc(), Bill.id.desc())
        )
        rows = session.exec(stmt).all()
        _sync_bill_payment_states(session, rows)
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
            .where(_bill_matches_party_expr(party, customer_name))
            .order_by(Bill.date_time.desc(), Bill.id.desc())
        ).all()
        _sync_bill_payment_states(session, rows)
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


@router.get("/{party_id}/returns", response_model=List[CustomerReturnLedgerRow])
def debtor_returns(party_id: int) -> List[CustomerReturnLedgerRow]:
    with get_session() as session:
        _sync_customer_debtor_parties(session)
        party = session.get(Party, party_id)
        if not party or party.party_group != "SUNDRY_DEBTOR":
            raise HTTPException(status_code=404, detail="Debtor party not found")
        customer_name = _party_customer_name(session, party)

        bills = session.exec(
            select(Bill)
            .where(Bill.is_deleted == False)  # noqa: E712
            .where(_bill_matches_party_expr(party, customer_name))
        ).all()
        bill_ids = [int(bill.id) for bill in bills if bill.id is not None]
        if not bill_ids:
            return []

        exchange_by_return_id = {
            int(row.return_id): row
            for row in session.exec(select(ExchangeRecord).where(ExchangeRecord.return_id.is_not(None))).all()
            if row.return_id is not None
        }
        rows = session.exec(
            select(Return)
            .where(Return.source_bill_id.in_(bill_ids))
            .order_by(Return.date_time.desc(), Return.id.desc())
        ).all()

        out: List[CustomerReturnLedgerRow] = []
        for row in rows:
            refund_mode = _infer_return_refund_mode(row)
            subtotal = _round2(float(getattr(row, "subtotal_return", 0.0) or 0.0))
            exchange = exchange_by_return_id.get(int(row.id or 0))
            out.append(
                CustomerReturnLedgerRow(
                    return_id=int(row.id or 0),
                    date_time=row.date_time,
                    source_bill_id=row.source_bill_id,
                    customer_name=customer_name,
                    subtotal_return=subtotal,
                    refund_mode=refund_mode,
                    refund_cash=_round2(float(getattr(row, "refund_cash", 0.0) or 0.0)),
                    refund_online=_round2(float(getattr(row, "refund_online", 0.0) or 0.0)),
                    credit_amount=subtotal if refund_mode == "credit" else 0.0,
                    exchange_id=int(exchange.id) if exchange and exchange.id is not None else None,
                    exchange_new_bill_id=int(exchange.new_bill_id) if exchange and exchange.new_bill_id is not None else None,
                    notes=row.notes,
                )
            )
        return out


@router.get("/{party_id}/receipts", response_model=List[PartyReceiptOut])
def list_party_receipts(
    party_id: int,
    deleted_filter: str = Query("active", pattern="^(active|deleted|all)$"),
) -> List[PartyReceiptOut]:
    with get_session() as session:
        _sync_customer_debtor_parties(session)
        party = session.get(Party, party_id)
        if not party or party.party_group != "SUNDRY_DEBTOR":
            raise HTTPException(status_code=404, detail="Debtor party not found")
        stmt = select(PartyReceipt).where(PartyReceipt.party_id == party_id)
        if deleted_filter == "active":
            stmt = stmt.where(PartyReceipt.is_deleted == False)  # noqa: E712
        elif deleted_filter == "deleted":
            stmt = stmt.where(PartyReceipt.is_deleted == True)  # noqa: E712
        rows = session.exec(stmt.order_by(PartyReceipt.id.desc())).all()
        return _party_receipt_outs(session, rows)


@router.get("/receipts", response_model=List[PartyReceiptOut])
def list_receipts(
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)"),
    limit: int = Query(500, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> List[PartyReceiptOut]:
    with get_session() as session:
        _sync_customer_debtor_parties(session)
        stmt = (
            select(PartyReceipt)
            .where(PartyReceipt.is_deleted == False)  # noqa: E712
            .order_by(PartyReceipt.id.desc())
            .offset(offset)
            .limit(limit)
        )
        if from_date:
            stmt = stmt.where(PartyReceipt.received_at >= f"{from_date}T00:00:00")
        if to_date:
            stmt = stmt.where(PartyReceipt.received_at <= f"{to_date}T23:59:59.999999")
        rows = session.exec(stmt).all()
        return _party_receipt_outs(session, rows)


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
        grouped = _receipt_adjustment_outs_by_receipt(
            session,
            sorted({int(row.receipt_id) for row in rows}),
        )
        out = [adjustment for receipt_rows in grouped.values() for adjustment in receipt_rows]
        return sorted(out, key=lambda row: int(row.id), reverse=True)


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
                .where(_bill_matches_party_expr(party, customer_name))
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
        session.flush()
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
            session.flush()

            session.add(
                ReceiptBillAdjustment(
                    receipt_id=receipt.id,
                    bill_id=bill.id,
                    bill_payment_id=bill_payment.id,
                    adjusted_amount=amount,
                    created_at=receipt_ts,
                )
            )

            _recalculate_bill_payment_state(session, bill)
            session.add(bill)

        session.commit()
        session.refresh(receipt)
        return _party_receipt_out(session, receipt)


@router.post("/{party_id}/receipts/{receipt_id}/apply", response_model=PartyReceiptOut)
def apply_party_receipt(party_id: int, receipt_id: int, payload: PartyReceiptApply) -> PartyReceiptOut:
    with get_session() as session:
        _sync_customer_debtor_parties(session)
        party = session.get(Party, party_id)
        if not party or party.party_group != "SUNDRY_DEBTOR":
            raise HTTPException(status_code=404, detail="Debtor party not found")

        receipt = session.get(PartyReceipt, receipt_id)
        if not receipt or int(receipt.party_id) != int(party_id) or bool(getattr(receipt, "is_deleted", False)):
            raise HTTPException(status_code=404, detail="Receipt not found")

        allocation_ts = _normalize_payment_ts(payload.payment_date)
        assert_financial_year_unlocked(session, allocation_ts, context="Customer advance allocation")
        customer_name = _party_customer_name(session, party)

        open_bills = {
            int(bill.id): bill
            for bill in session.exec(
                select(Bill)
                .where(Bill.is_deleted == False)  # noqa: E712
                .where(_bill_matches_party_expr(party, customer_name))
            ).all()
        }
        _sync_bill_payment_states(session, list(open_bills.values()))

        by_bill: dict[int, float] = {}
        for adj in payload.adjustments:
            amount = _round2(adj.amount)
            if amount <= 0:
                continue
            bill_id = int(adj.bill_id)
            by_bill[bill_id] = _round2(by_bill.get(bill_id, 0.0) + amount)
        if not by_bill:
            raise HTTPException(status_code=400, detail="Add at least one bill adjustment")

        _sync_party_receipt_unallocated(session, receipt)
        available = _round2(_as_float(receipt.unallocated_amount))
        adjustment_total = _round2(sum(by_bill.values()))
        if adjustment_total > available + 0.0001:
            raise HTTPException(status_code=400, detail="Adjusted amount exceeds available advance")

        normalized_adjustments: List[tuple[Bill, float]] = []
        for bill_id, amount in by_bill.items():
            bill = open_bills.get(int(bill_id))
            if not bill:
                raise HTTPException(status_code=400, detail=f"Bill {bill_id} does not belong to this customer")
            outstanding = _round2(
                max(
                    0.0,
                    _as_float(bill.total_amount)
                    - _as_float(bill.paid_amount)
                    - _as_float(getattr(bill, "writeoff_amount", 0.0)),
                )
            )
            if amount > outstanding + 0.0001:
                raise HTTPException(status_code=400, detail=f"Adjustment for bill {bill_id} exceeds outstanding amount")
            normalized_adjustments.append((bill, amount))

        remaining_cash, remaining_online = _receipt_remaining_channels(session, receipt)
        allocation_note = _normalize_text(payload.note)
        for bill, amount in normalized_adjustments:
            cash_share, online_share = _allocate_receipt_channels(amount, remaining_cash, remaining_online)
            if _round2(cash_share + online_share) != _round2(amount):
                raise HTTPException(status_code=400, detail="Receipt advance balance is not available for this allocation")
            remaining_cash = _round2(remaining_cash - cash_share)
            remaining_online = _round2(remaining_online - online_share)
            payment_mode = "split" if cash_share > 0 and online_share > 0 else "cash" if cash_share > 0 else "online"
            bill_payment = BillPayment(
                bill_id=bill.id,
                received_at=allocation_ts,
                mode=payment_mode,
                cash_amount=cash_share,
                online_amount=online_share,
                writeoff_amount=0.0,
                note=f"party receipt #{receipt.id} advance allocation{f': {allocation_note}' if allocation_note else ''}",
                is_writeoff=False,
                is_deleted=False,
                deleted_at=None,
            )
            session.add(bill_payment)
            session.flush()

            session.add(
                ReceiptBillAdjustment(
                    receipt_id=receipt.id,
                    bill_id=bill.id,
                    bill_payment_id=bill_payment.id,
                    adjusted_amount=amount,
                    created_at=allocation_ts,
                )
            )
            _recalculate_bill_payment_state(session, bill)
            session.add(bill)

        _sync_party_receipt_unallocated(session, receipt)
        log_audit(
            session,
            entity_type="PARTY_RECEIPT",
            entity_id=int(receipt.id),
            action="APPLY",
            note=f"Applied customer advance receipt #{receipt.id}",
            details={
                "party_id": party.id,
                "applied_amount": adjustment_total,
                "bill_ids": [int(bill.id) for bill, _amount in normalized_adjustments],
                "note": allocation_note,
            },
        )
        session.commit()
        session.refresh(receipt)
        return _party_receipt_out(session, receipt)


@router.patch("/{party_id}/receipts/{receipt_id}", response_model=PartyReceiptOut)
def update_party_receipt(party_id: int, receipt_id: int, payload: PartyReceiptUpdate) -> PartyReceiptOut:
    require_min_role("MANAGER", context="Customer receipt edit")
    with get_session() as session:
        _sync_customer_debtor_parties(session)
        party = session.get(Party, party_id)
        if not party or party.party_group != "SUNDRY_DEBTOR":
            raise HTTPException(status_code=404, detail="Debtor party not found")

        receipt = session.get(PartyReceipt, receipt_id)
        if not receipt or int(receipt.party_id) != int(party_id):
            raise HTTPException(status_code=404, detail="Receipt not found")
        if bool(getattr(receipt, "is_deleted", False)):
            raise HTTPException(status_code=400, detail="Deleted receipt cannot be edited. Recover it first.")

        cash, online, total_amount = _validate_receipt_mode(payload.mode, payload.cash_amount, payload.online_amount)
        receipt_ts = _normalize_payment_ts(payload.payment_date) if payload.payment_date else str(receipt.received_at or datetime.now().isoformat(timespec="seconds"))
        assert_financial_year_unlocked(session, receipt_ts, context="Customer receipt edit")

        active_adjustments = sorted(
            _active_receipt_adjustments(session, int(receipt.id)),
            key=lambda row: (str(row.created_at or ""), int(row.id or 0)),
        )
        adjusted_total = _round2(sum(_as_float(row.adjusted_amount) for row in active_adjustments))
        if total_amount + 0.0001 < adjusted_total:
            raise HTTPException(status_code=400, detail="Receipt total cannot be less than applied bill amount")

        receipt.received_at = receipt_ts
        receipt.mode = str(payload.mode).strip().lower()
        receipt.cash_amount = cash
        receipt.online_amount = online
        receipt.total_amount = total_amount
        receipt.unallocated_amount = _round2(max(0.0, total_amount - adjusted_total))
        receipt.note = _normalize_text(payload.note)
        session.add(receipt)

        remaining_cash = cash
        remaining_online = online
        affected_bill_ids = set()
        for adjustment in active_adjustments:
            amount = _round2(_as_float(adjustment.adjusted_amount))
            if amount <= 0:
                continue
            if adjustment.bill_payment_id is None:
                continue
            payment = session.get(BillPayment, int(adjustment.bill_payment_id))
            if not payment or bool(getattr(payment, "is_deleted", False)):
                continue
            cash_share, online_share = _allocate_receipt_channels(amount, remaining_cash, remaining_online)
            if _round2(cash_share + online_share) != amount:
                raise HTTPException(status_code=400, detail="Receipt payment channels cannot cover existing bill adjustments")
            remaining_cash = _round2(remaining_cash - cash_share)
            remaining_online = _round2(remaining_online - online_share)
            payment.cash_amount = cash_share
            payment.online_amount = online_share
            payment.mode = "split" if cash_share > 0 and online_share > 0 else "cash" if cash_share > 0 else "online"
            session.add(payment)
            mark_voucher_deleted(session, source_type="BILL_PAYMENT", source_id=int(payment.id))
            affected_bill_ids.add(int(adjustment.bill_id))

        for bill_id in affected_bill_ids:
            bill = session.get(Bill, int(bill_id))
            if bill:
                _recalculate_bill_payment_state(session, bill)
                session.add(bill)

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
            action="UPDATE",
            note=f"Updated customer receipt #{receipt.id}",
            details={
                "party_id": party.id,
                "total_amount": receipt.total_amount,
                "unallocated_amount": receipt.unallocated_amount,
                "affected_bill_ids": sorted(affected_bill_ids),
            },
        )
        session.commit()
        session.refresh(receipt)
        return _party_receipt_out(session, receipt)


@router.post("/{party_id}/receipts/{receipt_id}/recover", response_model=PartyReceiptOut)
def recover_party_receipt(party_id: int, receipt_id: int) -> PartyReceiptOut:
    require_min_role("MANAGER", context="Customer receipt recover")
    with get_session() as session:
        _sync_customer_debtor_parties(session)
        party = session.get(Party, party_id)
        if not party or party.party_group != "SUNDRY_DEBTOR":
            raise HTTPException(status_code=404, detail="Debtor party not found")

        receipt = session.get(PartyReceipt, receipt_id)
        if not receipt or int(receipt.party_id) != int(party_id):
            raise HTTPException(status_code=404, detail="Receipt not found")
        if not bool(getattr(receipt, "is_deleted", False)):
            return _party_receipt_out(session, receipt)

        assert_financial_year_unlocked(session, receipt.received_at, context="Customer receipt recover")
        adjustments = session.exec(
            select(ReceiptBillAdjustment).where(ReceiptBillAdjustment.receipt_id == receipt.id)
        ).all()

        for adjustment in adjustments:
            if adjustment.bill_payment_id is None:
                continue
            payment = session.get(BillPayment, int(adjustment.bill_payment_id))
            bill = session.get(Bill, int(adjustment.bill_id))
            if not payment or not bill:
                raise HTTPException(status_code=400, detail=f"Cannot recover receipt because bill/payment for bill {adjustment.bill_id} is missing")
            if bool(getattr(bill, "is_deleted", False)):
                raise HTTPException(status_code=400, detail=f"Cannot recover receipt because bill {bill.id} is deleted")
            other_total = _round2(
                sum(
                    _as_float(row.cash_amount) + _as_float(row.online_amount) + _as_float(getattr(row, "writeoff_amount", 0.0))
                    for row in session.exec(
                        select(BillPayment).where(
                            BillPayment.bill_id == bill.id,
                            BillPayment.is_deleted == False,  # noqa: E712
                        )
                    ).all()
                    if int(getattr(row, "id", 0) or 0) != int(payment.id)
                )
            )
            proposed = _round2(_as_float(payment.cash_amount) + _as_float(payment.online_amount) + _as_float(getattr(payment, "writeoff_amount", 0.0)))
            if other_total + proposed > _round2(_as_float(bill.total_amount)) + 0.0001:
                raise HTTPException(status_code=400, detail=f"Recovering receipt would overpay bill {bill.id}")

        receipt.is_deleted = False
        receipt.deleted_at = None
        session.add(receipt)
        affected_bill_ids = set()
        for adjustment in adjustments:
            affected_bill_ids.add(int(adjustment.bill_id))
            if adjustment.bill_payment_id is None:
                continue
            payment = session.get(BillPayment, int(adjustment.bill_payment_id))
            if payment:
                payment.is_deleted = False
                payment.deleted_at = None
                session.add(payment)
                mark_voucher_deleted(session, source_type="BILL_PAYMENT", source_id=int(payment.id))

        for bill_id in affected_bill_ids:
            bill = session.get(Bill, int(bill_id))
            if bill:
                _recalculate_bill_payment_state(session, bill)
                session.add(bill)
        _sync_party_receipt_unallocated(session, receipt)
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
            action="RECOVER",
            note=f"Recovered customer receipt #{receipt.id}",
            details={"party_id": party.id, "affected_bill_ids": sorted(affected_bill_ids)},
        )
        session.commit()
        session.refresh(receipt)
        return _party_receipt_out(session, receipt)


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
            return _party_receipt_out(session, receipt)

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
        return _party_receipt_out(session, receipt)
