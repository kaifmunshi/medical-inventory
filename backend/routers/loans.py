from datetime import datetime
import re
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func
from sqlmodel import select

from backend.accounting import mark_voucher_deleted, post_loan_adjustment_voucher, post_loan_voucher, post_opening_loan_voucher
from backend.controls import assert_financial_year_unlocked
from backend.db import get_session
from backend.models import BankbookEntry, Bill, CashbookEntry, LoanAccountOut, LoanAdjustment, LoanAdjustmentCreate, LoanAdjustmentUpdate, LoanOpening, LoanOpeningCreate, LoanReconcileCreate, OpeningLoanReturnCreate, Party
from backend.security import require_min_role

router = APIRouter()


def _round2(value: float) -> float:
    return round(float(value or 0), 2)


def _loan_model(book: str):
    return LoanOpening if book == "OPENING" else BankbookEntry if book == "BANK" else CashbookEntry


def _loan_date(loan) -> str:
    return str(getattr(loan, "opening_date", None) or getattr(loan, "created_at", ""))[:10]


@router.get("/reconciliation-candidates")
def reconciliation_candidates():
    with get_session() as session:
        managed_cash = {int(x.cashbook_entry_id) for x in session.exec(select(LoanAdjustment).where(LoanAdjustment.cashbook_entry_id.is_not(None), LoanAdjustment.is_deleted == False)).all() if x.cashbook_entry_id}  # noqa: E712
        managed_bank = {int(x.bankbook_entry_id) for x in session.exec(select(LoanAdjustment).where(LoanAdjustment.bankbook_entry_id.is_not(None), LoanAdjustment.is_deleted == False)).all() if x.bankbook_entry_id}  # noqa: E712
        out = []
        for book, model, managed in (("CASH", CashbookEntry, managed_cash), ("BANK", BankbookEntry, managed_bank)):
            stmt = select(model).where(model.entry_type != "LOAN", func.lower(func.coalesce(model.note, "")).like("%loan%")).order_by(model.created_at.desc())
            for row in session.exec(stmt).all():
                if int(row.id) in managed:
                    continue
                role = "REPAYMENT" if str(row.entry_type or "").upper() in {"RECEIPT", "LOAN_REPAYMENT"} else "DISBURSEMENT"
                out.append({"book": book, "entry_id": int(row.id), "entry_type": row.entry_type, "date": row.created_at,
                            "amount": _round2(row.amount), "note": row.note, "suggested_role": role})
        out.sort(key=lambda row: (row["date"], row["book"], row["entry_id"]), reverse=True)
        return out


@router.post("/reconcile")
def reconcile_existing_entry(payload: LoanReconcileCreate):
    require_min_role("MANAGER", context="Existing loan reconciliation")
    book = str(payload.book or "").upper()
    role = str(payload.role or "").upper()
    if book not in {"CASH", "BANK"} or role not in {"DISBURSEMENT", "REPAYMENT"}:
        raise HTTPException(status_code=400, detail="Invalid book or reconciliation role")
    with get_session() as session:
        model = BankbookEntry if book == "BANK" else CashbookEntry
        row = session.get(model, payload.entry_id)
        party = session.get(Party, payload.party_id)
        if not row:
            raise HTTPException(status_code=404, detail="Book entry not found")
        if not party or party.party_group != "SUNDRY_DEBTOR":
            raise HTTPException(status_code=400, detail="Select a debtor")
        assert_financial_year_unlocked(session, row.created_at, context="Existing loan reconciliation")
        if payload.amount is not None:
            amount = _round2(payload.amount)
            if amount <= 0:
                raise HTTPException(status_code=400, detail="amount must be greater than zero")
            row.amount = amount
        if payload.entry_date:
            try:
                datetime.strptime(payload.entry_date, "%Y-%m-%d")
            except ValueError:
                raise HTTPException(status_code=400, detail="entry_date must be YYYY-MM-DD")
            next_created_at = f"{payload.entry_date}T{str(row.created_at)[11:19]}"
            assert_financial_year_unlocked(session, next_created_at, context="Existing loan reconciliation")
            row.created_at = next_created_at
        if payload.note is not None:
            row.note = payload.note or None
        if role == "DISBURSEMENT":
            if str(row.entry_type).upper() in {"RECEIPT", "LOAN_REPAYMENT"}:
                raise HTTPException(status_code=400, detail="A receipt cannot be converted to a loan disbursement")
            row.entry_type = "LOAN"
            row.party_id = int(party.id)
            row.is_suspense = False
            session.add(row); session.flush()
            post_loan_voucher(session, row, party, book=book)
        else:
            target_book = str(payload.target_loan_book or "").upper()
            if payload.create_opening_amount is not None:
                target_book = "OPENING"
                opening_date = payload.create_opening_date or str(row.created_at)[:10]
                if opening_date > str(row.created_at)[:10]:
                    raise HTTPException(status_code=400, detail="Opening loan date cannot be after the return date")
                loan = _create_opening_loan(session, party=party, amount=payload.create_opening_amount,
                                            opening_date=opening_date, note="Historical loan balance before recorded return")
            else:
                loan = session.get(_loan_model(target_book), payload.target_loan_entry_id) if target_book in {"CASH", "BANK", "OPENING"} and payload.target_loan_entry_id else None
            if not loan or (target_book != "OPENING" and loan.entry_type != "LOAN") or int(loan.party_id or 0) != int(party.id):
                raise HTTPException(status_code=400, detail="Select a matching loan account for this repayment")
            account = _account(session, loan, target_book)
            if float(row.amount or 0) > account.outstanding_amount + 0.0001:
                raise HTTPException(status_code=400, detail="Repayment exceeds the selected loan outstanding")
            if str(row.created_at)[:10] < _loan_date(loan):
                raise HTTPException(status_code=400, detail="Repayment date cannot be before the loan date")
            if str(row.entry_type).upper() not in {"RECEIPT", "LOAN_REPAYMENT"}:
                raise HTTPException(status_code=400, detail="Only a receipt can be reconciled as repayment")
            row.entry_type = "LOAN_REPAYMENT"
            row.party_id = int(party.id); row.is_suspense = False; session.add(row)
            adj = LoanAdjustment(loan_entry_id=int(loan.id), loan_book=target_book, party_id=int(party.id),
                                 adjustment_type="MONEY", amount=_round2(row.amount), note=row.note,
                                 adjusted_at=row.created_at, settlement_book=book,
                                 cashbook_entry_id=int(row.id) if book == "CASH" else None,
                                 bankbook_entry_id=int(row.id) if book == "BANK" else None)
            session.add(adj); session.flush(); post_loan_adjustment_voucher(session, adj, party)
        mark_voucher_deleted(session, source_type=f"{book}BOOK_SUSPENSE", source_id=int(row.id))
        session.commit()
        return {"ok": True, "book": book, "entry_id": int(row.id), "role": role}


def _account(session, loan, book: str = "CASH") -> LoanAccountOut:
    party = session.get(Party, loan.party_id)
    if not party:
        raise HTTPException(status_code=409, detail="Loan borrower account no longer exists")
    adjustments = session.exec(
        select(LoanAdjustment)
        .where(LoanAdjustment.loan_book == book, LoanAdjustment.loan_entry_id == loan.id, LoanAdjustment.is_deleted == False)  # noqa: E712
        .order_by(LoanAdjustment.adjusted_at.desc(), LoanAdjustment.id.desc())
    ).all()
    adjusted = _round2(sum(float(row.amount or 0) for row in adjustments))
    principal = _round2(loan.amount)
    return LoanAccountOut(
        loan_entry_id=int(loan.id), loan_book=book, party_id=int(party.id), party_name=party.name,
        loan_date=getattr(loan, "opening_date", None) or loan.created_at, principal_amount=principal, adjusted_amount=adjusted,
        outstanding_amount=_round2(max(0, principal - adjusted)), note=loan.note, adjustments=adjustments,
    )


def _create_opening_loan(session, *, party: Party, amount: float, opening_date: str, note: Optional[str] = None) -> LoanOpening:
    value = _round2(amount)
    if value <= 0:
        raise HTTPException(status_code=400, detail="Opening loan amount must be greater than zero")
    try:
        datetime.strptime(opening_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="opening_date must be YYYY-MM-DD")
    assert_financial_year_unlocked(session, opening_date, context="Opening loan balance")
    row = LoanOpening(party_id=int(party.id), opening_date=opening_date, amount=value, note=note or "Loan predating system records")
    session.add(row); session.flush(); post_opening_loan_voucher(session, row, party)
    return row


@router.post("/opening", response_model=LoanAccountOut)
def create_opening_loan(payload: LoanOpeningCreate):
    require_min_role("MANAGER", context="Opening loan creation")
    with get_session() as session:
        party = session.get(Party, payload.party_id)
        if not party or party.party_group != "SUNDRY_DEBTOR" or not party.is_active:
            raise HTTPException(status_code=400, detail="Select an active debtor")
        row = _create_opening_loan(session, party=party, amount=payload.amount, opening_date=payload.opening_date, note=payload.note)
        session.commit()
        return _account(session, row, "OPENING")


@router.post("/opening-with-return", response_model=LoanAccountOut)
def create_opening_loan_with_return(payload: OpeningLoanReturnCreate):
    require_min_role("MANAGER", context="Historical loan return")
    settlement = str(payload.settlement_book or "").upper()
    if settlement not in {"CASH", "BANK"}:
        raise HTTPException(status_code=400, detail="settlement_book must be CASH or BANK")
    principal = _round2(payload.opening_amount); returned = _round2(payload.return_amount)
    if principal <= 0 or returned <= 0 or returned > principal + 0.0001:
        raise HTTPException(status_code=400, detail="Opening balance must cover the return amount")
    if payload.opening_date > payload.return_date:
        raise HTTPException(status_code=400, detail="Opening loan date cannot be after the return date")
    bank_mode = str(payload.bank_mode or "UPI").upper()
    if settlement == "BANK" and bank_mode not in {"UPI", "NEFT", "RTGS", "IMPS", "BANK_DEPOSIT"}:
        raise HTTPException(status_code=400, detail="Invalid bank mode")
    with get_session() as session:
        party = session.get(Party, payload.party_id)
        if not party or party.party_group != "SUNDRY_DEBTOR" or not party.is_active:
            raise HTTPException(status_code=400, detail="Select an active debtor")
        loan = _create_opening_loan(session, party=party, amount=principal, opening_date=payload.opening_date,
                                    note="Historical loan balance before first recorded return")
        return_ts = f"{payload.return_date}T{datetime.now().strftime('%H:%M:%S')}"
        assert_financial_year_unlocked(session, return_ts, context="Historical loan return")
        adjustment = LoanAdjustment(loan_entry_id=int(loan.id), loan_book="OPENING", party_id=int(party.id),
                                    adjustment_type="MONEY", amount=returned, note=payload.note or None,
                                    adjusted_at=return_ts, settlement_book=settlement)
        session.add(adjustment); session.flush(); post_loan_adjustment_voucher(session, adjustment, party)
        if settlement == "CASH":
            entry = CashbookEntry(entry_type="LOAN_REPAYMENT", amount=returned, created_at=return_ts,
                                  party_id=int(party.id), note=payload.note or f"Loan repayment from {party.name}")
            session.add(entry); session.flush(); adjustment.cashbook_entry_id = int(entry.id)
        else:
            entry = BankbookEntry(entry_type="LOAN_REPAYMENT", mode=bank_mode, amount=returned, txn_charges=0,
                                  created_at=return_ts, party_id=int(party.id), note=payload.note or f"Loan repayment from {party.name}")
            session.add(entry); session.flush(); adjustment.bankbook_entry_id = int(entry.id)
        session.add(adjustment); session.commit()
        return _account(session, loan, "OPENING")


@router.get("/", response_model=List[LoanAccountOut])
def list_loans(party_id: Optional[int] = Query(None), open_only: bool = Query(False)):
    with get_session() as session:
        stmt = select(CashbookEntry).where(CashbookEntry.entry_type == "LOAN")
        if party_id is not None:
            stmt = stmt.where(CashbookEntry.party_id == party_id)
        rows = session.exec(stmt.order_by(CashbookEntry.created_at.desc(), CashbookEntry.id.desc())).all()
        bank_stmt = select(BankbookEntry).where(BankbookEntry.entry_type == "LOAN")
        if party_id is not None:
            bank_stmt = bank_stmt.where(BankbookEntry.party_id == party_id)
        bank_rows = session.exec(bank_stmt.order_by(BankbookEntry.created_at.desc(), BankbookEntry.id.desc())).all()
        opening_stmt = select(LoanOpening).where(LoanOpening.is_deleted == False)  # noqa: E712
        if party_id is not None:
            opening_stmt = opening_stmt.where(LoanOpening.party_id == party_id)
        opening_rows = session.exec(opening_stmt.order_by(LoanOpening.opening_date.desc(), LoanOpening.id.desc())).all()
        result = [_account(session, row, "CASH") for row in rows] + [_account(session, row, "BANK") for row in bank_rows] + [_account(session, row, "OPENING") for row in opening_rows]
        result.sort(key=lambda row: (row.loan_date, row.loan_book, row.loan_entry_id), reverse=True)
        return [row for row in result if row.outstanding_amount > 0.009] if open_only else result


@router.post("/{loan_book}/{loan_entry_id}/adjustments")
def add_adjustment(loan_book: str, loan_entry_id: int, payload: LoanAdjustmentCreate):
    require_min_role("MANAGER", context="Loan adjustment")
    kind = str(payload.adjustment_type or "").strip().upper()
    if kind not in {"MONEY", "WRITE_OFF", "PRODUCT"}:
        raise HTTPException(status_code=400, detail="adjustment_type must be MONEY, WRITE_OFF or PRODUCT")
    amount = _round2(payload.amount)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="amount must be greater than zero")
    if kind == "PRODUCT" and not str(payload.product_reference or "").strip():
        raise HTTPException(status_code=400, detail="Product reference is required")
    with get_session() as session:
        book = str(loan_book or "").upper()
        if book not in {"CASH", "BANK", "OPENING"}:
            raise HTTPException(status_code=400, detail="loan_book must be CASH, BANK or OPENING")
        loan = session.get(_loan_model(book), loan_entry_id)
        if not loan or (book != "OPENING" and loan.entry_type != "LOAN") or (book == "OPENING" and loan.is_deleted) or not loan.party_id:
            raise HTTPException(status_code=404, detail="Loan not found")
        account = _account(session, loan, book)
        if amount > account.outstanding_amount + 0.0001:
            raise HTTPException(status_code=400, detail=f"Adjustment exceeds outstanding loan amount of {account.outstanding_amount:.2f}")
        adjusted_at = datetime.now().isoformat(timespec="seconds")
        if payload.adjustment_date:
            try:
                datetime.strptime(payload.adjustment_date, "%Y-%m-%d")
            except ValueError:
                raise HTTPException(status_code=400, detail="adjustment_date must be YYYY-MM-DD")
            adjusted_at = f"{payload.adjustment_date}T{datetime.now().strftime('%H:%M:%S')}"
        assert_financial_year_unlocked(session, adjusted_at, context="Loan adjustment")
        if adjusted_at[:10] < _loan_date(loan):
            raise HTTPException(status_code=400, detail="Adjustment date cannot be before the loan date")
        party = session.get(Party, loan.party_id)
        if not party or not party.is_active:
            raise HTTPException(status_code=409, detail="Loan borrower account is inactive or missing")
        if kind == "PRODUCT":
            match = re.fullmatch(r"Bill\s*#(\d+)", str(payload.product_reference or "").strip(), flags=re.IGNORECASE)
            if not match:
                raise HTTPException(status_code=400, detail="Select a valid customer bill for the product adjustment")
            bill = session.get(Bill, int(match.group(1)))
            note = str(getattr(bill, "notes", "") or "").strip().lower() if bill else ""
            note_matches = note == f"customer: {party.name.strip().lower()}" or note.startswith(f"customer: {party.name.strip().lower()} |") or note.startswith(f"customer: {party.name.strip().lower()}\n")
            belongs = bool(bill and not bill.is_deleted and (int(bill.party_id or 0) == int(party.id) or (party.legacy_customer_id and int(bill.customer_id or 0) == int(party.legacy_customer_id)) or note_matches))
            if not belongs:
                raise HTTPException(status_code=400, detail="Selected bill does not belong to this loan borrower")
        settlement_book = str(payload.settlement_book or "CASH").upper() if kind == "MONEY" else None
        if settlement_book not in {None, "CASH", "BANK"}:
            raise HTTPException(status_code=400, detail="settlement_book must be CASH or BANK")
        bank_mode = str(payload.bank_mode or "UPI").upper()
        if settlement_book == "BANK" and bank_mode not in {"UPI", "NEFT", "RTGS", "IMPS", "BANK_DEPOSIT"}:
            raise HTTPException(status_code=400, detail="Invalid bank mode")
        row = LoanAdjustment(
            loan_entry_id=loan_entry_id, loan_book=book, party_id=int(loan.party_id), adjustment_type=kind,
            amount=amount, product_reference=(payload.product_reference or None), note=(payload.note or None),
            adjusted_at=adjusted_at, settlement_book=settlement_book,
        )
        session.add(row)
        session.flush()
        post_loan_adjustment_voucher(session, row, party)
        if kind == "MONEY" and settlement_book == "CASH":
            cash = CashbookEntry(entry_type="LOAN_REPAYMENT", amount=amount, created_at=adjusted_at,
                                 party_id=int(loan.party_id), note=payload.note or f"Loan repayment from {party.name}")
            session.add(cash)
            session.flush()
            row.cashbook_entry_id = int(cash.id)
            session.add(row)
        elif kind == "MONEY":
            bank = BankbookEntry(entry_type="LOAN_REPAYMENT", mode=bank_mode, amount=amount, txn_charges=0,
                                 created_at=adjusted_at, party_id=int(loan.party_id),
                                 note=payload.note or f"Loan repayment from {party.name}")
            session.add(bank)
            session.flush()
            row.bankbook_entry_id = int(bank.id)
            session.add(row)
        session.commit()
        return _account(session, loan, book)


@router.post("/{loan_entry_id}/adjustments", deprecated=True)
def add_cash_adjustment_compat(loan_entry_id: int, payload: LoanAdjustmentCreate):
    return add_adjustment("CASH", loan_entry_id, payload)


@router.delete("/adjustments/{adjustment_id}")
def delete_adjustment(adjustment_id: int):
    require_min_role("MANAGER", context="Loan adjustment delete")
    with get_session() as session:
        row = session.get(LoanAdjustment, adjustment_id)
        if not row or row.is_deleted:
            raise HTTPException(status_code=404, detail="Loan adjustment not found")
        assert_financial_year_unlocked(session, row.adjusted_at, context="Loan adjustment delete")
        row.is_deleted = True
        session.add(row)
        if row.cashbook_entry_id:
            cash = session.get(CashbookEntry, row.cashbook_entry_id)
            if cash:
                session.delete(cash)
        if row.bankbook_entry_id:
            bank = session.get(BankbookEntry, row.bankbook_entry_id)
            if bank:
                session.delete(bank)
        mark_voucher_deleted(session, source_type="LOAN_ADJUSTMENT", source_id=int(row.id))
        session.commit()
        return {"ok": True}


@router.get("/adjustment-by-entry")
def adjustment_by_entry(book: str = Query(...), entry_id: int = Query(...)):
    book_key = str(book or "").upper()
    if book_key not in {"CASH", "BANK"}:
        raise HTTPException(status_code=400, detail="book must be CASH or BANK")
    with get_session() as session:
        field = LoanAdjustment.bankbook_entry_id if book_key == "BANK" else LoanAdjustment.cashbook_entry_id
        row = session.exec(select(LoanAdjustment).where(field == entry_id, LoanAdjustment.is_deleted == False)).first()  # noqa: E712
        if not row:
            raise HTTPException(status_code=404, detail="Loan return adjustment not found")
        return row


@router.patch("/adjustments/{adjustment_id}")
def update_adjustment(adjustment_id: int, payload: LoanAdjustmentUpdate):
    require_min_role("MANAGER", context="Loan adjustment edit")
    amount = _round2(payload.amount)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="amount must be greater than zero")
    target_book = str(payload.target_loan_book or "").upper()
    if target_book not in {"CASH", "BANK", "OPENING"} or not payload.target_loan_entry_id:
        raise HTTPException(status_code=400, detail="Select the target loan account")
    with get_session() as session:
        row = session.get(LoanAdjustment, adjustment_id)
        if not row or row.is_deleted or row.adjustment_type != "MONEY":
            raise HTTPException(status_code=404, detail="Editable loan return not found")
        loan = session.get(_loan_model(target_book), payload.target_loan_entry_id)
        party = session.get(Party, payload.party_id)
        if not loan or (target_book != "OPENING" and loan.entry_type != "LOAN") or (target_book == "OPENING" and loan.is_deleted) or not party or int(loan.party_id or 0) != int(party.id):
            raise HTTPException(status_code=400, detail="Selected loan does not belong to this client")
        other_adjusted = sum(float(x.amount or 0) for x in session.exec(
            select(LoanAdjustment).where(
                LoanAdjustment.loan_book == target_book,
                LoanAdjustment.loan_entry_id == int(loan.id),
                LoanAdjustment.is_deleted == False,  # noqa: E712
                LoanAdjustment.id != adjustment_id,
            )
        ).all())
        available = _round2(float(loan.amount or 0) - other_adjusted)
        if amount > available + 0.0001:
            raise HTTPException(status_code=400, detail=f"Return exceeds available loan balance of {available:.2f}")
        adjusted_at = row.adjusted_at
        if payload.adjustment_date:
            try:
                datetime.strptime(payload.adjustment_date, "%Y-%m-%d")
            except ValueError:
                raise HTTPException(status_code=400, detail="adjustment_date must be YYYY-MM-DD")
            adjusted_at = f"{payload.adjustment_date}T{str(row.adjusted_at)[11:19]}"
        assert_financial_year_unlocked(session, row.adjusted_at, context="Loan adjustment edit")
        assert_financial_year_unlocked(session, adjusted_at, context="Loan adjustment edit")
        if adjusted_at[:10] < _loan_date(loan):
            raise HTTPException(status_code=400, detail="Return date cannot be before the selected loan date")
        row.loan_book = target_book
        row.loan_entry_id = int(loan.id)
        row.party_id = int(party.id)
        row.amount = amount
        row.note = payload.note or None
        row.adjusted_at = adjusted_at
        session.add(row)
        linked = session.get(BankbookEntry, row.bankbook_entry_id) if row.bankbook_entry_id else session.get(CashbookEntry, row.cashbook_entry_id)
        if not linked:
            raise HTTPException(status_code=409, detail="Linked book entry is missing")
        linked.amount = amount
        linked.note = payload.note or f"Loan repayment from {party.name}"
        linked.created_at = adjusted_at
        linked.party_id = int(party.id)
        session.add(linked)
        session.flush()
        post_loan_adjustment_voucher(session, row, party)
        session.commit()
        return _account(session, loan, target_book)
