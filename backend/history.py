"""Local run metadata. Draft text, facts, API keys and editor state never enter this store."""

import hashlib
import hmac
import re
import secrets
import sqlite3
import time
from threading import Condition


PHASES = {"idle", "running", "pausing", "paused", "completed", "cancelled"}
EVENTS = {"run_state", "iteration_start", "best_updated", "gate_rejected",
          "budget_update", "needs_user_input"}
REASONS = {"user", "target_reached", "max_iter", "stagnated", "needs_user_input",
           "user_stop", "cancelled", "key_required", "budget_limit", "invalid_request",
           "provider_error", "cost_unknown", "length", "evidence", "preservation",
           "no_improvement", "invalid_candidate", "settled", "none"}
EVENT_FIELDS = {"seq", "type", "phase", "reason", "iteration", "spentMicros"}
RUN_ID = r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
EVENT_LIMIT = 1024


class HistoryError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def validate_event(item):
    if not isinstance(item, dict) or set(item) != EVENT_FIELDS:
        raise HistoryError(422, "실행 기록 형식을 확인하세요.")
    for field, allowed in (("phase", PHASES), ("type", EVENTS), ("reason", REASONS)):
        if not isinstance(item[field], str) or item[field] not in allowed:
            raise HistoryError(422, "알 수 없는 실행 상태입니다.")
    for field, low, high in (("seq", 1, EVENT_LIMIT), ("iteration", 0, 10), ("spentMicros", 0, 10_000_000)):
        if type(item[field]) is not int or not low <= item[field] <= high:
            raise HistoryError(422, "실행 기록의 수치 범위를 확인하세요.")
    return tuple(item[k] for k in ("seq", "type", "phase", "reason", "iteration", "spentMicros"))


class History:
    def __init__(self, path=":memory:"):
        self.condition = Condition()
        self.closed = False
        self.secret = secrets.token_bytes(32)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS runs (
                owner_id TEXT NOT NULL, id TEXT NOT NULL, created INTEGER NOT NULL,
                PRIMARY KEY(owner_id, id)
            );
            CREATE TABLE IF NOT EXISTS run_events (
                owner_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
                type TEXT NOT NULL, phase TEXT NOT NULL, reason TEXT NOT NULL,
                iteration INTEGER NOT NULL, spentMicros INTEGER NOT NULL,
                PRIMARY KEY(owner_id, run_id, seq),
                FOREIGN KEY(owner_id, run_id) REFERENCES runs(owner_id, id) ON DELETE CASCADE
            );
        """)
        with self.db:
            self.db.execute("DELETE FROM runs WHERE created < ?", (int(time.time()) - 30 * 86400,))

    def close(self):
        with self.condition:
            self.closed = True
            self.condition.notify_all()
            self.db.close()

    def open_run(self, owner, run):
        with self.condition, self.db:
            now = int(time.time())
            self.db.execute("DELETE FROM runs WHERE created < ?", (now - 30 * 86400,))
            self.db.execute("INSERT OR IGNORE INTO runs VALUES (?, ?, ?)", (owner, run, now))

    def require(self, owner, run):
        if self.closed:
            raise HistoryError(503, "기록 서버가 종료되었습니다.")
        if not self.db.execute("SELECT 1 FROM runs WHERE owner_id=? AND id=?", (owner, run)).fetchone():
            raise HistoryError(404, "실행 기록을 찾을 수 없습니다.")

    def list_runs(self, owner):
        with self.condition:
            rows = self.db.execute("""
                SELECT r.id, r.created, e.seq, e.phase, e.iteration, e.spentMicros
                FROM runs r JOIN run_events e ON e.owner_id=r.owner_id AND e.run_id=r.id
                WHERE r.owner_id=? AND e.seq=(
                    SELECT MAX(seq) FROM run_events WHERE owner_id=r.owner_id AND run_id=r.id
                ) ORDER BY r.created DESC, r.rowid DESC LIMIT 30
            """, (owner,))
            return [dict(row) for row in rows]

    def append(self, owner, run, items):
        if not isinstance(items, list) or not 1 <= len(items) <= 128:
            raise HistoryError(422, "실행 이벤트 수를 확인하세요.")
        values = [validate_event(item) for item in items]
        with self.condition, self.db:
            self.require(owner, run)
            tail = self.db.execute("SELECT COALESCE(MAX(seq),0) FROM run_events WHERE owner_id=? AND run_id=?",
                                   (owner, run)).fetchone()[0]
            for row in values:
                seq = row[0]
                if seq <= tail:
                    previous = self.db.execute("""SELECT seq,type,phase,reason,iteration,spentMicros
                        FROM run_events WHERE owner_id=? AND run_id=? AND seq=?""", (owner, run, seq)).fetchone()
                    if previous and tuple(previous) == row:
                        continue
                    raise HistoryError(409, "같은 순번의 기록이 이미 있습니다.")
                if seq != tail + 1:
                    raise HistoryError(409, "이전 순번의 실행 기록이 필요합니다.")
                self.db.execute("INSERT INTO run_events VALUES (?,?,?,?,?,?,?,?)", (owner, run, *row))
                tail = seq
            self.condition.notify_all()
            return tail

    def ticket(self, owner, run):
        with self.condition:
            self.require(owner, run)
            return self._sign(owner, run, int(time.time()) + 120)

    def _sign(self, owner, run, until):
        digest = hmac.new(self.secret, f"{owner}|{run}|{until}".encode(), hashlib.sha256).hexdigest()
        return f"{until}.{digest}"

    def replay(self, owner, run, token, cursor, follow):
        if not re.fullmatch(r"[0-9]{1,12}\.[a-f0-9]{64}", token or ""):
            raise HistoryError(401, "실행 기록 열람 권한이 필요합니다.")
        until = int(token.split(".")[0])
        if until <= time.time() or not hmac.compare_digest(token, self._sign(owner, run, until)):
            raise HistoryError(401, "실행 기록 열람 권한을 갱신하세요.")
        with self.condition:
            self.require(owner, run)

            def fetch():
                return [dict(row) for row in self.db.execute("""SELECT seq,type,phase,reason,iteration,spentMicros
                    FROM run_events WHERE owner_id=? AND run_id=? AND seq>? ORDER BY seq LIMIT 128""",
                    (owner, run, cursor))]

            rows = fetch()
            if not rows and cursor and not self.db.execute(
                    "SELECT 1 FROM run_events WHERE owner_id=? AND run_id=? AND seq=?", (owner, run, cursor)).fetchone():
                raise HistoryError(409, "마지막 순번이 실행 기록 범위를 벗어났습니다.")
            if not rows and follow:
                self.condition.wait(timeout=8)
                self.require(owner, run)
                rows = fetch()
            return rows

    def delete(self, owner, run):
        with self.condition, self.db:
            self.db.execute("DELETE FROM runs WHERE owner_id=? AND id=?", (owner, run))
            self.condition.notify_all()
