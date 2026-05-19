from contextlib import contextmanager
from datetime import datetime
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
from sqlmodel import create_engine, Session, SQLModel
from sqlalchemy import text

BASE_DIR = Path(__file__).resolve().parent.parent   # project root (medical-inventory/)


def _resolve_db_file() -> Path:
    env_value = (
        os.environ.get("MEDICAL_SHOP_DB_PATH")
        or os.environ.get("MEDICAL_INVENTORY_DB_PATH")
        or os.environ.get("DB_FILE")
    )
    if env_value:
        return Path(env_value).expanduser().resolve()

    candidates = [
        Path.cwd() / "medical_shop.db",
        Path(sys.argv[0]).resolve().parent / "medical_shop.db" if sys.argv and sys.argv[0] else None,
        Path(sys.executable).resolve().parent / "medical_shop.db" if sys.executable else None,
        BASE_DIR / "medical_shop.db",
    ]

    for candidate in candidates:
        if candidate and candidate.exists():
            return candidate

    return BASE_DIR / "medical_shop.db"


DB_FILE = _resolve_db_file()
DB_FILE.parent.mkdir(parents=True, exist_ok=True)

engine = create_engine(
    f"sqlite:///{DB_FILE}",
    echo=False,
    connect_args={"check_same_thread": False},
)


def _now_ts() -> str:
    return datetime.now().isoformat(timespec="seconds")


PURCHASE_DUPLICATE_STOCK_REPAIR_TARGETS = [
    {
        "purchase_item_id": 14,
        "invoice_number": "A000758",
        "product_name": "Arq Badyan 500Ml",
        "brand": "Hamdard",
        "expiry_date": "2026-12-31",
        "mrp": 120.0,
        "qty": 3,
        "old_item_id": 1467,
        "restored_item_id": 1605,
    },
    {
        "purchase_item_id": 19,
        "invoice_number": "AYU2600051",
        "product_name": "Rheumarx 30Cap",
        "brand": "Ayukalp",
        "expiry_date": "2027-12-31",
        "mrp": 196.88,
        "qty": 6,
        "old_item_id": 1454,
        "restored_item_id": 1610,
    },
    {
        "purchase_item_id": 32,
        "invoice_number": "GR 30",
        "product_name": "Aerand Bhrust Harde 100Tab",
        "brand": "Yash",
        "expiry_date": "2029-02-28",
        "mrp": 100.0,
        "qty": 3,
        "old_item_id": 1520,
        "restored_item_id": 1623,
    },
    {
        "purchase_item_id": 48,
        "invoice_number": "A000037",
        "product_name": "It. Ustukhuddus 150g",
        "brand": "Hamdard",
        "expiry_date": "2028-12-31",
        "mrp": 75.0,
        "qty": 3,
        "old_item_id": 1314,
        "restored_item_id": 1639,
    },
    {
        "purchase_item_id": 129,
        "invoice_number": "A000630",
        "product_name": "MJ Hajrul Yahud 60 g",
        "brand": "Hamdard",
        "expiry_date": "2028-08-31",
        "mrp": 60.0,
        "qty": 1,
        "old_item_id": 1586,
        "restored_item_id": 1715,
    },
]


def repair_purchase_duplicate_stock_links(session) -> int:
    """Restore known purchase-created batches that a bulk duplicate repair hid."""
    ts = _now_ts()
    applied = []

    for target in PURCHASE_DUPLICATE_STOCK_REPAIR_TARGETS:
        row = session.exec(
            text("""
                SELECT
                    p.id AS purchase_id,
                    pi.id AS purchase_item_id,
                    pi.cost_price,
                    pi.effective_cost_price,
                    pi.product_id,
                    pi.lot_id AS current_lot_id,
                    old_item.id AS old_item_id,
                    old_item.stock AS old_stock,
                    old_item.is_archived AS old_archived,
                    restored_item.id AS restored_item_id,
                    restored_item.stock AS restored_stock,
                    restored_item.is_archived AS restored_archived,
                    restored_lot.id AS restored_lot_id
                FROM purchaseitem pi
                JOIN purchase p ON p.id = pi.purchase_id
                JOIN item old_item ON old_item.id = pi.inventory_item_id
                JOIN item restored_item ON restored_item.id = :restored_item_id
                LEFT JOIN inventorylot restored_lot ON restored_lot.legacy_item_id = restored_item.id
                WHERE pi.id = :purchase_item_id
                  AND p.invoice_number = :invoice_number
                  AND COALESCE(p.is_deleted, 0) = 0
                  AND COALESCE(pi.stock_source, 'CREATED') = 'ATTACHED'
                  AND pi.inventory_item_id = :old_item_id
                  AND old_item.id = :old_item_id
                  AND COALESCE(old_item.stock, 0) = 0
                  AND COALESCE(old_item.is_archived, 0) = 1
                  AND lower(trim(COALESCE(pi.product_name, ''))) = lower(trim(:product_name))
                  AND lower(trim(COALESCE(pi.brand, ''))) = lower(trim(:brand))
                  AND COALESCE(pi.expiry_date, '') = COALESCE(:expiry_date, '')
                  AND ABS(COALESCE(pi.mrp, 0) - :mrp) < 0.001
                  AND (COALESCE(pi.sealed_qty, 0) + COALESCE(pi.free_qty, 0)) = :qty
                  AND lower(trim(COALESCE(restored_item.name, ''))) = lower(trim(:product_name))
                  AND lower(trim(COALESCE(restored_item.brand, ''))) = lower(trim(:brand))
                  AND COALESCE(restored_item.expiry_date, '') = COALESCE(:expiry_date, '')
                  AND ABS(COALESCE(restored_item.mrp, 0) - :mrp) < 0.001
                  AND EXISTS (
                      SELECT 1
                      FROM stockmovement sm
                      WHERE sm.item_id = restored_item.id
                        AND sm.ref_type = 'PURCHASE'
                        AND sm.ref_id = p.id
                        AND sm.reason = 'PURCHASE'
                        AND sm.delta = :qty
                  )
                  AND EXISTS (
                      SELECT 1
                      FROM stockmovement sm
                      WHERE sm.item_id = restored_item.id
                        AND sm.ref_type = 'PURCHASE'
                        AND sm.ref_id = p.id
                        AND sm.reason = 'PURCHASE_DUPLICATE_REPAIR'
                        AND sm.delta = -:qty
                        AND sm.note LIKE '%' || '#' || :old_item_id
                  )
                LIMIT 1
            """).bindparams(**target),
        ).first()

        if not row:
            continue

        purchase_id = int(row[0])
        restored_lot_id = int(row[12]) if row[12] is not None else None
        if restored_lot_id is None:
            continue

        ledger_row = session.exec(
            text("""
                SELECT COALESCE(SUM(delta), 0)
                FROM stockmovement
                WHERE item_id = :restored_item_id
                  AND NOT (
                      reason = 'PURCHASE_DUPLICATE_REPAIR'
                      AND ref_type = 'PURCHASE'
                      AND ref_id = :purchase_id
                  )
            """).bindparams(
                restored_item_id=int(target["restored_item_id"]),
                purchase_id=purchase_id,
            ),
        ).first()
        restored_stock = max(0, int(ledger_row[0] or 0) if ledger_row else int(target["qty"]))
        effective_cost = float(row[3] or row[2] or 0)

        session.exec(
            text("""
                UPDATE purchaseitem
                SET inventory_item_id = :restored_item_id,
                    lot_id = :restored_lot_id,
                    stock_source = 'CREATED'
                WHERE id = :purchase_item_id
                  AND purchase_id = :purchase_id
                  AND inventory_item_id = :old_item_id
            """).bindparams(
                restored_item_id=int(target["restored_item_id"]),
                restored_lot_id=restored_lot_id,
                purchase_item_id=int(target["purchase_item_id"]),
                purchase_id=purchase_id,
                old_item_id=int(target["old_item_id"]),
            ),
        )
        session.exec(
            text("""
                UPDATE item
                SET stock = :restored_stock,
                    is_archived = CASE WHEN :restored_stock > 0 THEN 0 ELSE 1 END,
                    archived_at = CASE WHEN :restored_stock > 0 THEN NULL ELSE archived_at END,
                    cost_price = :effective_cost,
                    product_id = COALESCE(product_id, :product_id),
                    updated_at = :ts
                WHERE id = :restored_item_id
            """).bindparams(
                restored_stock=restored_stock,
                effective_cost=effective_cost,
                product_id=row[4],
                ts=ts,
                restored_item_id=int(target["restored_item_id"]),
            ),
        )
        session.exec(
            text("""
                UPDATE inventorylot
                SET sealed_qty = :restored_stock,
                    loose_qty = 0,
                    is_active = CASE WHEN :restored_stock > 0 THEN 1 ELSE 0 END,
                    cost_price = :effective_cost,
                    updated_at = :ts
                WHERE id = :restored_lot_id
                  AND legacy_item_id = :restored_item_id
            """).bindparams(
                restored_stock=restored_stock,
                effective_cost=effective_cost,
                ts=ts,
                restored_lot_id=restored_lot_id,
                restored_item_id=int(target["restored_item_id"]),
            ),
        )
        session.exec(
            text("""
                UPDATE item
                SET stock = 0,
                    is_archived = 1,
                    cost_price = 0,
                    updated_at = :ts
                WHERE id = :old_item_id
                  AND COALESCE(stock, 0) = 0
            """).bindparams(ts=ts, old_item_id=int(target["old_item_id"])),
        )
        session.exec(
            text("""
                UPDATE inventorylot
                SET sealed_qty = 0,
                    loose_qty = 0,
                    is_active = 0,
                    cost_price = 0,
                    updated_at = :ts
                WHERE legacy_item_id = :old_item_id
            """).bindparams(ts=ts, old_item_id=int(target["old_item_id"])),
        )
        session.exec(
            text("""
                DELETE FROM stockmovement
                WHERE ref_type = 'PURCHASE'
                  AND ref_id = :purchase_id
                  AND (
                      (
                          item_id = :old_item_id
                          AND reason = 'PURCHASE_LINK'
                          AND COALESCE(note, '') LIKE 'Bulk repair:%'
                      )
                      OR (
                          item_id = :restored_item_id
                          AND reason = 'PURCHASE_DUPLICATE_REPAIR'
                          AND COALESCE(note, '') LIKE 'Bulk repair:%'
                      )
                  )
            """).bindparams(
                purchase_id=purchase_id,
                old_item_id=int(target["old_item_id"]),
                restored_item_id=int(target["restored_item_id"]),
            ),
        )
        applied.append(
            {
                "purchase_id": purchase_id,
                "purchase_item_id": int(target["purchase_item_id"]),
                "invoice_number": str(target["invoice_number"]),
                "product_name": str(target["product_name"]),
                "restored_item_id": int(target["restored_item_id"]),
                "old_linked_item_id": int(target["old_item_id"]),
                "restored_qty": restored_stock,
            }
        )

    if applied:
        import json

        session.exec(
            text("""
                INSERT INTO auditlog (event_ts, entity_type, entity_id, action, note, details_json, actor)
                VALUES (
                    :ts,
                    'PURCHASE',
                    NULL,
                    'DATA_REPAIR',
                    'Restored purchase-created stock batches after incorrect duplicate repair',
                    :details_json,
                    'migration'
                )
            """).bindparams(ts=ts, details_json=json.dumps(applied, separators=(",", ":"))),
        )

    return len(applied)


def auto_repair_hidden_purchase_duplicate_stock() -> tuple[int, str | None, int]:
    """Run the broad duplicate-stock repair against the resolved SQLite DB file."""
    from scripts.repair_purchase_duplicate_stock import apply_pairs, create_backup, discover_pairs

    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    try:
        pairs, warnings = discover_pairs(conn)
        if not pairs:
            return 0, None, len(warnings)
        backup_path = create_backup(DB_FILE, BASE_DIR / "backups")
        apply_pairs(conn, pairs, backup_path)
        return len(pairs), str(backup_path), len(warnings)
    finally:
        conn.close()


def auto_repair_client_loose_conversion_and_credit_returns() -> tuple[int, int, int, int, str | None, int]:
    """Run the client loose-conversion/bill-return repair once at startup."""
    from scripts.client_db_repair import ClientRepair, backup_database

    def run_repair(*, apply: bool):
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        try:
            repair = ClientRepair(
                conn,
                apply=apply,
                product_ids=set(),
                bill_ids=set(),
                fix_all_bill_mismatches=False,
            )
            stats = repair.run()
            if apply:
                conn.commit()
            else:
                conn.rollback()
            return stats
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    preview = run_repair(apply=False)
    change_count = int(preview.loose_syncs or 0) + int(preview.loose_stock_repairs or 0) + int(preview.bill_total_repairs or 0)
    if change_count <= 0:
        return (
            int(preview.loose_syncs or 0),
            int(preview.loose_stock_repairs or 0),
            int(preview.bill_total_repairs or 0),
            int(preview.voucher_syncs or 0),
            None,
            int(preview.warnings or 0),
        )

    backup_path = backup_database(DB_FILE, BASE_DIR / "backups")
    applied = run_repair(apply=True)
    return (
        int(applied.loose_syncs or 0),
        int(applied.loose_stock_repairs or 0),
        int(applied.bill_total_repairs or 0),
        int(applied.voucher_syncs or 0),
        str(backup_path),
        int(applied.warnings or 0),
    )


def create_data_repair_backup(label: str) -> str:
    backup_dir = BASE_DIR / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_label = "".join(ch if ch.isalnum() or ch in {"_", "-"} else "_" for ch in str(label or "repair"))
    backup_path = backup_dir / f"{DB_FILE.stem}.{safe_label}_{stamp}{DB_FILE.suffix}"
    shutil.copy2(DB_FILE, backup_path)
    return str(backup_path)


def _row_value(row, index: int = 0, default=None):
    if row is None:
        return default
    try:
        return row[index]
    except Exception:
        return default


def _clean_text_key(value) -> str:
    text = " ".join(str(value or "").strip().split()).lower()
    return re.sub(r"\b(\d+)\s+(g|gm|ml|tab|tabs|tablet|tablets|cap|caps|n)\b", r"\1\2", text)


def revert_unsafe_opening_purchase_restores(session) -> tuple[int, str | None]:
    """
    Undo the broad purchase-stock restore for rows where the purchase had already
    been represented by an OPENING/ITEM_CREATE batch created on/after the invoice date.

    This keeps later sales on the opening batch intact and neutralizes only the
    duplicate purchase-created batch revived by the earlier broad repair.
    """
    repair_logs = session.exec(
        text("""
            SELECT id, details_json
            FROM auditlog
            WHERE action = 'DATA_REPAIR'
              AND note = 'Restored purchase-created batches hidden by duplicate-stock repair'
            ORDER BY id
        """),
    ).all()
    if not repair_logs:
        return 0, None

    raw_items = []
    seen_keys = set()
    for log_row in repair_logs:
        try:
            payload = json.loads(str(log_row[1] or "{}"))
        except Exception:
            continue
        for entry in payload.get("items", []) if isinstance(payload, dict) else []:
            try:
                purchase_id = int(entry.get("purchase_id") or 0)
                purchase_item_id = int(entry.get("purchase_item_id") or 0)
                target_item_id = int(entry.get("target_item_id") or 0)
                duplicate_item_id = int(entry.get("duplicate_item_id") or 0)
                qty = int(entry.get("qty") or 0)
            except Exception:
                continue
            key = (purchase_id, purchase_item_id, target_item_id, duplicate_item_id)
            if not all(key) or qty <= 0 or key in seen_keys:
                continue
            seen_keys.add(key)
            raw_items.append(
                {
                    "purchase_id": purchase_id,
                    "purchase_item_id": purchase_item_id,
                    "target_item_id": target_item_id,
                    "duplicate_item_id": duplicate_item_id,
                    "qty": qty,
                    "invoice_number": str(entry.get("invoice_number") or ""),
                    "product_name": str(entry.get("product_name") or ""),
                }
            )

    candidates = []
    reserved_target_item_ids = set()
    for item in raw_items:
        base_params = {
            "purchase_id": item["purchase_id"],
            "purchase_item_id": item["purchase_item_id"],
            "target_item_id": item["target_item_id"],
            "duplicate_item_id": item["duplicate_item_id"],
            "qty": item["qty"],
        }
        row = session.exec(
            text("""
                SELECT
                    p.invoice_number,
                    p.invoice_date,
                    pi.product_id,
                    pi.effective_cost_price,
                    pi.expiry_date,
                    pi.mrp,
                    pi.rack_number,
                    target_lot.id AS target_lot_id
                FROM purchaseitem pi
                JOIN purchase p ON p.id = pi.purchase_id
                JOIN item target ON target.id = :target_item_id
                JOIN item duplicate ON duplicate.id = :duplicate_item_id
                LEFT JOIN inventorylot target_lot ON target_lot.legacy_item_id = target.id
                WHERE pi.id = :purchase_item_id
                  AND pi.purchase_id = :purchase_id
                  AND COALESCE(p.is_deleted, 0) = 0
                  AND pi.inventory_item_id = :duplicate_item_id
                  AND COALESCE(pi.stock_source, 'CREATED') = 'CREATED'
                  AND (COALESCE(pi.sealed_qty, 0) + COALESCE(pi.free_qty, 0)) = :qty
                  AND COALESCE(duplicate.stock, 0) = :qty
                  AND COALESCE(duplicate.is_archived, 0) = 0
                  AND lower(trim(COALESCE(target.name, ''))) = lower(trim(COALESCE(pi.product_name, '')))
                  AND lower(trim(COALESCE(duplicate.name, ''))) = lower(trim(COALESCE(pi.product_name, '')))
                  AND lower(trim(COALESCE(target.brand, ''))) = lower(trim(COALESCE(pi.brand, '')))
                  AND lower(trim(COALESCE(duplicate.brand, ''))) = lower(trim(COALESCE(pi.brand, '')))
                  AND COALESCE(target.expiry_date, '') = COALESCE(pi.expiry_date, '')
                  AND COALESCE(duplicate.expiry_date, '') = COALESCE(pi.expiry_date, '')
                  AND ABS(COALESCE(target.mrp, 0) - COALESCE(pi.mrp, 0)) < 0.001
                  AND ABS(COALESCE(duplicate.mrp, 0) - COALESCE(pi.mrp, 0)) < 0.001
                LIMIT 1
            """).bindparams(**base_params),
        ).first()
        if not row or row[7] is None:
            continue

        invoice_date = str(row[1] or "")[:10]
        if not invoice_date:
            continue

        opening_row = session.exec(
            text("""
                SELECT MIN(ts), COALESCE(SUM(delta), 0)
                FROM stockmovement
                WHERE item_id = :target_item_id
                  AND reason = 'OPENING'
                  AND ref_type = 'ITEM_CREATE'
            """).bindparams(target_item_id=item["target_item_id"]),
        ).first()
        opening_ts = str(_row_value(opening_row, 0, "") or "")
        opening_delta = int(_row_value(opening_row, 1, 0) or 0)
        if opening_ts[:10] < invoice_date or opening_delta != int(item["qty"]):
            continue

        pre_invoice_count = int(
            _row_value(
                session.exec(
                    text("""
                        SELECT COUNT(*)
                        FROM stockmovement
                        WHERE item_id = :target_item_id
                          AND date(ts) < date(:invoice_date)
                    """).bindparams(target_item_id=item["target_item_id"], invoice_date=invoice_date),
                ).first(),
                0,
                0,
            )
            or 0
        )
        if pre_invoice_count != 0:
            continue

        duplicate_purchase_count = int(
            _row_value(
                session.exec(
                    text("""
                        SELECT COUNT(*)
                        FROM stockmovement
                        WHERE item_id = :duplicate_item_id
                          AND reason = 'PURCHASE'
                          AND ref_type = 'PURCHASE'
                          AND ref_id = :purchase_id
                          AND delta = :qty
                    """).bindparams(
                        duplicate_item_id=item["duplicate_item_id"],
                        purchase_id=item["purchase_id"],
                        qty=item["qty"],
                    ),
                ).first(),
                0,
                0,
            )
            or 0
        )
        duplicate_other_count = int(
            _row_value(
                session.exec(
                    text("""
                        SELECT COUNT(*)
                        FROM stockmovement
                        WHERE item_id = :duplicate_item_id
                          AND NOT (
                              reason = 'PURCHASE'
                              AND ref_type = 'PURCHASE'
                              AND ref_id = :purchase_id
                              AND delta = :qty
                          )
                    """).bindparams(
                        duplicate_item_id=item["duplicate_item_id"],
                        purchase_id=item["purchase_id"],
                        qty=item["qty"],
                    ),
                ).first(),
                0,
                0,
            )
            or 0
        )
        duplicate_bill_count = int(
            _row_value(
                session.exec(
                    text("SELECT COUNT(*) FROM billitem WHERE item_id = :duplicate_item_id").bindparams(
                        duplicate_item_id=item["duplicate_item_id"],
                    ),
                ).first(),
                0,
                0,
            )
            or 0
        )
        if duplicate_purchase_count != 1 or duplicate_other_count != 0 or duplicate_bill_count != 0:
            continue
        if item["target_item_id"] in reserved_target_item_ids:
            continue
        reserved_target_item_ids.add(item["target_item_id"])

        candidates.append(
            {
                **item,
                "invoice_number": str(row[0] or item["invoice_number"]),
                "invoice_date": invoice_date,
                "product_id": int(row[2] or 0) or None,
                "effective_cost_price": float(row[3] or 0),
                "expiry_date": str(row[4] or ""),
                "mrp": float(row[5] or 0),
                "rack_number": int(row[6] or 0),
                "target_lot_id": int(row[7]),
            }
        )

    if not candidates:
        return 0, None

    session.commit()
    backup_path = create_data_repair_backup("before_opening_purchase_restore_revert")
    ts = _now_ts()
    applied = []
    for item in candidates:
        purchase_ts = f"{item['invoice_date']}T00:00:00"
        session.exec(
            text("""
                UPDATE purchaseitem
                SET inventory_item_id = :target_item_id,
                    lot_id = :target_lot_id,
                    stock_source = 'CREATED'
                WHERE id = :purchase_item_id
                  AND purchase_id = :purchase_id
                  AND inventory_item_id = :duplicate_item_id
                  AND COALESCE(stock_source, 'CREATED') = 'CREATED'
            """).bindparams(
                target_item_id=item["target_item_id"],
                target_lot_id=item["target_lot_id"],
                purchase_item_id=item["purchase_item_id"],
                purchase_id=item["purchase_id"],
                duplicate_item_id=item["duplicate_item_id"],
            ),
        )
        session.exec(
            text("""
                UPDATE stockmovement
                SET ts = :purchase_ts,
                    reason = 'PURCHASE',
                    ref_type = 'PURCHASE',
                    ref_id = :purchase_id,
                    note = 'Purchase ' || :invoice_number,
                    actor = 'SYSTEM'
                WHERE item_id = :target_item_id
                  AND reason = 'OPENING'
                  AND ref_type = 'ITEM_CREATE'
                  AND delta = :qty
            """).bindparams(
                purchase_ts=purchase_ts,
                target_item_id=item["target_item_id"],
                purchase_id=item["purchase_id"],
                invoice_number=item["invoice_number"],
                qty=item["qty"],
            ),
        )
        session.exec(
            text("""
                UPDATE item
                SET mrp = :mrp,
                    cost_price = :effective_cost_price,
                    product_id = COALESCE(product_id, :product_id),
                    rack_number = :rack_number,
                    updated_at = :ts
                WHERE id = :target_item_id
            """).bindparams(
                mrp=item["mrp"],
                effective_cost_price=item["effective_cost_price"],
                product_id=item["product_id"],
                rack_number=item["rack_number"],
                ts=ts,
                target_item_id=item["target_item_id"],
            ),
        )
        session.exec(
            text("""
                UPDATE inventorylot
                SET mrp = :mrp,
                    cost_price = :effective_cost_price,
                    rack_number = :rack_number,
                    updated_at = :ts
                WHERE id = :target_lot_id
                  AND legacy_item_id = :target_item_id
            """).bindparams(
                mrp=item["mrp"],
                effective_cost_price=item["effective_cost_price"],
                rack_number=item["rack_number"],
                ts=ts,
                target_lot_id=item["target_lot_id"],
                target_item_id=item["target_item_id"],
            ),
        )
        session.exec(
            text("""
                UPDATE item
                SET stock = 0,
                    is_archived = 1,
                    archived_at = COALESCE(archived_at, :ts),
                    cost_price = 0,
                    updated_at = :ts
                WHERE id = :duplicate_item_id
            """).bindparams(ts=ts, duplicate_item_id=item["duplicate_item_id"]),
        )
        session.exec(
            text("""
                UPDATE inventorylot
                SET sealed_qty = 0,
                    loose_qty = 0,
                    is_active = 0,
                    cost_price = 0,
                    updated_at = :ts
                WHERE legacy_item_id = :duplicate_item_id
            """).bindparams(ts=ts, duplicate_item_id=item["duplicate_item_id"]),
        )
        session.exec(
            text("""
                DELETE FROM stockmovement
                WHERE item_id = :duplicate_item_id
                  AND reason = 'PURCHASE'
                  AND ref_type = 'PURCHASE'
                  AND ref_id = :purchase_id
                  AND delta = :qty
            """).bindparams(
                duplicate_item_id=item["duplicate_item_id"],
                purchase_id=item["purchase_id"],
                qty=item["qty"],
            ),
        )
        applied.append(
            {
                "purchase_id": item["purchase_id"],
                "purchase_item_id": item["purchase_item_id"],
                "invoice_number": item["invoice_number"],
                "product_name": item["product_name"],
                "target_item_id": item["target_item_id"],
                "duplicate_item_id": item["duplicate_item_id"],
                "qty": item["qty"],
            }
        )

    session.exec(
        text("""
            INSERT INTO auditlog (event_ts, entity_type, entity_id, action, note, details_json, actor)
            VALUES (
                :ts,
                'PURCHASE',
                NULL,
                'DATA_REPAIR',
                'Converted opening purchase duplicate restores',
                :details_json,
                'migration'
            )
        """).bindparams(
            ts=ts,
            details_json=json.dumps(
                {"backup": backup_path, "fixed_count": len(applied), "items": applied},
                ensure_ascii=True,
                separators=(",", ":"),
            ),
        ),
    )
    session.commit()
    return len(applied), backup_path


def merge_opening_purchase_duplicate_batches(session) -> tuple[int, str | None]:
    """Convert opening placeholders into purchase stock and merge duplicate purchase batches."""
    attached_rows = session.exec(
        text("""
            SELECT
                pi.id AS purchase_item_id,
                p.id AS purchase_id,
                p.invoice_number,
                p.invoice_date,
                pi.product_id,
                pi.effective_cost_price,
                pi.expiry_date,
                pi.mrp,
                pi.rack_number,
                (COALESCE(pi.sealed_qty, 0) + COALESCE(pi.free_qty, 0)) AS qty,
                target.id AS target_item_id,
                target_lot.id AS target_lot_id,
                opening.id AS opening_movement_id
            FROM purchaseitem pi
            JOIN purchase p ON p.id = pi.purchase_id
            JOIN item target ON target.id = pi.inventory_item_id
            JOIN stockmovement opening
              ON opening.item_id = target.id
             AND opening.reason = 'OPENING'
             AND opening.ref_type = 'ITEM_CREATE'
             AND opening.delta = (COALESCE(pi.sealed_qty, 0) + COALESCE(pi.free_qty, 0))
            LEFT JOIN inventorylot target_lot ON target_lot.legacy_item_id = target.id
            WHERE COALESCE(p.is_deleted, 0) = 0
              AND COALESCE(pi.stock_source, 'CREATED') = 'ATTACHED'
              AND (COALESCE(pi.sealed_qty, 0) + COALESCE(pi.free_qty, 0)) > 0
              AND target_lot.id IS NOT NULL
              AND date(opening.ts) >= date(p.invoice_date)
              AND NOT EXISTS (
                  SELECT 1
                  FROM stockmovement pre
                  WHERE pre.item_id = target.id
                    AND date(pre.ts) < date(p.invoice_date)
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM stockmovement existing_purchase
                  WHERE existing_purchase.item_id = target.id
                    AND existing_purchase.reason = 'PURCHASE'
                    AND existing_purchase.ref_type = 'PURCHASE'
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM purchaseitem other_pi
                  JOIN purchase other_p ON other_p.id = other_pi.purchase_id
                  WHERE other_pi.inventory_item_id = target.id
                    AND other_pi.id != pi.id
                    AND COALESCE(other_p.is_deleted, 0) = 0
              )
        """),
    ).all()

    created_base_rows = session.exec(
        text("""
            SELECT
                pi.id AS purchase_item_id,
                p.id AS purchase_id,
                p.invoice_number,
                p.invoice_date,
                pi.product_id,
                pi.effective_cost_price,
                pi.expiry_date,
                pi.mrp,
                pi.rack_number,
                (COALESCE(pi.sealed_qty, 0) + COALESCE(pi.free_qty, 0)) AS qty,
                duplicate.id AS duplicate_item_id,
                duplicate.stock AS duplicate_stock
            FROM purchaseitem pi
            JOIN purchase p ON p.id = pi.purchase_id
            JOIN item duplicate ON duplicate.id = pi.inventory_item_id
            WHERE COALESCE(p.is_deleted, 0) = 0
              AND COALESCE(pi.stock_source, 'CREATED') = 'CREATED'
              AND (COALESCE(pi.sealed_qty, 0) + COALESCE(pi.free_qty, 0)) > 0
              AND EXISTS (
                  SELECT 1
                  FROM stockmovement purchase_sm
                  WHERE purchase_sm.item_id = duplicate.id
                    AND purchase_sm.reason = 'PURCHASE'
                    AND purchase_sm.ref_type = 'PURCHASE'
                    AND purchase_sm.ref_id = p.id
                    AND purchase_sm.delta = (COALESCE(pi.sealed_qty, 0) + COALESCE(pi.free_qty, 0))
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM stockmovement repair_sm
                  WHERE repair_sm.item_id = duplicate.id
                    AND repair_sm.reason = 'PURCHASE_DUPLICATE_REPAIR'
                    AND repair_sm.ref_type = 'PURCHASE'
                    AND repair_sm.ref_id = p.id
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM stockmovement pre
                  WHERE pre.item_id = duplicate.id
                    AND date(pre.ts) < date(p.invoice_date)
              )
        """),
    ).all()

    candidates = []
    reserved_target_item_ids = set()
    seen_purchase_items = set()
    for row in attached_rows:
        purchase_item_id = int(row[0])
        seen_purchase_items.add(purchase_item_id)
        target_item_id = int(row[10])
        if target_item_id in reserved_target_item_ids:
            continue
        reserved_target_item_ids.add(target_item_id)
        candidates.append(
            {
                "mode": "attached",
                "purchase_item_id": purchase_item_id,
                "purchase_id": int(row[1]),
                "invoice_number": str(row[2] or ""),
                "invoice_date": str(row[3] or "")[:10],
                "product_id": int(row[4] or 0) or None,
                "effective_cost_price": float(row[5] or 0),
                "expiry_date": str(row[6] or ""),
                "mrp": float(row[7] or 0),
                "rack_number": int(row[8] or 0),
                "qty": int(row[9] or 0),
                "target_item_id": target_item_id,
                "target_lot_id": int(row[11]),
                "opening_movement_id": int(row[12]),
                "duplicate_item_id": None,
            }
        )

    for row in created_base_rows:
        purchase_item_id = int(row[0])
        if purchase_item_id in seen_purchase_items:
            continue
        params = {
            "purchase_item_id": purchase_item_id,
            "purchase_id": int(row[1]),
            "invoice_number": str(row[2] or ""),
            "invoice_date": str(row[3] or "")[:10],
            "product_id": int(row[4] or 0) or None,
            "effective_cost_price": float(row[5] or 0),
            "expiry_date": str(row[6] or ""),
            "mrp": float(row[7] or 0),
            "rack_number": int(row[8] or 0),
            "qty": int(row[9] or 0),
            "duplicate_item_id": int(row[10]),
        }
        target_rows = session.exec(
            text("""
                SELECT target.id, target_lot.id, opening.id
                FROM purchaseitem pi
                JOIN item duplicate ON duplicate.id = :duplicate_item_id
                JOIN item target
                  ON target.id != duplicate.id
                 AND lower(trim(COALESCE(target.name, ''))) = lower(trim(COALESCE(pi.product_name, '')))
                 AND lower(trim(COALESCE(target.brand, ''))) = lower(trim(COALESCE(pi.brand, '')))
                 AND COALESCE(target.expiry_date, '') = COALESCE(pi.expiry_date, '')
                JOIN stockmovement opening
                  ON opening.item_id = target.id
                 AND opening.reason = 'OPENING'
                 AND opening.ref_type = 'ITEM_CREATE'
                 AND opening.delta = :qty
                LEFT JOIN inventorylot target_lot ON target_lot.legacy_item_id = target.id
                WHERE pi.id = :purchase_item_id
                  AND target_lot.id IS NOT NULL
                  AND date(opening.ts) >= date(:invoice_date)
                  AND NOT EXISTS (
                      SELECT 1
                      FROM stockmovement pre
                      WHERE pre.item_id = target.id
                        AND date(pre.ts) < date(:invoice_date)
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM stockmovement existing_purchase
                      WHERE existing_purchase.item_id = target.id
                        AND existing_purchase.reason = 'PURCHASE'
                        AND existing_purchase.ref_type = 'PURCHASE'
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM purchaseitem other_pi
                      JOIN purchase other_p ON other_p.id = other_pi.purchase_id
                      WHERE other_pi.inventory_item_id = target.id
                        AND COALESCE(other_p.is_deleted, 0) = 0
                  )
                ORDER BY ABS(COALESCE(target.mrp, 0) - :mrp), target.id
            """).bindparams(
                duplicate_item_id=params["duplicate_item_id"],
                qty=params["qty"],
                purchase_item_id=params["purchase_item_id"],
                invoice_date=params["invoice_date"],
                mrp=params["mrp"],
            ),
        ).all()
        target_rows = [target for target in target_rows if int(target[0]) not in reserved_target_item_ids]
        if len(target_rows) != 1:
            continue
        target = target_rows[0]
        reserved_target_item_ids.add(int(target[0]))
        candidates.append(
            {
                "mode": "created_duplicate",
                **params,
                "target_item_id": int(target[0]),
                "target_lot_id": int(target[1]),
                "opening_movement_id": int(target[2]),
            }
        )

    if not candidates:
        return 0, None

    session.commit()
    backup_path = create_data_repair_backup("before_opening_purchase_batch_merge")
    ts = _now_ts()
    applied = []
    for item in candidates:
        purchase_ts = f"{item['invoice_date']}T00:00:00"
        session.exec(
            text("""
                UPDATE purchaseitem
                SET inventory_item_id = :target_item_id,
                    lot_id = :target_lot_id,
                    stock_source = 'CREATED'
                WHERE id = :purchase_item_id
                  AND purchase_id = :purchase_id
            """).bindparams(
                target_item_id=item["target_item_id"],
                target_lot_id=item["target_lot_id"],
                purchase_item_id=item["purchase_item_id"],
                purchase_id=item["purchase_id"],
            ),
        )
        session.exec(
            text("""
                UPDATE stockmovement
                SET ts = :purchase_ts,
                    reason = 'PURCHASE',
                    ref_type = 'PURCHASE',
                    ref_id = :purchase_id,
                    note = 'Purchase ' || :invoice_number,
                    actor = 'SYSTEM'
                WHERE id = :opening_movement_id
                  AND item_id = :target_item_id
                  AND reason = 'OPENING'
                  AND ref_type = 'ITEM_CREATE'
                  AND delta = :qty
            """).bindparams(
                purchase_ts=purchase_ts,
                invoice_number=item["invoice_number"],
                purchase_id=item["purchase_id"],
                opening_movement_id=item["opening_movement_id"],
                target_item_id=item["target_item_id"],
                qty=item["qty"],
            ),
        )
        session.exec(
            text("""
                DELETE FROM stockmovement
                WHERE item_id = :target_item_id
                  AND reason = 'PURCHASE_LINK'
                  AND ref_type = 'PURCHASE'
                  AND ref_id = :purchase_id
            """).bindparams(target_item_id=item["target_item_id"], purchase_id=item["purchase_id"]),
        )

        duplicate_item_id = item.get("duplicate_item_id")
        if duplicate_item_id:
            session.exec(
                text("UPDATE billitem SET item_id = :target_item_id WHERE item_id = :duplicate_item_id").bindparams(
                    target_item_id=item["target_item_id"],
                    duplicate_item_id=duplicate_item_id,
                ),
            )
            session.exec(
                text("""
                    UPDATE billitemallocation
                    SET item_id = :target_item_id,
                        lot_id = :target_lot_id
                    WHERE item_id = :duplicate_item_id
                """).bindparams(
                    target_item_id=item["target_item_id"],
                    target_lot_id=item["target_lot_id"],
                    duplicate_item_id=duplicate_item_id,
                ),
            )
            session.exec(
                text("UPDATE returnitem SET item_id = :target_item_id WHERE item_id = :duplicate_item_id").bindparams(
                    target_item_id=item["target_item_id"],
                    duplicate_item_id=duplicate_item_id,
                ),
            )
            session.exec(
                text("UPDATE stockaudititem SET item_id = :target_item_id WHERE item_id = :duplicate_item_id").bindparams(
                    target_item_id=item["target_item_id"],
                    duplicate_item_id=duplicate_item_id,
                ),
            )
            session.exec(
                text("""
                    UPDATE stockmovement
                    SET item_id = :target_item_id
                    WHERE item_id = :duplicate_item_id
                      AND NOT (
                          reason = 'PURCHASE'
                          AND ref_type = 'PURCHASE'
                          AND ref_id = :purchase_id
                      )
                      AND reason != 'PURCHASE_DUPLICATE_REPAIR'
                """).bindparams(
                    target_item_id=item["target_item_id"],
                    duplicate_item_id=duplicate_item_id,
                    purchase_id=item["purchase_id"],
                ),
            )
            session.exec(
                text("""
                    DELETE FROM stockmovement
                    WHERE item_id = :duplicate_item_id
                      AND reason = 'PURCHASE'
                      AND ref_type = 'PURCHASE'
                      AND ref_id = :purchase_id
                      AND delta = :qty
                """).bindparams(
                    duplicate_item_id=duplicate_item_id,
                    qty=item["qty"],
                    purchase_id=item["purchase_id"],
                ),
            )
            session.exec(
                text("""
                    DELETE FROM stockmovement
                    WHERE item_id = :duplicate_item_id
                      AND reason = 'PURCHASE_DUPLICATE_REPAIR'
                      AND ref_type = 'PURCHASE'
                      AND ref_id = :purchase_id
                """).bindparams(
                    duplicate_item_id=duplicate_item_id,
                    purchase_id=item["purchase_id"],
                ),
            )
            session.exec(
                text("""
                    UPDATE item
                    SET stock = 0,
                        is_archived = 1,
                        archived_at = COALESCE(archived_at, :ts),
                        cost_price = 0,
                        updated_at = :ts
                    WHERE id = :duplicate_item_id
                """).bindparams(ts=ts, duplicate_item_id=duplicate_item_id),
            )
            session.exec(
                text("""
                    UPDATE inventorylot
                    SET sealed_qty = 0,
                        loose_qty = 0,
                        is_active = 0,
                        cost_price = 0,
                        updated_at = :ts
                    WHERE legacy_item_id = :duplicate_item_id
                """).bindparams(ts=ts, duplicate_item_id=duplicate_item_id),
            )

        target_stock_row = session.exec(
            text("SELECT COALESCE(SUM(delta), 0) FROM stockmovement WHERE item_id = :target_item_id").bindparams(
                target_item_id=item["target_item_id"],
            ),
        ).first()
        target_stock = int(_row_value(target_stock_row, 0, 0) or 0)
        if target_stock < 0:
            raise RuntimeError(f"Opening purchase merge would make item #{item['target_item_id']} negative")

        session.exec(
            text("""
                UPDATE item
                SET stock = :target_stock,
                    is_archived = CASE WHEN :target_stock > 0 THEN 0 ELSE 1 END,
                    archived_at = CASE WHEN :target_stock > 0 THEN NULL ELSE COALESCE(archived_at, :ts) END,
                    mrp = :mrp,
                    cost_price = :effective_cost_price,
                    product_id = COALESCE(product_id, :product_id),
                    rack_number = :rack_number,
                    updated_at = :ts
                WHERE id = :target_item_id
            """).bindparams(
                target_stock=target_stock,
                mrp=item["mrp"],
                effective_cost_price=item["effective_cost_price"],
                product_id=item["product_id"],
                rack_number=item["rack_number"],
                ts=ts,
                target_item_id=item["target_item_id"],
            ),
        )
        session.exec(
            text("""
                UPDATE inventorylot
                SET sealed_qty = :target_stock,
                    loose_qty = 0,
                    is_active = CASE WHEN :target_stock > 0 THEN 1 ELSE 0 END,
                    mrp = :mrp,
                    cost_price = :effective_cost_price,
                    rack_number = :rack_number,
                    updated_at = :ts
                WHERE id = :target_lot_id
                  AND legacy_item_id = :target_item_id
            """).bindparams(
                target_stock=target_stock,
                mrp=item["mrp"],
                effective_cost_price=item["effective_cost_price"],
                rack_number=item["rack_number"],
                ts=ts,
                target_lot_id=item["target_lot_id"],
                target_item_id=item["target_item_id"],
            ),
        )
        applied.append(
            {
                "mode": item["mode"],
                "purchase_id": item["purchase_id"],
                "purchase_item_id": item["purchase_item_id"],
                "invoice_number": item["invoice_number"],
                "target_item_id": item["target_item_id"],
                "duplicate_item_id": duplicate_item_id,
                "qty": item["qty"],
                "target_stock": target_stock,
            }
        )

    session.exec(
        text("""
            INSERT INTO auditlog (event_ts, entity_type, entity_id, action, note, details_json, actor)
            VALUES (
                :ts,
                'PURCHASE',
                NULL,
                'DATA_REPAIR',
                'Merged opening purchase duplicate batches',
                :details_json,
                'migration'
            )
        """).bindparams(
            ts=ts,
            details_json=json.dumps(
                {"backup": backup_path, "fixed_count": len(applied), "items": applied},
                ensure_ascii=True,
                separators=(",", ":"),
            ),
        ),
    )
    session.commit()
    return len(applied), backup_path


def cleanup_opening_purchase_duplicate_repair_pairs(session) -> tuple[int, str | None]:
    """
    Clean the visible source-side PURCHASE + PURCHASE_DUPLICATE_REPAIR pairs left
    by earlier safe merges. The kept target batch already owns the purchase and
    all transactional refs; these source rows only make product ledgers noisy.
    """
    rows = session.exec(
        text("""
            SELECT
                src_purchase.id AS purchase_movement_id,
                repair.id AS repair_movement_id,
                src.id AS source_item_id,
                target.id AS target_item_id,
                p.id AS purchase_id,
                pi.id AS purchase_item_id,
                src_purchase.delta AS qty,
                source_lot.id AS source_lot_id
            FROM stockmovement src_purchase
            JOIN stockmovement repair
              ON repair.item_id = src_purchase.item_id
             AND repair.reason = 'PURCHASE_DUPLICATE_REPAIR'
             AND repair.ref_type = 'PURCHASE'
             AND repair.ref_id = src_purchase.ref_id
             AND repair.delta = -src_purchase.delta
            JOIN purchase p
              ON p.id = src_purchase.ref_id
             AND COALESCE(p.is_deleted, 0) = 0
            JOIN purchaseitem pi
              ON pi.purchase_id = p.id
             AND COALESCE(pi.stock_source, 'CREATED') = 'CREATED'
             AND (COALESCE(pi.sealed_qty, 0) + COALESCE(pi.free_qty, 0)) = src_purchase.delta
             AND pi.inventory_item_id IS NOT NULL
             AND pi.inventory_item_id != src_purchase.item_id
             AND (
                 COALESCE(repair.note, '') = ''
                 OR repair.note LIKE '%' || '#' || pi.inventory_item_id || '%'
             )
            JOIN item src ON src.id = src_purchase.item_id
            JOIN item target ON target.id = pi.inventory_item_id
            JOIN stockmovement target_purchase
              ON target_purchase.item_id = target.id
             AND target_purchase.reason = 'PURCHASE'
             AND target_purchase.ref_type = 'PURCHASE'
             AND target_purchase.ref_id = p.id
             AND target_purchase.delta = src_purchase.delta
            LEFT JOIN inventorylot source_lot ON source_lot.legacy_item_id = src.id
            WHERE src_purchase.reason = 'PURCHASE'
              AND src_purchase.ref_type = 'PURCHASE'
              AND src_purchase.delta > 0
              AND COALESCE(src.stock, 0) = 0
              AND COALESCE(src.is_archived, 0) = 1
              AND NOT EXISTS (
                  SELECT 1
                  FROM stockmovement other_sm
                  WHERE other_sm.item_id = src.id
                    AND other_sm.id NOT IN (src_purchase.id, repair.id)
              )
              AND NOT EXISTS (SELECT 1 FROM billitem WHERE item_id = src.id)
              AND NOT EXISTS (
                  SELECT 1
                  FROM billitemallocation alloc
                  WHERE alloc.item_id = src.id
                     OR (source_lot.id IS NOT NULL AND alloc.lot_id = source_lot.id)
              )
              AND NOT EXISTS (SELECT 1 FROM returnitem WHERE item_id = src.id)
              AND NOT EXISTS (SELECT 1 FROM stockaudititem WHERE item_id = src.id)
              AND NOT EXISTS (
                  SELECT 1
                  FROM purchaseitem pi_src
                  WHERE pi_src.inventory_item_id = src.id
                     OR (source_lot.id IS NOT NULL AND pi_src.lot_id = source_lot.id)
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM packopenevent pe
                  WHERE pe.source_item_id = src.id
                     OR pe.loose_item_id = src.id
                     OR (source_lot.id IS NOT NULL AND pe.source_lot_id = source_lot.id)
                     OR (source_lot.id IS NOT NULL AND pe.loose_lot_id = source_lot.id)
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM inventorylot child_lot
                  WHERE source_lot.id IS NOT NULL
                    AND child_lot.opened_from_lot_id = source_lot.id
              )
            ORDER BY src.id, p.id
        """)
    ).all()
    if not rows:
        return 0, None

    grouped: dict[tuple[int, int, int, int], list] = {}
    for row in rows:
        key = (int(row[2]), int(row[4]), int(row[0]), int(row[1]))
        grouped.setdefault(key, []).append(row)

    candidates = []
    for key, matches in grouped.items():
        if len(matches) != 1:
            continue
        row = matches[0]
        candidates.append(
            {
                "purchase_movement_id": int(row[0]),
                "repair_movement_id": int(row[1]),
                "source_item_id": int(row[2]),
                "target_item_id": int(row[3]),
                "purchase_id": int(row[4]),
                "purchase_item_id": int(row[5]),
                "qty": int(row[6]),
                "source_lot_id": int(row[7]) if row[7] is not None else None,
            }
        )

    if not candidates:
        return 0, None

    session.commit()
    backup_path = create_data_repair_backup("before_opening_purchase_repair_pair_cleanup")
    ts = _now_ts()
    applied = []
    for item in candidates:
        session.exec(
            text("""
                DELETE FROM stockmovement
                WHERE id IN (:purchase_movement_id, :repair_movement_id)
            """).bindparams(
                purchase_movement_id=item["purchase_movement_id"],
                repair_movement_id=item["repair_movement_id"],
            ),
        )
        applied.append(item)

    session.exec(
        text("""
            INSERT INTO auditlog (event_ts, entity_type, entity_id, action, note, details_json, actor)
            VALUES (
                :ts,
                'PURCHASE',
                NULL,
                'DATA_REPAIR',
                'Cleaned source-side duplicate purchase repair pairs after opening merge',
                :details_json,
                'migration'
            )
        """).bindparams(
            ts=ts,
            details_json=json.dumps(
                {"backup": backup_path, "fixed_count": len(applied), "items": applied},
                ensure_ascii=True,
                separators=(",", ":"),
            ),
        ),
    )
    session.commit()
    return len(applied), backup_path


def convert_positive_club_recon_to_opening(session) -> tuple[int, str | None]:
    """
    Older clubbing code preserved leftover source stock with a current-dated
    RECON_ADJUST row. Convert positive balances to historical opening rows so
    stock ledgers read as old balance + real purchases, not as a new adjustment.
    """
    rows = session.exec(
        text("""
            SELECT
                repair.id,
                repair.item_id,
                repair.delta,
                COALESCE(
                    (
                        SELECT MIN(other.ts)
                        FROM stockmovement other
                        WHERE other.item_id = repair.item_id
                          AND other.id != repair.id
                          AND COALESCE(other.ts, '') != ''
                    ),
                    repair.ts
                ) AS first_ts
            FROM stockmovement repair
            WHERE repair.reason = 'RECON_ADJUST'
              AND repair.delta > 0
              AND COALESCE(repair.note, '') LIKE 'Club balance:%'
        """)
    ).all()
    if not rows:
        return 0, None

    session.commit()
    backup_path = create_data_repair_backup("before_club_recon_opening_cleanup")
    ts = _now_ts()
    applied = []
    for row in rows:
        movement_id = int(row[0])
        item_id = int(row[1])
        delta = int(row[2])
        first_date = str(row[3] or "")[:10]
        opening_ts = f"{first_date}T00:00:00" if first_date else ts
        session.exec(
            text("""
                UPDATE stockmovement
                SET ts = :opening_ts,
                    reason = 'OPENING',
                    ref_type = 'ITEM',
                    ref_id = :item_id,
                    note = 'Opening balance retained after duplicate OP placeholder(s) were replaced by purchase batch(es)',
                    actor = COALESCE(actor, 'migration')
                WHERE id = :movement_id
            """).bindparams(
                opening_ts=opening_ts,
                item_id=item_id,
                movement_id=movement_id,
            ),
        )
        applied.append(
            {
                "movement_id": movement_id,
                "item_id": item_id,
                "qty": delta,
                "opening_ts": opening_ts,
            }
        )

    session.exec(
        text("""
            INSERT INTO auditlog (event_ts, entity_type, entity_id, action, note, details_json, actor)
            VALUES (
                :ts,
                'STOCK',
                NULL,
                'DATA_REPAIR',
                'Converted club balance recon rows to historical opening rows',
                :details_json,
                'migration'
            )
        """).bindparams(
            ts=ts,
            details_json=json.dumps(
                {"backup": backup_path, "fixed_count": len(applied), "items": applied},
                ensure_ascii=True,
                separators=(",", ":"),
            ),
        ),
    )
    session.commit()
    return len(applied), backup_path


def merge_safe_duplicate_products(session) -> tuple[int, str | None]:
    """
    Merge product master rows that differ only by spacing/unit formatting, such
    as "150 g" vs "150g". Only merges rows with the same brand, printed price,
    rack, and unit settings; price/category conflicts are left alone.
    """
    rows = session.exec(
        text("""
            SELECT
                id,
                name,
                COALESCE(brand, '') AS brand,
                category_id,
                COALESCE(default_rack_number, 0) AS default_rack_number,
                COALESCE(printed_price, 0) AS printed_price,
                COALESCE(parent_unit_name, '') AS parent_unit_name,
                COALESCE(child_unit_name, '') AS child_unit_name,
                COALESCE(loose_sale_enabled, 0) AS loose_sale_enabled,
                COALESCE(default_conversion_qty, -1) AS default_conversion_qty,
                COALESCE(is_active, 1) AS is_active,
                created_at,
                updated_at
            FROM product
            ORDER BY id
        """)
    ).all()
    groups: dict[tuple, list] = {}
    for row in rows:
        key = (
            _clean_text_key(row[1]),
            _clean_text_key(row[2]),
            round(float(row[5] or 0), 2),
            int(row[4] or 0),
            _clean_text_key(row[6]),
            _clean_text_key(row[7]),
            int(row[8] or 0),
            int(row[9] or -1),
        )
        groups.setdefault(key, []).append(row)

    candidates = []
    for key, matches in groups.items():
        if len(matches) < 2:
            continue
        category_ids = {int(row[3]) for row in matches if row[3] is not None}
        if len(category_ids) > 1:
            continue

        def ref_count(row) -> int:
            product_id = int(row[0])
            counts = session.exec(
                text("""
                    SELECT
                        (SELECT COUNT(*) FROM item WHERE product_id = :product_id),
                        (SELECT COUNT(*) FROM purchaseitem WHERE product_id = :product_id),
                        (SELECT COUNT(*) FROM inventorylot WHERE product_id = :product_id)
                """).bindparams(product_id=product_id)
            ).one()
            return int(counts[0] or 0) + int(counts[1] or 0) + int(counts[2] or 0)

        keeper = sorted(matches, key=lambda row: (-ref_count(row), int(row[0])))[0]
        duplicates = [row for row in matches if int(row[0]) != int(keeper[0])]
        if duplicates:
            candidates.append((keeper, duplicates))

    if not candidates:
        return 0, None

    session.commit()
    backup_path = create_data_repair_backup("before_safe_duplicate_product_merge")
    ts = _now_ts()
    applied = []
    for keeper, duplicates in candidates:
        keeper_id = int(keeper[0])
        canonical_name = " ".join(str(keeper[1] or "").strip().split())
        category_id = keeper[3]
        for duplicate in duplicates:
            duplicate_id = int(duplicate[0])
            if category_id is None and duplicate[3] is not None:
                category_id = int(duplicate[3])
            for table_name in ("item", "purchaseitem", "inventorylot"):
                session.exec(
                    text(f"UPDATE {table_name} SET product_id = :keeper_id WHERE product_id = :duplicate_id").bindparams(
                        keeper_id=keeper_id,
                        duplicate_id=duplicate_id,
                    )
                )
            session.exec(
                text("""
                    UPDATE product
                    SET is_active = 0,
                        updated_at = :ts
                    WHERE id = :duplicate_id
                """).bindparams(ts=ts, duplicate_id=duplicate_id)
            )
            applied.append(
                {
                    "keeper_product_id": keeper_id,
                    "duplicate_product_id": duplicate_id,
                    "duplicate_name": duplicate[1],
                    "brand": duplicate[2],
                }
            )

        session.exec(
            text("""
                UPDATE product
                SET name = :name,
                    category_id = COALESCE(category_id, :category_id),
                    is_active = 1,
                    updated_at = :ts
                WHERE id = :keeper_id
            """).bindparams(
                name=canonical_name,
                category_id=category_id,
                ts=ts,
                keeper_id=keeper_id,
            )
        )

    session.exec(
        text("""
            INSERT INTO auditlog (event_ts, entity_type, entity_id, action, note, details_json, actor)
            VALUES (
                :ts,
                'PRODUCT',
                NULL,
                'DATA_REPAIR',
                'Merged safe duplicate product master rows',
                :details_json,
                'migration'
            )
        """).bindparams(
            ts=ts,
            details_json=json.dumps(
                {"backup": backup_path, "fixed_count": len(applied), "items": applied},
                ensure_ascii=True,
                separators=(",", ":"),
            ),
        ),
    )
    session.commit()
    return len(applied), backup_path


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

        # ✅ NEW: soft-archive fields (so 0-stock batches can be hidden safely)
        # NOTE: We do NOT hard-delete rows because BillItem/ReturnItem references can break later.
        if "is_archived" not in col_names:
            session.exec(text(
                "ALTER TABLE item ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0"
            ))

        if "archived_at" not in col_names:
            session.exec(text(
                "ALTER TABLE item ADD COLUMN archived_at TEXT"
            ))

        if "product_id" not in col_names:
            session.exec(text(
                "ALTER TABLE item ADD COLUMN product_id INTEGER"
            ))

        if "category_id" not in col_names:
            session.exec(text(
                "ALTER TABLE item ADD COLUMN category_id INTEGER"
            ))

        if "cost_price" not in col_names:
            session.exec(text(
                "ALTER TABLE item ADD COLUMN cost_price REAL NOT NULL DEFAULT 0"
            ))

        # Older client databases may still be missing timestamps that the current Item model selects.
        if "created_at" not in col_names:
            session.exec(text(
                "ALTER TABLE item ADD COLUMN created_at TEXT"
            ))
            session.exec(text(
                "UPDATE item SET created_at = :ts WHERE created_at IS NULL OR TRIM(created_at) = ''"
            ).bindparams(ts=_now_ts()))

        if "updated_at" not in col_names:
            session.exec(text(
                "ALTER TABLE item ADD COLUMN updated_at TEXT"
            ))
            session.exec(text(
                "UPDATE item SET updated_at = COALESCE(NULLIF(created_at, ''), :ts) WHERE updated_at IS NULL OR TRIM(updated_at) = ''"
            ).bindparams(ts=_now_ts()))

        session.exec(text(
            "UPDATE item SET created_at = :ts WHERE created_at IS NULL OR TRIM(created_at) = ''"
        ).bindparams(ts=_now_ts()))
        session.exec(text(
            "UPDATE item SET updated_at = COALESCE(NULLIF(created_at, ''), :ts) WHERE updated_at IS NULL OR TRIM(updated_at) = ''"
        ).bindparams(ts=_now_ts()))

        session.commit()

        # ✅ helpful indexes (safe to run repeatedly)
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_item_is_archived ON item (is_archived)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_item_stock ON item (stock)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_item_product_id ON item (product_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_item_category_id ON item (category_id)"))
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
        if "writeoff_amount" not in bill_col_names:
            session.exec(text(
                "ALTER TABLE bill ADD COLUMN writeoff_amount REAL NOT NULL DEFAULT 0"
            ))
        if "paid_at" not in bill_col_names:
            session.exec(text(
                "ALTER TABLE bill ADD COLUMN paid_at TEXT"
            ))
        if "is_deleted" not in bill_col_names:
            session.exec(text(
                "ALTER TABLE bill ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0"
            ))
        if "deleted_at" not in bill_col_names:
            session.exec(text(
                "ALTER TABLE bill ADD COLUMN deleted_at TEXT"
            ))
        if "customer_id" not in bill_col_names:
            session.exec(text(
                "ALTER TABLE bill ADD COLUMN customer_id INTEGER"
            ))
        if "party_id" not in bill_col_names:
            session.exec(text(
                "ALTER TABLE bill ADD COLUMN party_id INTEGER"
            ))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_bill_is_deleted ON bill (is_deleted)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_bill_customer_id ON bill (customer_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_bill_party_id ON bill (party_id)"))
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
                writeoff_amount REAL NOT NULL DEFAULT 0,
                note TEXT,
                is_writeoff INTEGER NOT NULL DEFAULT 0,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                deleted_at TEXT
            )
        """))
        bp_cols = session.exec(text("PRAGMA table_info(billpayment)")).all()
        bp_col_names = {c[1] for c in bp_cols}
        if "writeoff_amount" not in bp_col_names:
            session.exec(text(
                "ALTER TABLE billpayment ADD COLUMN writeoff_amount REAL NOT NULL DEFAULT 0"
            ))
        if "is_writeoff" not in bp_col_names:
            session.exec(text(
                "ALTER TABLE billpayment ADD COLUMN is_writeoff INTEGER NOT NULL DEFAULT 0"
            ))
        if "is_deleted" not in bp_col_names:
            session.exec(text(
                "ALTER TABLE billpayment ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0"
            ))
        if "deleted_at" not in bp_col_names:
            session.exec(text(
                "ALTER TABLE billpayment ADD COLUMN deleted_at TEXT"
            ))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_billpayment_bill_id ON billpayment (bill_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_billpayment_received_at ON billpayment (received_at)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_billpayment_is_writeoff ON billpayment (is_writeoff)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_billpayment_is_deleted ON billpayment (is_deleted)"))
        session.commit()

        # ---------- bill item allocation migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS billitemallocation (
                id INTEGER PRIMARY KEY,
                bill_id INTEGER NOT NULL,
                bill_item_id INTEGER NOT NULL,
                item_id INTEGER NOT NULL,
                lot_id INTEGER,
                quantity INTEGER NOT NULL DEFAULT 0,
                stock_unit TEXT,
                created_at TEXT NOT NULL
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_billitemallocation_bill_id ON billitemallocation (bill_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_billitemallocation_bill_item_id ON billitemallocation (bill_item_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_billitemallocation_item_id ON billitemallocation (item_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_billitemallocation_lot_id ON billitemallocation (lot_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_billitemallocation_created_at ON billitemallocation (created_at)"))
        session.commit()

        # ---------- brand/category/product master migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS brand (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_brand_name ON brand (name)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_brand_is_active ON brand (is_active)"))

        session.exec(text("""
            CREATE TABLE IF NOT EXISTS category (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_category_name ON category (name)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_category_is_active ON category (is_active)"))

        session.exec(text("""
            CREATE TABLE IF NOT EXISTS product (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                alias TEXT,
                brand TEXT,
                category_id INTEGER,
                default_rack_number INTEGER NOT NULL DEFAULT 0,
                printed_price REAL NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        product_cols = session.exec(text("PRAGMA table_info(product)")).all()
        product_col_names = {c[1] for c in product_cols}
        if "printed_price" not in product_col_names:
            session.exec(text(
                "ALTER TABLE product ADD COLUMN printed_price REAL NOT NULL DEFAULT 0"
            ))
        if "default_rack_number" not in product_col_names:
            session.exec(text(
                "ALTER TABLE product ADD COLUMN default_rack_number INTEGER NOT NULL DEFAULT 0"
            ))
        if "is_active" not in product_col_names:
            session.exec(text(
                "ALTER TABLE product ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1"
            ))
        if "parent_unit_name" not in product_col_names:
            session.exec(text(
                "ALTER TABLE product ADD COLUMN parent_unit_name TEXT"
            ))
        if "child_unit_name" not in product_col_names:
            session.exec(text(
                "ALTER TABLE product ADD COLUMN child_unit_name TEXT"
            ))
        if "loose_sale_enabled" not in product_col_names:
            session.exec(text(
                "ALTER TABLE product ADD COLUMN loose_sale_enabled INTEGER NOT NULL DEFAULT 0"
            ))
        if "default_conversion_qty" not in product_col_names:
            session.exec(text(
                "ALTER TABLE product ADD COLUMN default_conversion_qty INTEGER"
            ))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_product_name ON product (name)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_product_alias ON product (alias)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_product_brand ON product (brand)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_product_category_id ON product (category_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_product_default_rack_number ON product (default_rack_number)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_product_is_active ON product (is_active)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_product_loose_sale_enabled ON product (loose_sale_enabled)"))
        session.commit()

        # ---------- customer / requested item migration ----------
        customer_cols = session.exec(text("PRAGMA table_info(customer)")).all()
        customer_col_names = {c[1] for c in customer_cols}
        if customer_cols:
            if "address_line" not in customer_col_names:
                session.exec(text("ALTER TABLE customer ADD COLUMN address_line TEXT"))
            if "created_at" not in customer_col_names:
                session.exec(text("ALTER TABLE customer ADD COLUMN created_at TEXT"))
            if "updated_at" not in customer_col_names:
                session.exec(text("ALTER TABLE customer ADD COLUMN updated_at TEXT"))

            session.exec(text(
                "UPDATE customer SET created_at = :ts WHERE created_at IS NULL OR TRIM(created_at) = ''"
            ).bindparams(ts=_now_ts()))
            session.exec(text(
                "UPDATE customer SET updated_at = COALESCE(NULLIF(created_at, ''), :ts) WHERE updated_at IS NULL OR TRIM(updated_at) = ''"
            ).bindparams(ts=_now_ts()))

            session.exec(text("CREATE INDEX IF NOT EXISTS ix_customer_name ON customer (name)"))
            session.exec(text("CREATE INDEX IF NOT EXISTS ix_customer_phone ON customer (phone)"))
            session.commit()

        requested_item_cols = session.exec(text("PRAGMA table_info(requesteditem)")).all()
        requested_item_col_names = {c[1] for c in requested_item_cols}
        if requested_item_cols:
            if "customer_name" not in requested_item_col_names:
                session.exec(text("ALTER TABLE requesteditem ADD COLUMN customer_name TEXT"))
            if "notes" not in requested_item_col_names:
                session.exec(text("ALTER TABLE requesteditem ADD COLUMN notes TEXT"))
            if "created_at" not in requested_item_col_names:
                session.exec(text("ALTER TABLE requesteditem ADD COLUMN created_at TEXT"))
            if "updated_at" not in requested_item_col_names:
                session.exec(text("ALTER TABLE requesteditem ADD COLUMN updated_at TEXT"))

            session.exec(text(
                "UPDATE requesteditem SET created_at = :ts WHERE created_at IS NULL OR TRIM(created_at) = ''"
            ).bindparams(ts=_now_ts()))
            session.exec(text(
                "UPDATE requesteditem SET updated_at = COALESCE(NULLIF(created_at, ''), :ts) WHERE updated_at IS NULL OR TRIM(updated_at) = ''"
            ).bindparams(ts=_now_ts()))

            session.exec(text("CREATE INDEX IF NOT EXISTS ix_requesteditem_mobile ON requesteditem (mobile)"))
            session.exec(text("CREATE INDEX IF NOT EXISTS ix_requesteditem_is_available ON requesteditem (is_available)"))
            session.commit()

        # ---------- inventory lot migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS inventorylot (
                id INTEGER PRIMARY KEY,
                product_id INTEGER NOT NULL,
                expiry_date TEXT,
                mrp REAL NOT NULL DEFAULT 0,
                cost_price REAL,
                rack_number INTEGER NOT NULL DEFAULT 0,
                sealed_qty INTEGER NOT NULL DEFAULT 0,
                loose_qty INTEGER NOT NULL DEFAULT 0,
                conversion_qty INTEGER,
                opened_from_lot_id INTEGER,
                legacy_item_id INTEGER,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_inventorylot_product_id ON inventorylot (product_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_inventorylot_rack_number ON inventorylot (rack_number)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_inventorylot_opened_from_lot_id ON inventorylot (opened_from_lot_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_inventorylot_legacy_item_id ON inventorylot (legacy_item_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_inventorylot_is_active ON inventorylot (is_active)"))
        session.commit()

        # ---------- party / year / audit master migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS party (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                party_group TEXT NOT NULL,
                phone TEXT,
                address_line TEXT,
                gst_number TEXT,
                notes TEXT,
                opening_balance REAL NOT NULL DEFAULT 0,
                opening_balance_type TEXT NOT NULL DEFAULT 'DR',
                legacy_customer_id INTEGER,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_party_name ON party (name)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_party_group ON party (party_group)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_party_phone ON party (phone)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_party_is_active ON party (is_active)"))

        session.exec(text("""
            CREATE TABLE IF NOT EXISTS financialyear (
                id INTEGER PRIMARY KEY,
                label TEXT NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 0,
                is_locked INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_financialyear_label ON financialyear (label)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_financialyear_is_active ON financialyear (is_active)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_financialyear_is_locked ON financialyear (is_locked)"))

        session.exec(text("""
            CREATE TABLE IF NOT EXISTS auditlog (
                id INTEGER PRIMARY KEY,
                event_ts TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id INTEGER,
                action TEXT NOT NULL,
                note TEXT,
                details_json TEXT,
                actor TEXT
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_auditlog_event_ts ON auditlog (event_ts)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_auditlog_entity_type ON auditlog (entity_type)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_auditlog_entity_id ON auditlog (entity_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_auditlog_action ON auditlog (action)"))
        session.commit()

        # ---------- user / pin migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS appuser (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                role TEXT NOT NULL,
                pin TEXT,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_appuser_name ON appuser (name)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_appuser_role ON appuser (role)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_appuser_is_active ON appuser (is_active)"))
        session.commit()

        # ---------- stock audit migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS stockaudit (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'DRAFT',
                created_at TEXT NOT NULL,
                closed_at TEXT
            )
        """))
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS stockaudititem (
                id INTEGER PRIMARY KEY,
                audit_id INTEGER NOT NULL,
                item_id INTEGER NOT NULL,
                system_stock INTEGER NOT NULL DEFAULT 0,
                physical_stock INTEGER
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_stockaudit_name ON stockaudit (name)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_stockaudit_status ON stockaudit (status)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_stockaudititem_audit_id ON stockaudititem (audit_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_stockaudititem_item_id ON stockaudititem (item_id)"))
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

        # ---------- bankbookentry table migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS bankbookentry (
                id INTEGER PRIMARY KEY,
                created_at TEXT NOT NULL,
                entry_type TEXT NOT NULL,
                mode TEXT NOT NULL,
                amount REAL NOT NULL,
                txn_charges REAL NOT NULL DEFAULT 0,
                note TEXT
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_bankbookentry_created_at ON bankbookentry (created_at)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_bankbookentry_entry_type ON bankbookentry (entry_type)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_bankbookentry_mode ON bankbookentry (mode)"))
        session.commit()

        # ---------- purchase migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS purchase (
                id INTEGER PRIMARY KEY,
                party_id INTEGER NOT NULL,
                invoice_number TEXT NOT NULL,
                invoice_date TEXT NOT NULL,
                notes TEXT,
                subtotal_amount REAL NOT NULL DEFAULT 0,
                discount_amount REAL NOT NULL DEFAULT 0,
                gst_amount REAL NOT NULL DEFAULT 0,
                rounding_adjustment REAL NOT NULL DEFAULT 0,
                total_amount REAL NOT NULL DEFAULT 0,
                paid_amount REAL NOT NULL DEFAULT 0,
                writeoff_amount REAL NOT NULL DEFAULT 0,
                payment_status TEXT NOT NULL DEFAULT 'UNPAID',
                is_deleted INTEGER NOT NULL DEFAULT 0,
                deleted_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS purchaseitem (
                id INTEGER PRIMARY KEY,
                purchase_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                inventory_item_id INTEGER,
                product_name TEXT NOT NULL,
                brand TEXT,
                expiry_date TEXT,
                rack_number INTEGER NOT NULL DEFAULT 0,
                sealed_qty INTEGER NOT NULL DEFAULT 0,
                free_qty INTEGER NOT NULL DEFAULT 0,
                cost_price REAL NOT NULL DEFAULT 0,
                effective_cost_price REAL NOT NULL DEFAULT 0,
                mrp REAL NOT NULL DEFAULT 0,
                gst_percent REAL NOT NULL DEFAULT 0,
                discount_amount REAL NOT NULL DEFAULT 0,
                rounding_adjustment REAL NOT NULL DEFAULT 0,
                line_total REAL NOT NULL DEFAULT 0
            )
        """))
        purchase_item_cols = session.exec(text("PRAGMA table_info(purchaseitem)")).all()
        purchase_item_col_names = {c[1] for c in purchase_item_cols}
        if "inventory_item_id" not in purchase_item_col_names:
            session.exec(text("ALTER TABLE purchaseitem ADD COLUMN inventory_item_id INTEGER"))
        if "lot_id" not in purchase_item_col_names:
            session.exec(text("ALTER TABLE purchaseitem ADD COLUMN lot_id INTEGER"))
        if "effective_cost_price" not in purchase_item_col_names:
            session.exec(text("ALTER TABLE purchaseitem ADD COLUMN effective_cost_price REAL NOT NULL DEFAULT 0"))
        if "stock_source" not in purchase_item_col_names:
            session.exec(text("ALTER TABLE purchaseitem ADD COLUMN stock_source TEXT NOT NULL DEFAULT 'CREATED'"))
        if "rounding_adjustment" not in purchase_item_col_names:
            session.exec(text("ALTER TABLE purchaseitem ADD COLUMN rounding_adjustment REAL NOT NULL DEFAULT 0"))

        session.exec(text("""
            CREATE TABLE IF NOT EXISTS purchasepayment (
                id INTEGER PRIMARY KEY,
                purchase_id INTEGER NOT NULL,
                party_id INTEGER,
                paid_at TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'cash',
                bank_mode TEXT,
                transaction_id TEXT,
                amount REAL NOT NULL DEFAULT 0,
                cash_amount REAL NOT NULL DEFAULT 0,
                online_amount REAL NOT NULL DEFAULT 0,
                txn_charges REAL NOT NULL DEFAULT 0,
                note TEXT,
                is_writeoff INTEGER NOT NULL DEFAULT 0,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                deleted_at TEXT
            )
        """))
        purchase_payment_cols = session.exec(text("PRAGMA table_info(purchasepayment)")).all()
        purchase_payment_col_names = {c[1] for c in purchase_payment_cols}
        if "party_id" not in purchase_payment_col_names:
            session.exec(text("ALTER TABLE purchasepayment ADD COLUMN party_id INTEGER"))
        if "mode" not in purchase_payment_col_names:
            session.exec(text("ALTER TABLE purchasepayment ADD COLUMN mode TEXT NOT NULL DEFAULT 'cash'"))
        if "bank_mode" not in purchase_payment_col_names:
            session.exec(text("ALTER TABLE purchasepayment ADD COLUMN bank_mode TEXT"))
        if "transaction_id" not in purchase_payment_col_names:
            session.exec(text("ALTER TABLE purchasepayment ADD COLUMN transaction_id TEXT"))
        if "cash_amount" not in purchase_payment_col_names:
            session.exec(text("ALTER TABLE purchasepayment ADD COLUMN cash_amount REAL NOT NULL DEFAULT 0"))
        if "online_amount" not in purchase_payment_col_names:
            session.exec(text("ALTER TABLE purchasepayment ADD COLUMN online_amount REAL NOT NULL DEFAULT 0"))
        if "txn_charges" not in purchase_payment_col_names:
            session.exec(text("ALTER TABLE purchasepayment ADD COLUMN txn_charges REAL NOT NULL DEFAULT 0"))
        session.exec(text("""
            UPDATE purchasepayment
            SET mode = CASE WHEN is_writeoff = 1 THEN 'writeoff' ELSE 'cash' END
            WHERE mode IS NULL OR TRIM(mode) = ''
        """))
        session.exec(text("""
            UPDATE purchasepayment
            SET cash_amount = amount
            WHERE is_writeoff = 0
              AND amount > 0
              AND COALESCE(cash_amount, 0) = 0
              AND COALESCE(online_amount, 0) = 0
        """))
        session.exec(text("""
            UPDATE purchasepayment
            SET party_id = (
                SELECT purchase.party_id
                FROM purchase
                WHERE purchase.id = purchasepayment.purchase_id
            )
            WHERE party_id IS NULL
              AND COALESCE(purchase_id, 0) > 0
        """))
        session.exec(text("""
            UPDATE purchasepayment
            SET bank_mode = 'UPI'
            WHERE is_writeoff = 0
              AND COALESCE(online_amount, 0) > 0
              AND (bank_mode IS NULL OR TRIM(bank_mode) = '')
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchase_party_id ON purchase (party_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchase_invoice_number ON purchase (invoice_number)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchase_payment_status ON purchase (payment_status)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchase_is_deleted ON purchase (is_deleted)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchaseitem_purchase_id ON purchaseitem (purchase_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchaseitem_product_id ON purchaseitem (product_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchaseitem_inventory_item_id ON purchaseitem (inventory_item_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchaseitem_lot_id ON purchaseitem (lot_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchaseitem_stock_source ON purchaseitem (stock_source)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchasepayment_purchase_id ON purchasepayment (purchase_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchasepayment_party_id ON purchasepayment (party_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchasepayment_paid_at ON purchasepayment (paid_at)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchasepayment_mode ON purchasepayment (mode)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchasepayment_bank_mode ON purchasepayment (bank_mode)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchasepayment_transaction_id ON purchasepayment (transaction_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_purchasepayment_is_writeoff ON purchasepayment (is_writeoff)"))
        session.commit()

        # ---------- receipts / loose stock / voucher migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS partyreceipt (
                id INTEGER PRIMARY KEY,
                party_id INTEGER NOT NULL,
                received_at TEXT NOT NULL,
                mode TEXT NOT NULL,
                cash_amount REAL NOT NULL DEFAULT 0,
                online_amount REAL NOT NULL DEFAULT 0,
                total_amount REAL NOT NULL DEFAULT 0,
                unallocated_amount REAL NOT NULL DEFAULT 0,
                note TEXT,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                deleted_at TEXT
            )
        """))
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS receiptbilladjustment (
                id INTEGER PRIMARY KEY,
                receipt_id INTEGER NOT NULL,
                bill_id INTEGER NOT NULL,
                bill_payment_id INTEGER,
                adjusted_amount REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
        """))
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS packopenevent (
                id INTEGER PRIMARY KEY,
                source_lot_id INTEGER NOT NULL,
                loose_lot_id INTEGER NOT NULL,
                source_item_id INTEGER,
                loose_item_id INTEGER,
                packs_opened INTEGER NOT NULL DEFAULT 0,
                loose_units_created INTEGER NOT NULL DEFAULT 0,
                note TEXT,
                created_at TEXT NOT NULL
            )
        """))
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS ledgergroup (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                nature TEXT NOT NULL,
                system_key TEXT,
                is_system INTEGER NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS ledger (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                group_id INTEGER NOT NULL,
                party_id INTEGER,
                system_key TEXT,
                is_system INTEGER NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS voucher (
                id INTEGER PRIMARY KEY,
                voucher_type TEXT NOT NULL,
                source_type TEXT NOT NULL,
                source_id INTEGER NOT NULL,
                voucher_no TEXT NOT NULL,
                voucher_date TEXT NOT NULL,
                narration TEXT,
                total_amount REAL NOT NULL DEFAULT 0,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                deleted_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """))
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS voucherentry (
                id INTEGER PRIMARY KEY,
                voucher_id INTEGER NOT NULL,
                ledger_id INTEGER NOT NULL,
                entry_type TEXT NOT NULL,
                amount REAL NOT NULL DEFAULT 0,
                narration TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_partyreceipt_party_id ON partyreceipt (party_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_partyreceipt_received_at ON partyreceipt (received_at)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_partyreceipt_is_deleted ON partyreceipt (is_deleted)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_receiptbilladjustment_receipt_id ON receiptbilladjustment (receipt_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_receiptbilladjustment_bill_id ON receiptbilladjustment (bill_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_receiptbilladjustment_bill_payment_id ON receiptbilladjustment (bill_payment_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_packopenevent_source_lot_id ON packopenevent (source_lot_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_packopenevent_loose_lot_id ON packopenevent (loose_lot_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_packopenevent_created_at ON packopenevent (created_at)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_ledgergroup_name ON ledgergroup (name)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_ledgergroup_system_key ON ledgergroup (system_key)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_ledger_name ON ledger (name)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_ledger_group_id ON ledger (group_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_ledger_party_id ON ledger (party_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_ledger_system_key ON ledger (system_key)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_voucher_voucher_type ON voucher (voucher_type)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_voucher_source_type ON voucher (source_type)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_voucher_source_id ON voucher (source_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_voucher_voucher_no ON voucher (voucher_no)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_voucher_voucher_date ON voucher (voucher_date)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_voucher_is_deleted ON voucher (is_deleted)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_voucherentry_voucher_id ON voucherentry (voucher_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_voucherentry_ledger_id ON voucherentry (ledger_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_voucherentry_entry_type ON voucherentry (entry_type)"))
        session.commit()

        # ---------- exchangerecord table migration ----------
        session.exec(text("""
            CREATE TABLE IF NOT EXISTS exchangerecord (
                id INTEGER PRIMARY KEY,
                created_at TEXT NOT NULL,
                source_bill_id INTEGER,
                return_id INTEGER NOT NULL,
                new_bill_id INTEGER NOT NULL,
                theoretical_net REAL NOT NULL DEFAULT 0,
                net_due REAL NOT NULL DEFAULT 0,
                rounding_adjustment REAL NOT NULL DEFAULT 0,
                payment_mode TEXT NOT NULL DEFAULT 'cash',
                payment_cash REAL NOT NULL DEFAULT 0,
                payment_online REAL NOT NULL DEFAULT 0,
                refund_cash REAL NOT NULL DEFAULT 0,
                refund_online REAL NOT NULL DEFAULT 0,
                notes TEXT
            )
        """))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_exchangerecord_created_at ON exchangerecord (created_at)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_exchangerecord_return_id ON exchangerecord (return_id)"))
        session.exec(text("CREATE INDEX IF NOT EXISTS ix_exchangerecord_new_bill_id ON exchangerecord (new_bill_id)"))
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

        session.exec(text("""
            CREATE TABLE IF NOT EXISTS appmeta (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at TEXT
            )
        """))
        session.commit()

        # ---------- one-time data repair: bad bulk purchase duplicate repair ----------
        purchase_duplicate_repair_key = "repair_purchase_duplicate_stock_links_v1"
        purchase_duplicate_repair_done = session.exec(
            text("SELECT value FROM appmeta WHERE key = :k LIMIT 1").bindparams(k=purchase_duplicate_repair_key),
        ).first()
        if not purchase_duplicate_repair_done:
            ts_repair = _now_ts()
            repaired_count = repair_purchase_duplicate_stock_links(session)
            session.exec(
                text("""
                    INSERT INTO appmeta (key, value, updated_at)
                    VALUES (:k, :value, :ts)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """).bindparams(
                    k=purchase_duplicate_repair_key,
                    value=f"done:{repaired_count}",
                    ts=ts_repair,
                ),
            )
            session.commit()

        # ---------- one-time data repair: purchase-created stock hidden by duplicate repair ----------
        hidden_purchase_stock_repair_key = "repair_hidden_purchase_duplicate_stock_v2"
        hidden_purchase_stock_repair_done = session.exec(
            text("SELECT value FROM appmeta WHERE key = :k LIMIT 1").bindparams(k=hidden_purchase_stock_repair_key),
        ).first()
        if not hidden_purchase_stock_repair_done:
            session.commit()
            ts_repair = _now_ts()
            repaired_count, backup_path, warning_count = auto_repair_hidden_purchase_duplicate_stock()
            session.exec(
                text("""
                    INSERT INTO appmeta (key, value, updated_at)
                    VALUES (:k, :value, :ts)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """).bindparams(
                    k=hidden_purchase_stock_repair_key,
                    value=f"done:{repaired_count};warnings:{warning_count};backup:{backup_path or ''}",
                    ts=ts_repair,
                ),
            )
            session.commit()

        # ---------- one-time data repair: convert opening placeholders used by purchases ----------
        opening_purchase_merge_key = "merge_opening_purchase_duplicate_batches_v1"
        opening_purchase_merge_done = session.exec(
            text("SELECT value FROM appmeta WHERE key = :k LIMIT 1").bindparams(k=opening_purchase_merge_key),
        ).first()
        if not opening_purchase_merge_done:
            session.commit()
            ts_repair = _now_ts()
            merged_count, backup_path = merge_opening_purchase_duplicate_batches(session)
            session.exec(
                text("""
                    INSERT INTO appmeta (key, value, updated_at)
                    VALUES (:k, :value, :ts)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """).bindparams(
                    k=opening_purchase_merge_key,
                    value=f"done:{merged_count};backup:{backup_path or ''}",
                    ts=ts_repair,
                ),
            )
            session.commit()

        # ---------- one-time data repair: undo unsafe purchase/opening duplicate restores ----------
        unsafe_opening_restore_key = "revert_unsafe_opening_purchase_restore_v1"
        unsafe_opening_restore_done = session.exec(
            text("SELECT value FROM appmeta WHERE key = :k LIMIT 1").bindparams(k=unsafe_opening_restore_key),
        ).first()
        if not unsafe_opening_restore_done:
            session.commit()
            ts_repair = _now_ts()
            reverted_count, backup_path = revert_unsafe_opening_purchase_restores(session)
            session.exec(
                text("""
                    INSERT INTO appmeta (key, value, updated_at)
                    VALUES (:k, :value, :ts)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """).bindparams(
                    k=unsafe_opening_restore_key,
                    value=f"done:{reverted_count};backup:{backup_path or ''}",
                    ts=ts_repair,
                ),
            )
            session.commit()

        # ---------- one-time data repair: remove source-side repair noise after opening merge ----------
        opening_purchase_cleanup_key = "cleanup_opening_purchase_duplicate_repair_pairs_v1"
        opening_purchase_cleanup_done = session.exec(
            text("SELECT value FROM appmeta WHERE key = :k LIMIT 1").bindparams(k=opening_purchase_cleanup_key),
        ).first()
        if not opening_purchase_cleanup_done:
            session.commit()
            ts_repair = _now_ts()
            cleaned_count, backup_path = cleanup_opening_purchase_duplicate_repair_pairs(session)
            session.exec(
                text("""
                    INSERT INTO appmeta (key, value, updated_at)
                    VALUES (:k, :value, :ts)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """).bindparams(
                    k=opening_purchase_cleanup_key,
                    value=f"done:{cleaned_count};backup:{backup_path or ''}",
                    ts=ts_repair,
                ),
            )
            session.commit()

        # ---------- one-time data repair: make old club balance rows ledger-friendly ----------
        club_recon_opening_cleanup_key = "convert_positive_club_recon_to_opening_v1"
        club_recon_opening_cleanup_done = session.exec(
            text("SELECT value FROM appmeta WHERE key = :k LIMIT 1").bindparams(k=club_recon_opening_cleanup_key),
        ).first()
        if not club_recon_opening_cleanup_done:
            session.commit()
            ts_repair = _now_ts()
            converted_count, backup_path = convert_positive_club_recon_to_opening(session)
            session.exec(
                text("""
                    INSERT INTO appmeta (key, value, updated_at)
                    VALUES (:k, :value, :ts)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """).bindparams(
                    k=club_recon_opening_cleanup_key,
                    value=f"done:{converted_count};backup:{backup_path or ''}",
                    ts=ts_repair,
                ),
            )
            session.commit()

        # ---------- one-time data repair: collapse safe product master duplicates ----------
        duplicate_product_merge_key = "merge_safe_duplicate_products_v1"
        duplicate_product_merge_done = session.exec(
            text("SELECT value FROM appmeta WHERE key = :k LIMIT 1").bindparams(k=duplicate_product_merge_key),
        ).first()
        if not duplicate_product_merge_done:
            session.commit()
            ts_repair = _now_ts()
            merged_count, backup_path = merge_safe_duplicate_products(session)
            session.exec(
                text("""
                    INSERT INTO appmeta (key, value, updated_at)
                    VALUES (:k, :value, :ts)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """).bindparams(
                    k=duplicate_product_merge_key,
                    value=f"done:{merged_count};backup:{backup_path or ''}",
                    ts=ts_repair,
                ),
            )
            session.commit()

        # ---------- default financial year ----------
        fy_count_row = session.exec(text("SELECT COUNT(*) FROM financialyear")).one()
        fy_count = fy_count_row[0] if isinstance(fy_count_row, tuple) or hasattr(fy_count_row, "__getitem__") else fy_count_row
        if int(fy_count or 0) == 0:
            today = datetime.now().date()
            if today.month >= 4:
                start_year = today.year
            else:
                start_year = today.year - 1
            start_date = f"{start_year}-04-01"
            end_date = f"{start_year + 1}-03-31"
            session.exec(
                text("""
                    INSERT INTO financialyear (
                        label, start_date, end_date, is_active, is_locked, created_at, updated_at
                    ) VALUES (
                        :label, :start_date, :end_date, 1, 0, :ts, :ts
                    )
                """).bindparams(
                    label=f"FY {str(start_year)[-2:]}-{str(start_year + 1)[-2:]}",
                    start_date=start_date,
                    end_date=end_date,
                    ts=_now_ts(),
                ),
            )
            session.commit()

        # ---------- inventory lot backfill ----------
        lot_backfill_key = "backfill_inventory_lots_v1"
        lot_backfill_done = session.exec(
            text("SELECT value FROM appmeta WHERE key = :k LIMIT 1").bindparams(k=lot_backfill_key),
        ).first()
        if not lot_backfill_done:
            ts3 = _now_ts()
            item_rows = session.exec(
                text("""
                    SELECT id, name, brand, product_id, category_id, expiry_date, mrp, cost_price, stock, rack_number, is_archived
                    FROM item
                    ORDER BY id ASC
                """)
            ).all()

            for row in item_rows:
                item_id = int(row[0] or 0)
                if item_id <= 0:
                    continue
                has_lot = session.exec(
                    text("SELECT 1 FROM inventorylot WHERE legacy_item_id = :item_id LIMIT 1").bindparams(item_id=item_id),
                ).first()
                if has_lot:
                    continue

                product_id = row[3]
                if product_id is None:
                    name = str(row[1] or "").strip()
                    brand = str(row[2] or "").strip() or None
                    if not name:
                        continue
                    existing_product = session.exec(
                        text("""
                            SELECT id
                            FROM product
                            WHERE lower(coalesce(name, '')) = lower(:name)
                              AND lower(coalesce(brand, '')) = lower(:brand)
                            LIMIT 1
                        """).bindparams(name=name, brand=brand or ""),
                    ).first()
                    if existing_product:
                        product_id = int(existing_product[0])
                    else:
                        session.exec(
                            text("""
                                INSERT INTO product (
                                    name, alias, brand, category_id, default_rack_number, printed_price,
                                    parent_unit_name, child_unit_name, loose_sale_enabled, default_conversion_qty,
                                    is_active, created_at, updated_at
                                ) VALUES (
                                    :name, NULL, :brand, :category_id, :rack_number, :printed_price,
                                    NULL, NULL, 0, NULL, 1, :ts, :ts
                                )
                            """).bindparams(
                                name=name,
                                brand=brand,
                                category_id=row[4],
                                rack_number=int(row[9] or 0),
                                printed_price=float(row[6] or 0),
                                ts=ts3,
                            ),
                        )
                        product_id = int(session.exec(text("SELECT last_insert_rowid()")).one()[0])
                        session.exec(
                            text("UPDATE item SET product_id = :product_id WHERE id = :item_id").bindparams(
                                product_id=product_id,
                                item_id=item_id,
                            ),
                        )

                if product_id is None:
                    continue

                session.exec(
                    text("""
                        INSERT INTO inventorylot (
                            product_id, expiry_date, mrp, cost_price, rack_number,
                            sealed_qty, loose_qty, conversion_qty, opened_from_lot_id,
                            legacy_item_id, is_active, created_at, updated_at
                        ) VALUES (
                            :product_id, :expiry_date, :mrp, :cost_price, :rack_number,
                            :sealed_qty, 0, NULL, NULL,
                            :legacy_item_id, :is_active, :ts, :ts
                        )
                    """).bindparams(
                        product_id=int(product_id),
                        expiry_date=row[5],
                        mrp=float(row[6] or 0),
                        cost_price=float(row[7] or 0),
                        rack_number=int(row[9] or 0),
                        sealed_qty=max(0, int(row[8] or 0)),
                        legacy_item_id=item_id,
                        is_active=0 if bool(row[10]) else 1,
                        ts=ts3,
                    ),
                )

            session.exec(
                text("""
                    INSERT INTO appmeta (key, value, updated_at)
                    VALUES (:k, 'done', :ts)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """).bindparams(k=lot_backfill_key, ts=ts3),
            )
            session.commit()

        # ---------- repeat-safe upkeep for lot links / loose rates ----------
        # Runs on normal app startup. No separate client-side script is required.
        ts_lot_upkeep = _now_ts()
        session.exec(
            text("""
                INSERT INTO inventorylot (
                    product_id, expiry_date, mrp, cost_price, rack_number,
                    sealed_qty, loose_qty, conversion_qty, opened_from_lot_id,
                    legacy_item_id, is_active, created_at, updated_at
                )
                SELECT
                    i.product_id,
                    i.expiry_date,
                    COALESCE(i.mrp, 0),
                    COALESCE(i.cost_price, 0),
                    COALESCE(i.rack_number, 0),
                    MAX(0, COALESCE(i.stock, 0)),
                    0,
                    p.default_conversion_qty,
                    NULL,
                    i.id,
                    CASE WHEN COALESCE(i.is_archived, 0) = 1 THEN 0 ELSE 1 END,
                    :ts,
                    :ts
                FROM item i
                JOIN product p ON p.id = i.product_id
                WHERE i.product_id IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM inventorylot l WHERE l.legacy_item_id = i.id
                  )
            """).bindparams(ts=ts_lot_upkeep),
        )
        session.exec(
            text("""
                UPDATE inventorylot
                SET sealed_qty = COALESCE((SELECT MAX(0, COALESCE(i.stock, 0)) FROM item i WHERE i.id = inventorylot.legacy_item_id), sealed_qty),
                    updated_at = :ts
                WHERE opened_from_lot_id IS NULL
                  AND legacy_item_id IS NOT NULL
                  AND EXISTS (SELECT 1 FROM item i WHERE i.id = inventorylot.legacy_item_id)
            """).bindparams(ts=ts_lot_upkeep),
        )
        session.exec(
            text("""
                UPDATE inventorylot
                SET loose_qty = COALESCE((SELECT MAX(0, COALESCE(i.stock, 0)) FROM item i WHERE i.id = inventorylot.legacy_item_id), loose_qty),
                    updated_at = :ts
                WHERE opened_from_lot_id IS NOT NULL
                  AND legacy_item_id IS NOT NULL
                  AND EXISTS (SELECT 1 FROM item i WHERE i.id = inventorylot.legacy_item_id)
            """).bindparams(ts=ts_lot_upkeep),
        )
        session.exec(
            text("""
                UPDATE item
                SET is_archived = 0,
                    archived_at = NULL,
                    updated_at = :ts
                WHERE COALESCE(stock, 0) > 0
                  AND COALESCE(is_archived, 0) = 1
            """).bindparams(ts=ts_lot_upkeep),
        )
        session.exec(
            text("""
                UPDATE inventorylot
                SET mrp = ROUND((
                        SELECT COALESCE(src.mrp, 0) / COALESCE(NULLIF(inventorylot.conversion_qty, 0), NULLIF(src.conversion_qty, 0), NULLIF(p.default_conversion_qty, 0))
                        FROM inventorylot src
                        JOIN product p ON p.id = inventorylot.product_id
                        WHERE src.id = inventorylot.opened_from_lot_id
                    ), 2),
                    cost_price = ROUND((
                        SELECT COALESCE(src.cost_price, 0) / COALESCE(NULLIF(inventorylot.conversion_qty, 0), NULLIF(src.conversion_qty, 0), NULLIF(p.default_conversion_qty, 0))
                        FROM inventorylot src
                        JOIN product p ON p.id = inventorylot.product_id
                        WHERE src.id = inventorylot.opened_from_lot_id
                    ), 2),
                    updated_at = :ts
                WHERE opened_from_lot_id IS NOT NULL
                  AND COALESCE(NULLIF(conversion_qty, 0), (
                        SELECT NULLIF(src.conversion_qty, 0)
                        FROM inventorylot src
                        WHERE src.id = inventorylot.opened_from_lot_id
                    ), (
                        SELECT NULLIF(p.default_conversion_qty, 0)
                        FROM product p
                        WHERE p.id = inventorylot.product_id
                    )) IS NOT NULL
            """).bindparams(ts=ts_lot_upkeep),
        )
        session.exec(
            text("""
                UPDATE item
                SET mrp = COALESCE((SELECT l.mrp FROM inventorylot l WHERE l.legacy_item_id = item.id AND l.opened_from_lot_id IS NOT NULL LIMIT 1), mrp),
                    cost_price = COALESCE((SELECT l.cost_price FROM inventorylot l WHERE l.legacy_item_id = item.id AND l.opened_from_lot_id IS NOT NULL LIMIT 1), cost_price),
                    updated_at = :ts
                WHERE EXISTS (
                    SELECT 1 FROM inventorylot l
                    WHERE l.legacy_item_id = item.id
                      AND l.opened_from_lot_id IS NOT NULL
                )
            """).bindparams(ts=ts_lot_upkeep),
        )
        session.commit()

        # ---------- one-time client repair: loose conversion + credit return bill totals ----------
        client_repair_key = "repair_client_loose_conversion_and_credit_returns_v1"
        client_repair_done = session.exec(
            text("SELECT value FROM appmeta WHERE key = :k LIMIT 1").bindparams(k=client_repair_key),
        ).first()
        if not client_repair_done:
            session.commit()
            ts_repair = _now_ts()
            loose_syncs, loose_stock_repairs, bill_total_repairs, voucher_syncs, backup_path, warning_count = (
                auto_repair_client_loose_conversion_and_credit_returns()
            )
            session.exec(
                text("""
                    INSERT INTO appmeta (key, value, updated_at)
                    VALUES (:k, :value, :ts)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """).bindparams(
                    k=client_repair_key,
                    value=(
                        f"done;loose_syncs:{loose_syncs};"
                        f"loose_stock_repairs:{loose_stock_repairs};"
                        f"bill_total_repairs:{bill_total_repairs};"
                        f"voucher_syncs:{voucher_syncs};"
                        f"warnings:{warning_count};"
                        f"backup:{backup_path or ''}"
                    ),
                    ts=ts_repair,
                ),
            )
            session.commit()

        # ---------- one-time backfill: deleted bill stock + ledger ----------
        backfill_key = "backfill_deleted_bill_stock_ledger_v2"
        already_done = session.exec(
            text("SELECT value FROM appmeta WHERE key = :k LIMIT 1").bindparams(k=backfill_key),
        ).first()

        if not already_done:
            ts = _now_ts()
            deleted_bill_ids = session.exec(text("SELECT id FROM bill WHERE is_deleted = 1")).all()

            for row in deleted_bill_ids:
                bill_id = int(row[0])

                has_delete_movement = session.exec(
                    text("""
                        SELECT 1
                        FROM stockmovement
                        WHERE ref_type = 'BILL' AND ref_id = :bill_id AND reason = 'BILL_DELETE'
                        LIMIT 1
                    """).bindparams(bill_id=bill_id),
                ).first()
                if has_delete_movement:
                    continue

                bill_lines = session.exec(
                    text("""
                        SELECT item_id, COALESCE(SUM(quantity), 0) AS qty
                        FROM billitem
                        WHERE bill_id = :bill_id
                        GROUP BY item_id
                        HAVING COALESCE(SUM(quantity), 0) > 0
                    """).bindparams(bill_id=bill_id),
                ).all()

                for line in bill_lines:
                    item_id = int(line[0])
                    qty = int(line[1])

                    item_exists = session.exec(
                        text("SELECT 1 FROM item WHERE id = :item_id LIMIT 1").bindparams(item_id=item_id),
                    ).first()
                    if not item_exists:
                        continue

                    session.exec(
                        text("UPDATE item SET stock = COALESCE(stock, 0) + :qty WHERE id = :item_id").bindparams(
                            qty=qty,
                            item_id=item_id,
                        ),
                    )
                    session.exec(
                        text("""
                            INSERT INTO stockmovement (item_id, ts, delta, reason, ref_type, ref_id, note, actor)
                            VALUES (:item_id, :ts, :delta, 'BILL_DELETE', 'BILL', :ref_id, :note, 'migration')
                        """).bindparams(
                            item_id=item_id,
                            ts=ts,
                            delta=qty,
                            ref_id=bill_id,
                            note=f"Backfill: bill #{bill_id} was already soft-deleted before ledger fix",
                        ),
                    )

            session.exec(
                text("""
                    INSERT INTO appmeta (key, value, updated_at)
                    VALUES (:k, 'done', :ts)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """).bindparams(k=backfill_key, ts=ts),
            )
            session.commit()

        # ---------- one-time backfill: missing SALE ledger rows for existing bills ----------
        sale_backfill_key = "backfill_missing_bill_sale_ledger_v2"
        sale_backfill_done = session.exec(
            text("SELECT value FROM appmeta WHERE key = :k LIMIT 1").bindparams(k=sale_backfill_key),
        ).first()

        if not sale_backfill_done:
            ts2 = _now_ts()
            bill_rows = session.exec(text("SELECT id FROM bill")).all()

            for row in bill_rows:
                bill_id = int(row[0])
                has_bill_edit = session.exec(
                    text("""
                        SELECT 1
                        FROM stockmovement
                        WHERE ref_type = 'BILL' AND ref_id = :bill_id AND reason = 'BILL_EDIT'
                        LIMIT 1
                    """).bindparams(bill_id=bill_id),
                ).first()
                if has_bill_edit:
                    # Edited bills already have correction entries; auto SALE backfill can overstate history.
                    continue

                bill_lines = session.exec(
                    text("""
                        SELECT item_id, COALESCE(SUM(quantity), 0) AS qty
                        FROM billitem
                        WHERE bill_id = :bill_id
                        GROUP BY item_id
                        HAVING COALESCE(SUM(quantity), 0) > 0
                    """).bindparams(bill_id=bill_id),
                ).all()

                for line in bill_lines:
                    item_id = int(line[0])
                    sold_qty = int(line[1])

                    sale_abs = session.exec(
                        text("""
                            SELECT COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0)
                            FROM stockmovement
                            WHERE ref_type = 'BILL'
                              AND ref_id = :bill_id
                              AND item_id = :item_id
                              AND reason = 'SALE'
                        """).bindparams(bill_id=bill_id, item_id=item_id),
                    ).first()
                    existing_sale_qty = int(sale_abs[0] or 0) if sale_abs else 0
                    missing_qty = sold_qty - existing_sale_qty
                    if missing_qty <= 0:
                        continue

                    session.exec(
                        text("""
                            INSERT INTO stockmovement (item_id, ts, delta, reason, ref_type, ref_id, note, actor)
                            VALUES (:item_id, :ts, :delta, 'SALE', 'BILL', :ref_id, :note, 'migration')
                        """).bindparams(
                            item_id=item_id,
                            ts=ts2,
                            delta=-missing_qty,
                            ref_id=bill_id,
                            note=f"Backfill: missing SALE movement for bill #{bill_id}",
                        ),
                    )

            session.exec(
                text("""
                    INSERT INTO appmeta (key, value, updated_at)
                    VALUES (:k, 'done', :ts)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """).bindparams(k=sale_backfill_key, ts=ts2),
            )
            session.commit()

# Register SQLModel table metadata even when backend.db is imported outside main.py.
from backend import models as _models  # noqa: F401,E402

SQLModel.metadata.create_all(engine)
migrate_db()

@contextmanager
def get_session():
    # IMPORTANT: stop expiring objects after commit
    with Session(engine, expire_on_commit=False) as session:
        yield session
