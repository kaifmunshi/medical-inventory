# backend/main.py
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import SQLModel
from backend import models
from backend.db import engine, get_session
from backend.routers import inventory, billing
from backend.routers import returns as returns_router
from backend.routers import requested_items  # 👈 NEW
from backend.routers import customers
from backend.routers import cashbook
from backend.routers import parties, products, purchases, lots, vouchers, settings, users, audit
from backend.security import ensure_default_user, set_request_actor
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



@app.on_event("startup")
def on_startup():
    SQLModel.metadata.create_all(engine)
    with get_session() as session:
        ensure_default_user(session)


@app.middleware("http")
async def bind_actor_context(request: Request, call_next):
    set_request_actor(request.headers.get("X-Actor-Name"), request.headers.get("X-Actor-Role"))
    response = await call_next(request)
    return response


# Routers
app.include_router(inventory.router, prefix="/inventory", tags=["Inventory"])
app.include_router(billing.router,   prefix="/billing",   tags=["Billing"])
app.include_router(returns_router.router, prefix="/returns", tags=["Returns"])
app.include_router(cashbook.router, prefix="/cashbook", tags=["Cashbook"])  # 👈 NEW
app.include_router(
    requested_items.router,
    prefix="/requested-items",
    tags=["Requested Items"],   # 👈 NEW
)
app.include_router(customers.router, prefix="/customers", tags=["Customers"])
app.include_router(parties.router, prefix="/parties", tags=["Parties"])
app.include_router(products.router, prefix="/products", tags=["Products"])
app.include_router(purchases.router, prefix="/purchases", tags=["Purchases"])
app.include_router(lots.router, prefix="/lots", tags=["Lots"])
app.include_router(vouchers.router, prefix="/vouchers", tags=["Vouchers"])
app.include_router(settings.router, prefix="/settings", tags=["Settings"])
app.include_router(users.router, prefix="/users", tags=["Users"])
app.include_router(audit.router, prefix="/audits", tags=["Audits"])


@app.get("/")
def home():
    return {"message": "Welcome to Ayurvedic Medical Inventory System"}
