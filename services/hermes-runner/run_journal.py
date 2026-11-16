"""Delivery journal, separate from Hermes' conversation database.

Unacknowledged results survive restart and cache eviction. Dispatch claims are
durable so a lost HTTP acknowledgment cannot execute the same run twice.
"""
import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path


class RunJournal:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        with self.connect() as conn:
            conn.execute('''CREATE TABLE IF NOT EXISTS delivery_runs (
                run_id TEXT PRIMARY KEY, record TEXT, claimed INTEGER NOT NULL DEFAULT 0,
                updated_at REAL NOT NULL, acknowledged_at REAL)''')

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.path, timeout=10)
        try:
            conn.execute('PRAGMA synchronous=FULL')
            with conn:
                yield conn
        finally:
            conn.close()

    def claim(self, run_id: str) -> bool:
        with self.connect() as conn:
            conn.execute('INSERT OR IGNORE INTO delivery_runs(run_id, updated_at) VALUES (?, ?)',
                         (run_id, time.time()))
            return conn.execute('UPDATE delivery_runs SET claimed=1 WHERE run_id=? AND claimed=0',
                                (run_id,)).rowcount == 1

    def save(self, run_id: str, record: dict) -> None:
        with self.connect() as conn:
            conn.execute('''INSERT INTO delivery_runs(run_id, record, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(run_id) DO UPDATE SET record=excluded.record, updated_at=excluded.updated_at''',
                         (run_id, json.dumps(record), time.time()))

    def load(self, run_id: str) -> dict | None:
        with self.connect() as conn:
            row = conn.execute('SELECT record, updated_at FROM delivery_runs WHERE run_id=?', (run_id,)).fetchone()
        if not row or not row[0]:
            return None
        record = json.loads(row[0])
        record['updated_at'] = time.monotonic() - max(0, time.time() - row[1])
        return record

    def acknowledge(self, run_id: str) -> None:
        with self.connect() as conn:
            conn.execute('UPDATE delivery_runs SET acknowledged_at=? WHERE run_id=?', (time.time(), run_id))
            # Keep replay tombstones. Only large acknowledged transcripts expire.
            conn.execute('UPDATE delivery_runs SET record=NULL WHERE acknowledged_at < ?', (time.time() - 7 * 86400,))
