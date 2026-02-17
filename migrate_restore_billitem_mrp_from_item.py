import sqlite3
from pathlib import Path

DB_PATH = Path("medical_shop.db")


def main():
    if not DB_PATH.exists():
        print(f"DB file not found: {DB_PATH.resolve()}")
        return

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    cur.execute("SELECT COUNT(*) FROM billitem")
    total_before = int(cur.fetchone()[0] or 0)
    print(f"BillItem rows before: {total_before}")

    cur.execute(
        """
        UPDATE billitem
        SET mrp = (
            SELECT item.mrp
            FROM item
            WHERE item.id = billitem.item_id
        )
        WHERE EXISTS (
            SELECT 1
            FROM item
            WHERE item.id = billitem.item_id
        )
        """
    )
    updated = int(cur.rowcount or 0)
    conn.commit()

    print(f"Updated BillItem.mrp rows: {updated}")
    conn.close()


if __name__ == "__main__":
    main()
