from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from sqlmodel import select

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

router = APIRouter()


def _round2(x: float) -> float:
    return float(f"{float(x or 0):.2f}")


def _parse_note_party(notes: Optional[str]) -> Optional[str]:
    raw = str(notes or "").strip()
    if not raw:
        return None
    lowered = raw.lower()
    if lowered.startswith("customer:"):
        first = raw.split("|", 1)[0].splitlines()[0]
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
        entries=[VoucherEntryOut(**entry.dict()) for entry in entries],
    )


@router.get("/ledger-groups", response_model=List[LedgerGroupOut])
def list_ledger_groups():
    with get_session() as session:
        rows = session.exec(select(LedgerGroup).order_by(LedgerGroup.name.asc(), LedgerGroup.id.asc())).all()
        return [LedgerGroupOut(**row.dict()) for row in rows]


@router.get("/ledgers", response_model=List[LedgerOut])
def list_ledgers(
    q: Optional[str] = Query(None),
    group_id: Optional[int] = Query(None),
    party_id: Optional[int] = Query(None),
):
    with get_session() as session:
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


@router.get("/daybook", response_model=VoucherDayBookOut)
def daybook(
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    voucher_type: Optional[str] = Query(
        None,
        description="SALE | PURCHASE | RECEIPT | PAYMENT | RETURN | EXCHANGE | EXPENSE | WITHDRAWAL | STOCK_JOURNAL | WRITE_OFF",
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
            BillPayment.is_deleted == False,  # noqa: E712
        )
        for payment in session.exec(receipt_stmt).all():
            bill = session.get(Bill, payment.bill_id)
            if not bill:
                continue
            if deleted_filter == "active" and bool(bill.is_deleted):
                continue
            if deleted_filter == "deleted" and not bool(bill.is_deleted):
                continue
            auto_note = str(payment.note or "").strip().lower()
            if auto_note == "auto: payment at bill creation":
                continue
            if int(payment.id or 0) in receipt_adjustment_payment_ids:
                continue
            rows.append(
                VoucherDayBookRow(
                    ts=payment.received_at,
                    voucher_type="RECEIPT",
                    source_type="BILL_PAYMENT",
                    source_id=int(payment.id or 0),
                    voucher_no=f"BR-{payment.id}",
                    party_name=_parse_note_party(bill.notes),
                    narration=payment.note or f"Receipt against bill #{payment.bill_id}",
                    amount=_round2(float(payment.cash_amount or 0) + float(payment.online_amount or 0)),
                    cash_amount=_round2(payment.cash_amount),
                    online_amount=_round2(payment.online_amount),
                    status=bill.payment_status,
                    is_deleted=False,
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

        purchase_payment_stmt = select(PurchasePayment).where(
            PurchasePayment.paid_at >= start_iso,
            PurchasePayment.paid_at <= end_iso,
            PurchasePayment.is_deleted == False,  # noqa: E712
        )
        for payment in session.exec(purchase_payment_stmt).all():
            purchase = session.get(Purchase, payment.purchase_id)
            if not purchase:
                continue
            if deleted_filter == "active" and bool(purchase.is_deleted):
                continue
            if deleted_filter == "deleted" and not bool(purchase.is_deleted):
                continue
            rows.append(
                VoucherDayBookRow(
                    ts=payment.paid_at,
                    voucher_type="WRITE_OFF" if bool(payment.is_writeoff) else "PAYMENT",
                    source_type="PURCHASE_PAYMENT",
                    source_id=int(payment.id or 0),
                    voucher_no=f"PP-{payment.id}",
                    party_name=party_map.get(int(purchase.party_id or 0)),
                    narration=payment.note or f"Payment for purchase {purchase.invoice_number}",
                    amount=_round2(payment.amount),
                    cash_amount=0.0,
                    online_amount=0.0,
                    status=purchase.payment_status,
                    is_deleted=False,
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
            elif row.voucher_type == "RECEIPT":
                summary.receipt_total = _round2(summary.receipt_total + amount)
            elif row.voucher_type == "PAYMENT":
                summary.payment_total = _round2(summary.payment_total + amount)
            elif row.voucher_type == "RETURN":
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
