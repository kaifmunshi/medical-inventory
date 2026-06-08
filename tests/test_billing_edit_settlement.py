import unittest
from contextlib import contextmanager

from fastapi import HTTPException
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from backend.models import Bill, BillItem, BillPayment, FinancialYear, Item
from backend.routers import billing
from backend.security import set_request_actor


class BillingEditSettlementTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        SQLModel.metadata.create_all(self.engine)
        self.session = Session(self.engine, expire_on_commit=False)
        self.original_get_session = billing.get_session
        self.original_sync_bill_vouchers = billing.sync_bill_vouchers

        @contextmanager
        def test_session():
            yield self.session

        billing.get_session = test_session
        billing.sync_bill_vouchers = lambda *_args, **_kwargs: None
        set_request_actor("Test Manager", "MANAGER", 1)
        self.session.add(
            FinancialYear(
                label="FY 2026",
                start_date="2026-01-01",
                end_date="2026-12-31",
                is_active=True,
                is_locked=False,
            )
        )
        self.session.commit()

    def tearDown(self):
        billing.get_session = self.original_get_session
        billing.sync_bill_vouchers = self.original_sync_bill_vouchers
        set_request_actor(None, None, None)
        self.session.close()

    def seed_bill_with_writeoff(self):
        item = Item(
            name="Test Item",
            brand="Brand",
            expiry_date="2027-01-31",
            mrp=100,
            cost_price=50,
            stock=5,
            rack_number=1,
        )
        self.session.add(item)
        self.session.commit()
        self.session.refresh(item)

        bill = Bill(
            date_time="2026-06-01T10:00:00",
            discount_percent=0,
            subtotal=100,
            total_amount=100,
            payment_mode="credit",
            payment_cash=0,
            payment_online=0,
            is_credit=False,
            payment_status="PAID",
            paid_amount=0,
            writeoff_amount=100,
            is_deleted=False,
        )
        self.session.add(bill)
        self.session.commit()
        self.session.refresh(bill)

        bill_item = BillItem(
            bill_id=bill.id,
            item_id=item.id,
            item_name=item.name,
            mrp=item.mrp,
            quantity=1,
            line_total=100,
        )
        payment = BillPayment(
            bill_id=bill.id,
            received_at="2026-06-01T10:00:00",
            mode="writeoff",
            cash_amount=0,
            online_amount=0,
            writeoff_amount=100,
            is_writeoff=True,
            note="manual writeoff",
        )
        self.session.add(bill_item)
        self.session.add(payment)
        self.session.commit()
        return bill, item

    def test_bill_edit_rejects_total_below_manual_writeoff(self):
        bill, item = self.seed_bill_with_writeoff()

        with self.assertRaises(HTTPException) as err:
            billing.update_bill(
                int(bill.id),
                billing.BillUpdateIn(
                    items=[billing.BillEditItemIn(item_id=int(item.id), quantity=1, custom_unit_price=80)],
                    discount_percent=0,
                    payment_mode="credit",
                    payment_cash=0,
                    payment_online=0,
                    payment_credit=80,
                    final_amount=80,
                    date_time="2026-06-01T10:00:00",
                ),
            )

        self.assertEqual(err.exception.status_code, 400)
        self.assertIn("below received/write-off amount", err.exception.detail)
        self.session.rollback()
        self.session.refresh(bill)
        self.session.refresh(item)
        self.assertEqual(bill.total_amount, 100)
        self.assertEqual(bill.writeoff_amount, 100)
        self.assertEqual(item.stock, 5)

    def test_bill_edit_allows_total_equal_to_manual_writeoff(self):
        bill, item = self.seed_bill_with_writeoff()

        updated = billing.update_bill(
            int(bill.id),
            billing.BillUpdateIn(
                items=[billing.BillEditItemIn(item_id=int(item.id), quantity=1, custom_unit_price=100)],
                discount_percent=0,
                payment_mode="credit",
                payment_cash=0,
                payment_online=0,
                payment_credit=100,
                final_amount=100,
                date_time="2026-06-01T10:00:00",
            ),
        )

        self.assertEqual(updated.total_amount, 100)
        self.assertEqual(updated.writeoff_amount, 100)
        self.assertEqual(updated.payment_status, "PAID")
        self.assertFalse(updated.is_credit)


if __name__ == "__main__":
    unittest.main()
