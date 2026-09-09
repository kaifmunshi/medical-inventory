"""Safely optimize the active client SQLite database after an application update."""

from datetime import datetime
from pathlib import Path
import sqlite3
import sys

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
from backend.db import DB_FILE


def main() -> None:
    db_path = Path(DB_FILE).resolve()
    if not db_path.exists():
        raise SystemExit(f"Database not found: {db_path}")

    backup_dir = db_path.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = backup_dir / f"{db_path.stem}.before_performance_update_{stamp}{db_path.suffix}"

    with sqlite3.connect(str(db_path), timeout=30) as source:
        with sqlite3.connect(str(backup_path), timeout=30) as destination:
            source.backup(destination)
        source.execute("PRAGMA journal_mode=WAL")
        source.execute("PRAGMA synchronous=NORMAL")
        source.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        source.execute("PRAGMA optimize")

    print(f"Optimized: {db_path}")
    print(f"Safety backup: {backup_path}")


if __name__ == "__main__":
    main()
