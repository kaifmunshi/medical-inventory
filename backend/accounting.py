from datetime import datetime
from typing import Dict, List, Optional, TypedDict

from sqlmodel import delete, select
from sqlalchemy import func

from backend.models import (
    Bill,
    BillPayment,
    Ledger,
    LedgerGroup,
    Party,
    PartyReceipt,
    Purchase,
    PurchasePayment,
    ReceiptBillAdjustment,
    Voucher,
    VoucherEntry,
)


class PostingLine(TypedDict):
    ledger_id: int
    entry_type: str
    amount: float
    narration: Optional[str]


def now_ts() -> str:
    return datetime.now().isoformat(timespec="seconds")


def round2(x: float) -> float:
    return float(f"{float(x or 0):.2f}")


SYSTEM_GROUPS = {
    "CASH_BANK": ("Cash & Bank", "ASSET"),
    "SUNDRY_DEBTORS": ("Sundry Debtors", "ASSET"),
    "SUNDRY_CREDITORS": ("Sundry Creditors", "LIABILITY"),
    "SALES": ("Sales Accounts", "INCOME"),
    "PURCHASES": ("Purchase Accounts", "EXPENSE"),
    "INDIRECT_INCOME": ("Indirect Incomes", "INCOME"),
    "INDIRECT_EXPENSE": ("Indirect Expenses", "EXPENSE"),
}


SYSTEM_LEDGERS = {
    "CASH_IN_HAND": ("Cash in Hand", "CASH_BANK"),
    "BANK_ACCOUNT": ("Bank Account", "CASH_BANK"),
    "SALES_ACCOUNT": ("Sales Account", "SALES"),
    "PURCHASE_ACCOUNT": ("Purchase Account", "PURCHASES"),
    "SALES_RECEIVABLE_CONTROL": ("Sales Receivable Control", "SUNDRY_DEBTORS"),
    "CUSTOMER_WRITE_OFF": ("Customer Write-off", "INDIRECT_EXPENSE"),
    "PURCHASE_WRITE_OFF": ("Purchase Write-off", "INDIRECT_INCOME"),
}


def _ensure_group(session, *, system_key: str, name: str, nature: str) -> LedgerGroup:
    row = session.exec(select(LedgerGroup).where(LedgerGroup.system_key == system_key)).first()
    if row:
        return row
    ts = now_ts()
    row = LedgerGroup(
        name=name,
        nature=nature,
        system_key=system_key,
        is_system=True,
        is_active=True,
        created_at=ts,
        updated_at=ts,
    )
    session.add(row)
    session.flush()
    return row


def _ensure_ledger(
    session,
    *,
    system_key: Optional[str],
    name: str,
    group_id: int,
    party_id: Optional[int] = None,
    is_system: bool = False,
):
    stmt = select(Ledger).where(Ledger.group_id == group_id, func.lower(Ledger.name) == name.lower())
    if system_key:
        row = session.exec(select(Ledger).where(Ledger.system_key == system_key)).first()
    elif party_id is not None:
        row = session.exec(select(Ledger).where(Ledger.party_id == party_id)).first()
    else:
        row = session.exec(stmt).first()
    if row:
        return row
    ts = now_ts()
    row = Ledger(
        name=name,
        group_id=group_id,
        party_id=party_id,
        system_key=system_key,
        is_system=is_system,
        is_active=True,
        created_at=ts,
        updated_at=ts,
    )
    session.add(row)
    session.flush()
    return row


def ensure_accounting_setup(session) -> Dict[str, Ledger]:
    groups: Dict[str, LedgerGroup] = {}
    for system_key, (name, nature) in SYSTEM_GROUPS.items():
        groups[system_key] = _ensure_group(session, system_key=system_key, name=name, nature=nature)

    ledgers: Dict[str, Ledger] = {}
    for system_key, (name, group_key) in SYSTEM_LEDGERS.items():
        ledgers[system_key] = _ensure_ledger(
            session,
            system_key=system_key,
            name=name,
            group_id=int(groups[group_key].id),
            is_system=True,
        )
    return ledgers


def ensure_party_ledger(session, party: Party) -> Ledger:
    groups = ensure_accounting_setup(session)
    if str(party.party_group or "").upper() == "SUNDRY_CREDITOR":
        group = session.exec(select(LedgerGroup).where(LedgerGroup.system_key == "SUNDRY_CREDITORS")).first()
    else:
        group = session.exec(select(LedgerGroup).where(LedgerGroup.system_key == "SUNDRY_DEBTORS")).first()
    return _ensure_ledger(
        session,
        system_key=None,
        name=str(party.name or "").strip() or f"Party {party.id}",
        group_id=int(group.id),
        party_id=int(party.id),
        is_system=False,
    )


def resolve_bill_party_ledger(session, bill: Bill) -> Optional[Ledger]:
    notes = str(bill.notes or "").strip()
    lower = notes.lower()
    if lower.startswith("customer:"):
        customer_name = notes.split("|", 1)[0].splitlines()[0].split(":", 1)[1].strip()
        party = session.exec(
            select(Party).where(
                Party.party_group == "SUNDRY_DEBTOR",
                func.lower(func.trim(func.coalesce(Party.name, ""))) == customer_name.lower(),
            )
        ).first()
        if party:
            return ensure_party_ledger(session, party)
    if bool(getattr(bill, "is_credit", False)):
        return ensure_accounting_setup(session)["SALES_RECEIVABLE_CONTROL"]
    return None


def upsert_voucher(
    session,
    *,
    voucher_type: str,
    source_type: str,
    source_id: int,
    voucher_date: str,
    voucher_no: str,
    narration: Optional[str],
    total_amount: float,
    lines: List[PostingLine],
) -> Voucher:
    voucher = session.exec(
        select(Voucher).where(Voucher.source_type == source_type, Voucher.source_id == source_id)
    ).first()
    ts = now_ts()
    if voucher:
        voucher.voucher_type = voucher_type
        voucher.voucher_no = voucher_no
        voucher.voucher_date = voucher_date
        voucher.narration = narration
        voucher.total_amount = round2(total_amount)
        voucher.is_deleted = False
        voucher.deleted_at = None
        voucher.updated_at = ts
        session.add(voucher)
        session.flush()
        session.exec(delete(VoucherEntry).where(VoucherEntry.voucher_id == voucher.id))
        session.flush()
    else:
        voucher = Voucher(
            voucher_type=voucher_type,
            source_type=source_type,
            source_id=source_id,
            voucher_no=voucher_no,
            voucher_date=voucher_date,
            narration=narration,
            total_amount=round2(total_amount),
            is_deleted=False,
            deleted_at=None,
            created_at=ts,
            updated_at=ts,
        )
        session.add(voucher)
        session.flush()

    for idx, line in enumerate(lines, start=1):
        session.add(
            VoucherEntry(
                voucher_id=int(voucher.id),
                ledger_id=int(line["ledger_id"]),
                entry_type=str(line["entry_type"]).upper(),
                amount=round2(line["amount"]),
                narration=line.get("narration"),
                sort_order=idx,
                created_at=ts,
            )
        )
    session.flush()
    return voucher


def mark_voucher_deleted(session, *, source_type: str, source_id: int) -> Optional[Voucher]:
    voucher = session.exec(
        select(Voucher).where(Voucher.source_type == source_type, Voucher.source_id == source_id)
    ).first()
    if not voucher:
        return None
    voucher.is_deleted = True
    voucher.deleted_at = now_ts()
    voucher.updated_at = voucher.deleted_at
    session.add(voucher)
    session.flush()
    return voucher


def post_sales_voucher(session, bill: Bill) -> Voucher:
    ledgers = ensure_accounting_setup(session)
    lines: List[PostingLine] = []
    total = round2(getattr(bill, "total_amount", 0.0))
    payments = session.exec(
        select(BillPayment).where(
            BillPayment.bill_id == bill.id,
            BillPayment.is_deleted == False,  # noqa: E712
        )
    ).all()
    auto_payments = [
        payment
        for payment in payments
        if str(payment.note or "").strip().lower() == "auto: payment at bill creation"
    ]
    if auto_payments:
        cash = round2(sum(float(payment.cash_amount or 0) for payment in auto_payments))
        online = round2(sum(float(payment.online_amount or 0) for payment in auto_payments))
    elif payments:
        cash = 0.0
        online = 0.0
    else:
        cash = round2(getattr(bill, "payment_cash", 0.0))
        online = round2(getattr(bill, "payment_online", 0.0))
    posting_cash = round2(min(cash, total))
    posting_online = round2(min(online, max(0.0, total - posting_cash)))
    if posting_cash > 0:
        lines.append({"ledger_id": int(ledgers["CASH_IN_HAND"].id), "entry_type": "DR", "amount": posting_cash, "narration": "Cash sale"})
    if posting_online > 0:
        lines.append({"ledger_id": int(ledgers["BANK_ACCOUNT"].id), "entry_type": "DR", "amount": posting_online, "narration": "Online sale"})
    outstanding = round2(max(0.0, total - posting_cash - posting_online))
    if outstanding > 0:
        debtor_ledger = resolve_bill_party_ledger(session, bill) or ledgers["SALES_RECEIVABLE_CONTROL"]
        lines.append({"ledger_id": int(debtor_ledger.id), "entry_type": "DR", "amount": outstanding, "narration": "Customer receivable"})
    lines.append({"ledger_id": int(ledgers["SALES_ACCOUNT"].id), "entry_type": "CR", "amount": total, "narration": "Sales"})
    return upsert_voucher(
        session,
        voucher_type="SALES",
        source_type="BILL",
        source_id=int(bill.id),
        voucher_date=str(bill.date_time or "")[:10],
        voucher_no=f"S-{bill.id}",
        narration=bill.notes or f"Sales bill #{bill.id}",
        total_amount=total,
        lines=lines,
    )


def post_purchase_voucher(session, purchase: Purchase, party: Party) -> Voucher:
    ledgers = ensure_accounting_setup(session)
    creditor_ledger = ensure_party_ledger(session, party)
    total = round2(getattr(purchase, "total_amount", 0.0))
    return upsert_voucher(
        session,
        voucher_type="PURCHASE",
        source_type="PURCHASE",
        source_id=int(purchase.id),
        voucher_date=str(purchase.invoice_date or "")[:10],
        voucher_no=f"P-{purchase.id}",
        narration=purchase.notes or f"Purchase invoice {purchase.invoice_number}",
        total_amount=total,
        lines=[
            {"ledger_id": int(ledgers["PURCHASE_ACCOUNT"].id), "entry_type": "DR", "amount": total, "narration": "Purchases"},
            {"ledger_id": int(creditor_ledger.id), "entry_type": "CR", "amount": total, "narration": "Supplier payable"},
        ],
    )


def post_purchase_payment_voucher(session, purchase: Purchase, party: Party, payment_id: int, amount: float, is_writeoff: bool, note: Optional[str], paid_at: str) -> Voucher:
    ledgers = ensure_accounting_setup(session)
    creditor_ledger = ensure_party_ledger(session, party)
    total = round2(amount)
    if is_writeoff:
        lines: List[PostingLine] = [
            {"ledger_id": int(creditor_ledger.id), "entry_type": "DR", "amount": total, "narration": note or "Supplier write-off"},
            {"ledger_id": int(ledgers["PURCHASE_WRITE_OFF"].id), "entry_type": "CR", "amount": total, "narration": note or "Supplier write-off"},
        ]
        voucher_type = "JOURNAL"
        source_type = "PURCHASE_WRITEOFF"
        voucher_no = f"PW-{payment_id}"
    else:
        lines = [
            {"ledger_id": int(creditor_ledger.id), "entry_type": "DR", "amount": total, "narration": note or "Supplier payment"},
            {"ledger_id": int(ledgers["CASH_IN_HAND"].id), "entry_type": "CR", "amount": total, "narration": note or "Supplier payment"},
        ]
        voucher_type = "PAYMENT"
        source_type = "PURCHASE_PAYMENT"
        voucher_no = f"PP-{payment_id}"
    return upsert_voucher(
        session,
        voucher_type=voucher_type,
        source_type=source_type,
        source_id=int(payment_id),
        voucher_date=str(paid_at or "")[:10],
        voucher_no=voucher_no,
        narration=note or f"Purchase settlement for {purchase.invoice_number}",
        total_amount=total,
        lines=lines,
    )


def post_party_receipt_voucher(session, receipt_id: int, party: Party, received_at: str, total_amount: float, cash_amount: float, online_amount: float, note: Optional[str]) -> Voucher:
    ledgers = ensure_accounting_setup(session)
    debtor_ledger = ensure_party_ledger(session, party)
    lines: List[PostingLine] = []
    if round2(cash_amount) > 0:
        lines.append({"ledger_id": int(ledgers["CASH_IN_HAND"].id), "entry_type": "DR", "amount": round2(cash_amount), "narration": note or "Customer receipt"})
    if round2(online_amount) > 0:
        lines.append({"ledger_id": int(ledgers["BANK_ACCOUNT"].id), "entry_type": "DR", "amount": round2(online_amount), "narration": note or "Customer receipt"})
    lines.append({"ledger_id": int(debtor_ledger.id), "entry_type": "CR", "amount": round2(total_amount), "narration": note or "Customer receipt"})
    return upsert_voucher(
        session,
        voucher_type="RECEIPT",
        source_type="PARTY_RECEIPT",
        source_id=int(receipt_id),
        voucher_date=str(received_at or "")[:10],
        voucher_no=f"R-{receipt_id}",
        narration=note or f"Receipt from {party.name}",
        total_amount=round2(total_amount),
        lines=lines,
    )


def post_bill_payment_voucher(
    session,
    bill: Bill,
    payment_id: int,
    received_at: str,
    cash_amount: float,
    online_amount: float,
    writeoff_amount: float,
    is_writeoff: bool,
    note: Optional[str],
) -> Voucher:
    ledgers = ensure_accounting_setup(session)
    debtor_ledger = resolve_bill_party_ledger(session, bill) or ledgers["SALES_RECEIVABLE_CONTROL"]
    lines: List[PostingLine] = []
    if is_writeoff:
        total = round2(writeoff_amount)
        lines.append({"ledger_id": int(ledgers["CUSTOMER_WRITE_OFF"].id), "entry_type": "DR", "amount": total, "narration": note or "Customer write-off"})
        lines.append({"ledger_id": int(debtor_ledger.id), "entry_type": "CR", "amount": total, "narration": note or "Customer write-off"})
    else:
        if round2(cash_amount) > 0:
            lines.append({"ledger_id": int(ledgers["CASH_IN_HAND"].id), "entry_type": "DR", "amount": round2(cash_amount), "narration": note or "Bill receipt"})
        if round2(online_amount) > 0:
            lines.append({"ledger_id": int(ledgers["BANK_ACCOUNT"].id), "entry_type": "DR", "amount": round2(online_amount), "narration": note or "Bill receipt"})
        total = round2(cash_amount) + round2(online_amount)
        lines.append({"ledger_id": int(debtor_ledger.id), "entry_type": "CR", "amount": round2(total), "narration": note or "Bill receipt"})
    return upsert_voucher(
        session,
        voucher_type="WRITE_OFF" if is_writeoff else "RECEIPT",
        source_type="BILL_PAYMENT",
        source_id=int(payment_id),
        voucher_date=str(received_at or "")[:10],
        voucher_no=f"{'BW' if is_writeoff else 'BR'}-{payment_id}",
        narration=note or (f"Bill write-off #{bill.id}" if is_writeoff else f"Bill receipt #{bill.id}"),
        total_amount=round2(total),
        lines=lines,
    )


def sync_bill_vouchers(session, bill: Bill) -> Voucher:
    if bool(getattr(bill, "is_deleted", False)):
        mark_voucher_deleted(session, source_type="BILL", source_id=int(bill.id))
    return post_sales_voucher(session, bill)


def sync_purchase_vouchers(session, purchase: Purchase, party: Party) -> Voucher:
    if bool(getattr(purchase, "is_deleted", False)):
        mark_voucher_deleted(session, source_type="PURCHASE", source_id=int(purchase.id))
    return post_purchase_voucher(session, purchase, party)


def sync_existing_vouchers(session) -> None:
    ensure_accounting_setup(session)

    party_map = {
        int(p.id): p
        for p in session.exec(select(Party)).all()
        if p.id is not None
    }
    receipt_adjustment_payment_ids = {
        int(row.bill_payment_id)
        for row in session.exec(select(ReceiptBillAdjustment)).all()
        if row.bill_payment_id is not None
    }

    for bill in session.exec(select(Bill)).all():
        post_sales_voucher(session, bill)

    for purchase in session.exec(select(Purchase)).all():
        party = party_map.get(int(purchase.party_id or 0))
        if not party:
            continue
        post_purchase_voucher(session, purchase, party)

    for payment in session.exec(select(PurchasePayment)).all():
        purchase = session.get(Purchase, payment.purchase_id)
        if not purchase:
            continue
        party = party_map.get(int(purchase.party_id or 0))
        if not party:
            continue
        post_purchase_payment_voucher(
            session,
            purchase,
            party,
            int(payment.id or 0),
            float(payment.amount or 0),
            bool(payment.is_writeoff),
            payment.note,
            payment.paid_at,
        )

    for receipt in session.exec(select(PartyReceipt)).all():
        party = party_map.get(int(receipt.party_id or 0))
        if not party:
            continue
        post_party_receipt_voucher(
            session,
            int(receipt.id or 0),
            party,
            receipt.received_at,
            float(receipt.total_amount or 0),
            float(receipt.cash_amount or 0),
            float(receipt.online_amount or 0),
            receipt.note,
        )

    for payment in session.exec(select(BillPayment)).all():
        if int(payment.id or 0) in receipt_adjustment_payment_ids:
            continue
        note = str(payment.note or "").strip().lower()
        if note == "auto: payment at bill creation":
            continue
        bill = session.get(Bill, payment.bill_id)
        if not bill:
            continue
        post_bill_payment_voucher(
            session,
            bill,
            int(payment.id or 0),
            payment.received_at,
            float(payment.cash_amount or 0),
            float(payment.online_amount or 0),
            float(getattr(payment, "writeoff_amount", 0) or 0),
            bool(getattr(payment, "is_writeoff", False)),
            payment.note,
        )
