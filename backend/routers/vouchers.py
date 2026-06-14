from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func
from sqlmodel import delete, select

from backend.accounting import ensure_accounting_setup
from backend.controls import assert_financial_year_unlocked, log_audit
from backend.db import get_session
from backend.models import (
    Bill,
    BillPayment,
    CashbookEntry,
    ExchangeRecord,
    Ledger,
    LedgerGroup,
    LedgerGroupOut,
    LedgerOut,
    PackOpenEvent,
    Party,
    PartyReceipt,
    Purchase,
    PurchasePayment,
    PurchaseReturn,
    ReceiptBillAdjustment,
    Return,
    Voucher,
    VoucherEntry,
    VoucherEntryOut,
    VoucherDayBookOut,
    VoucherDayBookRow,
    VoucherDayBookSummary,
    VoucherOut,
)
from backend.security import require_min_role

router = APIRouter()


class JournalEntryLineIn(BaseModel):
    ledger_id: int
    entry_type: str
    amount: float
    narration: Optional[str] = None


class JournalEntryIn(BaseModel):
    voucher_date: Optional[str] = None
    voucher_no: Optional[str] = None
    narration: Optional[str] = None
    entries: List[JournalEntryLineIn]


class LedgerCreateIn(BaseModel):
    name: str
    group_id: int


def _round2(x: float) -> float:
    return float(f"{float(x or 0):.2f}")


def _parse_note_party(notes: Optional[str]) -> Optional[str]:
    raw = str(notes or "").strip()
    if not raw:
        return None
    lowered = raw.lower()
    if lowered.startswith("customer:"):
        first_lines = raw.split("|", 1)[0].splitlines()
        first = first_lines[0] if first_lines else ""
        if ":" not in first:
            return None
        return first.split(":", 1)[1].strip() or None
    return None


def _normalize_ymd(value: Optional[str], *, default_to_today: bool) -> str:
    if not value:
        if default_to_today:
            return datetime.now().date().isoformat()
        raise HTTPException(status_code=400, detail="Date is required")
    raw = str(value).strip()[:10]
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date().isoformat()
    except Exception:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")


def _row_matches(row: VoucherDayBookRow, q: str, voucher_type: Optional[str]) -> bool:
    if voucher_type and row.voucher_type != voucher_type:
        return False
    if not q:
        return True
    haystack = " | ".join(
        [
            str(row.voucher_no or ""),
            str(row.party_name or ""),
            str(row.narration or ""),
            str(row.source_type or ""),
            str(row.voucher_type or ""),
        ]
    ).lower()
    return q in haystack


def _voucher_out(session, voucher: Voucher) -> VoucherOut:
    entries = session.exec(
        select(VoucherEntry).where(VoucherEntry.voucher_id == voucher.id).order_by(VoucherEntry.sort_order.asc(), VoucherEntry.id.asc())
    ).all()
    ledger_ids = [int(entry.ledger_id) for entry in entries]
    ledgers = {
        int(row.id): row
        for row in session.exec(select(Ledger).where(Ledger.id.in_(ledger_ids))).all()
        if row.id is not None
    } if ledger_ids else {}
    return VoucherOut(
        id=int(voucher.id),
        voucher_type=voucher.voucher_type,
        source_type=voucher.source_type,
        source_id=int(voucher.source_id),
        voucher_no=voucher.voucher_no,
        voucher_date=voucher.voucher_date,
        narration=voucher.narration,
        total_amount=_round2(voucher.total_amount),
        is_deleted=bool(voucher.is_deleted),
        deleted_at=voucher.deleted_at,
        created_at=voucher.created_at,
        updated_at=voucher.updated_at,
        entries=[
            VoucherEntryOut(
                **entry.dict(),
                ledger_name=(ledgers.get(int(entry.ledger_id)).name if ledgers.get(int(entry.ledger_id)) else None),
            )
            for entry in entries
        ],
    )


def _manual_journal_or_404(session, voucher_id: int) -> Voucher:
    row = session.get(Voucher, voucher_id)
    if (
        not row
        or str(row.source_type or "").upper() != "MANUAL_JOURNAL"
        or str(row.voucher_type or "").upper() != "JOURNAL"
    ):
        raise HTTPException(status_code=404, detail="Journal voucher not found")
    return row


def _validate_journal_payload(
    session,
    payload: JournalEntryIn,
    *,
    current_voucher_id: Optional[int] = None,
):
    voucher_date = _normalize_ymd(payload.voucher_date, default_to_today=True)
    voucher_no = str(payload.voucher_no or "").strip() or None
    narration = str(payload.narration or "").strip() or None

    if voucher_no:
        existing = session.exec(
            select(Voucher).where(
                Voucher.voucher_no == voucher_no,
                Voucher.is_deleted == False,  # noqa: E712
            )
        ).all()
        for row in existing:
            if current_voucher_id is None or int(row.id or 0) != int(current_voucher_id):
                raise HTTPException(status_code=400, detail=f"Voucher number '{voucher_no}' already exists")

    raw_lines = list(payload.entries or [])
    if len(raw_lines) < 2:
        raise HTTPException(status_code=400, detail="Journal entry needs at least two lines")

    ledger_ids = {int(line.ledger_id or 0) for line in raw_lines if int(line.ledger_id or 0) > 0}
    ledgers = {
        int(row.id): row
        for row in session.exec(select(Ledger).where(Ledger.id.in_(ledger_ids))).all()
        if row.id is not None
    } if ledger_ids else {}

    posting_lines = []
    debit_total = 0.0
    credit_total = 0.0
    for idx, raw in enumerate(raw_lines, start=1):
        ledger_id = int(raw.ledger_id or 0)
        ledger = ledgers.get(ledger_id)
        if not ledger or not bool(getattr(ledger, "is_active", True)):
            raise HTTPException(status_code=400, detail=f"Line {idx}: ledger is invalid or inactive")
        entry_type = str(raw.entry_type or "").strip().upper()
        if entry_type not in {"DR", "CR"}:
            raise HTTPException(status_code=400, detail=f"Line {idx}: entry type must be DR or CR")
        amount = _round2(raw.amount)
        if amount <= 0:
            raise HTTPException(status_code=400, detail=f"Line {idx}: amount must be greater than 0")
        line_narration = str(raw.narration or "").strip() or None
        if entry_type == "DR":
            debit_total = _round2(debit_total + amount)
        else:
            credit_total = _round2(credit_total + amount)
        posting_lines.append({
            "ledger_id": ledger_id,
            "entry_type": entry_type,
            "amount": amount,
            "narration": line_narration,
        })

    if debit_total <= 0 or credit_total <= 0:
        raise HTTPException(status_code=400, detail="Journal entry needs both debit and credit lines")
    if abs(debit_total - credit_total) > 0.009:
        raise HTTPException(status_code=400, detail="Total debit must equal total credit")

    return voucher_date, voucher_no, narration, _round2(debit_total), posting_lines


@router.get("/ledger-groups", response_model=List[LedgerGroupOut])
def list_ledger_groups():
    with get_session() as session:
        ensure_accounting_setup(session)
        rows = session.exec(select(LedgerGroup).order_by(LedgerGroup.name.asc(), LedgerGroup.id.asc())).all()
        return [LedgerGroupOut(**row.dict()) for row in rows]


@router.get("/ledgers", response_model=List[LedgerOut])
def list_ledgers(
    q: Optional[str] = Query(None),
    group_id: Optional[int] = Query(None),
    party_id: Optional[int] = Query(None),
):
    with get_session() as session:
        ensure_accounting_setup(session)
        stmt = select(Ledger)
        if group_id is not None:
            stmt = stmt.where(Ledger.group_id == group_id)
        if party_id is not None:
            stmt = stmt.where(Ledger.party_id == party_id)
        qq = str(q or "").strip().lower()
        if qq:
            stmt = stmt.where(func.lower(func.coalesce(Ledger.name, "")).like(f"%{qq}%"))
        rows = session.exec(stmt.order_by(Ledger.name.asc(), Ledger.id.asc())).all()
        return [LedgerOut(**row.dict()) for row in rows]


@router.post("/ledgers", response_model=LedgerOut)
def create_ledger(payload: LedgerCreateIn):
    require_min_role("MANAGER", context="Ledger creation")
    name = " ".join(str(payload.name or "").strip().split())
    if not name:
        raise HTTPException(status_code=400, detail="Ledger name is required")

    with get_session() as session:
        ensure_accounting_setup(session)
        group = session.get(LedgerGroup, int(payload.group_id or 0))
        if not group or not bool(group.is_active):
            raise HTTPException(status_code=400, detail="Ledger group is invalid or inactive")

        existing = session.exec(
            select(Ledger).where(
                Ledger.group_id == int(group.id),
                func.lower(func.trim(func.coalesce(Ledger.name, ""))) == name.lower(),
            )
        ).first()
        if existing:
            raise HTTPException(status_code=400, detail="Ledger already exists in this group")

        ts = datetime.now().isoformat(timespec="seconds")
        row = Ledger(
            name=name,
            group_id=int(group.id),
            party_id=None,
            system_key=None,
            is_system=False,
            is_active=True,
            created_at=ts,
            updated_at=ts,
        )
        session.add(row)
        session.flush()
        log_audit(
            session,
            entity_type="LEDGER",
            entity_id=int(row.id),
            action="CREATE",
            note=f"Created ledger {row.name}",
            details={"group_id": int(group.id), "group_name": group.name},
        )
        session.commit()
        session.refresh(row)
        return LedgerOut(**row.dict())


@router.get("/", response_model=List[VoucherOut])
def list_posted_vouchers(
    voucher_type: Optional[str] = Query(None),
    source_type: Optional[str] = Query(None),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    with get_session() as session:
        stmt = select(Voucher)
        if voucher_type:
            stmt = stmt.where(Voucher.voucher_type == str(voucher_type).strip().upper())
        if source_type:
            stmt = stmt.where(Voucher.source_type == str(source_type).strip().upper())
        if from_date:
            stmt = stmt.where(Voucher.voucher_date >= _normalize_ymd(from_date, default_to_today=False))
        if to_date:
            stmt = stmt.where(Voucher.voucher_date <= _normalize_ymd(to_date, default_to_today=False))
        rows = session.exec(stmt.order_by(Voucher.voucher_date.desc(), Voucher.id.desc()).offset(offset).limit(limit)).all()
        return [_voucher_out(session, row) for row in rows]


@router.get("/journals", response_model=List[VoucherOut])
def list_journal_vouchers(
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    q: Optional[str] = Query(None, description="Search voucher no, narration, or ledger"),
    deleted_filter: str = Query("active", pattern="^(active|deleted|all)$"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    with get_session() as session:
        stmt = select(Voucher).where(
            Voucher.voucher_type == "JOURNAL",
            Voucher.source_type == "MANUAL_JOURNAL",
        )
        if deleted_filter == "active":
            stmt = stmt.where(Voucher.is_deleted == False)  # noqa: E712
        elif deleted_filter == "deleted":
            stmt = stmt.where(Voucher.is_deleted == True)  # noqa: E712
        if from_date:
            stmt = stmt.where(Voucher.voucher_date >= _normalize_ymd(from_date, default_to_today=False))
        if to_date:
            stmt = stmt.where(Voucher.voucher_date <= _normalize_ymd(to_date, default_to_today=False))

        rows = session.exec(stmt.order_by(Voucher.voucher_date.desc(), Voucher.id.desc())).all()
        query_text = str(q or "").strip().lower()
        if query_text:
            filtered = []
            for row in rows:
                entries = session.exec(select(VoucherEntry).where(VoucherEntry.voucher_id == row.id)).all()
                ledger_names = []
                for entry in entries:
                    ledger = session.get(Ledger, int(entry.ledger_id))
                    if ledger:
                        ledger_names.append(str(ledger.name or ""))
                haystack = " | ".join([
                    str(row.voucher_no or ""),
                    str(row.narration or ""),
                    " | ".join(ledger_names),
                ]).lower()
                if query_text in haystack:
                    filtered.append(row)
            rows = filtered

        return [_voucher_out(session, row) for row in rows[offset:offset + limit]]


@router.post("/journals", response_model=VoucherOut)
def create_journal_voucher(payload: JournalEntryIn):
    require_min_role("MANAGER", context="Journal entry creation")
    with get_session() as session:
        ensure_accounting_setup(session)
        voucher_date, voucher_no, narration, total_amount, posting_lines = _validate_journal_payload(session, payload)
        assert_financial_year_unlocked(session, voucher_date, context="Journal entry")

        ts = datetime.now().isoformat(timespec="seconds")
        voucher = Voucher(
            voucher_type="JOURNAL",
            source_type="MANUAL_JOURNAL",
            source_id=0,
            voucher_no=voucher_no or "JV-PENDING",
            voucher_date=voucher_date,
            narration=narration,
            total_amount=total_amount,
            is_deleted=False,
            deleted_at=None,
            created_at=ts,
            updated_at=ts,
        )
        session.add(voucher)
        session.flush()
        voucher.source_id = int(voucher.id)
        if not voucher_no:
            voucher.voucher_no = f"JV-{voucher.id}"
        session.add(voucher)
        for idx, line in enumerate(posting_lines, start=1):
            session.add(
                VoucherEntry(
                    voucher_id=int(voucher.id),
                    ledger_id=int(line["ledger_id"]),
                    entry_type=str(line["entry_type"]),
                    amount=_round2(line["amount"]),
                    narration=line.get("narration"),
                    sort_order=idx,
                    created_at=ts,
                )
            )
        log_audit(
            session,
            entity_type="JOURNAL",
            entity_id=int(voucher.id),
            action="CREATE",
            note=f"Created journal voucher {voucher.voucher_no}",
            details={"voucher_date": voucher_date, "total_amount": total_amount},
        )
        session.commit()
        session.refresh(voucher)
        return _voucher_out(session, voucher)


@router.patch("/journals/{voucher_id}", response_model=VoucherOut)
def update_journal_voucher(voucher_id: int, payload: JournalEntryIn):
    require_min_role("MANAGER", context="Journal entry edit")
    with get_session() as session:
        voucher = _manual_journal_or_404(session, voucher_id)
        if bool(voucher.is_deleted):
            raise HTTPException(status_code=400, detail="Deleted journal voucher cannot be edited")
        assert_financial_year_unlocked(session, voucher.voucher_date, context="Journal entry edit")
        voucher_date, voucher_no, narration, total_amount, posting_lines = _validate_journal_payload(
            session,
            payload,
            current_voucher_id=int(voucher.id),
        )
        assert_financial_year_unlocked(session, voucher_date, context="Journal entry edit")

        ts = datetime.now().isoformat(timespec="seconds")
        voucher.voucher_date = voucher_date
        voucher.voucher_no = voucher_no or f"JV-{voucher.id}"
        voucher.narration = narration
        voucher.total_amount = total_amount
        voucher.updated_at = ts
        session.add(voucher)
        session.flush()
        session.exec(delete(VoucherEntry).where(VoucherEntry.voucher_id == voucher.id))
        session.flush()
        for idx, line in enumerate(posting_lines, start=1):
            session.add(
                VoucherEntry(
                    voucher_id=int(voucher.id),
                    ledger_id=int(line["ledger_id"]),
                    entry_type=str(line["entry_type"]),
                    amount=_round2(line["amount"]),
                    narration=line.get("narration"),
                    sort_order=idx,
                    created_at=ts,
                )
            )
        log_audit(
            session,
            entity_type="JOURNAL",
            entity_id=int(voucher.id),
            action="UPDATE",
            note=f"Updated journal voucher {voucher.voucher_no}",
            details={"voucher_date": voucher_date, "total_amount": total_amount},
        )
        session.commit()
        session.refresh(voucher)
        return _voucher_out(session, voucher)


@router.delete("/journals/{voucher_id}", response_model=VoucherOut)
def delete_journal_voucher(voucher_id: int):
    require_min_role("MANAGER", context="Journal entry delete")
    with get_session() as session:
        voucher = _manual_journal_or_404(session, voucher_id)
        if not bool(voucher.is_deleted):
            assert_financial_year_unlocked(session, voucher.voucher_date, context="Journal entry delete")
            ts = datetime.now().isoformat(timespec="seconds")
            voucher.is_deleted = True
            voucher.deleted_at = ts
            voucher.updated_at = ts
            session.add(voucher)
            log_audit(
                session,
                entity_type="JOURNAL",
                entity_id=int(voucher.id),
                action="DELETE",
                note=f"Deleted journal voucher {voucher.voucher_no}",
            )
            session.commit()
            session.refresh(voucher)
        return _voucher_out(session, voucher)


@router.post("/journals/{voucher_id}/restore", response_model=VoucherOut)
def restore_journal_voucher(voucher_id: int):
    require_min_role("MANAGER", context="Journal entry restore")
    with get_session() as session:
        voucher = _manual_journal_or_404(session, voucher_id)
        if bool(voucher.is_deleted):
            assert_financial_year_unlocked(session, voucher.voucher_date, context="Journal entry restore")
            voucher.is_deleted = False
            voucher.deleted_at = None
            voucher.updated_at = datetime.now().isoformat(timespec="seconds")
            session.add(voucher)
            log_audit(
                session,
                entity_type="JOURNAL",
                entity_id=int(voucher.id),
                action="RESTORE",
                note=f"Restored journal voucher {voucher.voucher_no}",
            )
            session.commit()
            session.refresh(voucher)
        return _voucher_out(session, voucher)


@router.get("/daybook", response_model=VoucherDayBookOut)
def daybook(
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    voucher_type: Optional[str] = Query(
        None,
        description="SALE | PURCHASE | PURCHASE_RETURN | JOURNAL | RECEIPT | PAYMENT | RETURN | EXCHANGE | EXPENSE | WITHDRAWAL | STOCK_JOURNAL | WRITE_OFF",
    ),
    q: Optional[str] = Query(None, description="Search by voucher no, party, narration"),
    deleted_filter: str = Query("active", pattern="^(active|deleted|all)$"),
    include_stock_journal: bool = Query(True),
):
    start_date = _normalize_ymd(from_date, default_to_today=True)
    end_date = _normalize_ymd(to_date or start_date, default_to_today=False)
    if start_date > end_date:
        raise HTTPException(status_code=400, detail="from_date cannot be after to_date")

    start_iso = f"{start_date}T00:00:00"
    end_iso = f"{end_date}T23:59:59"
    query_text = str(q or "").strip().lower()
    normalized_voucher_type = str(voucher_type or "").strip().upper() or None

    with get_session() as session:
        party_map = {
            int(p.id): str(p.name or "").strip()
            for p in session.exec(select(Party)).all()
            if p.id is not None
        }
        receipt_adjustment_payment_ids = {
            int(row.bill_payment_id)
            for row in session.exec(select(ReceiptBillAdjustment)).all()
            if row.bill_payment_id is not None
        }

        rows: List[VoucherDayBookRow] = []

        bill_stmt = select(Bill).where(Bill.date_time >= start_iso, Bill.date_time <= end_iso)
        if deleted_filter == "active":
            bill_stmt = bill_stmt.where(Bill.is_deleted == False)  # noqa: E712
        elif deleted_filter == "deleted":
            bill_stmt = bill_stmt.where(Bill.is_deleted == True)  # noqa: E712
        for bill in session.exec(bill_stmt).all():
            rows.append(
                VoucherDayBookRow(
                    ts=bill.date_time,
                    voucher_type="SALE",
                    source_type="BILL",
                    source_id=int(bill.id or 0),
                    voucher_no=f"S-{bill.id}",
                    party_name=_parse_note_party(bill.notes),
                    narration=bill.notes or f"Sales bill #{bill.id}",
                    amount=_round2(bill.total_amount),
                    cash_amount=_round2(bill.payment_cash),
                    online_amount=_round2(bill.payment_online),
                    status=bill.payment_status,
                    is_deleted=bool(bill.is_deleted),
                )
            )

        receipt_stmt = select(BillPayment).where(
            BillPayment.received_at >= start_iso,
            BillPayment.received_at <= end_iso,
        )
        if deleted_filter == "active":
            receipt_stmt = receipt_stmt.where(BillPayment.is_deleted == False)  # noqa: E712
        elif deleted_filter == "deleted":
            receipt_stmt = receipt_stmt.where(BillPayment.is_deleted == True)  # noqa: E712
        for payment in session.exec(receipt_stmt).all():
            bill = session.get(Bill, payment.bill_id)
            if not bill:
                continue
            is_deleted = bool(payment.is_deleted) or bool(bill.is_deleted)
            if deleted_filter == "active" and is_deleted:
                continue
            if deleted_filter == "deleted" and not is_deleted:
                continue
            auto_note = str(payment.note or "").strip().lower()
            if auto_note == "auto: payment at bill creation":
                continue
            if int(payment.id or 0) in receipt_adjustment_payment_ids:
                continue
            rows.append(
                VoucherDayBookRow(
                    ts=payment.received_at,
                    voucher_type="WRITE_OFF" if bool(getattr(payment, "is_writeoff", False)) else "RECEIPT",
                    source_type="BILL_PAYMENT",
                    source_id=int(payment.id or 0),
                    voucher_no=f"{'BW' if bool(getattr(payment, 'is_writeoff', False)) else 'BR'}-{payment.id}",
                    party_name=_parse_note_party(bill.notes),
                    narration=payment.note or (
                        f"Write-off against bill #{payment.bill_id}"
                        if bool(getattr(payment, "is_writeoff", False))
                        else f"Receipt against bill #{payment.bill_id}"
                    ),
                    amount=_round2(
                        float(getattr(payment, "writeoff_amount", 0) or 0)
                        if bool(getattr(payment, "is_writeoff", False))
                        else float(payment.cash_amount or 0) + float(payment.online_amount or 0)
                    ),
                    cash_amount=0.0 if bool(getattr(payment, "is_writeoff", False)) else _round2(payment.cash_amount),
                    online_amount=0.0 if bool(getattr(payment, "is_writeoff", False)) else _round2(payment.online_amount),
                    status="DELETED" if is_deleted else bill.payment_status,
                    is_deleted=is_deleted,
                )
            )

        purchase_stmt = select(Purchase).where(Purchase.created_at >= start_iso, Purchase.created_at <= end_iso)
        if deleted_filter == "active":
            purchase_stmt = purchase_stmt.where(Purchase.is_deleted == False)  # noqa: E712
        elif deleted_filter == "deleted":
            purchase_stmt = purchase_stmt.where(Purchase.is_deleted == True)  # noqa: E712
        for purchase in session.exec(purchase_stmt).all():
            rows.append(
                VoucherDayBookRow(
                    ts=purchase.created_at,
                    voucher_type="PURCHASE",
                    source_type="PURCHASE",
                    source_id=int(purchase.id or 0),
                    voucher_no=f"P-{purchase.id}",
                    party_name=party_map.get(int(purchase.party_id or 0)),
                    narration=purchase.notes or f"Purchase invoice {purchase.invoice_number}",
                    amount=_round2(purchase.total_amount),
                    cash_amount=0.0,
                    online_amount=0.0,
                    status=purchase.payment_status,
                    is_deleted=bool(purchase.is_deleted),
                )
            )

        purchase_return_stmt = select(PurchaseReturn).where(
            PurchaseReturn.return_date >= start_date,
            PurchaseReturn.return_date <= end_date,
        )
        if deleted_filter == "active":
            purchase_return_stmt = purchase_return_stmt.where(PurchaseReturn.is_deleted == False)  # noqa: E712
        elif deleted_filter == "deleted":
            purchase_return_stmt = purchase_return_stmt.where(PurchaseReturn.is_deleted == True)  # noqa: E712
        for purchase_return in session.exec(purchase_return_stmt).all():
            rows.append(
                VoucherDayBookRow(
                    ts=f"{purchase_return.return_date}T00:00:00",
                    voucher_type="PURCHASE_RETURN",
                    source_type="PURCHASE_RETURN",
                    source_id=int(purchase_return.id or 0),
                    voucher_no=purchase_return.return_number,
                    party_name=party_map.get(int(purchase_return.party_id or 0)),
                    narration=purchase_return.notes or f"Purchase return {purchase_return.return_number}",
                    amount=_round2(purchase_return.total_amount),
                    cash_amount=0.0,
                    online_amount=0.0,
                    status="DELETED" if purchase_return.is_deleted else "POSTED",
                    is_deleted=bool(purchase_return.is_deleted),
                )
            )

        journal_stmt = select(Voucher).where(
            Voucher.voucher_type == "JOURNAL",
            Voucher.source_type == "MANUAL_JOURNAL",
            Voucher.voucher_date >= start_date,
            Voucher.voucher_date <= end_date,
        )
        if deleted_filter == "active":
            journal_stmt = journal_stmt.where(Voucher.is_deleted == False)  # noqa: E712
        elif deleted_filter == "deleted":
            journal_stmt = journal_stmt.where(Voucher.is_deleted == True)  # noqa: E712
        for voucher in session.exec(journal_stmt).all():
            rows.append(
                VoucherDayBookRow(
                    ts=f"{voucher.voucher_date}T00:00:00",
                    voucher_type="JOURNAL",
                    source_type="MANUAL_JOURNAL",
                    source_id=int(voucher.id or 0),
                    voucher_no=voucher.voucher_no,
                    narration=voucher.narration or "Journal entry",
                    amount=_round2(voucher.total_amount),
                    cash_amount=0.0,
                    online_amount=0.0,
                    status="DELETED" if bool(voucher.is_deleted) else "POSTED",
                    is_deleted=bool(voucher.is_deleted),
                )
            )

        purchase_payment_stmt = select(PurchasePayment).where(
            PurchasePayment.paid_at >= start_iso,
            PurchasePayment.paid_at <= end_iso,
        )
        if deleted_filter == "active":
            purchase_payment_stmt = purchase_payment_stmt.where(PurchasePayment.is_deleted == False)  # noqa: E712
        elif deleted_filter == "deleted":
            purchase_payment_stmt = purchase_payment_stmt.where(PurchasePayment.is_deleted == True)  # noqa: E712
        for payment in session.exec(purchase_payment_stmt).all():
            purchase = session.get(Purchase, payment.purchase_id) if int(payment.purchase_id or 0) > 0 else None
            payment_party_id = int(purchase.party_id or 0) if purchase else int(getattr(payment, "party_id", 0) or 0)
            if not payment_party_id:
                continue
            is_deleted = bool(payment.is_deleted) or bool(getattr(purchase, "is_deleted", False))
            if deleted_filter == "active" and is_deleted:
                continue
            if deleted_filter == "deleted" and not is_deleted:
                continue
            transaction_suffix = f" | Txn {payment.transaction_id}" if getattr(payment, "transaction_id", None) else ""
            rows.append(
                VoucherDayBookRow(
                    ts=payment.paid_at,
                    voucher_type="WRITE_OFF" if bool(payment.is_writeoff) else "PAYMENT",
                    source_type="PURCHASE_PAYMENT",
                    source_id=int(payment.id or 0),
                    voucher_no=f"PP-{payment.id}",
                    party_name=party_map.get(payment_party_id),
                    narration=(payment.note or (
                        f"Payment for purchase {purchase.invoice_number}"
                        if purchase
                        else "Supplier payment without purchase"
                    )) + transaction_suffix,
                    amount=_round2(payment.amount),
                    cash_amount=0.0 if bool(payment.is_writeoff) else _round2(getattr(payment, "cash_amount", 0.0)),
                    online_amount=0.0 if bool(payment.is_writeoff) else _round2(getattr(payment, "online_amount", 0.0)),
                    status="DELETED" if is_deleted else (purchase.payment_status if purchase else "PAID"),
                    is_deleted=is_deleted,
                )
            )
            bank_charges = _round2(float(getattr(payment, "txn_charges", 0) or 0))
            if not bool(payment.is_writeoff) and bank_charges > 0 and float(getattr(payment, "online_amount", 0) or 0) > 0:
                rows.append(
                    VoucherDayBookRow(
                        ts=payment.paid_at,
                        voucher_type="EXPENSE",
                        source_type="PURCHASE_PAYMENT_CHARGE",
                        source_id=int(payment.id or 0),
                        voucher_no=f"PBC-{payment.id}",
                        party_name=party_map.get(payment_party_id),
                        narration=(payment.note or (
                            f"Bank charges for purchase {purchase.invoice_number}"
                            if purchase
                            else "Bank charges for supplier payment"
                        )) + transaction_suffix,
                        amount=bank_charges,
                        cash_amount=0.0,
                        online_amount=bank_charges,
                        status="DELETED" if is_deleted else "POSTED",
                        is_deleted=is_deleted,
                    )
                )

        party_receipt_stmt = select(PartyReceipt).where(
            PartyReceipt.received_at >= start_iso,
            PartyReceipt.received_at <= end_iso,
        )
        if deleted_filter == "active":
            party_receipt_stmt = party_receipt_stmt.where(PartyReceipt.is_deleted == False)  # noqa: E712
        elif deleted_filter == "deleted":
            party_receipt_stmt = party_receipt_stmt.where(PartyReceipt.is_deleted == True)  # noqa: E712
        for receipt in session.exec(party_receipt_stmt).all():
            rows.append(
                VoucherDayBookRow(
                    ts=receipt.received_at,
                    voucher_type="RECEIPT",
                    source_type="PARTY_RECEIPT",
                    source_id=int(receipt.id or 0),
                    voucher_no=f"R-{receipt.id}",
                    party_name=party_map.get(int(receipt.party_id or 0)),
                    narration=receipt.note or "Customer receipt",
                    amount=_round2(receipt.total_amount),
                    cash_amount=_round2(receipt.cash_amount),
                    online_amount=_round2(receipt.online_amount),
                    status="ON_ACCOUNT" if _round2(receipt.unallocated_amount) > 0 else "ADJUSTED",
                    is_deleted=bool(receipt.is_deleted),
                )
            )

        return_stmt = select(Return).where(Return.date_time >= start_iso, Return.date_time <= end_iso)
        for row in session.exec(return_stmt).all():
            rows.append(
                VoucherDayBookRow(
                    ts=row.date_time,
                    voucher_type="RETURN",
                    source_type="RETURN",
                    source_id=int(row.id or 0),
                    voucher_no=f"RET-{row.id}",
                    narration=row.notes or (f"Return against bill #{row.source_bill_id}" if row.source_bill_id else "Return"),
                    amount=_round2(row.subtotal_return),
                    cash_amount=_round2(row.refund_cash),
                    online_amount=_round2(row.refund_online),
                    status=None,
                    is_deleted=False,
                )
            )

        exchange_stmt = select(ExchangeRecord).where(
            ExchangeRecord.created_at >= start_iso,
            ExchangeRecord.created_at <= end_iso,
        )
        for row in session.exec(exchange_stmt).all():
            amount = _round2(abs(float(row.net_due or 0))) if float(row.net_due or 0) else _round2(row.theoretical_net)
            rows.append(
                VoucherDayBookRow(
                    ts=row.created_at,
                    voucher_type="EXCHANGE",
                    source_type="EXCHANGE",
                    source_id=int(row.id or 0),
                    voucher_no=f"EX-{row.id}",
                    narration=row.notes or (f"Exchange against bill #{row.source_bill_id}" if row.source_bill_id else "Exchange"),
                    amount=amount,
                    cash_amount=_round2(float(row.payment_cash or 0) + float(row.refund_cash or 0)),
                    online_amount=_round2(float(row.payment_online or 0) + float(row.refund_online or 0)),
                    status=None,
                    is_deleted=False,
                )
            )

        cashbook_stmt = select(CashbookEntry).where(
            CashbookEntry.created_at >= start_iso,
            CashbookEntry.created_at <= end_iso,
        )
        for entry in session.exec(cashbook_stmt).all():
            entry_type = str(entry.entry_type or "").upper()
            rows.append(
                VoucherDayBookRow(
                    ts=entry.created_at,
                    voucher_type="EXPENSE" if entry_type == "EXPENSE" else entry_type,
                    source_type="CASHBOOK",
                    source_id=int(entry.id or 0),
                    voucher_no=f"CB-{entry.id}",
                    narration=entry.note or f"Cashbook {entry_type.lower()}",
                    amount=_round2(entry.amount),
                    cash_amount=_round2(entry.amount) if entry_type == "RECEIPT" else 0.0,
                    online_amount=0.0,
                    status=None,
                    is_deleted=False,
                )
            )

        if include_stock_journal:
            pack_open_stmt = select(PackOpenEvent).where(
                PackOpenEvent.created_at >= start_iso,
                PackOpenEvent.created_at <= end_iso,
            )
            for event in session.exec(pack_open_stmt).all():
                rows.append(
                    VoucherDayBookRow(
                        ts=event.created_at,
                        voucher_type="STOCK_JOURNAL",
                        source_type="PACK_OPEN",
                        source_id=int(event.id or 0),
                        voucher_no=f"SJ-{event.id}",
                        narration=event.note or f"Opened {event.packs_opened} pack(s) into {event.loose_units_created} loose units",
                        amount=_round2(event.loose_units_created),
                        cash_amount=0.0,
                        online_amount=0.0,
                        status=None,
                        is_deleted=False,
                    )
                )

        filtered_rows = [
            row for row in rows
            if _row_matches(row, query_text, normalized_voucher_type)
        ]
        filtered_rows.sort(key=lambda row: (row.ts, row.source_id), reverse=True)

        summary = VoucherDayBookSummary(total_rows=len(filtered_rows))
        for row in filtered_rows:
            amount = _round2(row.amount)
            if row.voucher_type == "SALE":
                summary.sales_total = _round2(summary.sales_total + amount)
            elif row.voucher_type == "PURCHASE":
                summary.purchase_total = _round2(summary.purchase_total + amount)
            elif row.voucher_type == "JOURNAL":
                summary.journal_total = _round2(summary.journal_total + amount)
            elif row.voucher_type == "RECEIPT":
                summary.receipt_total = _round2(summary.receipt_total + amount)
            elif row.voucher_type == "PAYMENT":
                summary.payment_total = _round2(summary.payment_total + amount)
            elif row.voucher_type in {"RETURN", "PURCHASE_RETURN"}:
                summary.return_total = _round2(summary.return_total + amount)
            elif row.voucher_type == "EXCHANGE":
                summary.exchange_total = _round2(summary.exchange_total + amount)
            elif row.voucher_type == "EXPENSE":
                summary.expense_total = _round2(summary.expense_total + amount)
            elif row.voucher_type == "WITHDRAWAL":
                summary.withdrawal_total = _round2(summary.withdrawal_total + amount)
            elif row.voucher_type == "STOCK_JOURNAL":
                summary.stock_journal_count += 1
            elif row.voucher_type == "WRITE_OFF":
                summary.writeoff_total = _round2(summary.writeoff_total + amount)

        return VoucherDayBookOut(
            from_date=start_date,
            to_date=end_date,
            rows=filtered_rows,
            summary=summary,
        )


@router.get("/{voucher_id}", response_model=VoucherOut)
def get_posted_voucher(voucher_id: int):
    with get_session() as session:
        row = session.get(Voucher, voucher_id)
        if not row:
            raise HTTPException(status_code=404, detail="Voucher not found")
        return _voucher_out(session, row)
