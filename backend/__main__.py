import argparse
import json
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import BoundedSemaphore
from urllib.parse import urlsplit

from .drafts import DraftError, make_draft

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
}
BODY_LIMIT = 256 * 1024


class LocalApp(ThreadingHTTPServer):
    def __init__(self, address, draft=make_draft):
        super().__init__(address, Handler)
        self.draft = draft
        self.draft_slot = BoundedSemaphore(1)


class Handler(BaseHTTPRequestHandler):
    server_version = "CareerProof"
    timeout = 20

    def log_message(self, *args):
        # Query strings, filenames, provider keys and bodies never enter access logs.
        pass

    def respond(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                         "img-src 'self' data:; connect-src 'self'; base-uri 'none'; "
                         "object-src 'none'; frame-ancestors 'none'; form-action 'self'")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def respond_json(self, status, value):
        self.respond(status, json.dumps(value, ensure_ascii=False).encode(), "application/json")

    def valid_host(self):
        port = self.server.server_port
        hosts = {f"localhost:{port}", f"127.0.0.1:{port}"}
        if port == 80:
            hosts.update(("localhost", "127.0.0.1"))
        return self.headers.get("Host") in hosts

    def do_GET(self):
        if not self.valid_host():
            self.respond_json(403, {"error": "로컬 작업 주소를 사용하세요."})
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
            if self.path != "/api/draft":
                raise DraftError(404, "요청 경로를 찾을 수 없습니다.")
            if self.headers.get("X-CareerProof-Request") != "1":
                raise DraftError(403, "초안 요청을 확인할 수 없습니다.")
            if self.headers.get_content_type() != "application/json" or self.headers.get("Transfer-Encoding"):
                raise DraftError(415, "JSON 본문을 사용하세요.")
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                raise DraftError(400, "요청 크기가 올바르지 않습니다.") from None
            if not 0 < length <= BODY_LIMIT:
                raise DraftError(413, "초안 요청 크기를 줄이세요.")
            try:
                data = json.loads(self.rfile.read(length).decode("utf-8"))
            except (ValueError, RecursionError):
                raise DraftError(400, "JSON 요청을 읽을 수 없습니다.") from None
            if not self.server.draft_slot.acquire(blocking=False):
                raise DraftError(409, "다른 초안 요청을 처리 중입니다.")
            try:
                result = self.server.draft(data, self.headers.get("X-LLM-API-Key"))
            finally:
                self.server.draft_slot.release()
            self.respond_json(HTTPStatus.OK, result)
        except DraftError as error:
            self.respond_json(error.status, {"error": str(error)})


def main():
    parser = argparse.ArgumentParser(description="CareerProof 로컬 워크벤치")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    host = "0.0.0.0" if os.environ.get("CAREERPROOF_CONTAINER") == "1" else "127.0.0.1"
    with LocalApp((host, args.port)) as server:
        print(f"CareerProof http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
