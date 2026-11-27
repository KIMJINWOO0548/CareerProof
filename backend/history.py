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
           "no_improvement", "invalid_candidate", "settled", "none", "input_required"}
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
        self.live_worker_ids = set()
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
            CREATE TABLE IF NOT EXISTS worker_runs (
                owner_id TEXT NOT NULL, run_id TEXT NOT NULL, provider TEXT NOT NULL,
                dispatch_pending INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(owner_id,run_id),
                FOREIGN KEY(owner_id,run_id) REFERENCES runs(owner_id,id) ON DELETE CASCADE
            );
        """)
        with self.db:
            self.db.execute("DELETE FROM runs WHERE created < ?", (int(time.time()) - 30 * 86400,))
            self._interrupt_lost_workers()

    def _interrupt_lost_workers(self):
        for marker in self.db.execute("SELECT * FROM worker_runs").fetchall():
            owner, run = marker["owner_id"], marker["run_id"]
            last = self.db.execute("""SELECT * FROM run_events WHERE owner_id=? AND run_id=?
                                      ORDER BY seq DESC LIMIT 1""", (owner, run)).fetchone()
            seq, phase, iteration, spent = (last["seq"], last["phase"], last["iteration"], last["spentMicros"]) if last else (0, "idle", 0, 0)
            if marker["dispatch_pending"]:
                seq += 1
                self.db.execute("INSERT INTO run_events VALUES (?,?,?,?,?,?,?,?)",
                                (owner, run, seq, "budget_update", phase, "cost_unknown", iteration, spent))
                self.db.execute("UPDATE worker_runs SET dispatch_pending=0 WHERE owner_id=? AND run_id=?", (owner, run))
            if phase not in {"cancelled", "completed"} and not (last and last["reason"] == "input_required"):
                self.db.execute("INSERT INTO run_events VALUES (?,?,?,?,?,?,?,?)",
                                (owner, run, seq + 1, "run_state", "paused", "input_required", iteration, spent))

    def _is_worker(self, owner, run):
        return self.db.execute("SELECT 1 FROM worker_runs WHERE owner_id=? AND run_id=?", (owner, run)).fetchone()

    def open_worker(self, owner, run, provider="ollama"):
        with self.condition, self.db:
            if provider not in {"ollama", "anthropic", "openai", "gemini"}:
                raise HistoryError(422, "실행 모델 설정을 확인하세요.")
            try:
                self.db.execute("INSERT INTO runs VALUES (?,?,?)", (owner, run, int(time.time())))
            except sqlite3.IntegrityError:
                raise HistoryError(409, "이미 사용한 실행 ID입니다.") from None
            self.db.execute("INSERT INTO worker_runs(owner_id,run_id,provider) VALUES (?,?,?)", (owner, run, provider))
            self.live_worker_ids.add((owner, run))

    def mark_dispatch(self, owner, run):
        with self.condition, self.db:
            self.require(owner, run)
            self.db.execute("UPDATE worker_runs SET dispatch_pending=1 WHERE owner_id=? AND run_id=?", (owner, run))

    def close(self):
        with self.condition:
            self.closed = True
            self.condition.notify_all()
            self.db.close()

    def open_run(self, owner, run):
        with self.condition, self.db:
            if self._is_worker(owner, run):
                raise HistoryError(409, "서버가 관리하는 실행 기록입니다.")
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

    def append(self, owner, run, items, *, client=False):
        if not isinstance(items, list) or not 1 <= len(items) <= 128:
            raise HistoryError(422, "실행 이벤트 수를 확인하세요.")
        values = [validate_event(item) for item in items]
        with self.condition, self.db:
            self.require(owner, run)
            if client and self._is_worker(owner, run):
                raise HistoryError(409, "서버가 관리하는 실행 기록입니다.")
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
                if row[1] == "budget_update":
                    self.db.execute("UPDATE worker_runs SET dispatch_pending=0 WHERE owner_id=? AND run_id=?", (owner, run))
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

    def delete(self, owner, run, *, client=False):
        with self.condition, self.db:
            if client and (owner, run) in self.live_worker_ids:
                raise HistoryError(409, "서버 작업 목록에서 해당 실행을 삭제하세요.")
            self.db.execute("DELETE FROM runs WHERE owner_id=? AND id=?", (owner, run))
            self.live_worker_ids.discard((owner, run))
            self.condition.notify_all()

    def erase_owner(self, owner):
        """Erase every owned row, including records outside the list's 30-row window."""
        with self.condition, self.db:
            pending = self.db.execute("""
                SELECT 1 FROM runs r WHERE r.owner_id=? AND (
                  EXISTS (SELECT 1 FROM worker_runs w WHERE w.owner_id=r.owner_id
                    AND w.run_id=r.id AND w.dispatch_pending=1)) LIMIT 1
            """, (owner,)).fetchone()
            if pending:
                raise HistoryError(409, "진행 중인 실행을 종료하거나 취소하고 사용량 정산이 끝날 때까지 기다린 뒤 삭제하세요.")
            count = self.db.execute("DELETE FROM runs WHERE owner_id=?", (owner,)).rowcount
            self.live_worker_ids = {key for key in self.live_worker_ids if key[0] != owner}
            self.condition.notify_all()
            return count
