import sqlite3
from pathlib import Path

DB_PATH = Path("medical_shop.db")


def round2(x: float) -> float:
    return float(f"{x:.2f}")


def main():
    if not DB_PATH.exists():
        print(f"DB file not found: {DB_PATH.resolve()}")
        return

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    cur.execute("SELECT id, total_amount FROM bill ORDER BY id")
    bills = cur.fetchall()

    touched_bills = 0
    touched_lines = 0

    for bill_id, total_amount in bills:
        target = round2(float(total_amount or 0.0))

        cur.execute(
            "SELECT id, quantity, line_total, mrp FROM billitem WHERE bill_id = ? ORDER BY id",
            (int(bill_id),),
        )
        rows = cur.fetchall()
        if not rows:
            continue

        bases = []
        for item_id, qty, line_total, mrp in rows:
            q = int(qty or 0)
            base = float(line_total or 0.0)
            if base <= 0 and q > 0:
                base = float(mrp or 0.0) * q
            bases.append((int(item_id), q, base))

        base_total = round2(sum(b for _, _, b in bases))
        if abs(base_total - target) <= 0.01:
            continue
        if base_total <= 0:
            continue

        factor = target / base_total
        running = 0.0
        adjusted = []

        for item_id, qty, base in bases:
            new_line = round2(max(0.0, base * factor))
            adjusted.append([item_id, qty, new_line])
            running = round2(running + new_line)

        residual = round2(target - running)
        if abs(residual) > 0.0001:
            adjusted[-1][2] = round2(max(0.0, adjusted[-1][2] + residual))

        for item_id, _qty, new_line_total in adjusted:
            cur.execute("UPDATE billitem SET line_total = ? WHERE id = ?", (new_line_total, item_id))
            touched_lines += int(cur.rowcount or 0)

        touched_bills += 1

    conn.commit()
    conn.close()

    print(f"Rebalanced bills: {touched_bills}")
    print(f"Updated billitem rows: {touched_lines}")


if __name__ == "__main__":
    main()
