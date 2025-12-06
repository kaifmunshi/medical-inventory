# backend\db.py
from contextlib import contextmanager
from sqlmodel import create_engine, Session

DB_FILE = "medical_shop.db"
engine = create_engine(f"sqlite:///{DB_FILE}", echo=False, connect_args={"check_same_thread": False})

@contextmanager
def get_session():
    with Session(engine) as session:
        yield session
