# backend/main.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import SQLModel

from backend.db import engine
from backend.routers import inventory, billing
from backend.routers import returns as returns_router
from backend.routers import requested_items  # 👈 NEW

app = FastAPI(title="Ayurvedic Medical Inventory System")

# For DEV: keep it simple and wide-open
# (once everything works, we can tighten this)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],        # 👈 TEMP: allow all origins in dev
    allow_credentials=True,
    allow_methods=["*"],        # 👈 allow POST, OPTIONS, etc.
    allow_headers=["*"],        # 👈 allow Content-Type, etc.
)


@app.on_event("startup")
def on_startup():
    SQLModel.metadata.create_all(engine)


# Routers
app.include_router(inventory.router, prefix="/inventory", tags=["Inventory"])
app.include_router(billing.router,   prefix="/billing",   tags=["Billing"])
app.include_router(returns_router.router, prefix="/returns", tags=["Returns"])
app.include_router(
    requested_items.router,
    prefix="/requested-items",
    tags=["Requested Items"],   # 👈 NEW
)


@app.get("/")
def home():
    return {"message": "Welcome to Ayurvedic Medical Inventory System"}
