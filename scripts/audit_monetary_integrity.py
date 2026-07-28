#!/usr/bin/env python3
"""Audit monetary invariants without normalizing intentional saved allocations.

Dry-run is the default. ``--apply`` repairs only deterministic header aggregates,
after making a timestamped database backup. Bill selling prices/discounts and
line-level allocation differences are report-only because their original intent
cannot safely be inferred from arithmetic alone.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path


def money(value: object) -> float:
    return round(float(value or 0), 2)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="medical_shop.db")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()

    db_path = Path(args.db).resolve()
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    findings: dict[str, list[dict[str, object]]] = {
        "purchase_header_mismatch": [],
        "purchase_roundoff_target_drift": [],
        "purchase_subtotal_mismatch": [],
        "purchase_line_allocations_preserved": [],
        "purchase_return_header_mismatch": [],
        "sales_return_allocations_preserved": [],
        "exchange_net_mismatch": [],
        "edited_bills_without_audit_snapshot": [],
    }

    for row in conn.execute(
        """
        SELECT id, invoice_number, subtotal_amount, discount_amount, gst_amount,
               rounding_adjustment, total_amount
        FROM purchase WHERE is_deleted = 0
        """
    ):
        expected = money(
            row["subtotal_amount"] - row["discount_amount"]
            + row["gst_amount"] + row["rounding_adjustment"]
        )
        if money(row["total_amount"]) != expected:
            findings["purchase_header_mismatch"].append({
                "id": row["id"], "invoice_number": row["invoice_number"],
                "saved": money(row["total_amount"]), "expected": expected,
            })

    for row in conn.execute(
        """
        SELECT id, invoice_number, total_amount, rounding_adjustment
        FROM purchase
        WHERE is_deleted = 0
          AND ABS(rounding_adjustment) >= 0.005
          AND ABS(total_amount - ROUND(total_amount, 0)) BETWEEN 0.004 AND 0.011
        """
    ):
        target = round(float(row["total_amount"] or 0))
        findings["purchase_roundoff_target_drift"].append({
            "id": row["id"],
            "invoice_number": row["invoice_number"],
            "saved": money(row["total_amount"]),
            "expected": float(target),
            "saved_rounding": money(row["rounding_adjustment"]),
            "expected_rounding": money(
                row["rounding_adjustment"] + target - row["total_amount"]
            ),
        })

    for row in conn.execute(
        """
        SELECT p.id, p.invoice_number, p.subtotal_amount,
               ROUND(COALESCE(SUM(pi.line_total), 0), 2) AS expected
        FROM purchase p LEFT JOIN purchaseitem pi ON pi.purchase_id = p.id
        WHERE p.is_deleted = 0 GROUP BY p.id
        HAVING ABS(p.subtotal_amount - expected) > 0.004
        """
    ):
        findings["purchase_subtotal_mismatch"].append(dict(row))

    for row in conn.execute(
        """
        SELECT id, purchase_id, product_name, line_total,
               ROUND(sealed_qty * cost_price - discount_amount + rounding_adjustment, 2) AS arithmetic
        FROM purchaseitem
        WHERE ABS(line_total - ROUND(sealed_qty * cost_price - discount_amount + rounding_adjustment, 2)) > 0.004
        """
    ):
        findings["purchase_line_allocations_preserved"].append(dict(row))

    for row in conn.execute(
        """
        SELECT id, return_number, taxable_amount, gst_amount, rounding_adjustment,
               total_amount,
               ROUND(taxable_amount + gst_amount + rounding_adjustment, 2) AS expected
        FROM purchasereturn WHERE is_deleted = 0
          AND ABS(total_amount - ROUND(taxable_amount + gst_amount + rounding_adjustment, 2)) > 0.004
        """
    ):
        findings["purchase_return_header_mismatch"].append(dict(row))

    for row in conn.execute(
        """
        SELECT r.id, r.subtotal_return, ROUND(COALESCE(SUM(ri.line_total), 0), 2) AS line_sum
        FROM return r LEFT JOIN returnitem ri ON ri.return_id = r.id
        GROUP BY r.id HAVING ABS(r.subtotal_return - line_sum) > 0.004
        """
    ):
        findings["sales_return_allocations_preserved"].append(dict(row))

    for row in conn.execute(
        """
        SELECT id, theoretical_net, rounding_adjustment, net_due,
               ROUND(theoretical_net + rounding_adjustment, 2) AS expected
        FROM exchangerecord
        WHERE ABS(net_due - ROUND(theoretical_net + rounding_adjustment, 2)) > 0.004
        """
    ):
        findings["exchange_net_mismatch"].append(dict(row))

    for row in conn.execute(
        """
        SELECT DISTINCT sm.ref_id AS bill_id
        FROM stockmovement sm
        WHERE sm.ref_type = 'BILL' AND sm.reason = 'BILL_EDIT'
          AND NOT EXISTS (
            SELECT 1 FROM auditlog a
            WHERE a.entity_type = 'BILL' AND a.entity_id = sm.ref_id
              AND a.action = 'UPDATE'
          )
        ORDER BY sm.ref_id
        """
    ):
        findings["edited_bills_without_audit_snapshot"].append(dict(row))

    repaired: list[dict[str, object]] = []
    backup_path: Path | None = None
    if args.apply:
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = db_path.with_name(f"{db_path.stem}.before_monetary_integrity_{stamp}.db")
        shutil.copy2(db_path, backup_path)
        with conn:
            for entry in findings["purchase_subtotal_mismatch"]:
                conn.execute(
                    "UPDATE purchase SET subtotal_amount = ? WHERE id = ?",
                    (entry["expected"], entry["id"]),
                )
                repaired.append({"table": "purchase", "field": "subtotal_amount", **entry})
            # Recalculate all deterministic purchase headers after subtotal
            # repairs so totals cannot be based on a stale aggregate.
            affected_purchase_ids = {
                int(entry["id"]) for entry in findings["purchase_header_mismatch"]
            } | {
                int(entry["id"]) for entry in findings["purchase_subtotal_mismatch"]
            }
            for purchase_id in sorted(affected_purchase_ids):
                conn.execute(
                    """
                    UPDATE purchase
                    SET total_amount = ROUND(
                        subtotal_amount - discount_amount + gst_amount + rounding_adjustment,
                        2
                    )
                    WHERE id = ?
                    """,
                    (purchase_id,),
                )
                repaired.append({"table": "purchase", "field": "total_amount", "id": purchase_id})
            for entry in findings["purchase_roundoff_target_drift"]:
                conn.execute(
                    """
                    UPDATE purchase
                    SET total_amount = ?, rounding_adjustment = ?
                    WHERE id = ?
                    """,
                    (entry["expected"], entry["expected_rounding"], entry["id"]),
                )
                repaired.append({"table": "purchase", "field": "roundoff", **entry})
            for entry in findings["purchase_return_header_mismatch"]:
                conn.execute(
                    "UPDATE purchasereturn SET total_amount = ? WHERE id = ?",
                    (entry["expected"], entry["id"]),
                )
                repaired.append({"table": "purchasereturn", **entry})
            for entry in findings["exchange_net_mismatch"]:
                conn.execute(
                    "UPDATE exchangerecord SET net_due = ? WHERE id = ?",
                    (entry["expected"], entry["id"]),
                )
                repaired.append({"table": "exchangerecord", **entry})
            if repaired:
                conn.execute(
                    """
                    INSERT INTO auditlog
                    (event_ts, entity_type, entity_id, action, note, details_json, actor)
                    VALUES (?, 'SYSTEM', NULL, 'MONETARY_INTEGRITY_REPAIR', ?, ?, 'SYSTEM')
                    """,
                    (
                        datetime.now().isoformat(timespec="seconds"),
                        f"Repaired {len(repaired)} deterministic monetary aggregate(s)",
                        json.dumps({"backup": str(backup_path), "repairs": repaired}, sort_keys=True),
                    ),
                )

    result = {
        "database": str(db_path),
        "mode": "apply" if args.apply else "dry-run",
        "backup": str(backup_path) if backup_path else None,
        "findings": findings,
        "repaired": repaired,
    }
    if args.as_json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(f"Database: {db_path}")
        print(f"Mode: {'APPLY' if args.apply else 'DRY RUN'}")
        for name, rows in findings.items():
            print(f"{name}: {len(rows)}")
        if backup_path:
            print(f"Backup: {backup_path}")
        print(f"Repaired: {len(repaired)}")
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
