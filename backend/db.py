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

        session.commit()

        # ✅ helpful indexes (safe to run repeatedly)
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_item_is_archived ON item (is_archived)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_item_stock ON item (stock)"))
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
                note TEXT
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_billpayment_bill_id ON billpayment (bill_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_billpayment_received_at ON billpayment (received_at)"))
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

        # ---------- one-time backfill: deleted bill stock + ledger ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS appmeta (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at TEXT
            )
        """))
        session.commit()

        backfill_key = "backfill_deleted_bill_stock_ledger_v1"
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
        sale_backfill_key = "backfill_missing_bill_sale_ledger_v1"
        sale_backfill_done = session.exec(
            text("SELECT value FROM appmeta WHERE key = :k LIMIT 1").bindparams(k=sale_backfill_key),
        ).first()

        if not sale_backfill_done:
            ts2 = _now_ts()
            bill_rows = session.exec(text("SELECT id FROM bill")).all()

            for row in bill_rows:
                bill_id = int(row[0])
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
