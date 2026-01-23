from contextlib import contextmanager
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


SQLModel.metadata.create_all(engine)
migrate_db()

@contextmanager
def get_session():
    # IMPORTANT: stop expiring objects after commit
    with Session(engine, expire_on_commit=False) as session:
        yield session