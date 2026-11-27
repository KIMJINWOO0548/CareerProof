import argparse
import hashlib
import json
import os
import re
import secrets
import sqlite3
from http.cookies import SimpleCookie, CookieError
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import BoundedSemaphore
from urllib.parse import urlsplit

from .drafts import DraftError, make_draft
from .history import EVENT_LIMIT, RUN_ID, History, HistoryError
from .receipts import DraftReceipts
from .workers import WorkerManager, WorkerError
from .evidence import extract_document, repo_signals, dart_company
from .committee import review_application

ROOT = Path(__file__).resolve().parent.parent
ASSETS = {
    "/": ("frontend/index.html", "text/html"),
    "/index.html": ("frontend/index.html", "text/html"),
    "/design.css": ("docs/ui/style.css", "text/css"),
    "/app.css": ("frontend/app.css", "text/css"),
    "/app.js": ("frontend/app.js", "text/javascript"),
    "/workspace.js": ("frontend/workspace.js", "text/javascript"),
    "/analysis.js": ("frontend/analysis.js", "text/javascript"),
    "/calibration.js": ("frontend/calibration.js", "text/javascript"),
    "/loop.js": ("frontend/loop.js", "text/javascript"),
    "/journal.js": ("frontend/journal.js", "text/javascript"),
    "/remote-runs.js": ("frontend/remote-runs.js", "text/javascript"),
    "/research.js": ("frontend/research.js", "text/javascript"),
    "/demo.js": ("frontend/demo.js", "text/javascript"),
    "/style-tools.js": ("frontend/style-tools.js", "text/javascript"),
    "/research-ui.js": ("frontend/research-ui.js", "text/javascript"),
    "/committee-ui.js": ("frontend/committee-ui.js", "text/javascript"),
    "/rubric.json": ("frontend/rubric.json", "application/json"),
    "/review.css": ("frontend/review.css", "text/css"),
    "/research.css": ("frontend/research.css", "text/css"),
}
BODY_LIMIT = 1024 * 1024


class LocalApp(ThreadingHTTPServer):
    def __init__(self, address, draft=make_draft, history_path=":memory:", review=review_application):
        super().__init__(address, Handler)
        self.draft = draft
        self.review = review
        self.draft_slot = BoundedSemaphore(1)
        self.history = History(history_path)
        self.receipts = DraftReceipts()
        self.workers = WorkerManager(self.history, self.generate)

    def generate(self, data, key):
        return self.model_request(self.draft, data, key)

    def model_request(self, operation, data, key):
        if not self.draft_slot.acquire(blocking=False):
            raise DraftError(409, "다른 초안 요청을 처리 중입니다.", "provider_busy")
        try:
            return operation(data, key)
        finally:
            self.draft_slot.release()

    def server_close(self):
        super().server_close()
        if hasattr(self, "workers"):
            self.workers.close()
        if hasattr(self, "history"):
            self.history.close()
        if hasattr(self, "receipts"):
            self.receipts.close()


class Handler(BaseHTTPRequestHandler):
    server_version = "CareerProof"
    timeout = 20

    def log_message(self, *args):
        # Query strings, filenames, provider keys and bodies never enter access logs.
        pass

    def respond(self, status, body, content_type, cookie=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                         "img-src 'self' data:; connect-src 'self'; base-uri 'none'; "
                         "object-src 'none'; frame-ancestors 'none'; form-action 'self'")
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (ConnectionError, TimeoutError):
                pass

    def respond_json(self, status, value):
        self.respond(status, json.dumps(value, ensure_ascii=False).encode(), "application/json")

    def valid_host(self):
        port = self.server.server_port
        hosts = {f"localhost:{port}", f"127.0.0.1:{port}"}
        if port == 80:
            hosts.update(("localhost", "127.0.0.1"))
        return self.headers.get("Host") in hosts

    def history_owner(self, initialize=False):
        cookies = SimpleCookie()
        name = f"cp_history_{self.server.server_port}"
        try:
            cookies.load(self.headers.get("Cookie", ""))
        except CookieError:
            cookies.clear()
        token = cookies[name].value if name in cookies else ""
        cookie = None
        if not re.fullmatch("[a-f0-9]{64}", token):
            if not initialize:
                raise HistoryError(401, "로컬 기록 세션을 다시 여세요.")
            token = secrets.token_hex(32)
        if initialize:
            # Renew an existing pre-worker cookie under /api as well. Its digest is stable.
            cookie = f"{name}={token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=2592000"
        return hashlib.sha256(token.encode()).hexdigest(), cookie

    def history_post(self, data):
        if self.path == "/api/history/session":
            _, cookie = self.history_owner(initialize=True)
            self.respond(200, b"{}", "application/json", cookie)
            return
        owner, _ = self.history_owner()
        if self.path == "/api/history/erase":
            if data != {"confirm": "erase-browser-workspace"}:
                raise HistoryError(422, "전체 삭제 확인이 필요합니다.")
            # Draft/committee receipts predate owner sessions. Do not discard or
            # hide a request while its provider charge may still be arriving.
            if not self.server.draft_slot.acquire(blocking=False):
                raise HistoryError(409, "초안·위원회 요청이 진행 중입니다. 응답과 사용량 정산이 끝난 뒤 삭제하세요.")
            try:
                count = self.server.workers.erase_owner(owner)
            finally:
                self.server.draft_slot.release()
            self.respond_json(200, {"deleted": True, "runs": count, "receiptTtlSeconds": 600})
            return
        match = re.fullmatch(rf"/api/history/({RUN_ID})/(open|append|ticket|delete)", self.path)
        if not match:
            raise HistoryError(404, "기록 경로를 찾을 수 없습니다.")
        run, op = match.groups()
        if op == "open":
            self.server.history.open_run(owner, run)
            result = {}
        elif op == "append":
            result = {"lastSeq": self.server.history.append(owner, run, data, client=True)}
        elif op == "delete":
            self.server.history.delete(owner, run, client=True)
            result = {}
        else:
            result = {"token": self.server.history.ticket(owner, run)}
        self.respond_json(200, result)

    def history_get(self):
        owner, _ = self.history_owner()
        if self.path == "/api/history":
            self.respond_json(200, {"runs": self.server.history.list_runs(owner)})
            return
        match = re.fullmatch(rf"/api/history/({RUN_ID})/events(\?follow=1)?", self.path)
        cursor = self.headers.get("Last-Event-ID", "0")
        if not match:
            raise HistoryError(404, "기록 경로를 찾을 수 없습니다.")
        if not re.fullmatch(r"[0-9]{1,4}", cursor) or int(cursor) > EVENT_LIMIT:
            raise HistoryError(400, "열람 시작 순번을 확인하세요.")
        auth = self.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else ""
        run, follow = match.groups()
        rows = self.server.history.replay(owner, run, token, int(cursor), bool(follow))
        batch = "".join(f"id: {row['seq']}\nevent: run_event\ndata: {json.dumps(row)}\n\n" for row in rows)
        self.respond(200, (batch or ": heartbeat\n\n").encode(), "text/event-stream")

    def workers_get(self):
        owner, _ = self.history_owner()
        manager = self.server.workers
        if self.path == "/api/runs":
            self.respond_json(200, {"available": manager.available, "runs": manager.list(owner)})
            return
        match = re.fullmatch(rf"/api/runs/({RUN_ID})(\?state=1)?", self.path)
        if not match:
            raise HistoryError(404, "실행을 찾을 수 없습니다.")
        snap = manager.get(owner, match[1], summary=bool(match[2]))
        self.respond_json(200, snap)

    def workers_post(self, data):
        owner, _ = self.history_owner()
        if not isinstance(data, dict):
            raise HistoryError(422, "실행 설정은 JSON 객체로 입력하세요.")
        manager = self.server.workers
        key = self.headers.get("X-LLM-API-Key")
        if self.path == "/api/runs":
            result = manager.create(owner, data, key)
        else:
            match = re.fullmatch(rf"/api/runs/({RUN_ID})/(commands|delete)", self.path)
            if not match:
                raise HistoryError(404, "실행 경로를 찾을 수 없습니다.")
            result = (manager.command(owner, match[1], data, key) if match[2] == "commands"
                      else manager.delete(owner, match[1], data))
        self.respond_json(200, result or {})

    def do_GET(self):
        if not self.valid_host():
            self.respond_json(403, {"error": "로컬 작업 주소를 사용하세요."})
            return
        if self.command == "GET" and self.path.startswith(("/api/history", "/api/runs")):
            try:
                if self.path.startswith("/api/runs"):
                    self.workers_get()
                else:
                    self.history_get()
            except WorkerError as error:
                self.respond_json(error.status, {"error": str(error), "code": error.code})
            except HistoryError as error:
                self.respond_json(error.status, {"error": str(error)})
            except sqlite3.Error:
                self.respond_json(503, {"error": "로컬 기록 저장소를 읽을 수 없습니다."})
            return
        resource = ASSETS.get(urlsplit(self.path).path)
        if resource is None:
            self.respond_json(404, {"error": "자료를 찾을 수 없습니다."})
            return
        path, content_type = resource
        self.respond(200, (ROOT / path).read_bytes(), content_type)

    do_HEAD = do_GET

    def do_POST(self):
        try:
            if not self.valid_host() or self.headers.get("Origin") != "http://" + self.headers["Host"]:
                raise DraftError(403, "현재 로컬 작업 화면에서 요청하세요.")
            history = self.path.startswith("/api/history/")
            workers = self.path == "/api/runs" or self.path.startswith("/api/runs/")
            evidence = self.path in {"/api/extract", "/api/github", "/api/dart"}
            if self.path not in {"/api/draft", "/api/committee"} and not history and not workers and not evidence:
                raise DraftError(404, "요청 경로를 찾을 수 없습니다.")
            if self.headers.get("X-CareerProof-Request") != "1":
                raise DraftError(403, "초안 요청을 확인할 수 없습니다.")
            if self.headers.get_content_type() != "application/json" or self.headers.get("Transfer-Encoding"):
                raise DraftError(415, "JSON 본문을 사용하세요.")
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                raise DraftError(400, "요청 크기가 올바르지 않습니다.") from None
            limit = 10 * 1024 * 1024 if workers or self.path == "/api/extract" else BODY_LIMIT
            if not 0 < length <= limit:
                raise DraftError(413, "초안 요청 크기를 줄이세요.")
            try:
                data = json.loads(self.rfile.read(length).decode("utf-8"))
            except (ValueError, RecursionError):
                raise DraftError(400, "JSON 요청을 읽을 수 없습니다.") from None
            if history:
                self.history_post(data)
                return
            if workers:
                self.workers_post(data)
                return
            if evidence:
                if self.path == "/api/extract":
                    result = extract_document(data)
                elif self.path == "/api/github":
                    result = repo_signals(data)
                else:
                    result = dart_company(data, self.headers.get("X-DART-API-Key"))
                self.respond_json(200, result)
                return
            key = self.headers.get("X-LLM-API-Key")
            if not isinstance(data, dict):
                raise DraftError(422, "요청 항목을 JSON 객체로 입력하세요.")
            operation = self.server.review if self.path == "/api/committee" else self.server.draft
            identity = {"route": self.path, "provider": data.get("provider"), "payload": data}
            result = self.server.receipts.execute(self.headers.get("X-CareerProof-Command"), identity, key,
                                                  lambda: self.server.model_request(operation, data, key))
            self.respond_json(HTTPStatus.OK, result)
        except WorkerError as error:
            self.respond_json(error.status, {"error": str(error), "code": error.code})
        except DraftError as error:
            payload = {"error": str(error), "code": error.code}
            if error.usage is not None:
                payload["usage"] = error.usage
            self.respond_json(error.status, payload)
        except HistoryError as error:
            self.respond_json(error.status, {"error": str(error)})
        except sqlite3.Error:
            self.respond_json(503, {"error": "로컬 기록 저장소를 사용할 수 없습니다."})


def main():
    parser = argparse.ArgumentParser(description="CareerProof 로컬 워크벤치")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    host = "0.0.0.0" if os.environ.get("CAREERPROOF_CONTAINER") == "1" else "127.0.0.1"
    state_dir = Path(os.environ.get("CAREERPROOF_DATA_DIR") or Path.home() / ".careerproof")
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    with LocalApp((host, args.port), history_path=state_dir / "history.sqlite3") as server:
        print(f"CareerProof http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
