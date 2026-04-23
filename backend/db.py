from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from sqlmodel import create_engine, Session, SQLModel
from sqlalchemy import text

BASE_DIR = Path(__file__).resolve().parent.parent   # project root (medical-inventory/)
DB_FILE = BASE_DIR / "medical_shop.db"

engine = create_engine(
    f"sqlite:///{DB_FILE}",
    echo=False,
    connect_args={"check_same_thread": False},
)


def _now_ts() -> str:
    return datetime.now().isoformat(timespec="seconds")


def migrate_db():
    with Session(engine) as session:
        # ---------- item table migration ----------
        cols = session.exec(text("PRAGMA table_info(item)")).all()
        col_names = {c[1] for c in cols}

        if "rack_number" not in col_names:
            session.exec(text(
                "ALTER TABLE item ADD COLUMN rack_number INTEGER NOT NULL DEFAULT 0"
            ))
            session.exec(text(
                "UPDATE item SET rack_number = 0 WHERE rack_number IS NULL"
            ))
            session.commit()

        # ✅ NEW: soft-archive fields (so 0-stock batches can be hidden safely)
        # NOTE: We do NOT hard-delete rows because BillItem/ReturnItem references can break later.
        if "is_archived" not in col_names:
            session.exec(text(
                "ALTER TABLE item ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0"
            ))

        if "archived_at" not in col_names:
            session.exec(text(
                "ALTER TABLE item ADD COLUMN archived_at TEXT"
            ))

        if "product_id" not in col_names:
            session.exec(text(
                "ALTER TABLE item ADD COLUMN product_id INTEGER"
            ))

        if "category_id" not in col_names:
            session.exec(text(
                "ALTER TABLE item ADD COLUMN category_id INTEGER"
            ))

        if "cost_price" not in col_names:
            session.exec(text(
                "ALTER TABLE item ADD COLUMN cost_price REAL NOT NULL DEFAULT 0"
            ))

        # Older client databases may still be missing timestamps that the current Item model selects.
        if "created_at" not in col_names:
            session.exec(text(
                "ALTER TABLE item ADD COLUMN created_at TEXT"
            ))
            session.exec(text(
                "UPDATE item SET created_at = :ts WHERE created_at IS NULL OR TRIM(created_at) = ''"
            ).bindparams(ts=_now_ts()))

        if "updated_at" not in col_names:
            session.exec(text(
                "ALTER TABLE item ADD COLUMN updated_at TEXT"
            ))
            session.exec(text(
                "UPDATE item SET updated_at = COALESCE(NULLIF(created_at, ''), :ts) WHERE updated_at IS NULL OR TRIM(updated_at) = ''"
            ).bindparams(ts=_now_ts()))

        session.exec(text(
            "UPDATE item SET created_at = :ts WHERE created_at IS NULL OR TRIM(created_at) = ''"
        ).bindparams(ts=_now_ts()))
        session.exec(text(
            "UPDATE item SET updated_at = COALESCE(NULLIF(created_at, ''), :ts) WHERE updated_at IS NULL OR TRIM(updated_at) = ''"
        ).bindparams(ts=_now_ts()))

        session.commit()

        # ✅ helpful indexes (safe to run repeatedly)
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_item_is_archived ON item (is_archived)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_item_stock ON item (stock)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_item_product_id ON item (product_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_item_category_id ON item (category_id)"))
        session.commit()

        # ---------- bill table migration ----------
        bill_cols = session.exec(text("PRAGMA table_info(bill)")).all()
        bill_col_names = {c[1] for c in bill_cols}

        if "is_credit" not in bill_col_names:
            session.exec(text(
                "ALTER TABLE bill ADD COLUMN is_credit INTEGER NOT NULL DEFAULT 0"
            ))
        if "payment_status" not in bill_col_names:
            session.exec(text(
                "ALTER TABLE bill ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'PAID'"
            ))
        if "paid_amount" not in bill_col_names:
            session.exec(text(
                "ALTER TABLE bill ADD COLUMN paid_amount REAL NOT NULL DEFAULT 0"
            ))
        if "paid_at" not in bill_col_names:
            session.exec(text(
                "ALTER TABLE bill ADD COLUMN paid_at TEXT"
            ))
        if "is_deleted" not in bill_col_names:
            session.exec(text(
                "ALTER TABLE bill ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0"
            ))
        if "deleted_at" not in bill_col_names:
            session.exec(text(
                "ALTER TABLE bill ADD COLUMN deleted_at TEXT"
            ))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_bill_is_deleted ON bill (is_deleted)"))
        session.commit()

        # ---------- billpayment table migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS billpayment (
                id INTEGER PRIMARY KEY,
                bill_id INTEGER NOT NULL,
                received_at TEXT NOT NULL,
                mode TEXT NOT NULL,
                cash_amount REAL NOT NULL DEFAULT 0,
                online_amount REAL NOT NULL DEFAULT 0,
                note TEXT,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                deleted_at TEXT
            )
        """))
        bp_cols = session.exec(text("PRAGMA table_info(billpayment)")).all()
        bp_col_names = {c[1] for c in bp_cols}
        if "is_deleted" not in bp_col_names:
            session.exec(text(
                "ALTER TABLE billpayment ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0"
            ))
        if "deleted_at" not in bp_col_names:
            session.exec(text(
                "ALTER TABLE billpayment ADD COLUMN deleted_at TEXT"
            ))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_billpayment_bill_id ON billpayment (bill_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_billpayment_received_at ON billpayment (received_at)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_billpayment_is_deleted ON billpayment (is_deleted)"))
        session.commit()

        # ---------- bill item allocation migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS billitemallocation (
                id INTEGER PRIMARY KEY,
                bill_id INTEGER NOT NULL,
                bill_item_id INTEGER NOT NULL,
                item_id INTEGER NOT NULL,
                lot_id INTEGER,
                quantity INTEGER NOT NULL DEFAULT 0,
                stock_unit TEXT,
                created_at TEXT NOT NULL
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_billitemallocation_bill_id ON billitemallocation (bill_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_billitemallocation_bill_item_id ON billitemallocation (bill_item_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_billitemallocation_item_id ON billitemallocation (item_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_billitemallocation_lot_id ON billitemallocation (lot_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_billitemallocation_created_at ON billitemallocation (created_at)"))
        session.commit()

        # ---------- brand/category/product master migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS brand (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_brand_name ON brand (name)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_brand_is_active ON brand (is_active)"))

        session.exec(text("""
            CREATE TABLE IF NOT EXISTS category (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_category_name ON category (name)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_category_is_active ON category (is_active)"))

        session.exec(text("""
            CREATE TABLE IF NOT EXISTS product (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                alias TEXT,
                brand TEXT,
                category_id INTEGER,
                default_rack_number INTEGER NOT NULL DEFAULT 0,
                printed_price REAL NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        product_cols = session.exec(text("PRAGMA table_info(product)")).all()
        product_col_names = {c[1] for c in product_cols}
        if "printed_price" not in product_col_names:
            session.exec(text(
                "ALTER TABLE product ADD COLUMN printed_price REAL NOT NULL DEFAULT 0"
            ))
        if "default_rack_number" not in product_col_names:
            session.exec(text(
                "ALTER TABLE product ADD COLUMN default_rack_number INTEGER NOT NULL DEFAULT 0"
            ))
        if "is_active" not in product_col_names:
            session.exec(text(
                "ALTER TABLE product ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1"
            ))
        if "parent_unit_name" not in product_col_names:
            session.exec(text(
                "ALTER TABLE product ADD COLUMN parent_unit_name TEXT"
            ))
        if "child_unit_name" not in product_col_names:
            session.exec(text(
                "ALTER TABLE product ADD COLUMN child_unit_name TEXT"
            ))
        if "loose_sale_enabled" not in product_col_names:
            session.exec(text(
                "ALTER TABLE product ADD COLUMN loose_sale_enabled INTEGER NOT NULL DEFAULT 0"
            ))
        if "default_conversion_qty" not in product_col_names:
            session.exec(text(
                "ALTER TABLE product ADD COLUMN default_conversion_qty INTEGER"
            ))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_product_name ON product (name)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_product_alias ON product (alias)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_product_brand ON product (brand)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_product_category_id ON product (category_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_product_default_rack_number ON product (default_rack_number)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_product_is_active ON product (is_active)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_product_loose_sale_enabled ON product (loose_sale_enabled)"))
        session.commit()

        # ---------- customer / requested item migration ----------
        customer_cols = session.exec(text("PRAGMA table_info(customer)")).all()
        customer_col_names = {c[1] for c in customer_cols}
        if customer_cols:
            if "address_line" not in customer_col_names:
                session.exec(text("ALTER TABLE customer ADD COLUMN address_line TEXT"))
            if "created_at" not in customer_col_names:
                session.exec(text("ALTER TABLE customer ADD COLUMN created_at TEXT"))
            if "updated_at" not in customer_col_names:
                session.exec(text("ALTER TABLE customer ADD COLUMN updated_at TEXT"))

            session.exec(text(
                "UPDATE customer SET created_at = :ts WHERE created_at IS NULL OR TRIM(created_at) = ''"
            ).bindparams(ts=_now_ts()))
            session.exec(text(
                "UPDATE customer SET updated_at = COALESCE(NULLIF(created_at, ''), :ts) WHERE updated_at IS NULL OR TRIM(updated_at) = ''"
            ).bindparams(ts=_now_ts()))

            session.exec(text("CREATE INDEX IF NOT EXISTS ix_customer_name ON customer (name)"))
            session.exec(text("CREATE INDEX IF NOT EXISTS ix_customer_phone ON customer (phone)"))
            session.commit()

        requested_item_cols = session.exec(text("PRAGMA table_info(requesteditem)")).all()
        requested_item_col_names = {c[1] for c in requested_item_cols}
        if requested_item_cols:
            if "customer_name" not in requested_item_col_names:
                session.exec(text("ALTER TABLE requesteditem ADD COLUMN customer_name TEXT"))
            if "notes" not in requested_item_col_names:
                session.exec(text("ALTER TABLE requesteditem ADD COLUMN notes TEXT"))
            if "created_at" not in requested_item_col_names:
                session.exec(text("ALTER TABLE requesteditem ADD COLUMN created_at TEXT"))
            if "updated_at" not in requested_item_col_names:
                session.exec(text("ALTER TABLE requesteditem ADD COLUMN updated_at TEXT"))

            session.exec(text(
                "UPDATE requesteditem SET created_at = :ts WHERE created_at IS NULL OR TRIM(created_at) = ''"
            ).bindparams(ts=_now_ts()))
            session.exec(text(
                "UPDATE requesteditem SET updated_at = COALESCE(NULLIF(created_at, ''), :ts) WHERE updated_at IS NULL OR TRIM(updated_at) = ''"
            ).bindparams(ts=_now_ts()))

            session.exec(text("CREATE INDEX IF NOT EXISTS ix_requesteditem_mobile ON requesteditem (mobile)"))
            session.exec(text("CREATE INDEX IF NOT EXISTS ix_requesteditem_is_available ON requesteditem (is_available)"))
            session.commit()

        # ---------- inventory lot migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS inventorylot (
                id INTEGER PRIMARY KEY,
                product_id INTEGER NOT NULL,
                expiry_date TEXT,
                mrp REAL NOT NULL DEFAULT 0,
                cost_price REAL,
                rack_number INTEGER NOT NULL DEFAULT 0,
                sealed_qty INTEGER NOT NULL DEFAULT 0,
                loose_qty INTEGER NOT NULL DEFAULT 0,
                conversion_qty INTEGER,
                opened_from_lot_id INTEGER,
                legacy_item_id INTEGER,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_inventorylot_product_id ON inventorylot (product_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_inventorylot_rack_number ON inventorylot (rack_number)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_inventorylot_opened_from_lot_id ON inventorylot (opened_from_lot_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_inventorylot_legacy_item_id ON inventorylot (legacy_item_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_inventorylot_is_active ON inventorylot (is_active)"))
        session.commit()

        # ---------- party / year / audit master migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS party (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                party_group TEXT NOT NULL,
                phone TEXT,
                address_line TEXT,
                gst_number TEXT,
                notes TEXT,
                opening_balance REAL NOT NULL DEFAULT 0,
                opening_balance_type TEXT NOT NULL DEFAULT 'DR',
                legacy_customer_id INTEGER,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_party_name ON party (name)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_party_group ON party (party_group)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_party_phone ON party (phone)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_party_is_active ON party (is_active)"))

        session.exec(text("""
            CREATE TABLE IF NOT EXISTS financialyear (
                id INTEGER PRIMARY KEY,
                label TEXT NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 0,
                is_locked INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_financialyear_label ON financialyear (label)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_financialyear_is_active ON financialyear (is_active)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_financialyear_is_locked ON financialyear (is_locked)"))

        session.exec(text("""
            CREATE TABLE IF NOT EXISTS auditlog (
                id INTEGER PRIMARY KEY,
                event_ts TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id INTEGER,
                action TEXT NOT NULL,
                note TEXT,
                details_json TEXT,
                actor TEXT
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_auditlog_event_ts ON auditlog (event_ts)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_auditlog_entity_type ON auditlog (entity_type)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_auditlog_entity_id ON auditlog (entity_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_auditlog_action ON auditlog (action)"))
        session.commit()

        # ---------- user / pin migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS appuser (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                role TEXT NOT NULL,
                pin TEXT,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_appuser_name ON appuser (name)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_appuser_role ON appuser (role)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_appuser_is_active ON appuser (is_active)"))
        session.commit()

        # ---------- stock audit migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS stockaudit (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'DRAFT',
                created_at TEXT NOT NULL,
                closed_at TEXT
            )
        """))
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS stockaudititem (
                id INTEGER PRIMARY KEY,
                audit_id INTEGER NOT NULL,
                item_id INTEGER NOT NULL,
                system_stock INTEGER NOT NULL DEFAULT 0,
                physical_stock INTEGER
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_stockaudit_name ON stockaudit (name)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_stockaudit_status ON stockaudit (status)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_stockaudititem_audit_id ON stockaudititem (audit_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_stockaudititem_item_id ON stockaudititem (item_id)"))
        session.commit()

        # ---------- cashbookentry table migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS cashbookentry (
                id INTEGER PRIMARY KEY,
                created_at TEXT NOT NULL,
                entry_type TEXT NOT NULL,
                amount REAL NOT NULL,
                note TEXT
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_cashbookentry_created_at ON cashbookentry (created_at)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_cashbookentry_entry_type ON cashbookentry (entry_type)"))
        session.commit()

        # ---------- bankbookentry table migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS bankbookentry (
                id INTEGER PRIMARY KEY,
                created_at TEXT NOT NULL,
                entry_type TEXT NOT NULL,
                mode TEXT NOT NULL,
                amount REAL NOT NULL,
                txn_charges REAL NOT NULL DEFAULT 0,
                note TEXT
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_bankbookentry_created_at ON bankbookentry (created_at)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_bankbookentry_entry_type ON bankbookentry (entry_type)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_bankbookentry_mode ON bankbookentry (mode)"))
        session.commit()

        # ---------- purchase migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS purchase (
                id INTEGER PRIMARY KEY,
                party_id INTEGER NOT NULL,
                invoice_number TEXT NOT NULL,
                invoice_date TEXT NOT NULL,
                notes TEXT,
                subtotal_amount REAL NOT NULL DEFAULT 0,
                discount_amount REAL NOT NULL DEFAULT 0,
                gst_amount REAL NOT NULL DEFAULT 0,
                rounding_adjustment REAL NOT NULL DEFAULT 0,
                total_amount REAL NOT NULL DEFAULT 0,
                paid_amount REAL NOT NULL DEFAULT 0,
                writeoff_amount REAL NOT NULL DEFAULT 0,
                payment_status TEXT NOT NULL DEFAULT 'UNPAID',
                is_deleted INTEGER NOT NULL DEFAULT 0,
                deleted_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS purchaseitem (
                id INTEGER PRIMARY KEY,
                purchase_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                inventory_item_id INTEGER,
                product_name TEXT NOT NULL,
                brand TEXT,
                expiry_date TEXT,
                rack_number INTEGER NOT NULL DEFAULT 0,
                sealed_qty INTEGER NOT NULL DEFAULT 0,
                free_qty INTEGER NOT NULL DEFAULT 0,
                cost_price REAL NOT NULL DEFAULT 0,
                effective_cost_price REAL NOT NULL DEFAULT 0,
                mrp REAL NOT NULL DEFAULT 0,
                gst_percent REAL NOT NULL DEFAULT 0,
                discount_amount REAL NOT NULL DEFAULT 0,
                line_total REAL NOT NULL DEFAULT 0
            )
        """))
        purchase_item_cols = session.exec(text("PRAGMA table_info(purchaseitem)")).all()
        purchase_item_col_names = {c[1] for c in purchase_item_cols}
        if "inventory_item_id" not in purchase_item_col_names:
            session.exec(text("ALTER TABLE purchaseitem ADD COLUMN inventory_item_id INTEGER"))
        if "lot_id" not in purchase_item_col_names:
            session.exec(text("ALTER TABLE purchaseitem ADD COLUMN lot_id INTEGER"))
        if "effective_cost_price" not in purchase_item_col_names:
            session.exec(text("ALTER TABLE purchaseitem ADD COLUMN effective_cost_price REAL NOT NULL DEFAULT 0"))

        session.exec(text("""
            CREATE TABLE IF NOT EXISTS purchasepayment (
                id INTEGER PRIMARY KEY,
                purchase_id INTEGER NOT NULL,
                paid_at TEXT NOT NULL,
                amount REAL NOT NULL DEFAULT 0,
                note TEXT,
                is_writeoff INTEGER NOT NULL DEFAULT 0,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                deleted_at TEXT
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchase_party_id ON purchase (party_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchase_invoice_number ON purchase (invoice_number)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchase_payment_status ON purchase (payment_status)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchase_is_deleted ON purchase (is_deleted)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchaseitem_purchase_id ON purchaseitem (purchase_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchaseitem_product_id ON purchaseitem (product_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchaseitem_inventory_item_id ON purchaseitem (inventory_item_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchaseitem_lot_id ON purchaseitem (lot_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchasepayment_purchase_id ON purchasepayment (purchase_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchasepayment_paid_at ON purchasepayment (paid_at)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchasepayment_is_writeoff ON purchasepayment (is_writeoff)"))
        session.commit()

        # ---------- receipts / loose stock / voucher migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS partyreceipt (
                id INTEGER PRIMARY KEY,
                party_id INTEGER NOT NULL,
                received_at TEXT NOT NULL,
                mode TEXT NOT NULL,
                cash_amount REAL NOT NULL DEFAULT 0,
                online_amount REAL NOT NULL DEFAULT 0,
                total_amount REAL NOT NULL DEFAULT 0,
                unallocated_amount REAL NOT NULL DEFAULT 0,
                note TEXT,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                deleted_at TEXT
            )
        """))
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS receiptbilladjustment (
                id INTEGER PRIMARY KEY,
                receipt_id INTEGER NOT NULL,
                bill_id INTEGER NOT NULL,
                bill_payment_id INTEGER,
                adjusted_amount REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
        """))
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS packopenevent (
                id INTEGER PRIMARY KEY,
                source_lot_id INTEGER NOT NULL,
                loose_lot_id INTEGER NOT NULL,
                source_item_id INTEGER,
                loose_item_id INTEGER,
                packs_opened INTEGER NOT NULL DEFAULT 0,
                loose_units_created INTEGER NOT NULL DEFAULT 0,
                note TEXT,
                created_at TEXT NOT NULL
            )
        """))
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS ledgergroup (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                nature TEXT NOT NULL,
                system_key TEXT,
                is_system INTEGER NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS ledger (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                group_id INTEGER NOT NULL,
                party_id INTEGER,
                system_key TEXT,
                is_system INTEGER NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS voucher (
                id INTEGER PRIMARY KEY,
                voucher_type TEXT NOT NULL,
                source_type TEXT NOT NULL,
                source_id INTEGER NOT NULL,
                voucher_no TEXT NOT NULL,
                voucher_date TEXT NOT NULL,
                narration TEXT,
                total_amount REAL NOT NULL DEFAULT 0,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                deleted_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS voucherentry (
                id INTEGER PRIMARY KEY,
                voucher_id INTEGER NOT NULL,
                ledger_id INTEGER NOT NULL,
                entry_type TEXT NOT NULL,
                amount REAL NOT NULL DEFAULT 0,
                narration TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_partyreceipt_party_id ON partyreceipt (party_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_partyreceipt_received_at ON partyreceipt (received_at)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_partyreceipt_is_deleted ON partyreceipt (is_deleted)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_receiptbilladjustment_receipt_id ON receiptbilladjustment (receipt_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_receiptbilladjustment_bill_id ON receiptbilladjustment (bill_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_receiptbilladjustment_bill_payment_id ON receiptbilladjustment (bill_payment_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_packopenevent_source_lot_id ON packopenevent (source_lot_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_packopenevent_loose_lot_id ON packopenevent (loose_lot_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_packopenevent_created_at ON packopenevent (created_at)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_ledgergroup_name ON ledgergroup (name)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_ledgergroup_system_key ON ledgergroup (system_key)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_ledger_name ON ledger (name)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_ledger_group_id ON ledger (group_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_ledger_party_id ON ledger (party_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_ledger_system_key ON ledger (system_key)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_voucher_voucher_type ON voucher (voucher_type)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_voucher_source_type ON voucher (source_type)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_voucher_source_id ON voucher (source_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_voucher_voucher_no ON voucher (voucher_no)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_voucher_voucher_date ON voucher (voucher_date)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_voucher_is_deleted ON voucher (is_deleted)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_voucherentry_voucher_id ON voucherentry (voucher_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_voucherentry_ledger_id ON voucherentry (ledger_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_voucherentry_entry_type ON voucherentry (entry_type)"))
        session.commit()

        # ---------- exchangerecord table migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS exchangerecord (
                id INTEGER PRIMARY KEY,
                created_at TEXT NOT NULL,
                source_bill_id INTEGER,
                return_id INTEGER NOT NULL,
                new_bill_id INTEGER NOT NULL,
                theoretical_net REAL NOT NULL DEFAULT 0,
                net_due REAL NOT NULL DEFAULT 0,
                rounding_adjustment REAL NOT NULL DEFAULT 0,
                payment_mode TEXT NOT NULL DEFAULT 'cash',
                payment_cash REAL NOT NULL DEFAULT 0,
                payment_online REAL NOT NULL DEFAULT 0,
                refund_cash REAL NOT NULL DEFAULT 0,
                refund_online REAL NOT NULL DEFAULT 0,
                notes TEXT
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_exchangerecord_created_at ON exchangerecord (created_at)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_exchangerecord_return_id ON exchangerecord (return_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_exchangerecord_new_bill_id ON exchangerecord (new_bill_id)"))
        session.commit()

        # ---------- stockmovement table migration ----------
        sm_cols = session.exec(text("PRAGMA table_info(stockmovement)")).all()
        sm_col_names = {c[1] for c in sm_cols}  # column name is index 1

        if not sm_cols:
            # table doesn't exist: create fresh
            session.exec(text("""
                CREATE TABLE IF NOT EXISTS stockmovement (
                    id INTEGER PRIMARY KEY,
                    item_id INTEGER NOT NULL,
                    ts TEXT NOT NULL,
                    delta INTEGER NOT NULL,
                    reason TEXT NOT NULL,
                    ref_type TEXT,
                    ref_id INTEGER,
                    note TEXT,
                    actor TEXT
                )
            """))
            session.commit()
        else:
            required = {"id", "item_id", "ts", "delta", "reason", "ref_type", "ref_id", "note", "actor"}
            missing = required - sm_col_names

            if missing:
                # Rename old table
                session.exec(text("ALTER TABLE stockmovement RENAME TO stockmovement_old"))
                session.commit()

                # Create new correct table
                session.exec(text("""
                    CREATE TABLE stockmovement (
                        id INTEGER PRIMARY KEY,
                        item_id INTEGER NOT NULL,
                        ts TEXT NOT NULL,
                        delta INTEGER NOT NULL,
                        reason TEXT NOT NULL,
                        ref_type TEXT,
                        ref_id INTEGER,
                        note TEXT,
                        actor TEXT
                    )
                """))
                session.commit()

                old_cols = sm_col_names

                # map any possible timestamp column
                if "ts" in old_cols:
                    ts_expr = "ts"
                elif "created_at" in old_cols:
                    ts_expr = "created_at"
                elif "date_time" in old_cols:
                    ts_expr = "date_time"
                elif "datetime" in old_cols:
                    ts_expr = "datetime"
                else:
                    ts_expr = "'1970-01-01T00:00:00'"

                item_id_expr = "item_id" if "item_id" in old_cols else "0"
                delta_expr = "delta" if "delta" in old_cols else "0"
                reason_expr = "reason" if "reason" in old_cols else "'MIGRATED'"
                ref_type_expr = "ref_type" if "ref_type" in old_cols else "NULL"
                ref_id_expr = "ref_id" if "ref_id" in old_cols else "NULL"
                note_expr = "note" if "note" in old_cols else "NULL"
                actor_expr = "actor" if "actor" in old_cols else "NULL"

                # IMPORTANT: don't copy id if old data might be inconsistent
                session.exec(text(f"""
                    INSERT INTO stockmovement (item_id, ts, delta, reason, ref_type, ref_id, note, actor)
                    SELECT
                        {item_id_expr},
                        {ts_expr},
                        {delta_expr},
                        {reason_expr},
                        {ref_type_expr},
                        {ref_id_expr},
                        {note_expr},
                        {actor_expr}
                    FROM stockmovement_old
                """))
                session.commit()

                session.exec(text("DROP TABLE stockmovement_old"))
                session.commit()

        # Create indexes (safe)
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_stockmovement_item_id ON stockmovement (item_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_stockmovement_ts ON stockmovement (ts)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_stockmovement_reason ON stockmovement (reason)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_stockmovement_ref_type ON stockmovement (ref_type)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_stockmovement_ref_id ON stockmovement (ref_id)"))
        session.commit()

        session.exec(text("""
            CREATE TABLE IF NOT EXISTS appmeta (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at TEXT
            )
        """))
        session.commit()

        # ---------- default financial year ----------
        fy_count_row = session.exec(text("SELECT COUNT(*) FROM financialyear")).one()
        fy_count = fy_count_row[0] if isinstance(fy_count_row, tuple) or hasattr(fy_count_row, "__getitem__") else fy_count_row
        if int(fy_count or 0) == 0:
            today = datetime.now().date()
            if today.month >= 4:
                start_year = today.year
            else:
                start_year = today.year - 1
            start_date = f"{start_year}-04-01"
            end_date = f"{start_year + 1}-03-31"
            session.exec(
                text("""
                    INSERT INTO financialyear (
                        label, start_date, end_date, is_active, is_locked, created_at, updated_at
                    ) VALUES (
                        :label, :start_date, :end_date, 1, 0, :ts, :ts
                    )
                """),
                {
                    "label": f"FY {str(start_year)[-2:]}-{str(start_year + 1)[-2:]}",
                    "start_date": start_date,
                    "end_date": end_date,
                    "ts": _now_ts(),
                },
            )
            session.commit()

        # ---------- inventory lot backfill ----------
        lot_backfill_key = "backfill_inventory_lots_v1"
        lot_backfill_done = session.exec(
            text("SELECT value FROM appmeta WHERE key = :k LIMIT 1").bindparams(k=lot_backfill_key),
        ).first()
        if not lot_backfill_done:
            ts3 = _now_ts()
            item_rows = session.exec(
                text("""
                    SELECT id, name, brand, product_id, category_id, expiry_date, mrp, cost_price, stock, rack_number, is_archived
                    FROM item
                    ORDER BY id ASC
                """)
            ).all()

            for row in item_rows:
                item_id = int(row[0] or 0)
                if item_id <= 0:
                    continue
                has_lot = session.exec(
                    text("SELECT 1 FROM inventorylot WHERE legacy_item_id = :item_id LIMIT 1").bindparams(item_id=item_id),
                ).first()
                if has_lot:
                    continue

                product_id = row[3]
                if product_id is None:
                    name = str(row[1] or "").strip()
                    brand = str(row[2] or "").strip() or None
                    if not name:
                        continue
                    existing_product = session.exec(
                        text("""
                            SELECT id
                            FROM product
                            WHERE lower(coalesce(name, '')) = lower(:name)
                              AND lower(coalesce(brand, '')) = lower(:brand)
                            LIMIT 1
                        """),
                        {"name": name, "brand": brand or ""},
                    ).first()
                    if existing_product:
                        product_id = int(existing_product[0])
                    else:
                        session.exec(
                            text("""
                                INSERT INTO product (
                                    name, alias, brand, category_id, default_rack_number, printed_price,
                                    parent_unit_name, child_unit_name, loose_sale_enabled, default_conversion_qty,
                                    is_active, created_at, updated_at
                                ) VALUES (
                                    :name, NULL, :brand, :category_id, :rack_number, :printed_price,
                                    NULL, NULL, 0, NULL, 1, :ts, :ts
                                )
                            """),
                            {
                                "name": name,
                                "brand": brand,
                                "category_id": row[4],
                                "rack_number": int(row[9] or 0),
                                "printed_price": float(row[6] or 0),
                                "ts": ts3,
                            },
                        )
                        product_id = int(session.exec(text("SELECT last_insert_rowid()")).one()[0])
                        session.exec(
                            text("UPDATE item SET product_id = :product_id WHERE id = :item_id"),
                            {"product_id": product_id, "item_id": item_id},
                        )

                if product_id is None:
                    continue

                session.exec(
                    text("""
                        INSERT INTO inventorylot (
                            product_id, expiry_date, mrp, cost_price, rack_number,
                            sealed_qty, loose_qty, conversion_qty, opened_from_lot_id,
                            legacy_item_id, is_active, created_at, updated_at
                        ) VALUES (
                            :product_id, :expiry_date, :mrp, :cost_price, :rack_number,
                            :sealed_qty, 0, NULL, NULL,
                            :legacy_item_id, :is_active, :ts, :ts
                        )
                    """),
                    {
                        "product_id": int(product_id),
                        "expiry_date": row[5],
                        "mrp": float(row[6] or 0),
                        "cost_price": float(row[7] or 0),
                        "rack_number": int(row[9] or 0),
                        "sealed_qty": max(0, int(row[8] or 0)),
                        "legacy_item_id": item_id,
                        "is_active": 0 if bool(row[10]) else 1,
                        "ts": ts3,
                    },
                )

            session.exec(
                text("""
                    INSERT INTO appmeta (key, value, updated_at)
                    VALUES (:k, 'done', :ts)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """).bindparams(k=lot_backfill_key, ts=ts3),
            )
            session.commit()

        # ---------- one-time backfill: deleted bill stock + ledger ----------
        backfill_key = "backfill_deleted_bill_stock_ledger_v2"
        already_done = session.exec(
            text("SELECT value FROM appmeta WHERE key = :k LIMIT 1").bindparams(k=backfill_key),
        ).first()

        if not already_done:
            ts = _now_ts()
            deleted_bill_ids = session.exec(text("SELECT id FROM bill WHERE is_deleted = 1")).all()

            for row in deleted_bill_ids:
                bill_id = int(row[0])

                has_delete_movement = session.exec(
                    text("""
                        SELECT 1
                        FROM stockmovement
                        WHERE ref_type = 'BILL' AND ref_id = :bill_id AND reason = 'BILL_DELETE'
                        LIMIT 1
                    """).bindparams(bill_id=bill_id),
                ).first()
                if has_delete_movement:
                    continue

                bill_lines = session.exec(
                    text("""
                        SELECT item_id, COALESCE(SUM(quantity), 0) AS qty
                        FROM billitem
                        WHERE bill_id = :bill_id
                        GROUP BY item_id
                        HAVING COALESCE(SUM(quantity), 0) > 0
                    """).bindparams(bill_id=bill_id),
                ).all()

                for line in bill_lines:
                    item_id = int(line[0])
                    qty = int(line[1])

                    item_exists = session.exec(
                        text("SELECT 1 FROM item WHERE id = :item_id LIMIT 1").bindparams(item_id=item_id),
                    ).first()
                    if not item_exists:
                        continue

                    session.exec(
                        text("UPDATE item SET stock = COALESCE(stock, 0) + :qty WHERE id = :item_id").bindparams(
                            qty=qty,
                            item_id=item_id,
                        ),
                    )
                    session.exec(
                        text("""
                            INSERT INTO stockmovement (item_id, ts, delta, reason, ref_type, ref_id, note, actor)
                            VALUES (:item_id, :ts, :delta, 'BILL_DELETE', 'BILL', :ref_id, :note, 'migration')
                        """).bindparams(
                            item_id=item_id,
                            ts=ts,
                            delta=qty,
                            ref_id=bill_id,
                            note=f"Backfill: bill #{bill_id} was already soft-deleted before ledger fix",
                        ),
                    )

            session.exec(
                text("""
                    INSERT INTO appmeta (key, value, updated_at)
                    VALUES (:k, 'done', :ts)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """).bindparams(k=backfill_key, ts=ts),
            )
            session.commit()

        # ---------- one-time backfill: missing SALE ledger rows for existing bills ----------
        sale_backfill_key = "backfill_missing_bill_sale_ledger_v2"
        sale_backfill_done = session.exec(
            text("SELECT value FROM appmeta WHERE key = :k LIMIT 1").bindparams(k=sale_backfill_key),
        ).first()

        if not sale_backfill_done:
            ts2 = _now_ts()
            bill_rows = session.exec(text("SELECT id FROM bill")).all()

            for row in bill_rows:
                bill_id = int(row[0])
                has_bill_edit = session.exec(
                    text("""
                        SELECT 1
                        FROM stockmovement
                        WHERE ref_type = 'BILL' AND ref_id = :bill_id AND reason = 'BILL_EDIT'
                        LIMIT 1
                    """).bindparams(bill_id=bill_id),
                ).first()
                if has_bill_edit:
                    # Edited bills already have correction entries; auto SALE backfill can overstate history.
                    continue

                bill_lines = session.exec(
                    text("""
                        SELECT item_id, COALESCE(SUM(quantity), 0) AS qty
                        FROM billitem
                        WHERE bill_id = :bill_id
                        GROUP BY item_id
                        HAVING COALESCE(SUM(quantity), 0) > 0
                    """).bindparams(bill_id=bill_id),
                ).all()

                for line in bill_lines:
                    item_id = int(line[0])
                    sold_qty = int(line[1])

                    sale_abs = session.exec(
                        text("""
                            SELECT COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0)
                            FROM stockmovement
                            WHERE ref_type = 'BILL'
                              AND ref_id = :bill_id
                              AND item_id = :item_id
                              AND reason = 'SALE'
                        """).bindparams(bill_id=bill_id, item_id=item_id),
                    ).first()
                    existing_sale_qty = int(sale_abs[0] or 0) if sale_abs else 0
                    missing_qty = sold_qty - existing_sale_qty
                    if missing_qty <= 0:
                        continue

                    session.exec(
                        text("""
                            INSERT INTO stockmovement (item_id, ts, delta, reason, ref_type, ref_id, note, actor)
                            VALUES (:item_id, :ts, :delta, 'SALE', 'BILL', :ref_id, :note, 'migration')
                        """).bindparams(
                            item_id=item_id,
                            ts=ts2,
                            delta=-missing_qty,
                            ref_id=bill_id,
                            note=f"Backfill: missing SALE movement for bill #{bill_id}",
                        ),
                    )

            session.exec(
                text("""
                    INSERT INTO appmeta (key, value, updated_at)
                    VALUES (:k, 'done', :ts)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """).bindparams(k=sale_backfill_key, ts=ts2),
            )
            session.commit()


SQLModel.metadata.create_all(engine)
migrate_db()

@contextmanager
def get_session():
    # IMPORTANT: stop expiring objects after commit
    with Session(engine, expire_on_commit=False) as session:
        yield session
