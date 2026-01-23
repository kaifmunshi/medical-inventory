# backend/main.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import SQLModel
from backend import models
from backend.db import engine
from backend.routers import inventory, billing
from backend.routers import returns as returns_router
from backend.routers import requested_items  # 👈 NEW
from backend.routers import cashbook
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


@app.get("/")
def home():
    return {"message": "Welcome to Ayurvedic Medical Inventory System"}
