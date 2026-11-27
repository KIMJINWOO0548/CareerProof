"""Short-lived, browser-owned writing tasks shared through a bearer code."""

import re
import secrets
from dataclasses import dataclass
from threading import Condition, Thread
from time import monotonic

from .drafts import (
    POLICY,
    PRIVATE_TEXT,
    DraftError,
    input_context,
    masked_context,
    parse_candidate,
)
from .writing_skill import writing_instructions

CODE = re.compile(r"[A-Za-z0-9_-]{43}")
START_FIELDS = {"question", "facts", "charLimit", "documentKind", "redactTerms"}


@dataclass
class Task:
    owner: str
    expires: float
    context: dict
    restore: dict
    instructions: str
    claimed: bool = False
    draft: dict | None = None


class AgentTasks:
    def __init__(self, ttl=900, owner_limit=4, total_limit=64):
        self.ttl = ttl
        self.owner_limit = owner_limit
        self.total_limit = total_limit
        self.tasks = {}
        self.condition = Condition()
        self.closed = False
        self.reaper = Thread(target=self._reap, daemon=True, name="careerproof-agent-expiry")
        self.reaper.start()

    def _expire(self):
        now = monotonic()
        for code in [key for key, task in self.tasks.items() if task.expires <= now]:
            del self.tasks[code]

    def _reap(self):
        with self.condition:
            while not self.closed:
                self._expire()
                deadline = min((task.expires for task in self.tasks.values()), default=None)
                self.condition.wait(None if deadline is None else max(0, deadline - monotonic()))

    def close(self):
        with self.condition:
            self.closed = True
            self.tasks.clear()
            self.condition.notify()
        self.reaper.join()

    def erase_owner(self, owner):
        with self.condition:
            for code in [key for key, task in self.tasks.items() if task.owner == owner]:
                del self.tasks[code]

    def start(self, owner, data):
        if data.keys() - START_FIELDS:
            raise DraftError(422, "선택한 문항과 사실만 연결할 수 있습니다.")
        context = input_context({"documentKind": "self_intro", **data})
        terms = data.get("redactTerms", [])
        context, restore = masked_context(context, terms)
        for fact in context["facts"]:
            if PRIVATE_TEXT.search(fact["id"]) or any(term.strip() in fact["id"] for term in terms):
                raise DraftError(422, "개인정보가 포함된 사실 ID를 변경하세요.")
        instructions = POLICY + "\n\n" + writing_instructions(context["documentKind"])
        with self.condition:
            self._expire()
            if self.closed:
                raise DraftError(503, "작업 서버가 종료되었습니다.")
            if (len(self.tasks) >= self.total_limit or
                    sum(task.owner == owner for task in self.tasks.values()) >= self.owner_limit):
                raise DraftError(429, "진행 중인 연결을 종료한 후 다시 시도하세요.")
            code = secrets.token_urlsafe(32)
            self.tasks[code] = Task(owner, monotonic() + self.ttl, context, restore, instructions)
            self.condition.notify()
            return {"code": code, "expiresInSeconds": self.ttl, "preview": context}

    def handle(self, op, data, owner=None):
        if not isinstance(data, dict):
            raise DraftError(422, "JSON 객체를 입력하세요.")
        if op == "start":
            return self.start(owner, data)
        fields = {"code", "draft"} if op == "submit" else {"code"}
        if data.keys() != fields:
            raise DraftError(422, "연결 요청의 항목을 확인하세요.")
        code = data["code"]
        with self.condition:
            self._expire()
            task = self.tasks.get(code) if isinstance(code, str) and CODE.fullmatch(code) else None
            if task is None or (op in {"result", "cancel"} and task.owner != owner):
                raise DraftError(404, "연결이 만료되었거나 해당 작업을 찾을 수 없습니다.")
            if op == "cancel":
                del self.tasks[code]
                return {}
            if op == "claim":
                if task.claimed or task.draft is not None:
                    raise DraftError(409, "이미 실행을 예약했거나 초안을 수신한 연결입니다.")
                task.claimed = True
            if op in {"read", "claim"}:
                return {"instructions": task.instructions, "context": task.context}
            allowed = {item["id"] for item in task.context["facts"]}
            if op == "result":
                if task.draft is None:
                    return {"status": "pending"}
                return {"status": "ready", **parse_candidate(task.draft, allowed, task.restore)}
            draft = data["draft"]
            if not isinstance(draft, dict):
                raise DraftError(422, "초안 객체를 확인하세요.")
            try:
                parse_candidate(draft, allowed, task.restore)
            except DraftError:
                raise DraftError(422, "초안 형식, 마스킹 토큰과 근거 ID를 확인하세요.") from None
            plain = re.sub(r"\[CPMASK_[0-9a-f]{16}_\d+\]", "", draft["text"])
            if PRIVATE_TEXT.search(plain) or any(literal in plain for literal in task.restore.values()):
                raise DraftError(422, "개인정보는 전달된 마스킹 토큰을 사용하세요.")
            normalized = {"text": draft["text"].strip(), "factIds": draft["factIds"]}
            if task.draft is not None and task.draft != normalized:
                raise DraftError(409, "이미 다른 초안을 수신했습니다.")
            task.draft = normalized
            return {"status": "received"}
