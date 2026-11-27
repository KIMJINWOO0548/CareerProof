"""Short-lived process-local receipts for retries of a single draft request."""

import hashlib
import hmac
import json
import secrets
import threading
import time
import uuid
from dataclasses import dataclass

from .drafts import DraftError


@dataclass
class _Receipt:
    fingerprint: bytes
    expires_at: float | None = None
    payload: str | None = None
    error_status: int | None = None

    def replay(self):
        if self.expires_at is None:
            raise DraftError(409, "같은 초안 요청을 처리 중입니다.", "request_in_progress")
        data = json.loads(self.payload)
        if self.error_status is not None:
            raise DraftError(self.error_status, data["message"], data["code"], usage=data["usage"])
        return data


def _canonical_id(value):
    try:
        parsed = uuid.UUID(value) if isinstance(value, str) else None
        if not parsed or parsed.version != 4 or str(parsed) != value.lower():
            raise ValueError()
        return str(parsed)
    except ValueError:
        raise DraftError(422, "요청 식별자는 UUIDv4 형식이어야 합니다.") from None


class DraftReceipts:
    def __init__(self, ttl=600, capacity=64, clock=time.monotonic):
        if ttl <= 0 or capacity <= 0:
            raise ValueError("ttl and capacity must be positive")
        self._ttl = ttl
        self._capacity = capacity
        self._clock = clock
        self._secret = secrets.token_bytes(32)
        self._entries = {}
        self._lock = threading.Lock()
        self._timer = None
        self._closed = False

    def _prune(self):
        now = self._clock()
        for request_id, record in list(self._entries.items()):
            if record.expires_at is not None and record.expires_at <= now:
                del self._entries[request_id]

    def _arm(self):
        # Expire text at rest even if no further client opens the app.
        if self._timer is not None:
            return
        next_expiry = min((r.expires_at for r in self._entries.values() if r.expires_at is not None), default=None)
        if next_expiry is not None:
            timer = threading.Timer(max(0, next_expiry - self._clock()), self._expire)
            timer.daemon = True
            self._timer = timer
            timer.start()

    def _expire(self):
        with self._lock:
            self._timer = None
            self._prune()
            self._arm()

    def close(self):
        with self._lock:
            self._closed = True
            self._entries.clear()
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None

    def execute(self, request_id, data, key, operation):
        if request_id is None:
            return operation()
        request_id = _canonical_id(request_id)
        try:
            canonical = json.dumps([data, key], sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        except (TypeError, ValueError, RecursionError):
            raise DraftError(422, "요청 항목의 JSON 형식을 확인하세요.") from None
        fingerprint = hmac.digest(self._secret, canonical, hashlib.sha256)
        del canonical
        with self._lock:
            self._prune()
            if self._closed:
                raise DraftError(503, "초안 요청 처리가 종료되었습니다.", "provider_busy")
            record = self._entries.get(request_id)
            if record is not None:
                if not hmac.compare_digest(record.fingerprint, fingerprint):
                    raise DraftError(409, "같은 요청 식별자에 다른 입력이 지정되었습니다.", "request_conflict")
                return record.replay()
            if len(self._entries) >= self._capacity:
                raise DraftError(503, "초안 요청 기록이 가득 찼습니다. 잠시 뒤 다시 시도하세요.", "receipt_capacity")
            record = _Receipt(fingerprint)
            self._entries[request_id] = record

        # Only the thread that inserted the reservation performs the provider call.
        status = None
        try:
            payload = json.dumps(operation(), ensure_ascii=False, allow_nan=False)
        except DraftError as error:
            if error.code == "provider_busy":
                # The local slot rejected this request before it reached a provider.
                with self._lock:
                    self._entries.pop(request_id, None)
                raise
            status = error.status
            payload = json.dumps({"message": str(error), "code": error.code, "usage": error.usage})
        except Exception:
            # Keep a tombstone when dispatch cannot be ruled out; never cache tracebacks or input.
            status = 502
            code = "cost_unknown" if isinstance(data, dict) and data.get("provider") == "anthropic" else "provider_error"
            payload = json.dumps({"message": "초안 요청의 처리 결과를 확인할 수 없습니다.", "code": code, "usage": None})
        with self._lock:
            record.payload = payload
            record.error_status = status
            record.expires_at = self._clock() + self._ttl
            self._arm()
            return record.replay()
