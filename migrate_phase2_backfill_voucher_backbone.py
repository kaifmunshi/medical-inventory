from sqlmodel import Session, select

from backend.accounting import (
    ensure_accounting_setup,
    post_bill_payment_voucher,
    post_party_receipt_voucher,
    post_purchase_payment_voucher,
    post_purchase_voucher,
    post_sales_voucher,
)
from backend.db import engine
from backend.models import Bill, BillPayment, Party, PartyReceipt, Purchase, PurchasePayment, ReceiptBillAdjustment


def main():
    with Session(engine) as session:
        ensure_accounting_setup(session)

        purchase_party_map = {int(p.id): p for p in session.exec(select(Party)).all() if p.id is not None}
        receipt_adjustment_payment_ids = {
            int(row.bill_payment_id)
            for row in session.exec(select(ReceiptBillAdjustment)).all()
            if row.bill_payment_id is not None
        }

        sales_count = 0
        purchase_count = 0
        payment_count = 0
        receipt_count = 0

        for bill in session.exec(select(Bill)).all():
            post_sales_voucher(session, bill)
            sales_count += 1

        for purchase in session.exec(select(Purchase)).all():
            party = purchase_party_map.get(int(purchase.party_id or 0))
            if not party:
                continue
            post_purchase_voucher(session, purchase, party)
            purchase_count += 1

        for payment in session.exec(select(PurchasePayment)).all():
            purchase = session.get(Purchase, payment.purchase_id)
            if not purchase:
                continue
            party = purchase_party_map.get(int(purchase.party_id or 0))
            if not party:
                continue
            post_purchase_payment_voucher(
                session,
                purchase,
                party,
                int(payment.id),
                float(payment.amount or 0),
                bool(payment.is_writeoff),
                payment.note,
                payment.paid_at,
            )
            payment_count += 1

        for receipt in session.exec(select(PartyReceipt)).all():
            party = purchase_party_map.get(int(receipt.party_id or 0))
            if not party:
                continue
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
            receipt_count += 1

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
                int(payment.id),
                payment.received_at,
                float(payment.cash_amount or 0),
                float(payment.online_amount or 0),
                payment.note,
            )
            receipt_count += 1

        session.commit()
        print(
            {
                "sales_vouchers": sales_count,
                "purchase_vouchers": purchase_count,
                "purchase_payment_vouchers": payment_count,
                "receipt_vouchers": receipt_count,
            }
        )


if __name__ == "__main__":
    main()
