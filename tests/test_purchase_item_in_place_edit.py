import unittest

from fastapi import HTTPException
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from backend import db as backend_db
from backend.models import InventoryLot, Item, Party, Product, Purchase, PurchaseItem, PurchaseItemIn, StockMovement
from backend.routers import purchases


class PurchaseItemInPlaceEditTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        SQLModel.metadata.create_all(self.engine)
        self.session = Session(self.engine)
        self.original_sync_purchase_vouchers = purchases.sync_purchase_vouchers
        self.original_create_data_repair_backup = backend_db.create_data_repair_backup
        purchases.sync_purchase_vouchers = lambda *_args, **_kwargs: None
        backend_db.create_data_repair_backup = lambda _label: "/tmp/test-purchase-lot-link-backup.db"

    def tearDown(self):
        purchases.sync_purchase_vouchers = self.original_sync_purchase_vouchers
        backend_db.create_data_repair_backup = self.original_create_data_repair_backup
        self.session.close()

    def seed_purchase_batch(self):
        product = Product(name="Dolo 650", brand="Micro", default_rack_number=1, printed_price=30)
        supplier = Party(name="Supplier", party_group="SUNDRY_CREDITOR", is_active=True)
        self.session.add(product)
        self.session.add(supplier)
        self.session.commit()
        self.session.refresh(product)
        self.session.refresh(supplier)

        purchase = Purchase(
            party_id=supplier.id,
            invoice_number="P-1",
            invoice_date="2026-06-01",
            subtotal_amount=200,
            total_amount=200,
        )
        self.session.add(purchase)
        self.session.commit()
        self.session.refresh(purchase)

        item = Item(
            name=product.name,
            brand=product.brand,
            product_id=product.id,
            expiry_date="2027-01-31",
            mrp=30,
            cost_price=20,
            stock=10,
            rack_number=1,
        )
        other_batch = Item(
            name=product.name,
            brand=product.brand,
            product_id=product.id,
            expiry_date="2028-01-31",
            mrp=35,
            cost_price=22,
            stock=5,
            rack_number=9,
        )
        self.session.add(item)
        self.session.add(other_batch)
        self.session.commit()
        self.session.refresh(item)
        self.session.refresh(other_batch)

        lot = InventoryLot(
            product_id=product.id,
            expiry_date=item.expiry_date,
            mrp=item.mrp,
            cost_price=item.cost_price,
            rack_number=item.rack_number,
            sealed_qty=item.stock,
            loose_qty=0,
            legacy_item_id=item.id,
            is_active=True,
        )
        self.session.add(lot)
        self.session.commit()
        self.session.refresh(lot)

        purchase_item = PurchaseItem(
            purchase_id=purchase.id,
            product_id=product.id,
            inventory_item_id=item.id,
            lot_id=lot.id,
            stock_source=purchases.STOCK_SOURCE_CREATED,
            product_name=product.name,
            brand=product.brand,
            expiry_date=item.expiry_date,
            rack_number=item.rack_number,
            sealed_qty=8,
            free_qty=2,
            cost_price=20,
            effective_cost_price=20,
            mrp=item.mrp,
            discount_amount=0,
            rounding_adjustment=0,
            line_total=160,
        )
        self.session.add(purchase_item)
        self.session.commit()
        self.session.refresh(purchase_item)
        return product, purchase, purchase_item, item, lot, other_batch

    def edit_payload(self, purchase_item: PurchaseItem, **overrides) -> PurchaseItemIn:
        data = {
            "purchase_item_id": purchase_item.id,
            "product_id": purchase_item.product_id,
            "product_name": purchase_item.product_name,
            "brand": purchase_item.brand,
            "expiry_date": purchase_item.expiry_date,
            "rack_number": purchase_item.rack_number,
            "sealed_qty": purchase_item.sealed_qty,
            "free_qty": purchase_item.free_qty,
            "cost_price": purchase_item.cost_price,
            "mrp": purchase_item.mrp,
            "gst_percent": 0,
            "discount_amount": purchase_item.discount_amount,
            "rounding_adjustment": purchase_item.rounding_adjustment,
        }
        data.update(overrides)
        return PurchaseItemIn(**data)

    def test_in_place_edit_updates_only_linked_purchase_batch(self):
        _product, purchase, purchase_item, item, lot, other_batch = self.seed_purchase_batch()

        purchases.update_purchase_items_in_place(
            self.session,
            purchase,
            [
                self.edit_payload(
                    purchase_item,
                    expiry_date="2027-12-31",
                    rack_number=4,
                    sealed_qty=9,
                    free_qty=2,
                    cost_price=18,
                    mrp=32,
                    discount_amount=9,
                    rounding_adjustment=1,
                )
            ],
        )

        self.session.refresh(purchase_item)
        self.session.refresh(purchase)
        self.session.refresh(item)
        self.session.refresh(lot)
        self.session.refresh(other_batch)

        self.assertEqual(purchase.subtotal_amount, 154)
        self.assertEqual(purchase.total_amount, 154)
        self.assertEqual(purchase_item.expiry_date, "2027-12-31")
        self.assertEqual(purchase_item.rack_number, 4)
        self.assertEqual(purchase_item.sealed_qty, 9)
        self.assertEqual(purchase_item.free_qty, 2)
        self.assertEqual(purchase_item.cost_price, 18)
        self.assertEqual(purchase_item.mrp, 32)
        self.assertEqual(purchase_item.line_total, 154)
        self.assertEqual(purchase_item.effective_cost_price, 14)

        self.assertEqual(item.expiry_date, "2027-12-31")
        self.assertEqual(item.rack_number, 4)
        self.assertEqual(item.stock, 11)
        self.assertEqual(item.mrp, 32)
        self.assertEqual(item.cost_price, 14)

        self.assertEqual(lot.expiry_date, "2027-12-31")
        self.assertEqual(lot.rack_number, 4)
        self.assertEqual(lot.sealed_qty, 11)
        self.assertEqual(lot.mrp, 32)
        self.assertEqual(lot.cost_price, 14)

        self.assertEqual(other_batch.expiry_date, "2028-01-31")
        self.assertEqual(other_batch.rack_number, 9)
        self.assertEqual(other_batch.stock, 5)
        self.assertEqual(other_batch.mrp, 35)
        self.assertEqual(other_batch.cost_price, 22)

        movements = self.session.exec(select(StockMovement).where(StockMovement.item_id == item.id)).all()
        self.assertEqual(len(movements), 1)
        self.assertEqual(movements[0].delta, 1)
        self.assertEqual(movements[0].reason, "PURCHASE_EDIT")

    def test_expiry_only_edit_recomputes_stale_line_total_before_paid_validation(self):
        _product, purchase, purchase_item, item, lot, _other_batch = self.seed_purchase_batch()
        purchase_item.line_total = 0
        purchase.subtotal_amount = 160
        purchase.total_amount = 160
        purchase.paid_amount = 160
        purchase.payment_status = "PAID"
        self.session.add(purchase_item)
        self.session.add(purchase)
        self.session.commit()

        purchases.update_purchase_items_in_place(
            self.session,
            purchase,
            [self.edit_payload(purchase_item, expiry_date="2027-10-31")],
        )

        self.session.refresh(purchase)
        self.session.refresh(purchase_item)
        self.session.refresh(item)
        self.session.refresh(lot)
        self.assertEqual(purchase_item.expiry_date, "2027-10-31")
        self.assertEqual(purchase_item.line_total, 160)
        self.assertEqual(purchase.subtotal_amount, 160)
        self.assertEqual(purchase.total_amount, 160)
        self.assertEqual(item.expiry_date, "2027-10-31")
        self.assertEqual(lot.expiry_date, "2027-10-31")

    def test_rate_reduction_below_paid_amount_is_rejected_without_commit(self):
        _product, purchase, purchase_item, item, lot, _other_batch = self.seed_purchase_batch()
        purchase.subtotal_amount = 160
        purchase.total_amount = 160
        purchase.paid_amount = 150
        purchase.payment_status = "PARTIAL"
        self.session.add(purchase)
        self.session.commit()

        with self.assertRaises(HTTPException) as err:
            purchases.update_purchase_items_in_place(
                self.session,
                purchase,
                [self.edit_payload(purchase_item, cost_price=10)],
            )

        self.assertEqual(err.exception.status_code, 400)
        self.assertIn("reduce total below settled amount", err.exception.detail)
        self.session.rollback()
        self.session.refresh(purchase)
        self.session.refresh(purchase_item)
        self.session.refresh(item)
        self.session.refresh(lot)
        self.assertEqual(purchase.total_amount, 160)
        self.assertEqual(purchase_item.cost_price, 20)
        self.assertEqual(purchase_item.line_total, 160)
        self.assertEqual(item.cost_price, 20)
        self.assertEqual(lot.cost_price, 20)

    def test_in_place_edit_rejects_blank_expiry(self):
        _product, purchase, purchase_item, item, lot, _other_batch = self.seed_purchase_batch()

        with self.assertRaises(HTTPException) as err:
            purchases.update_purchase_items_in_place(
                self.session,
                purchase,
                [self.edit_payload(purchase_item, expiry_date="")],
            )

        self.assertEqual(err.exception.status_code, 400)
        self.assertIn("expiry date is required", err.exception.detail)
        self.session.rollback()
        self.session.refresh(purchase_item)
        self.session.refresh(item)
        self.session.refresh(lot)
        self.assertEqual(purchase_item.expiry_date, "2027-01-31")
        self.assertEqual(item.expiry_date, "2027-01-31")
        self.assertEqual(lot.expiry_date, "2027-01-31")

    def test_in_place_edit_rejects_product_identity_change(self):
        _product, purchase, purchase_item, _item, _lot, _other_batch = self.seed_purchase_batch()

        with self.assertRaises(HTTPException) as err:
            purchases.update_purchase_items_in_place(
                self.session,
                purchase,
                [self.edit_payload(purchase_item, product_name="Different Product")],
            )

        self.assertEqual(err.exception.status_code, 400)
        self.assertIn("cannot change product/batch identity", err.exception.detail)

    def test_in_place_edit_rejects_missing_lot_linkage(self):
        _product, purchase, purchase_item, item, _lot, _other_batch = self.seed_purchase_batch()
        purchase_item.lot_id = None
        self.session.add(purchase_item)
        self.session.commit()

        with self.assertRaises(HTTPException) as err:
            purchases.update_purchase_items_in_place(
                self.session,
                purchase,
                [self.edit_payload(purchase_item, mrp=33)],
            )

        self.session.refresh(item)
        self.assertEqual(err.exception.status_code, 400)
        self.assertIn("missing lot linkage", err.exception.detail)
        self.assertEqual(item.mrp, 30)

    def test_in_place_edit_rejects_mismatched_lot_linkage(self):
        _product, purchase, purchase_item, item, lot, other_batch = self.seed_purchase_batch()
        lot.legacy_item_id = other_batch.id
        self.session.add(lot)
        self.session.commit()

        with self.assertRaises(HTTPException) as err:
            purchases.update_purchase_items_in_place(
                self.session,
                purchase,
                [self.edit_payload(purchase_item, expiry_date="2027-09-30")],
            )

        self.session.refresh(item)
        self.assertEqual(err.exception.status_code, 400)
        self.assertIn("lot does not match linked inventory batch", err.exception.detail)
        self.assertEqual(item.expiry_date, "2027-01-31")

    def test_in_place_edit_rejects_stock_reduction_below_zero(self):
        _product, purchase, purchase_item, item, lot, _other_batch = self.seed_purchase_batch()
        item.stock = 1
        lot.sealed_qty = 1
        self.session.add(item)
        self.session.add(lot)
        self.session.commit()

        with self.assertRaises(HTTPException) as err:
            purchases.update_purchase_items_in_place(
                self.session,
                purchase,
                [self.edit_payload(purchase_item, sealed_qty=0, free_qty=1)],
            )

        self.session.refresh(item)
        self.session.refresh(lot)
        self.assertEqual(err.exception.status_code, 400)
        self.assertIn("cannot reduce stock below 0", err.exception.detail)
        self.assertEqual(item.stock, 1)
        self.assertEqual(lot.sealed_qty, 1)

    def test_in_place_edit_allows_stock_reduction_to_exactly_zero(self):
        _product, purchase, purchase_item, item, lot, _other_batch = self.seed_purchase_batch()
        item.stock = 1
        lot.sealed_qty = 1
        self.session.add(item)
        self.session.add(lot)
        self.session.commit()

        purchases.update_purchase_items_in_place(
            self.session,
            purchase,
            [self.edit_payload(purchase_item, sealed_qty=9, free_qty=0)],
        )

        self.session.refresh(purchase_item)
        self.session.refresh(item)
        self.session.refresh(lot)
        self.assertEqual(purchase_item.sealed_qty, 9)
        self.assertEqual(purchase_item.free_qty, 0)
        self.assertEqual(item.stock, 0)
        self.assertEqual(lot.sealed_qty, 0)
        self.assertTrue(item.is_archived)
        self.assertFalse(lot.is_active)

    def test_startup_repair_links_missing_purchase_lot_when_unambiguous(self):
        _product, _purchase, purchase_item, _item, lot, _other_batch = self.seed_purchase_batch()
        purchase_item.lot_id = None
        self.session.add(purchase_item)
        self.session.commit()

        fixed, skipped, backup_path = backend_db.repair_purchase_item_lot_links(self.session)
        self.session.commit()

        self.session.refresh(purchase_item)
        self.assertEqual(fixed, 1)
        self.assertEqual(skipped, 0)
        self.assertEqual(backup_path, "/tmp/test-purchase-lot-link-backup.db")
        self.assertEqual(purchase_item.lot_id, lot.id)

    def test_startup_repair_skips_ambiguous_purchase_lot_candidates(self):
        product, _purchase, purchase_item, item, _lot, _other_batch = self.seed_purchase_batch()
        purchase_item.lot_id = None
        duplicate_lot = InventoryLot(
            product_id=product.id,
            expiry_date=item.expiry_date,
            mrp=item.mrp,
            cost_price=item.cost_price,
            rack_number=item.rack_number,
            sealed_qty=item.stock,
            loose_qty=0,
            legacy_item_id=item.id,
            is_active=True,
        )
        self.session.add(purchase_item)
        self.session.add(duplicate_lot)
        self.session.commit()

        fixed, skipped, backup_path = backend_db.repair_purchase_item_lot_links(self.session)
        self.session.commit()

        self.session.refresh(purchase_item)
        self.assertEqual(fixed, 0)
        self.assertEqual(skipped, 2)
        self.assertIsNone(backup_path)
        self.assertIsNone(purchase_item.lot_id)


if __name__ == "__main__":
    unittest.main()
