#!/usr/bin/env python3
"""
Audit or repair purchase-created stock batches hidden by a bad duplicate repair.

Default mode is read-only preview. Use --apply to modify the database.
The repair restores the original purchase-created batch and points the
purchase item back to that batch, so future purchase edit/delete behavior
continues to work with the existing app logic.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
import sqlite3
import sys
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable


TARGET_RE = re.compile(r"#(\d+)\s*$")


def now_ts() -> str:
    return datetime.now().isoformat(timespec="seconds")


def norm_text(value: object) -> str:
    return " ".join(str(value or "").strip().lower().split())


def norm_money(value: object) -> str:
    return f"{float(value or 0):.3f}"


def row_dicts(cursor: sqlite3.Cursor, sql: str, params: Iterable[object] = ()) -> list[dict]:
    cursor.execute(sql, tuple(params))
    return [dict(row) for row in cursor.fetchall()]


@dataclass
class RepairPair:
    purchase_item: dict
    duplicate: dict
    link_id: int | None

    @property
    def qty(self) -> int:
        return int(self.purchase_item["qty"] or 0)

    @property
    def purchase_id(self) -> int:
        return int(self.purchase_item["purchase_id"])

    @property
    def target_item_id(self) -> int:
        return int(self.purchase_item["target_item_id"])

    @property
    def duplicate_item_id(self) -> int:
        return int(self.duplicate["duplicate_item_id"])

    def report_row(self) -> dict:
        item = self.purchase_item
        dupe = self.duplicate
        return {
            "purchase_id": self.purchase_id,
            "invoice_number": item["invoice_number"],
            "invoice_date": item["invoice_date"],
            "purchase_item_id": item["purchase_item_id"],
            "product_name": item["product_name"],
            "brand": item["brand"],
            "qty": self.qty,
            "target_item_id": self.target_item_id,
            "target_stock_now": item["target_stock"],
            "duplicate_item_id": self.duplicate_item_id,
            "duplicate_purchase_movement_id": dupe["purchase_movement_id"],
            "duplicate_repair_movement_id": dupe["repair_movement_id"],
            "target_purchase_link_id": self.link_id or "",
        }


def load_purchase_items(conn: sqlite3.Connection) -> list[dict]:
    cur = conn.cursor()
    return row_dicts(
        cur,
        """
        SELECT
            pi.id AS purchase_item_id,
            pi.purchase_id,
            p.invoice_number,
            p.invoice_date,
            pi.inventory_item_id AS target_item_id,
            pi.lot_id AS target_lot_id,
            pi.product_id,
            pi.product_name,
            pi.brand,
            pi.expiry_date,
            pi.mrp,
            pi.cost_price,
            pi.effective_cost_price,
            COALESCE(pi.sealed_qty, 0) AS sealed_qty,
            COALESCE(pi.free_qty, 0) AS free_qty,
            COALESCE(pi.sealed_qty, 0) + COALESCE(pi.free_qty, 0) AS qty,
            COALESCE(pi.stock_source, 'CREATED') AS stock_source,
            target.stock AS target_stock,
            target.is_archived AS target_is_archived,
            (
                SELECT MIN(sm.ts)
                FROM stockmovement sm
                WHERE sm.item_id = pi.inventory_item_id
                  AND sm.reason = 'OPENING'
                  AND sm.ref_type = 'ITEM_CREATE'
            ) AS target_opening_ts,
            COALESCE((
                SELECT SUM(sm.delta)
                FROM stockmovement sm
                WHERE sm.item_id = pi.inventory_item_id
                  AND sm.reason = 'OPENING'
                  AND sm.ref_type = 'ITEM_CREATE'
            ), 0) AS target_opening_delta,
            (
                SELECT COUNT(*)
                FROM stockmovement sm
                WHERE sm.item_id = pi.inventory_item_id
                  AND date(sm.ts) < date(p.invoice_date)
            ) AS target_pre_invoice_movement_count,
            COALESCE((
                SELECT SUM(sm.delta)
                FROM stockmovement sm
                WHERE sm.item_id = pi.inventory_item_id
                  AND sm.ref_type = 'PURCHASE'
                  AND sm.ref_id = pi.purchase_id
                  AND sm.reason = 'PURCHASE'
            ), 0) AS target_purchase_delta
        FROM purchaseitem pi
        JOIN purchase p ON p.id = pi.purchase_id
        JOIN item target ON target.id = pi.inventory_item_id
        WHERE COALESCE(p.is_deleted, 0) = 0
          AND COALESCE(pi.stock_source, 'CREATED') = 'ATTACHED'
          AND (COALESCE(pi.sealed_qty, 0) + COALESCE(pi.free_qty, 0)) > 0
          AND COALESCE((
                SELECT SUM(sm.delta)
                FROM stockmovement sm
                WHERE sm.item_id = pi.inventory_item_id
                  AND sm.ref_type = 'PURCHASE'
                  AND sm.ref_id = pi.purchase_id
                  AND sm.reason = 'PURCHASE'
          ), 0) = 0
        ORDER BY pi.purchase_id, pi.id
        """,
    )


def load_duplicate_repairs(conn: sqlite3.Connection) -> list[dict]:
    cur = conn.cursor()
    rows = row_dicts(
        cur,
        """
        SELECT
            repair.id AS repair_movement_id,
            purchase_sm.id AS purchase_movement_id,
            repair.ref_id AS purchase_id,
            repair.item_id AS duplicate_item_id,
            repair.delta AS repair_delta,
            purchase_sm.delta AS purchase_delta,
            repair.note AS repair_note,
            dupe.name AS duplicate_name,
            dupe.brand AS duplicate_brand,
            dupe.expiry_date AS duplicate_expiry_date,
            dupe.mrp AS duplicate_mrp,
            dupe.stock AS duplicate_stock,
            dupe.is_archived AS duplicate_is_archived,
            dupe_lot.id AS duplicate_lot_id,
            (
                SELECT COUNT(*)
                FROM stockmovement other
                WHERE other.item_id = repair.item_id
                  AND other.id NOT IN (repair.id, purchase_sm.id)
            ) AS other_movement_count
        FROM stockmovement repair
        JOIN stockmovement purchase_sm
          ON purchase_sm.item_id = repair.item_id
         AND purchase_sm.ref_type = repair.ref_type
         AND purchase_sm.ref_id = repair.ref_id
         AND purchase_sm.reason = 'PURCHASE'
         AND purchase_sm.delta = -repair.delta
        JOIN item dupe ON dupe.id = repair.item_id
        LEFT JOIN inventorylot dupe_lot ON dupe_lot.legacy_item_id = dupe.id
        WHERE repair.ref_type = 'PURCHASE'
          AND repair.reason = 'PURCHASE_DUPLICATE_REPAIR'
          AND repair.delta < 0
          AND COALESCE(dupe.stock, 0) = 0
          AND COALESCE(dupe.is_archived, 0) = 1
        ORDER BY repair.ref_id, repair.item_id, repair.id
        """,
    )

    out: list[dict] = []
    for row in rows:
        match = TARGET_RE.search(str(row.get("repair_note") or ""))
        if not match:
            continue
        row["target_item_id"] = int(match.group(1))
        if int(row.get("other_movement_count") or 0) != 0:
            continue
        if not row.get("duplicate_lot_id"):
            continue
        out.append(row)
    return out


def group_key(row: dict, qty: int) -> tuple:
    return (
        int(row["purchase_id"]),
        int(row["target_item_id"]),
        norm_text(row.get("product_name") or row.get("duplicate_name")),
        norm_text(row.get("brand") or row.get("duplicate_brand")),
        str(row.get("expiry_date") or row.get("duplicate_expiry_date") or ""),
        norm_money(row.get("mrp") or row.get("duplicate_mrp")),
        int(qty),
    )


def is_opening_purchase(row: dict, qty: int) -> bool:
    opening_date = str(row.get("target_opening_ts") or "")[:10]
    invoice_date = str(row.get("invoice_date") or "")[:10]
    if not opening_date or not invoice_date or opening_date < invoice_date:
        return False
    if int(row.get("target_opening_delta") or 0) != int(qty or 0):
        return False
    return int(row.get("target_pre_invoice_movement_count") or 0) == 0


def discover_pairs(conn: sqlite3.Connection) -> tuple[list[RepairPair], list[str]]:
    purchase_items_by_key: dict[tuple, list[dict]] = defaultdict(list)
    same_day_opening_keys: set[tuple] = set()
    for item in load_purchase_items(conn):
        qty = int(item["qty"] or 0)
        key = group_key(item, qty)
        if is_opening_purchase(item, qty):
            same_day_opening_keys.add(key)
            continue
        purchase_items_by_key[key].append(item)

    duplicates_by_key: dict[tuple, list[dict]] = defaultdict(list)
    for dupe in load_duplicate_repairs(conn):
        qty = int(dupe["purchase_delta"] or 0)
        key = group_key(dupe, qty)
        if key in same_day_opening_keys:
            continue
        duplicates_by_key[key].append(dupe)

    cur = conn.cursor()
    link_ids_by_target: dict[tuple[int, int], deque[int]] = defaultdict(deque)
    for purchase_id, target_item_id in sorted({(key[0], key[1]) for key in set(purchase_items_by_key) | set(duplicates_by_key)}):
        cur.execute(
            """
            SELECT id
            FROM stockmovement
            WHERE item_id = ?
              AND ref_type = 'PURCHASE'
              AND ref_id = ?
              AND reason = 'PURCHASE_LINK'
              AND COALESCE(delta, 0) = 0
            ORDER BY id
            """,
            (target_item_id, purchase_id),
        )
        link_ids_by_target[(purchase_id, target_item_id)] = deque(int(row[0]) for row in cur.fetchall())

    pairs: list[RepairPair] = []
    warnings: list[str] = []
    for key in sorted(set(purchase_items_by_key) | set(duplicates_by_key)):
        items = sorted(purchase_items_by_key.get(key, []), key=lambda row: int(row["purchase_item_id"]))
        dupes = sorted(duplicates_by_key.get(key, []), key=lambda row: int(row["purchase_movement_id"]))
        if len(items) != len(dupes):
            warnings.append(
                f"Skipped partial group purchase={key[0]} target_item={key[1]} qty={key[-1]} "
                f"purchase_items={len(items)} duplicate_repairs={len(dupes)}"
            )
            continue
        links = link_ids_by_target[(int(key[0]), int(key[1]))]
        for item, dupe in zip(items, dupes):
            link_id = links.popleft() if links else None
            pairs.append(RepairPair(item, dupe, link_id))

    return pairs, warnings


def write_csv(path: Path, pairs: list[RepairPair]) -> None:
    rows = [pair.report_row() for pair in pairs]
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def create_backup(db_path: Path, backup_dir: Path) -> Path:
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = backup_dir / f"{db_path.stem}.before_purchase_duplicate_stock_fix_{stamp}{db_path.suffix}"
    shutil.copy2(db_path, backup_path)
    return backup_path


def apply_pairs(conn: sqlite3.Connection, pairs: list[RepairPair], backup_path: Path | None) -> None:
    ts = now_ts()
    details = []
    cur = conn.cursor()
    cur.execute("BEGIN")
    try:
        for pair in pairs:
            item = pair.purchase_item
            dupe = pair.duplicate
            qty = pair.qty
            effective_cost = float(item.get("effective_cost_price") or item.get("cost_price") or 0)

            cur.execute(
                """
                UPDATE purchaseitem
                SET inventory_item_id = ?,
                    lot_id = ?,
                    stock_source = 'CREATED'
                WHERE id = ?
                  AND purchase_id = ?
                  AND inventory_item_id = ?
                  AND COALESCE(stock_source, 'CREATED') = 'ATTACHED'
                """,
                (
                    pair.duplicate_item_id,
                    int(dupe["duplicate_lot_id"]),
                    int(item["purchase_item_id"]),
                    pair.purchase_id,
                    pair.target_item_id,
                ),
            )
            if cur.rowcount != 1:
                raise RuntimeError(f"Purchase item #{item['purchase_item_id']} changed while repairing")

            cur.execute(
                """
                UPDATE item
                SET stock = ?,
                    is_archived = 0,
                    archived_at = NULL,
                    cost_price = ?,
                    product_id = COALESCE(product_id, ?),
                    updated_at = ?
                WHERE id = ?
                  AND COALESCE(stock, 0) = 0
                  AND COALESCE(is_archived, 0) = 1
                """,
                (qty, effective_cost, item.get("product_id"), ts, pair.duplicate_item_id),
            )
            if cur.rowcount != 1:
                raise RuntimeError(f"Duplicate item #{pair.duplicate_item_id} changed while repairing")

            cur.execute(
                """
                UPDATE inventorylot
                SET sealed_qty = ?,
                    loose_qty = 0,
                    is_active = 1,
                    cost_price = ?,
                    updated_at = ?
                WHERE id = ?
                  AND legacy_item_id = ?
                """,
                (qty, effective_cost, ts, int(dupe["duplicate_lot_id"]), pair.duplicate_item_id),
            )
            if cur.rowcount != 1:
                raise RuntimeError(f"Duplicate lot #{dupe['duplicate_lot_id']} changed while repairing")

            cur.execute(
                "DELETE FROM stockmovement WHERE id = ? AND reason = 'PURCHASE_DUPLICATE_REPAIR'",
                (int(dupe["repair_movement_id"]),),
            )
            if cur.rowcount != 1:
                raise RuntimeError(f"Repair movement #{dupe['repair_movement_id']} changed while repairing")

            if pair.link_id:
                cur.execute(
                    "DELETE FROM stockmovement WHERE id = ? AND reason = 'PURCHASE_LINK' AND COALESCE(delta, 0) = 0",
                    (pair.link_id,),
                )
                if cur.rowcount != 1:
                    raise RuntimeError(f"Purchase link movement #{pair.link_id} changed while repairing")

            details.append(pair.report_row())

        cur.execute(
            """
            INSERT INTO auditlog (event_ts, entity_type, entity_id, action, note, details_json, actor)
            VALUES (?, 'PURCHASE', NULL, 'DATA_REPAIR',
                    'Restored purchase-created batches hidden by duplicate-stock repair',
                    ?, 'repair_purchase_duplicate_stock.py')
            """,
            (
                ts,
                json.dumps(
                    {
                        "backup": str(backup_path) if backup_path else None,
                        "fixed_count": len(details),
                        "items": details,
                    },
                    separators=(",", ":"),
                ),
            ),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit/fix hidden purchase-created stock batches.")
    parser.add_argument("--db", default="medical_shop.db", help="SQLite DB path. Default: medical_shop.db")
    parser.add_argument("--apply", action="store_true", help="Apply repairs. Without this, preview only.")
    parser.add_argument("--csv", help="Write candidate report CSV to this path.")
    parser.add_argument("--backup-dir", default="backups", help="Backup folder used with --apply.")
    parser.add_argument("--no-backup", action="store_true", help="Do not create a DB backup before --apply.")
    args = parser.parse_args()

    db_path = Path(args.db).expanduser().resolve()
    if not db_path.exists():
        print(f"DB not found: {db_path}", file=sys.stderr)
        return 2

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        pairs, warnings = discover_pairs(conn)
        total_qty = sum(pair.qty for pair in pairs)
        purchase_count = len({pair.purchase_id for pair in pairs})
        print(f"Repairable rows: {len(pairs)}")
        print(f"Affected purchases: {purchase_count}")
        print(f"Hidden purchase quantity: {total_qty}")
        if warnings:
            print(f"Warnings: {len(warnings)}")
            for warning in warnings[:20]:
                print(f"  - {warning}")
            if len(warnings) > 20:
                print(f"  ... {len(warnings) - 20} more")

        if args.csv:
            csv_path = Path(args.csv).expanduser().resolve()
            write_csv(csv_path, pairs)
            print(f"CSV report: {csv_path}")

        for pair in pairs[:20]:
            row = pair.report_row()
            print(
                f"#{row['purchase_item_id']} purchase {row['invoice_number']} "
                f"{row['product_name']} qty {row['qty']}: target #{row['target_item_id']} "
                f"<- restore batch #{row['duplicate_item_id']}"
            )
        if len(pairs) > 20:
            print(f"... {len(pairs) - 20} more")

        if not args.apply:
            print("Preview only. Re-run with --apply to repair.")
            return 0

        if not pairs:
            print("Nothing to repair.")
            return 0

        backup_path = None
        if not args.no_backup:
            backup_path = create_backup(db_path, Path(args.backup_dir).expanduser().resolve())
            print(f"Backup created: {backup_path}")

        apply_pairs(conn, pairs, backup_path)
        print(f"Applied repairs: {len(pairs)}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
