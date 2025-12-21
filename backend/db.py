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

SQLModel.metadata.create_all(engine)
migrate_db()

@contextmanager
def get_session():
    with Session(engine) as session:
        yield session
