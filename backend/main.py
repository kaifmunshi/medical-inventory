# backend/main.py
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session
from sqlmodel import SQLModel
from backend.accounting import sync_existing_vouchers
from backend import models
from backend.db import engine, migrate_db
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
from backend.routers import settings
from backend.routers import lots
from backend.routers import vouchers
from backend.routers import users
app = FastAPI(title="Ayurvedic Medical Inventory System")

# For DEV: allow local frontend origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
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



@app.on_event("startup")
def on_startup():
    SQLModel.metadata.create_all(engine)
    migrate_db()
    with Session(engine, expire_on_commit=False) as session:
        sync_existing_vouchers(session)
        session.commit()


# Routers
app.include_router(inventory.router, prefix="/inventory", tags=["Inventory"])
app.include_router(billing.router,   prefix="/billing",   tags=["Billing"])
app.include_router(returns_router.router, prefix="/returns", tags=["Returns"])
app.include_router(cashbook.router, prefix="/cashbook", tags=["Cashbook"])  # 👈 NEW
app.include_router(bankbook.router, prefix="/bankbook", tags=["Bankbook"])
app.include_router(products.router, prefix="/products", tags=["Products"])
app.include_router(parties.router, prefix="/parties", tags=["Parties"])
app.include_router(purchases.router, prefix="/purchases", tags=["Purchases"])
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
