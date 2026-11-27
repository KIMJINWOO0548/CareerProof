import json
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "careerproof_mcp.py"


def request(method, req_id=None, **params):
    message = {"jsonrpc": "2.0", "method": method, "params": params}
    if req_id is not None:
        message["id"] = req_id
    return json.dumps(message).encode() + b"\n"


def handshake(version="2025-11-25"):
    return request("initialize", 1, protocolVersion=version, capabilities={},
                   clientInfo={"name": "test", "version": "1"}) + request("notifications/initialized")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.received.append((self.path, self.headers, data))
        code = data["code"]
        if code == "redirect":
            self.send_response(307)
            self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/other")
            self.end_headers()
            return
        self.send_response(404 if code == "invalid" else 200)
        self.end_headers()
        if code == "invalid":
            self.wfile.write(b"private-error-detail")
        elif code == "oversized":
            self.wfile.write(b"x" * (1024 * 1024 + 1))
        elif self.path == "/api/agent/read":
            self.wfile.write(json.dumps({"instructions": "Use the confirmed facts.",
                                         "context": {"facts": [{"id": "F1", "text": "확인한 사실"}]},
                                         "private": "omit"}).encode())
        else:
            self.wfile.write(b'{"status":"received"}')


class McpStdioTest(unittest.TestCase):
    def setUp(self):
        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.server.received = []
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(self.server.shutdown)

    def run_bridge(self, wire):
        proc = subprocess.run([sys.executable, str(SCRIPT), "--port", str(self.server.server_port)],
                              input=wire, capture_output=True, timeout=12, check=False)
        self.assertEqual(proc.stderr, b"")
        self.assertEqual(proc.returncode, 0)
        return [json.loads(line) for line in proc.stdout.splitlines()]

    def test_tools_round_trip(self):
        args = {"code": "test", "text": "검토용 초안", "factIds": ["F1"]}
        replies = self.run_bridge(handshake() + request("ping", 2) + request("tools/list", 3)
            + request("tools/call", 4, name="read_writing_task", arguments={"code": "test"})
            + request("tools/call", 5, name="submit_draft", arguments=args))
        self.assertEqual([r["id"] for r in replies], [1, 2, 3, 4, 5])
        self.assertEqual(replies[0]["result"]["capabilities"], {"tools": {}})
        self.assertEqual(replies[1]["result"], {})
        self.assertEqual([t["name"] for t in replies[2]["result"]["tools"]], ["read_writing_task", "submit_draft"])
        task, receipt = [json.loads(r["result"]["content"][0]["text"]) for r in replies[3:]]
        self.assertEqual(set(task), {"context", "instructions"})
        self.assertEqual(task["context"]["facts"][0]["text"], "확인한 사실")
        self.assertEqual(receipt, {"status": "received"})
        calls = self.server.received
        self.assertEqual([(p, d) for p, _, d in calls], [
            ("/api/agent/read", {"code": "test"}),
            ("/api/agent/submit", {"code": "test", "draft": {"text": args["text"], "factIds": ["F1"]}})])
        for _, headers, _ in calls:
            host = f"127.0.0.1:{self.server.server_port}"
            self.assertEqual(headers["Host"], host)
            self.assertEqual(headers["Origin"], "http://" + host)
            self.assertEqual(headers["X-CareerProof-Request"], "1")
            self.assertIsNone(headers["Authorization"])

    def test_negotiation_and_errors(self):
        replies = self.run_bridge(request("tools/list", 0) + handshake("future") + request("unknown", 2)
            + request("tools/call", 3, name="unknown") + request("notifications/ignored")
            + request("tools/call", 4, name="submit_draft", arguments={"code": "test"}))
        self.assertEqual(replies[0]["error"]["code"], -32002)
        self.assertEqual(replies[1]["result"]["protocolVersion"], "2025-11-25")
        self.assertEqual([r["error"]["code"] for r in replies[2:4]], [-32601, -32602])
        self.assertTrue(replies[4]["result"]["isError"])
        self.assertEqual(self.server.received, [])
        self.assertEqual(self.run_bridge(handshake("2025-06-18"))[0]["result"]["protocolVersion"], "2025-06-18")

    def test_http_failure_and_framing_recovery(self):
        wire = handshake() + b'x' * (1024 * 1024 + 10) + b'\n{\n'
        for i, code in enumerate(("redirect", "invalid", "oversized")):
            wire += request("tools/call", i + 4, name="read_writing_task", arguments={"code": code})
        replies = self.run_bridge(wire + request("ping", 7))
        self.assertEqual([r["error"]["code"] for r in replies[1:3]], [-32600, -32700])
        self.assertTrue(all(r["result"]["isError"] for r in replies[3:6]))
        self.assertNotIn("private-error-detail", str(replies))
        self.assertEqual([p for p, _, _ in self.server.received], ["/api/agent/read"] * 3)
        self.assertEqual(replies[-1]["result"], {})


if __name__ == "__main__":
    unittest.main()
