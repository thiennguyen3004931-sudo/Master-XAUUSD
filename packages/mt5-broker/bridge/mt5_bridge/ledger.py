from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import threading
import time
from typing import Any, Literal

ReservationState = Literal["ACQUIRED", "PENDING", "COMPLETED"]


class IdempotencyLedger:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS idempotency (
                key TEXT PRIMARY KEY,
                state TEXT NOT NULL,
                response_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """
        )
        self._lock = threading.RLock()

    def reserve(self, key: str) -> tuple[ReservationState, dict[str, Any] | None]:
        now = int(time.time() * 1000)
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                row = self._connection.execute(
                    "SELECT state, response_json FROM idempotency WHERE key = ?", (key,)
                ).fetchone()
                if row is not None:
                    state, payload = str(row[0]), row[1]
                    self._connection.execute("COMMIT")
                    if state == "COMPLETED" and payload:
                        return "COMPLETED", json.loads(payload)
                    return "PENDING", None

                self._connection.execute(
                    "INSERT INTO idempotency(key, state, response_json, created_at, updated_at) VALUES (?, 'PENDING', NULL, ?, ?)",
                    (key, now, now),
                )
                self._connection.execute("COMMIT")
                return "ACQUIRED", None
            except Exception:
                self._connection.execute("ROLLBACK")
                raise

    def complete(self, key: str, response: dict[str, Any]) -> None:
        payload = json.dumps(response, separators=(",", ":"), sort_keys=True)
        now = int(time.time() * 1000)
        with self._lock:
            self._connection.execute(
                "UPDATE idempotency SET state = 'COMPLETED', response_json = ?, updated_at = ? WHERE key = ?",
                (payload, now, key),
            )

    def release(self, key: str) -> None:
        with self._lock:
            self._connection.execute(
                "DELETE FROM idempotency WHERE key = ? AND state = 'PENDING'", (key,)
            )

    def get(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT response_json FROM idempotency WHERE key = ? AND state = 'COMPLETED'", (key,)
            ).fetchone()
        return json.loads(row[0]) if row and row[0] else None

    def close(self) -> None:
        with self._lock:
            self._connection.close()
