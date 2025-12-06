import sqlite3
from pathlib import Path

# 👇 change this if your DB name/path is different
DB_PATH = Path("medical_shop.db")

def main():
    if not DB_PATH.exists():
        print(f"❌ DB file not found: {DB_PATH.resolve()}")
        return

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # Check existing columns in "return" table
    cur.execute('PRAGMA table_info("return");')
    columns = [row[1] for row in cur.fetchall()]
    print("Existing columns in 'return':", columns)

    if "rounding_adjustment" in columns:
        print("✅ Column 'rounding_adjustment' already exists. Nothing to do.")
    else:
        print("➕ Adding column 'rounding_adjustment'...")
        cur.execute("""
            ALTER TABLE "return"
            ADD COLUMN rounding_adjustment REAL NOT NULL DEFAULT 0.0;
        """)
        conn.commit()
        print("✅ Column added successfully.")

        # verify
        cur.execute('PRAGMA table_info("return");')
        print("Updated columns in 'return':", [row[1] for row in cur.fetchall()])

    conn.close()

if __name__ == "__main__":
    main()
