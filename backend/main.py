# backend/main.py
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlmodel import Session
from backend.accounting import sync_existing_vouchers
from backend import models
from backend.db import engine
from backend.security import set_request_actor, verify_session_token
from backend.routers import inventory, billing
from backend.routers import returns as returns_router
from backend.routers import requested_items  # 👈 NEW
from backend.routers import customers
from backend.routers import cashbook
from backend.routers import bankbook
from backend.routers import products
from backend.routers import audit
from backend.routers import parties
from backend.routers import purchases
from backend.routers import purchase_returns
from backend.routers import settings
from backend.routers import lots
from backend.routers import vouchers
from backend.routers import users
app = FastAPI(title="Ayurvedic Medical Inventory System")

extra_origins = [
    origin.strip()
    for origin in str(os.environ.get("APP_CORS_ORIGINS") or "").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
        "null",
        *extra_origins,
    ],
    allow_origin_regex=r"^(https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+)(?::\d+)?|tauri://localhost|capacitor://localhost|null)$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def bind_request_actor(request: Request, call_next):
    set_request_actor(None, None, None)
    auth = str(request.headers.get("authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        payload = verify_session_token(auth[7:].strip())
        if payload:
            set_request_actor(
                str(payload.get("name") or ""),
                str(payload.get("role") or ""),
                int(payload.get("uid")) if payload.get("uid") is not None else None,
            )
    return await call_next(request)



def _sync_existing_vouchers_once() -> None:
    with Session(engine, expire_on_commit=False) as session:
        key = "accounting_existing_vouchers_synced_v1"
        row = session.exec(text("SELECT value FROM appmeta WHERE key = :key").bindparams(key=key)).first()
        if row and str(row[0]) == "done":
            return
        sync_existing_vouchers(session)
        session.exec(
            text("""
                INSERT INTO appmeta (key, value, updated_at)
                VALUES (:key, 'done', datetime('now'))
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """).bindparams(key=key)
        )
        session.commit()


@app.on_event("startup")
def on_startup():
    # backend.db already creates tables and applies schema/data migrations on import.
    # Keep startup light: only run the historical accounting backfill once per database.
    _sync_existing_vouchers_once()


# Routers
app.include_router(inventory.router, prefix="/inventory", tags=["Inventory"])
app.include_router(billing.router,   prefix="/billing",   tags=["Billing"])
app.include_router(returns_router.router, prefix="/returns", tags=["Sales Returns"])
app.include_router(cashbook.router, prefix="/cashbook", tags=["Cashbook"])  # 👈 NEW
app.include_router(bankbook.router, prefix="/bankbook", tags=["Bankbook"])
app.include_router(products.router, prefix="/products", tags=["Products"])
app.include_router(parties.router, prefix="/parties", tags=["Parties"])
app.include_router(purchases.router, prefix="/purchases", tags=["Purchases"])
app.include_router(purchase_returns.router, prefix="/purchase-returns", tags=["Purchase Returns"])
app.include_router(audit.router, prefix="/audits", tags=["Stock Audit"])
app.include_router(settings.router, prefix="/settings", tags=["Settings"])
app.include_router(lots.router, prefix="/lots", tags=["Lots"])
app.include_router(vouchers.router, prefix="/vouchers", tags=["Vouchers"])
app.include_router(users.router, prefix="/users", tags=["Users"])
app.include_router(
    requested_items.router,
    prefix="/requested-items",
    tags=["Requested Items"],   # 👈 NEW
)
app.include_router(customers.router, prefix="/customers", tags=["Customers"])


@app.get("/")
def home():
    return {"message": "Welcome to Ayurvedic Medical Inventory System"}
