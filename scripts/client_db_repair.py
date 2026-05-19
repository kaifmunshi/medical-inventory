#!/usr/bin/env python3
"""
Client DB repair utility for two narrow production data issues.

Default mode is read-only. Use --apply to write changes. In apply mode the
script creates a SQLite backup before touching the database.

Repairs covered:
1. Loose-stock conversion corrections after a product's conversion quantity was
   fixed later. This syncs lot/item conversion and loose prices, then appends a
   stock movement if old pack-open events created too few loose units.
2. Bill totals wrongly left at zero after credit returns. This recalculates the
   current bill total from bill lines minus credit returns and syncs the bill's
   sales voucher when voucher tables exist.
"""

from __future__ import annotations

import argparse
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, Sequence


EPSILON = 0.005
LOOSE_REPAIR_REASON = "LOOSE_CONVERSION_REPAIR"
LOOSE_REPAIR_REF_TYPE = "PACK_OPEN_REPAIR"


def now_ts() -> str:
    return datetime.now().isoformat(timespec="seconds")


def round2(value: object) -> float:
    return float(f"{float(value or 0):.2f}")


def norm_text(value: object) -> str:
    return " ".join(str(value or "").strip().split())


def row_dicts(cursor: sqlite3.Cursor, sql: str, params: Iterable[object] = ()) -> list[dict]:
    cursor.execute(sql, tuple(params))
    return [dict(row) for row in cursor.fetchall()]


def one_value(cursor: sqlite3.Cursor, sql: str, params: Iterable[object] = (), default=None):
    cursor.execute(sql, tuple(params))
    row = cursor.fetchone()
    return row[0] if row else default


def table_exists(cursor: sqlite3.Cursor, name: str) -> bool:
    return bool(
        one_value(
            cursor,
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (name,),
            False,
        )
    )


def table_columns(cursor: sqlite3.Cursor, name: str) -> set[str]:
    if not table_exists(cursor, name):
        return set()
    return {str(row[1]) for row in cursor.execute(f"PRAGMA table_info({name})").fetchall()}


def sql_placeholders(values: Sequence[object]) -> str:
    return ",".join("?" for _ in values)


def backup_database(db_path: Path, backup_dir: Path) -> Path:
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    suffix = db_path.suffix or ".db"
    backup_path = backup_dir / f"{db_path.stem}.before_client_repair_{stamp}{suffix}"
    counter = 2
    while backup_path.exists():
        backup_path = backup_dir / f"{db_path.stem}.before_client_repair_{stamp}_{counter}{suffix}"
        counter += 1
    with sqlite3.connect(str(db_path)) as src, sqlite3.connect(str(backup_path)) as dst:
        src.backup(dst)
    return backup_path


@dataclass
class RepairStats:
    loose_syncs: int = 0
    loose_stock_repairs: int = 0
    bill_total_repairs: int = 0
    voucher_syncs: int = 0
    warnings: int = 0


class ClientRepair:
    def __init__(
        self,
        conn: sqlite3.Connection,
        *,
        apply: bool,
        product_ids: set[int],
        bill_ids: set[int],
        fix_all_bill_mismatches: bool,
    ) -> None:
        self.conn = conn
        self.cur = conn.cursor()
        self.apply = apply
        self.product_ids = product_ids
        self.bill_ids = bill_ids
        self.fix_all_bill_mismatches = fix_all_bill_mismatches
        self.stats = RepairStats()

    def log(self, message: str) -> None:
        print(message)

    def warn(self, message: str) -> None:
        self.stats.warnings += 1
        print(f"WARNING: {message}")

    def run(self) -> RepairStats:
        self.require_tables()
        self.sync_loose_conversions()
        self.repair_loose_pack_open_stock()
        self.repair_credit_return_bill_totals()
        return self.stats

    def require_tables(self) -> None:
        required = ["product", "inventorylot", "item", "bill", "billitem", "return", "returnitem"]
        missing = [name for name in required if not table_exists(self.cur, name)]
        if missing:
            raise RuntimeError(f"Database is missing required tables: {', '.join(missing)}")

    def product_filter_sql(self, alias: str = "p") -> tuple[str, list[int]]:
        if not self.product_ids:
            return "", []
        return f" AND {alias}.id IN ({sql_placeholders(sorted(self.product_ids))})", sorted(self.product_ids)

    def bill_filter_sql(self, alias: str = "b") -> tuple[str, list[int]]:
        if not self.bill_ids:
            return "", []
        return f" AND {alias}.id IN ({sql_placeholders(sorted(self.bill_ids))})", sorted(self.bill_ids)

    def sync_loose_conversions(self) -> None:
        product_filter, params = self.product_filter_sql("p")
        rows = row_dicts(
            self.cur,
            f"""
            SELECT
                p.id AS product_id,
                p.name AS product_name,
                p.brand AS product_brand,
                p.category_id AS product_category_id,
                p.default_conversion_qty AS conversion_qty,
                sl.id AS source_lot_id,
                sl.mrp AS source_mrp,
                sl.cost_price AS source_cost_price,
                sl.conversion_qty AS source_conversion_qty,
                ll.id AS loose_lot_id,
                ll.mrp AS loose_lot_mrp,
                ll.cost_price AS loose_lot_cost_price,
                ll.conversion_qty AS loose_lot_conversion_qty,
                ll.legacy_item_id AS loose_item_id,
                li.mrp AS loose_item_mrp,
                li.cost_price AS loose_item_cost_price,
                li.name AS loose_item_name,
                li.brand AS loose_item_brand,
                li.category_id AS loose_item_category_id
            FROM product p
            JOIN inventorylot sl
              ON sl.product_id = p.id
             AND sl.opened_from_lot_id IS NULL
             AND COALESCE(sl.is_active, 1) = 1
            LEFT JOIN inventorylot ll
              ON ll.opened_from_lot_id = sl.id
             AND COALESCE(ll.is_active, 1) = 1
            LEFT JOIN item li ON li.id = ll.legacy_item_id
            WHERE COALESCE(p.is_active, 1) = 1
              AND COALESCE(p.loose_sale_enabled, 0) = 1
              AND COALESCE(p.default_conversion_qty, 0) > 0
              {product_filter}
            ORDER BY p.id, sl.id, ll.id
            """,
            params,
        )

        ts = now_ts()
        for row in rows:
            conversion = int(row["conversion_qty"] or 0)
            if conversion <= 0:
                continue
            source_lot_id = int(row["source_lot_id"])
            expected_mrp = round2(float(row["source_mrp"] or 0) / conversion)
            expected_cost = (
                round2(float(row["source_cost_price"] or 0) / conversion)
                if row["source_cost_price"] is not None
                else None
            )

            source_updates: list[str] = []
            if int(row["source_conversion_qty"] or 0) != conversion:
                source_updates.append("conversion_qty = ?")
            if source_updates:
                self.log(
                    f"[loose-sync] Product #{row['product_id']} {row['product_name']}: "
                    f"source lot #{source_lot_id} conversion {row['source_conversion_qty']} -> {conversion}"
                )
                self.stats.loose_syncs += 1
                if self.apply:
                    self.cur.execute(
                        "UPDATE inventorylot SET conversion_qty = ?, updated_at = ? WHERE id = ?",
                        (conversion, ts, source_lot_id),
                    )

            loose_lot_id = row["loose_lot_id"]
            if not loose_lot_id:
                continue

            lot_changes: list[str] = []
            if int(row["loose_lot_conversion_qty"] or 0) != conversion:
                lot_changes.append(f"conversion {row['loose_lot_conversion_qty']} -> {conversion}")
            if abs(float(row["loose_lot_mrp"] or 0) - expected_mrp) > EPSILON:
                lot_changes.append(f"MRP {row['loose_lot_mrp']} -> {expected_mrp}")
            if expected_cost is not None and abs(float(row["loose_lot_cost_price"] or 0) - expected_cost) > EPSILON:
                lot_changes.append(f"cost {row['loose_lot_cost_price']} -> {expected_cost}")
            if lot_changes:
                self.log(
                    f"[loose-sync] Product #{row['product_id']} {row['product_name']}: "
                    f"loose lot #{loose_lot_id} " + ", ".join(lot_changes)
                )
                self.stats.loose_syncs += 1
                if self.apply:
                    self.cur.execute(
                        """
                        UPDATE inventorylot
                        SET conversion_qty = ?, mrp = ?, cost_price = ?, updated_at = ?
                        WHERE id = ?
                        """,
                        (conversion, expected_mrp, expected_cost, ts, int(loose_lot_id)),
                    )

            loose_item_id = row["loose_item_id"]
            if not loose_item_id:
                continue
            item_changes: list[str] = []
            if abs(float(row["loose_item_mrp"] or 0) - expected_mrp) > EPSILON:
                item_changes.append(f"MRP {row['loose_item_mrp']} -> {expected_mrp}")
            if expected_cost is not None and abs(float(row["loose_item_cost_price"] or 0) - expected_cost) > EPSILON:
                item_changes.append(f"cost {row['loose_item_cost_price']} -> {expected_cost}")
            if norm_text(row["loose_item_name"]) != norm_text(row["product_name"]):
                item_changes.append("name sync")
            if norm_text(row["loose_item_brand"]) != norm_text(row["product_brand"]):
                item_changes.append("brand sync")
            if (row["loose_item_category_id"] or None) != (row["product_category_id"] or None):
                item_changes.append("category sync")
            if item_changes:
                self.log(
                    f"[loose-sync] Product #{row['product_id']} {row['product_name']}: "
                    f"loose item #{loose_item_id} " + ", ".join(item_changes)
                )
                self.stats.loose_syncs += 1
                if self.apply:
                    self.cur.execute(
                        """
                        UPDATE item
                        SET name = ?, brand = ?, category_id = ?, mrp = ?, cost_price = ?, updated_at = ?
                        WHERE id = ?
                        """,
                        (
                            row["product_name"],
                            row["product_brand"],
                            row["product_category_id"],
                            expected_mrp,
                            float(expected_cost or 0),
                            ts,
                            int(loose_item_id),
                        ),
                    )

    def repair_loose_pack_open_stock(self) -> None:
        if not table_exists(self.cur, "packopenevent") or not table_exists(self.cur, "stockmovement"):
            self.warn("packopenevent or stockmovement table missing; skipping loose stock quantity repair")
            return

        product_filter, params = self.product_filter_sql("p")
        rows = row_dicts(
            self.cur,
            f"""
            SELECT
                p.id AS product_id,
                p.name AS product_name,
                p.default_conversion_qty AS conversion_qty,
                e.source_lot_id,
                e.loose_lot_id,
                ll.legacy_item_id AS loose_item_id,
                COALESCE(SUM(e.packs_opened), 0) AS packs_net,
                COALESCE(SUM(e.loose_units_created), 0) AS units_net,
                COALESCE(li.stock, 0) AS loose_stock,
                COALESCE(ll.loose_qty, 0) AS loose_qty
            FROM packopenevent e
            JOIN inventorylot sl ON sl.id = e.source_lot_id
            JOIN product p ON p.id = sl.product_id
            JOIN inventorylot ll ON ll.id = e.loose_lot_id
            LEFT JOIN item li ON li.id = ll.legacy_item_id
            WHERE COALESCE(p.is_active, 1) = 1
              AND COALESCE(p.loose_sale_enabled, 0) = 1
              AND COALESCE(p.default_conversion_qty, 0) > 0
              {product_filter}
            GROUP BY p.id, e.source_lot_id, e.loose_lot_id
            ORDER BY p.id, e.source_lot_id, e.loose_lot_id
            """,
            params,
        )

        movement_cols = table_columns(self.cur, "stockmovement")
        ts = now_ts()
        for row in rows:
            conversion = int(row["conversion_qty"] or 0)
            loose_item_id = row["loose_item_id"]
            if conversion <= 0 or not loose_item_id:
                continue

            recorded_net = int(row["units_net"] or 0)
            expected_net = int(row["packs_net"] or 0) * conversion
            if recorded_net == expected_net:
                continue

            existing_repair = int(
                one_value(
                    self.cur,
                    """
                    SELECT COALESCE(SUM(delta), 0)
                    FROM stockmovement
                    WHERE item_id = ?
                      AND reason = ?
                      AND ref_type = ?
                      AND ref_id = ?
                    """,
                    (int(loose_item_id), LOOSE_REPAIR_REASON, LOOSE_REPAIR_REF_TYPE, int(row["loose_lot_id"])),
                    0,
                )
                or 0
            )
            delta = expected_net - recorded_net - existing_repair
            if delta == 0:
                continue

            current_stock = int(row["loose_stock"] or 0)
            current_lot_qty = int(row["loose_qty"] or 0)
            if current_stock + delta < 0 or current_lot_qty + delta < 0:
                self.warn(
                    f"Skipping product #{row['product_id']} loose lot #{row['loose_lot_id']}: "
                    f"repair delta {delta} would make stock negative"
                )
                continue

            self.log(
                f"[loose-stock] Product #{row['product_id']} {row['product_name']}: "
                f"pack open net says {recorded_net}, conversion expects {expected_net}; "
                f"loose item #{loose_item_id} stock {current_stock} -> {current_stock + delta}"
            )
            self.stats.loose_stock_repairs += 1
            if self.apply:
                self.cur.execute(
                    "UPDATE item SET stock = ?, updated_at = ? WHERE id = ?",
                    (current_stock + delta, ts, int(loose_item_id)),
                )
                self.cur.execute(
                    "UPDATE inventorylot SET loose_qty = ?, updated_at = ? WHERE id = ?",
                    (current_lot_qty + delta, ts, int(row["loose_lot_id"])),
                )
                cols = ["item_id", "ts", "delta", "reason", "ref_type", "ref_id", "note"]
                vals: list[object] = [
                    int(loose_item_id),
                    ts,
                    delta,
                    LOOSE_REPAIR_REASON,
                    LOOSE_REPAIR_REF_TYPE,
                    int(row["loose_lot_id"]),
                    (
                        f"Repair loose conversion for product #{row['product_id']} "
                        f"source lot #{row['source_lot_id']}: recorded {recorded_net}, expected {expected_net}"
                    ),
                ]
                if "actor" in movement_cols:
                    cols.append("actor")
                    vals.append("client_repair")
                self.cur.execute(
                    f"INSERT INTO stockmovement ({','.join(cols)}) VALUES ({sql_placeholders(vals)})",
                    vals,
                )

    def repair_credit_return_bill_totals(self) -> None:
        exchange_exists = table_exists(self.cur, "exchangerecord")
        bill_filter, params = self.bill_filter_sql("b")
        exchange_clause = (
            """
            AND NOT EXISTS (
                SELECT 1
                FROM exchangerecord ex
                WHERE ex.return_id = r.id
                  AND ex.source_bill_id = b.id
            )
            """
            if exchange_exists
            else ""
        )
        rows = row_dicts(
            self.cur,
            f"""
            SELECT
                b.id,
                b.date_time,
                b.subtotal,
                b.total_amount,
                b.payment_mode,
                b.payment_cash,
                b.payment_online,
                b.paid_amount,
                b.writeoff_amount,
                b.payment_status,
                b.is_credit,
                b.paid_at,
                b.customer_id,
                b.party_id,
                b.notes,
                COALESCE((
                    SELECT SUM(bi.line_total)
                    FROM billitem bi
                    WHERE bi.bill_id = b.id
                ), 0) AS line_base_total,
                COALESCE((
                    SELECT SUM(r.subtotal_return)
                    FROM "return" r
                    WHERE r.source_bill_id = b.id
                      AND COALESCE(r.refund_cash, 0) = 0
                      AND COALESCE(r.refund_online, 0) = 0
                      {exchange_clause}
                ), 0) AS credit_return_total
            FROM bill b
            WHERE COALESCE(b.is_deleted, 0) = 0
              {bill_filter}
            ORDER BY b.id
            """,
            params,
        )

        for row in rows:
            credit_total = round2(row["credit_return_total"])
            if credit_total <= EPSILON:
                continue

            line_base = round2(row["line_base_total"])
            if line_base <= EPSILON:
                line_base = round2(row["subtotal"])
            if line_base <= EPSILON:
                continue

            expected_total = round2(max(0.0, line_base - credit_total))
            current_total = round2(row["total_amount"])
            if abs(expected_total - current_total) <= EPSILON:
                continue

            auto_safe_zero_case = current_total <= EPSILON and expected_total > EPSILON
            should_apply = bool(self.bill_ids) or self.fix_all_bill_mismatches or auto_safe_zero_case
            marker = "repair" if should_apply else "review-only"
            self.log(
                f"[bill-return/{marker}] Bill #{row['id']}: line base {line_base}, "
                f"credit returns {credit_total}, current total {current_total}, expected {expected_total}"
            )
            if not should_apply:
                continue

            paid_cover = round2(float(row["paid_amount"] or 0) + float(row["writeoff_amount"] or 0))
            if expected_total <= EPSILON or paid_cover >= expected_total - EPSILON:
                payment_status = "PAID"
                is_credit = 0
                paid_at = row["paid_at"]
            elif paid_cover > EPSILON:
                payment_status = "PARTIAL"
                is_credit = 1
                paid_at = None
            else:
                payment_status = "UNPAID"
                is_credit = 1
                paid_at = None

            self.stats.bill_total_repairs += 1
            if self.apply:
                self.cur.execute(
                    """
                    UPDATE bill
                    SET total_amount = ?,
                        payment_status = ?,
                        is_credit = ?,
                        paid_at = ?
                    WHERE id = ?
                    """,
                    (expected_total, payment_status, is_credit, paid_at, int(row["id"])),
                )
                updated = dict(row)
                updated["total_amount"] = expected_total
                updated["payment_status"] = payment_status
                updated["is_credit"] = is_credit
                updated["paid_at"] = paid_at
                self.sync_sales_voucher(updated)

    def get_or_create_party_ledger(self, party_id: int) -> int | None:
        ledger_id = one_value(self.cur, "SELECT id FROM ledger WHERE party_id = ? LIMIT 1", (party_id,))
        if ledger_id:
            return int(ledger_id)
        party = self.cur.execute(
            "SELECT id, name, party_group FROM party WHERE id = ? LIMIT 1",
            (party_id,),
        ).fetchone()
        if not party:
            return None
        group_key = "SUNDRY_CREDITORS" if str(party["party_group"] or "").upper() == "SUNDRY_CREDITOR" else "SUNDRY_DEBTORS"
        group_id = one_value(self.cur, "SELECT id FROM ledgergroup WHERE system_key = ? LIMIT 1", (group_key,))
        if not group_id:
            return None
        ts = now_ts()
        self.cur.execute(
            """
            INSERT INTO ledger (name, group_id, party_id, system_key, is_system, is_active, created_at, updated_at)
            VALUES (?, ?, ?, NULL, 0, 1, ?, ?)
            """,
            (str(party["name"] or f"Party {party_id}").strip(), int(group_id), party_id, ts, ts),
        )
        return int(self.cur.lastrowid)

    def sales_receivable_ledger_id(self, bill: dict) -> int | None:
        if not table_exists(self.cur, "ledger"):
            return None
        party_id = int(bill["party_id"] or 0)
        if party_id > 0:
            ledger_id = self.get_or_create_party_ledger(party_id)
            if ledger_id:
                return ledger_id

        customer_id = int(bill["customer_id"] or 0)
        if customer_id > 0 and table_exists(self.cur, "party"):
            party_id = one_value(
                self.cur,
                """
                SELECT id
                FROM party
                WHERE party_group = 'SUNDRY_DEBTOR'
                  AND legacy_customer_id = ?
                LIMIT 1
                """,
                (customer_id,),
            )
            if party_id:
                ledger_id = self.get_or_create_party_ledger(int(party_id))
                if ledger_id:
                    return ledger_id

        notes = str(bill["notes"] or "").strip()
        if notes.lower().startswith("customer:") and table_exists(self.cur, "party"):
            first_line = notes.split("|", 1)[0].splitlines()[0] if notes.splitlines() else ""
            customer_name = first_line.split(":", 1)[1].strip() if ":" in first_line else ""
            if customer_name:
                party_id = one_value(
                    self.cur,
                    """
                    SELECT id
                    FROM party
                    WHERE party_group = 'SUNDRY_DEBTOR'
                      AND lower(trim(coalesce(name, ''))) = lower(trim(?))
                    LIMIT 1
                    """,
                    (customer_name,),
                )
                if party_id:
                    ledger_id = self.get_or_create_party_ledger(int(party_id))
                    if ledger_id:
                        return ledger_id

        return one_value(
            self.cur,
            "SELECT id FROM ledger WHERE system_key = 'SALES_RECEIVABLE_CONTROL' LIMIT 1",
            (),
        )

    def system_ledger_id(self, key: str) -> int | None:
        if not table_exists(self.cur, "ledger"):
            return None
        ledger_id = one_value(self.cur, "SELECT id FROM ledger WHERE system_key = ? LIMIT 1", (key,))
        return int(ledger_id) if ledger_id else None

    def sync_sales_voucher(self, bill: dict) -> None:
        if not table_exists(self.cur, "voucher") or not table_exists(self.cur, "voucherentry"):
            return

        cash_ledger = self.system_ledger_id("CASH_IN_HAND")
        bank_ledger = self.system_ledger_id("BANK_ACCOUNT")
        sales_ledger = self.system_ledger_id("SALES_ACCOUNT")
        receivable_ledger = self.sales_receivable_ledger_id(bill)
        if not sales_ledger:
            self.warn(f"Bill #{bill['id']}: sales ledger missing; voucher not synced")
            return

        payments = row_dicts(
            self.cur,
            """
            SELECT *
            FROM billpayment
            WHERE bill_id = ?
              AND COALESCE(is_deleted, 0) = 0
            """,
            (int(bill["id"]),),
        ) if table_exists(self.cur, "billpayment") else []
        auto_payments = [
            payment
            for payment in payments
            if str(payment.get("note") or "").strip().lower() == "auto: payment at bill creation"
        ]
        if auto_payments:
            cash = round2(sum(float(payment.get("cash_amount") or 0) for payment in auto_payments))
            online = round2(sum(float(payment.get("online_amount") or 0) for payment in auto_payments))
        elif payments:
            cash = 0.0
            online = 0.0
        else:
            cash = round2(bill["payment_cash"])
            online = round2(bill["payment_online"])

        total = round2(bill["total_amount"])
        posting_cash = round2(min(cash, total))
        posting_online = round2(min(online, max(0.0, total - posting_cash)))
        outstanding = round2(max(0.0, total - posting_cash - posting_online))

        lines: list[tuple[int, str, float, str]] = []
        if posting_cash > EPSILON and cash_ledger:
            lines.append((int(cash_ledger), "DR", posting_cash, "Cash sale"))
        if posting_online > EPSILON and bank_ledger:
            lines.append((int(bank_ledger), "DR", posting_online, "Online sale"))
        if outstanding > EPSILON:
            if not receivable_ledger:
                self.warn(f"Bill #{bill['id']}: receivable ledger missing; voucher not synced")
                return
            lines.append((int(receivable_ledger), "DR", outstanding, "Customer receivable"))
        lines.append((int(sales_ledger), "CR", total, "Sales"))

        ts = now_ts()
        voucher_id = one_value(
            self.cur,
            "SELECT id FROM voucher WHERE source_type = 'BILL' AND source_id = ? LIMIT 1",
            (int(bill["id"]),),
        )
        voucher_date = str(bill["date_time"] or "")[:10]
        narration = bill["notes"] or f"Sales bill #{bill['id']}"
        if voucher_id:
            self.cur.execute(
                """
                UPDATE voucher
                SET voucher_type = 'SALES',
                    voucher_no = ?,
                    voucher_date = ?,
                    narration = ?,
                    total_amount = ?,
                    is_deleted = 0,
                    deleted_at = NULL,
                    updated_at = ?
                WHERE id = ?
                """,
                (f"S-{bill['id']}", voucher_date, narration, total, ts, int(voucher_id)),
            )
            self.cur.execute("DELETE FROM voucherentry WHERE voucher_id = ?", (int(voucher_id),))
        else:
            self.cur.execute(
                """
                INSERT INTO voucher
                    (voucher_type, source_type, source_id, voucher_no, voucher_date, narration,
                     total_amount, is_deleted, deleted_at, created_at, updated_at)
                VALUES ('SALES', 'BILL', ?, ?, ?, ?, ?, 0, NULL, ?, ?)
                """,
                (int(bill["id"]), f"S-{bill['id']}", voucher_date, narration, total, ts, ts),
            )
            voucher_id = int(self.cur.lastrowid)

        for idx, (ledger_id, entry_type, amount, narration_line) in enumerate(lines, start=1):
            self.cur.execute(
                """
                INSERT INTO voucherentry
                    (voucher_id, ledger_id, entry_type, amount, narration, sort_order, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (int(voucher_id), ledger_id, entry_type, amount, narration_line, idx, ts),
            )
        self.stats.voucher_syncs += 1
        self.log(f"[voucher] Bill #{bill['id']}: sales voucher synced to {total}")


def parse_ids(values: list[str]) -> set[int]:
    out: set[int] = set()
    for value in values:
        for part in str(value).split(","):
            part = part.strip()
            if not part:
                continue
            out.add(int(part))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit or repair narrow client DB data issues.")
    parser.add_argument("--db", default="medical_shop.db", help="Path to medical_shop.db")
    parser.add_argument("--apply", action="store_true", help="Apply repairs. Without this, the script only previews.")
    parser.add_argument("--backup-dir", default="backups", help="Backup directory used with --apply")
    parser.add_argument("--product-id", action="append", default=[], help="Limit loose-stock repairs to product id(s). Can repeat or comma-separate.")
    parser.add_argument("--bill-id", action="append", default=[], help="Limit bill-return repairs to bill id(s). Can repeat or comma-separate.")
    parser.add_argument(
        "--fix-all-bill-return-mismatches",
        action="store_true",
        help="Also repair non-zero bill total mismatches. By default only zero-total crashes, or explicit --bill-id, are repaired.",
    )
    args = parser.parse_args()

    db_path = Path(args.db).expanduser().resolve()
    if not db_path.exists():
        raise SystemExit(f"DB not found: {db_path}")

    print(f"DB: {db_path}")
    print("Mode: APPLY" if args.apply else "Mode: dry-run preview")
    backup_path = None
    if args.apply:
        backup_path = backup_database(db_path, Path(args.backup_dir).expanduser().resolve())
        print(f"Backup: {backup_path}")

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        integrity = one_value(conn.cursor(), "PRAGMA integrity_check", (), "unknown")
        if integrity != "ok":
            raise RuntimeError(f"SQLite integrity_check failed: {integrity}")

        repair = ClientRepair(
            conn,
            apply=bool(args.apply),
            product_ids=parse_ids(args.product_id),
            bill_ids=parse_ids(args.bill_id),
            fix_all_bill_mismatches=bool(args.fix_all_bill_return_mismatches),
        )
        stats = repair.run()
        if args.apply:
            conn.commit()
        else:
            conn.rollback()
        print(
            "Summary: "
            f"loose_syncs={stats.loose_syncs}, "
            f"loose_stock_repairs={stats.loose_stock_repairs}, "
            f"bill_total_repairs={stats.bill_total_repairs}, "
            f"voucher_syncs={stats.voucher_syncs}, "
            f"warnings={stats.warnings}"
        )
        if not args.apply:
            print("No changes written. Re-run with --apply after reviewing the preview.")
    except Exception:
        conn.rollback()
        if backup_path:
            print(f"Backup remains available at: {backup_path}")
        raise
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
