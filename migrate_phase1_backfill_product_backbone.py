from collections import defaultdict
from datetime import date, datetime
from typing import Optional

from sqlmodel import Session, SQLModel, select

from backend.db import engine
from backend.models import (
    Category,
    Customer,
    FinancialYear,
    InventoryLot,
    Item,
    Party,
    Product,
)


def now_ts() -> str:
    return datetime.now().isoformat(timespec="seconds")


def norm(s: Optional[str]) -> str:
    return str(s or "").strip().casefold()


def current_financial_year_bounds(today: date) -> tuple[str, str, str]:
    if today.month >= 4:
        start_year = today.year
        end_year = today.year + 1
    else:
        start_year = today.year - 1
        end_year = today.year
    start_date = f"{start_year:04d}-04-01"
    end_date = f"{end_year:04d}-03-31"
    label = f"FY {start_year}-{str(end_year)[-2:]}"
    return label, start_date, end_date


def pick_default_rack(items: list[Item]) -> int:
    counts: dict[int, int] = defaultdict(int)
    for item in items:
        counts[int(item.rack_number or 0)] += 1
    if not counts:
        return 0
    return sorted(counts.items(), key=lambda x: (-x[1], x[0]))[0][0]


def ensure_uncategorized_category(session: Session) -> Category:
    row = session.exec(
        select(Category).where(Category.name == "Uncategorized")
    ).first()
    if row:
        return row

    ts = now_ts()
    row = Category(
        name="Uncategorized",
        is_active=True,
        created_at=ts,
        updated_at=ts,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def ensure_current_financial_year(session: Session) -> None:
    label, start_date, end_date = current_financial_year_bounds(date.today())
    existing = session.exec(
        select(FinancialYear).where(
            FinancialYear.label == label,
            FinancialYear.start_date == start_date,
            FinancialYear.end_date == end_date,
        )
    ).first()
    if existing:
        if not existing.is_active:
            existing.is_active = True
            existing.updated_at = now_ts()
            session.add(existing)
            session.commit()
        return

    ts = now_ts()
    row = FinancialYear(
        label=label,
        start_date=start_date,
        end_date=end_date,
        is_active=True,
        is_locked=False,
        created_at=ts,
        updated_at=ts,
    )
    session.add(row)
    session.commit()


def backfill_products_and_lots(session: Session) -> dict[str, int]:
    stats = {"products_created": 0, "lots_created": 0}
    uncategorized = ensure_uncategorized_category(session)

    items = session.exec(select(Item).order_by(Item.id)).all()
    grouped: dict[tuple[str, str], list[Item]] = defaultdict(list)
    for item in items:
        grouped[(norm(item.name), norm(item.brand))].append(item)

    product_map: dict[tuple[str, str], Product] = {}
    for (_, _), grouped_items in grouped.items():
        sample = grouped_items[0]
        existing = session.exec(
            select(Product).where(
                Product.name == sample.name,
                Product.brand == sample.brand,
            )
        ).first()
        if existing:
            product_map[(norm(sample.name), norm(sample.brand))] = existing
            continue

        ts = now_ts()
        product = Product(
            name=sample.name,
            alias=None,
            brand=sample.brand,
            category_id=uncategorized.id,
            default_rack_number=pick_default_rack(grouped_items),
            parent_unit_name=None,
            child_unit_name=None,
            loose_sale_enabled=False,
            default_conversion_qty=None,
            is_active=True,
            created_at=ts,
            updated_at=ts,
        )
        session.add(product)
        session.commit()
        session.refresh(product)
        product_map[(norm(sample.name), norm(sample.brand))] = product
        stats["products_created"] += 1

    for item in items:
        existing_lot = session.exec(
            select(InventoryLot).where(InventoryLot.legacy_item_id == item.id)
        ).first()
        if existing_lot:
            continue

        product = product_map[(norm(item.name), norm(item.brand))]
        ts = now_ts()
        lot = InventoryLot(
            product_id=product.id,
            expiry_date=item.expiry_date,
            mrp=float(item.mrp or 0),
            cost_price=None,
            rack_number=int(item.rack_number or 0),
            sealed_qty=int(item.stock or 0),
            loose_qty=0,
            conversion_qty=product.default_conversion_qty,
            opened_from_lot_id=None,
            legacy_item_id=item.id,
            is_active=not bool(getattr(item, "is_archived", False)),
            created_at=getattr(item, "created_at", ts) or ts,
            updated_at=getattr(item, "updated_at", ts) or ts,
        )
        session.add(lot)
        session.commit()
        stats["lots_created"] += 1

    return stats


def backfill_parties(session: Session) -> dict[str, int]:
    stats = {"parties_created": 0}
    customers = session.exec(select(Customer).order_by(Customer.id)).all()

    for customer in customers:
        existing = session.exec(
            select(Party).where(Party.legacy_customer_id == customer.id)
        ).first()
        if existing:
            continue

        ts = now_ts()
        row = Party(
            name=customer.name,
            party_group="SUNDRY_DEBTOR",
            phone=customer.phone,
            address_line=customer.address_line,
            gst_number=None,
            notes=None,
            opening_balance=0.0,
            opening_balance_type="DR",
            legacy_customer_id=customer.id,
            is_active=True,
            created_at=getattr(customer, "created_at", ts) or ts,
            updated_at=getattr(customer, "updated_at", ts) or ts,
        )
        session.add(row)
        session.commit()
        stats["parties_created"] += 1

    return stats


def main():
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        ensure_current_financial_year(session)
        product_stats = backfill_products_and_lots(session)
        party_stats = backfill_parties(session)

        print("Phase 1 backfill complete")
        print(f"products_created={product_stats['products_created']}")
        print(f"lots_created={product_stats['lots_created']}")
        print(f"parties_created={party_stats['parties_created']}")


if __name__ == "__main__":
    main()
