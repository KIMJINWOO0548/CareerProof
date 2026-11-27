"""Server-owned, process-isolated drafting loops. User content lives in process memory."""

import copy
import hashlib
import hmac
import json
import os
import queue
import re
import secrets
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path

from .drafts import DraftError, MODEL_NAME, PRICING, CLOUD_PROVIDERS
from .history import RUN_ID

SCRIPT = Path(__file__).resolve().with_name("worker.mjs")
MAX_FRAME = 10 * 1024 * 1024
TERMINAL = {"completed", "cancelled"}
COMMAND_WAIT = 12
CALL_WAIT = 150


class WorkerError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


def invalid():
    return WorkerError(422, "invalid_request", "서버 실행의 입력과 설정을 확인하세요.")


def conflict(code="stale_version"):
    return WorkerError(409, code, "실행의 상태 또는 편집 기준이 변경되었습니다. 최신 내용을 다시 확인하세요.")


def wire(value, limit=MAX_FRAME):
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"),
                             sort_keys=True).encode("utf-8")
    except (UnicodeError, TypeError, ValueError, RecursionError):
        raise invalid() from None
    if len(encoded) > limit:
        raise WorkerError(413, "too_large", "작업 크기가 서버 실행 한도를 넘었습니다.")
    return encoded


def uuid4(value):
    if not isinstance(value, str) or not re.fullmatch(RUN_ID, value):
        raise invalid()
    return value


def question(workspace, qid):
    if not isinstance(workspace, dict) or not isinstance(workspace.get("questions"), list):
        raise invalid()
    matches = [q for q in workspace["questions"] if isinstance(q, dict) and q.get("id") == qid]
    if len(matches) != 1:
        raise invalid()
    return matches[0]


def cloud_settings(provider, key, payload):
    terms = payload.get("redactTerms", [])
    if (not isinstance(terms, list) or len(terms) > 50
            or any(not isinstance(t, str) or not 1 <= len(t) <= 200 for t in terms)):
        raise invalid()
    if provider in CLOUD_PROVIDERS:
        if payload.get("confirmed") is not True:
            raise invalid()
        if not isinstance(key, str) or not re.fullmatch(r"[!-~]{1,512}", key):
            raise WorkerError(422, "key_required", "서버 실행에 사용할 키를 입력하세요.")
    elif key:
        raise invalid()
    return terms


def node_args(node, *args):
    return [node, "--max-old-space-size=192", str(SCRIPT), *args]


def process_options():
    # Node receives neither the provider key nor any parent environment credentials.
    env = {k: os.environ[k] for k in ("SystemRoot", "WINDIR") if k in os.environ}
    return {"cwd": str(SCRIPT.parent.parent), "env": env, "stderr": subprocess.DEVNULL,
            "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}


@dataclass
class Run:
    owner: str
    id: str
    config: dict
    workspace: dict
    initial: dict
    state: dict
    version: int = 0
    control: threading.Lock = field(default_factory=threading.Lock)
    messages: queue.Queue = field(default_factory=lambda: queue.Queue(8))
    process: object = None
    reader: object = None
    writer: object = None
    dead: bool = False
    key: str | None = None
    redact: list = field(default_factory=list)
    expires: float = 0
    key_timer: object = None
    receipts: dict = field(default_factory=dict)
    waiting: dict | None = None
    last_seq: int = 0
    last_call: int = 0
    inflight: str | None = None
    retained_bytes: int = 0

    def snapshot(self):
        return dict(self.config, id=self.id, version=self.version, state=self.state,
                    workspace=self.workspace, initial=self.initial, redactTerms=self.redact)


class WorkerManager:
    def __init__(self, history, generate, node_path=None):
        self.history = history
        self.generate = generate
        self.node = shutil.which("node" if node_path is None else str(node_path))
        self.available = bool(self.node and SCRIPT.is_file())
        self.cv = threading.Condition()
        self.secret = secrets.token_bytes(32)
        self.runs = {}
        self.deleted = {}
        self.closed = False

    def _lookup(self, owner, run_id):
        with self.cv:
            run = self.runs.get((owner, run_id))
            if not run:
                raise WorkerError(404, "not_found", "메모리에 남아 있는 실행을 찾을 수 없습니다.")
            return run

    def list(self, owner):
        with self.cv:
            return [dict(id=r.id, version=r.version, phase=r.state["phase"], reason=r.state["reason"],
                         company=r.workspace.get("company"), title=question(r.workspace, r.config["questionId"]).get("title"),
                         questionId=r.config["questionId"], canDelete=bool((r.dead or r.state["phase"] in TERMINAL)
                         and not r.inflight and not r.state.get("usagePending"))) for r in reversed(self.runs.values())
                    if r.owner == owner and r.version]

    def _set_key(self, run, key):
        if run.key_timer:
            run.key_timer.cancel()
            run.key_timer = None
        run.key = key
        if key:
            run.expires = time.monotonic() + 900
            def expire(deadline):
                with self.cv:
                    if run.expires == deadline:
                        run.key = None
                        run.key_timer = None
            run.key_timer = threading.Timer(900, expire, args=(run.expires,))
            run.key_timer.daemon = True
            run.key_timer.start()

    def get(self, owner, run_id, summary=False):
        run = self._lookup(owner, run_id)
        with run.control, self.cv:
            snapshot = self._lookup(owner, run_id).snapshot()
            if summary:
                snapshot = {k: v for k, v in snapshot.items() if k not in {"workspace", "initial", "redactTerms"}}
            return copy.deepcopy(snapshot)

    def _fingerprint(self, payload):
        return hmac.digest(self.secret, wire(payload), hashlib.sha256)

    @staticmethod
    def _previous(run, command_id, fingerprint):
        receipt = run.receipts.get(command_id)
        if receipt:
            old, outcome = receipt
            if not hmac.compare_digest(old, fingerprint):
                raise conflict("command_conflict")
            if isinstance(outcome, WorkerError):
                raise WorkerError(outcome.status, outcome.code, str(outcome))
            return copy.deepcopy(outcome)
        return None

    def _spawn(self, run):
        try:
            run.process = subprocess.Popen(node_args(self.node), stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, **process_options())
        except OSError:
            raise WorkerError(503, "worker_unavailable", "로컬 Node 워커를 시작할 수 없습니다.") from None
        run.reader = threading.Thread(target=self._read, args=(run,), daemon=True)
        run.writer = threading.Thread(target=self._write, args=(run,), daemon=True)
        run.writer.start()
        run.reader.start()

    def create(self, owner, payload, key=None):
        if not self.available:
            raise WorkerError(503, "worker_unavailable", "서버 반복 작성에는 로컬 Node.js가 필요합니다.")
        if not isinstance(payload, dict):
            raise invalid()
        rid, cid = uuid4(payload.get("runId")), uuid4(payload.get("commandId"))
        fp = self._fingerprint(payload)
        cfg = {k: payload.get(k) for k in ("questionId", "model", "provider", "target", "maxIterations", "budgetUsd")}
        workspace, initial = payload.get("workspace"), payload.get("initial")
        q = question(workspace, cfg["questionId"])
        if not isinstance(initial, dict) or not isinstance(q.get("id"), str) or not isinstance(cfg["model"], str):
            raise invalid()
        if cfg["provider"] not in (*CLOUD_PROVIDERS, "ollama") or not MODEL_NAME.fullmatch(cfg["model"]):
            raise invalid()
        if cfg["provider"] in CLOUD_PROVIDERS and cfg["model"] != PRICING["providers"][cfg["provider"]]["model"]:
            raise invalid()
        if cfg["provider"] == "ollama" and "cloud" in cfg["model"].lower():
            raise invalid()
        with self.cv:
            if (owner, rid) in self.deleted:
                raise conflict("command_conflict")
            existing = self.runs.get((owner, rid))
            if existing is None:
                if self.closed:
                    raise WorkerError(503, "worker_unavailable", "서버가 종료 중입니다.")
                terms = cloud_settings(cfg["provider"], key, payload)
                owned = [r for r in self.runs.values() if r.owner == owner]
                live = [r for r in self.runs.values() if not r.dead and
                        (r.state["phase"] not in TERMINAL or r.inflight)]
                if any(r.owner == owner and r.config["questionId"] == q["id"] for r in live):
                    raise conflict("run_active")
                if len(owned) >= 20 or len(live) >= 4:
                    raise WorkerError(429, "worker_capacity", "실행 수 한도에 도달했습니다. 종료된 실행을 정리하세요.")
                self.history.open_worker(owner, rid, cfg["provider"])
                initial_state = dict(phase="idle", reason=None, iteration=0, events=[], best=None,
                                     spentUsd=0, usagePending=False, usageUnknown=False, questions=[])
                run = Run(owner, rid, cfg, workspace, initial, initial_state, redact=terms)
                self._set_key(run, key)
                run.control.acquire()
                self.runs[(owner, rid)] = run
        if existing is not None:
            with existing.control, self.cv:
                previous = self._previous(existing, cid, fp)
                if previous is not None:
                    return previous
                raise conflict("command_conflict")
        try:
            with self.cv:
                if self.closed or run.dead:
                    raise WorkerError(503, "worker_unavailable", "서버가 종료 중입니다.")
                self._spawn(run)
            msg = {k: cfg[k] for k in ("questionId", "provider", "target", "maxIterations", "budgetUsd")}
            return self._dispatch(run, cid, fp, dict(msg, type="start", workspace=workspace, initial=initial))
        except Exception:
            with self.cv:
                if not run.version:
                    self._kill(run)
                    self.runs.pop((owner, rid), None)
                    # A rejected start never dispatched. An ambiguous start retains its reservation on disk.
                    if not run.last_seq:
                        self.history.delete(owner, rid)
            raise
        finally:
            run.control.release()

    def _dispatch(self, run, cid, fp, msg, update=None):
        frame = wire(dict(msg, commandId=cid)) + b"\n"
        with self.cv:
            if self.closed or run.dead:
                raise conflict("input_required")
            pending = {"id": cid, "answer": None, "update": update}
            run.waiting = pending
            try:
                run.messages.put_nowait(frame)
                self.cv.wait_for(lambda: pending["answer"] is not None or run.dead or self.closed, timeout=COMMAND_WAIT)
                if pending["answer"] is None:
                    if not self.closed and not run.dead:
                        self._interrupt(run)
                    self._kill(run)
                    raise WorkerError(503, "worker_unavailable", "로컬 워커의 응답이 중단되었습니다.")
                ok, code, message = pending["answer"]
                if not ok:
                    raise WorkerError(409 if code in ("stale_workspace", "stale_revision", "invalid_transition", "needs_user_input")
                                      else 422, code, message)
                outcome = run.snapshot()
                run.receipts[cid] = (fp, outcome)
                return copy.deepcopy(outcome)
            except WorkerError as error:
                run.receipts[cid] = (fp, WorkerError(error.status, error.code, str(error)))
                raise
            finally:
                run.waiting = None

    def command(self, owner, run_id, payload, key=None):
        if not isinstance(payload, dict):
            raise invalid()
        cid = uuid4(payload.get("commandId"))
        fp = self._fingerprint(payload)
        run = self._lookup(owner, run_id)
        with run.control:
            with self.cv:
                self._lookup(owner, run_id)
                previous = self._previous(run, cid, fp)
                if previous is not None:
                    return previous
                if len(run.receipts) >= 100 and payload.get("kind") not in ("stop", "cancel"):
                    raise WorkerError(409, "command_limit", "명령 수 한도에 도달했습니다. 실행을 종료하세요.")
            try:
                return self._command(run, payload, key, cid, fp)
            except WorkerError as error:
                with self.cv:
                    if len(run.receipts) < 102:
                        run.receipts[cid] = (fp, WorkerError(error.status, error.code, str(error)))
                raise

    def _command(self, run, payload, key, cid, fp):
        with self.cv:
            if type(payload.get("baseVersion")) is not int or payload["baseVersion"] != run.version:
                raise conflict()
            kind, phase = payload.get("kind"), run.state["phase"]
        if kind in ("edit", "approve", "resume"):
            # Old workspace versions are retained only for exact command replay.
            # Reserve space before mutating either the worker or the recovery snapshot.
            previous_size = len(wire(run.workspace))
            if run.retained_bytes + previous_size > 32 * 1024 * 1024:
                raise WorkerError(409, "command_limit", "실행의 편집 이력 한도에 도달했습니다. 작업을 내려받고 새 실행을 시작하세요.")
        if kind in ("edit", "approve"):
            if phase not in TERMINAL | {"paused"}:
                raise conflict("invalid_transition")
            outcome = self._checkpoint(run, payload, cid, fp)
            run.retained_bytes += previous_size
            return outcome
        phases = {"resume": {"paused"}, "pause": {"running"}, "stop": {"paused", "pausing", "running"},
                  "cancel": {"paused", "pausing", "running"}}
        if not isinstance(kind, str) or kind not in phases or phase not in phases[kind]:
            raise conflict("invalid_transition")
        msg = {"type": kind}
        update = None
        if kind == "resume":
            ws, initial = payload.get("workspace"), payload.get("initial")
            q = question(ws, run.config["questionId"])
            old = question(run.workspace, run.config["questionId"]).get("revisions", [])
            revisions = q.get("revisions")
            if (not isinstance(revisions, list) or revisions[:len(old)] != old or "baseRevisionId" not in payload
                    or q.get("headRevisionId") != payload["baseRevisionId"]):
                raise conflict("stale_revision")
            terms = cloud_settings(run.config["provider"], key, {"redactTerms": run.redact, **payload})
            with self.cv:
                old_terms = run.redact
                run.redact = terms
                self._set_key(run, key)
            msg.update(workspace=ws, initial=initial, baseRevisionId=payload["baseRevisionId"])
            update = (ws, initial)
        try:
            outcome = self._dispatch(run, cid, fp, msg, update)
            if update is not None:
                run.retained_bytes += previous_size
            return outcome
        except Exception:
            if kind == "resume":
                with self.cv:
                    self._set_key(run, None)
                    run.redact = old_terms
            raise

    def _checkpoint(self, run, payload, cid, fp):
        msg = {k: payload[k] for k in ("kind", "workspace", "initial", "baseRevisionId", "revisionId") if k in payload}
        msg.update(previous=run.workspace, questionId=run.config["questionId"])
        try:
            completed = subprocess.run(node_args(self.node, "--checkpoint"), input=wire(msg, 2 * MAX_FRAME) + b"\n",
                                       stdout=subprocess.PIPE, timeout=COMMAND_WAIT, **process_options())
            if completed.returncode or len(completed.stdout) > MAX_FRAME:
                raise ValueError()
            out = json.loads(completed.stdout)
        except (ValueError, OSError, subprocess.TimeoutExpired):
            raise WorkerError(503, "worker_unavailable", "편집 기준을 검증할 수 없습니다.") from None
        if not out.get("ok"):
            code = out.get("code", "invalid_request")
            raise WorkerError(409 if code in ("stale_workspace", "stale_revision") else 422, code,
                              out.get("message", "편집본을 확인하세요."))
        with self.cv:
            if self.closed:
                raise conflict("input_required")
            run.workspace = out["workspace"]
            if payload["kind"] == "edit":
                run.initial = payload["initial"]
            run.version += 1
            outcome = run.snapshot()
            run.receipts[cid] = (fp, outcome)
            return copy.deepcopy(outcome)

    def _write(self, run):
        try:
            with run.process.stdin as pipe:
                while (frame := run.messages.get()) is not None:
                    pipe.write(frame)
                    pipe.flush()
        except (ValueError, OSError):
            with self.cv:
                if not self.closed and not run.dead and run.state["phase"] not in TERMINAL:
                    self._interrupt(run)
                self._kill(run)

    def _read(self, run):
        try:
            with run.process.stdout as pipe:
                while raw := pipe.readline(MAX_FRAME + 1):
                    if len(raw) > MAX_FRAME or not raw.endswith(b"\n"):
                        break
                    message = json.loads(raw)
                    with self.cv:
                        if self.closed or run.dead:
                            break
                        self._handle(run, message)
        except Exception:
            # Provider text, command payloads and child stderr never enter error logs.
            pass
        finally:
            with self.cv:
                if not self.closed and not run.dead and (
                        run.state["phase"] not in TERMINAL or run.state.get("usagePending")):
                    self._interrupt(run)
                self._kill(run)
            run.process.wait()

    def _interrupt(self, run):
        unknown = run.config["provider"] in CLOUD_PROVIDERS and bool(run.state.get("usagePending") or run.inflight)
        terminal = run.state["phase"] in TERMINAL
        phase = run.state["phase"] if terminal else "paused"
        reason = run.state["reason"] if terminal else ("cost_unknown" if unknown else "input_required")
        events = []
        if unknown:
            events.append(dict(seq=run.last_seq + 1, type="budget_update", phase=run.state["phase"],
                               reason="cost_unknown", iteration=run.state["iteration"]))
        if not terminal:
            events.append(dict(seq=run.last_seq + len(events) + 1, type="run_state", phase=phase,
                               reason=reason, iteration=run.state["iteration"]))
        run.state = dict(run.state, phase=phase, reason=reason, usageUnknown=unknown or run.state.get("usageUnknown"),
                         usagePending=False, events=[*run.state["events"], *events])
        if run.last_seq and events:
            try:
                self.history.append(run.owner, run.id, [dict(event, spentMicros=round(run.state["spentUsd"] * 1e6))
                                                        for event in events])
                run.last_seq = events[-1]["seq"]
            except Exception:
                pass

    def _kill(self, run):
        self._set_key(run, None)
        if run.dead:
            return
        run.dead = True
        if run.process:
            try:
                run.process.kill()
            except OSError:
                pass
            run.messages.put_nowait(None)
        self.cv.notify_all()

    def _handle(self, run, message):
        kind = message["type"]
        if kind == "ack":
            pending = run.waiting
            if not pending or pending["id"] != message["commandId"]:
                raise ValueError("ack")
            if message["ok"]:
                run.version += 1
                if pending["update"]:
                    run.workspace, run.initial = pending["update"]
            pending["answer"] = (message["ok"], message.get("code", "invalid_request"),
                                 message.get("message", "실행 명령을 확인하세요."))
            self.cv.notify_all()
        elif kind == "state":
            state = message["state"]
            for item in state["events"][run.last_seq:]:
                metadata = dict(seq=item["seq"], type=item["type"], phase=item.get("phase", state["phase"]),
                                reason=item.get("reason", "none"), iteration=item["iteration"],
                                spentMicros=round(state["spentUsd"] * 1_000_000))
                self.history.append(run.owner, run.id, [metadata])
                run.last_seq = item["seq"]
            run.state = state
            if state["phase"] in TERMINAL | {"paused"}:
                self._set_key(run, None)
        elif kind == "generate":
            args = message["payload"]
            iteration = args["iteration"]
            if run.inflight or iteration != run.last_call + 1 or run.state["phase"] not in {"running", "pausing"}:
                raise ValueError("call order")
            run.inflight = message["callId"]
            run.last_call = iteration
            provider = run.config["provider"]
            body = dict(provider=provider, model=run.config["model"], question=args["question"],
                        facts=args["facts"], feedback=args["feedback"], charLimit=question(run.workspace, run.config["questionId"])["limit"])
            if args.get("previous"):
                body["previousText"] = args["previous"]["text"]
            if provider in CLOUD_PROVIDERS:
                remaining = Decimal(str(run.config["budgetUsd"])) - Decimal(str(run.state["spentUsd"]))
                body.update(confirmed=True, redactTerms=run.redact,
                            budgetUsd=str(min(remaining, Decimal(str(args["remainingUsd"])))))
                if run.expires <= time.monotonic():
                    run.key = None
            threading.Thread(target=self._generate, args=(run, run.inflight, body, run.key), daemon=True).start()
        else:
            raise ValueError("protocol")

    def _generate(self, run, call, body, key):
        def timed_out():
            with self.cv:
                if not self.closed and not run.dead and run.inflight == call:
                    self._interrupt(run)
                    self._kill(run)

        deadline = threading.Timer(CALL_WAIT, timed_out)
        deadline.daemon = True
        deadline.start()
        usage = None
        try:
            if body["provider"] in CLOUD_PROVIDERS and not key:
                raise DraftError(422, "실행 키를 다시 입력하세요.", "key_required")
            with self.cv:
                if self.closed or run.dead:
                    run.inflight = None
                    return
                if body["provider"] in CLOUD_PROVIDERS:
                    self.history.mark_dispatch(run.owner, run.id)
            result = self.generate(body, key)
            usage = result.get("usage")
            reply = dict(type="result", callId=call, result=result)
        except DraftError as error:
            usage = error.usage
            if usage is None and error.code != "cost_unknown":
                usage = {"costUsd": "0"}
            reply = dict(type="error", callId=call, error=dict(status=error.status, code=error.code, message=str(error), usage=error.usage))
        except Exception:
            code = "cost_unknown" if body["provider"] in CLOUD_PROVIDERS else "provider_error"
            reply = dict(type="error", callId=call, error=dict(status=502, code=code, message="제공자 응답을 확인할 수 없습니다."))
        finally:
            deadline.cancel()
        with self.cv:
            run.inflight = None
            if not self.closed and not run.dead:
                run.messages.put_nowait(wire(reply) + b"\n")
            elif not self.closed and run.dead and usage and run.state.get("usageUnknown"):
                # A verified charge can arrive after the child died. Settle without promoting that draft.
                cost = Decimal(str(usage["costUsd"]))
                spent = Decimal(str(run.state["spentUsd"])) + cost
                phase = run.state["phase"]
                metadata = dict(seq=run.last_seq + 1, type="budget_update", phase=phase, reason="settled",
                                iteration=run.state["iteration"])
                events = [metadata]
                reason = run.state["reason"]
                if phase not in TERMINAL:
                    reason = "input_required"
                    events.append(dict(metadata, seq=run.last_seq + 2, type="run_state", reason=reason))
                rows = [dict(e, spentMicros=round(spent * 1_000_000)) for e in events]
                self.history.append(run.owner, run.id, rows)
                run.last_seq = events[-1]["seq"]
                run.state = dict(run.state, reason=reason, usageUnknown=False, spentUsd=float(spent),
                                 events=[*run.state["events"], *events])

    def delete(self, owner, run_id, payload):
        if not isinstance(payload, dict):
            raise invalid()
        cid, fp = uuid4(payload.get("commandId")), self._fingerprint(payload)
        with self.cv:
            old = self.deleted.get((owner, run_id))
            if old:
                if old[:2] == (cid, fp):
                    return {"id": run_id, "deleted": True}
                raise conflict("command_conflict")
        run = self._lookup(owner, run_id)
        with run.control, self.cv:
            old = self.deleted.get((owner, run_id))
            if old:
                if old == (cid, fp):
                    return {"id": run_id, "deleted": True}
                raise conflict("command_conflict")
            if type(payload.get("baseVersion")) is not int or payload["baseVersion"] != run.version:
                raise conflict()
            if cid in run.receipts:
                raise conflict("command_conflict")
            if (not run.dead and run.state["phase"] not in TERMINAL) or run.inflight or run.state.get("usagePending"):
                raise conflict("invalid_transition")
            self.history.delete(owner, run.id)
            self._kill(run)
            self.runs.pop((owner, run_id), None)
            self.deleted[(owner, run_id)] = (cid, fp)
            if len(self.deleted) > 1000:
                del self.deleted[next(iter(self.deleted))]
            return {"id": run_id, "deleted": True}

    def erase_owner(self, owner):
        # Creation, dispatch, settlement and snapshots also use cv. Never remove an
        # in-flight charge or a command that still owns a run's control lock.
        with self.cv:
            owned = [run for run in self.runs.values() if run.owner == owner]
            if any(run.control.locked() or (not run.dead and run.state["phase"] not in TERMINAL)
                   or run.inflight or run.state.get("usagePending")
                   for run in owned):
                raise WorkerError(409, "run_active", "진행 중인 실행을 종료하거나 취소하고 사용량 정산이 끝날 때까지 기다린 뒤 삭제하세요.")
            count = self.history.erase_owner(owner)
            for run in owned:
                self._kill(run)
                self.runs.pop((owner, run.id), None)
            self.deleted = {key: value for key, value in self.deleted.items() if key[0] != owner}
            return count

    def close(self):
        with self.cv:
            self.closed = True
            processes = list(self.runs.values())
            for run in processes:
                self._kill(run)
            self.runs.clear()
            self.deleted.clear()
        for run in processes:
            if run.process:
                run.process.wait(timeout=5)
            for thread in (run.reader, run.writer):
                if thread and thread.is_alive():
                    thread.join(timeout=2)
