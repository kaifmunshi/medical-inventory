# backend/db.py
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

        # add new fields only if missing
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


SQLModel.metadata.create_all(engine)
migrate_db()

@contextmanager
def get_session():
    with Session(engine) as session:
        yield session
