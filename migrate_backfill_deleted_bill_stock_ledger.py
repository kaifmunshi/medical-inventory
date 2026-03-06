import argparse
import sqlite3
from datetime import datetime
from pathlib import Path


def now_ts() -> str:
    return datetime.now().isoformat(timespec="seconds")


def run(db_path: Path, apply: bool) -> int:
    if not db_path.exists():
        print(f"DB file not found: {db_path.resolve()}")
        return 1

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    cur.execute("SELECT id FROM bill WHERE is_deleted = 1 ORDER BY id")
    deleted_bills = [int(r["id"]) for r in cur.fetchall()]

    print(f"Deleted bills found: {len(deleted_bills)}")

    bills_to_fix = 0
    movements_to_add = 0
    total_stock_restore = 0
    skipped_already_fixed = 0
    skipped_no_items = 0
    skipped_missing_items = 0

    ts = now_ts()

    for bill_id in deleted_bills:
        cur.execute(
            """
            SELECT 1
            FROM stockmovement
            WHERE ref_type = 'BILL' AND ref_id = ? AND reason = 'BILL_DELETE'
            LIMIT 1
            """,
            (bill_id,),
        )
        if cur.fetchone():
            skipped_already_fixed += 1
            continue

        cur.execute(
            """
            SELECT item_id, SUM(quantity) AS qty
            FROM billitem
            WHERE bill_id = ?
            GROUP BY item_id
            HAVING SUM(quantity) > 0
            """,
            (bill_id,),
        )
        lines = [(int(r["item_id"]), int(r["qty"])) for r in cur.fetchall()]
        if not lines:
            skipped_no_items += 1
            continue

        missing = []
        for item_id, _qty in lines:
            cur.execute("SELECT id FROM item WHERE id = ?", (item_id,))
            if not cur.fetchone():
                missing.append(item_id)

        if missing:
            skipped_missing_items += 1
            print(
                f"Skip bill #{bill_id}: missing item rows for item_id={','.join(str(x) for x in sorted(set(missing)))}"
            )
            continue

        bills_to_fix += 1
        movements_to_add += len(lines)
        total_stock_restore += sum(qty for _item_id, qty in lines)

        if not apply:
            continue

        for item_id, qty in lines:
            cur.execute(
                "UPDATE item SET stock = COALESCE(stock, 0) + ? WHERE id = ?",
                (qty, item_id),
            )
            cur.execute(
                """
                INSERT INTO stockmovement (item_id, ts, delta, reason, ref_type, ref_id, note, actor)
                VALUES (?, ?, ?, 'BILL_DELETE', 'BILL', ?, ?, ?)
                """,
                (
                    item_id,
                    ts,
                    qty,
                    bill_id,
                    f"Backfill: bill #{bill_id} was already soft-deleted before ledger fix",
                    "migration",
                ),
            )

    if apply:
        conn.commit()
    conn.close()

    print(f"Mode: {'APPLY' if apply else 'DRY-RUN'}")
    print(f"Bills needing backfill: {bills_to_fix}")
    print(f"Ledger rows to add: {movements_to_add}")
    print(f"Net stock to restore: {total_stock_restore}")
    print(f"Skipped (already fixed): {skipped_already_fixed}")
    print(f"Skipped (no bill items): {skipped_no_items}")
    print(f"Skipped (missing items): {skipped_missing_items}")
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="Backfill stock + stockmovement for already soft-deleted bills."
    )
    parser.add_argument(
        "--db",
        default="medical_shop.db",
        help="Path to SQLite DB file (default: medical_shop.db)",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply changes. Without this flag, script runs in dry-run mode.",
    )
    args = parser.parse_args()

    raise SystemExit(run(Path(args.db), apply=bool(args.apply)))


if __name__ == "__main__":
    main()
