"""Run metadata survives restart and can be replayed without persisting private input."""

import hashlib
import http.client
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

from backend.__main__ import LocalApp
from backend.history import History, HistoryError


def event(seq, **changes):
    return dict({"seq": seq, "type": "run_state", "phase": "running",
                 "reason": "none", "iteration": 1, "spentMicros": 0}, **changes)


class JournalTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "history.sqlite3"
        self.history = History(self.path)
        self.addCleanup(lambda: self.history.close())
        self.owner = hashlib.sha256(b"fake session").hexdigest()
        self.run = str(uuid4())
        self.history.open_run(self.owner, self.run)

    def append(self, *rows):
        return self.history.append(self.owner, self.run, list(rows))

    def replay(self, cursor):
        token = self.history.ticket(self.owner, self.run)
        return self.history.replay(self.owner, self.run, token, cursor, False)

    def test_contiguous_idempotent_append_and_restart(self):
        self.append(event(1))
        self.append(event(1), event(2, phase="paused", reason="user"))
        with self.assertRaises(HistoryError) as conflict:
            self.append(event(2))
        self.assertEqual(conflict.exception.status, 409)
        with self.assertRaises(HistoryError):
            self.append(event(3), event(5))
        self.assertEqual([row["seq"] for row in self.replay(0)], [1, 2])
        old_ticket = self.history.ticket(self.owner, self.run)
        self.history.close()
        self.history = History(self.path)
        self.assertEqual(self.replay(1), [event(2, phase="paused", reason="user")])
        with self.assertRaises(HistoryError):
            self.history.replay(self.owner, self.run, old_ticket, 0, False)

    def test_owner_ticket_cursor_and_delete(self):
        self.append(event(1))
        self.assertFalse(self.history.list_runs("other"))
        token = self.history.ticket(self.owner, self.run)
        with self.assertRaises(HistoryError):
            self.history.replay("other", self.run, token, 0, False)
        with self.assertRaises(HistoryError):
            self.replay(2)
        self.history.delete("other", self.run)
        self.assertEqual(len(self.history.list_runs(self.owner)), 1)
        self.history.delete(self.owner, self.run)
        with self.assertRaises(HistoryError):
            self.replay(0)
        self.assertEqual(self.history.db.execute("SELECT count(*) FROM run_events").fetchone()[0], 0)

    def test_rejects_free_text_before_any_database_write(self):
        marker = "가상개인본문_MARKER"
        for change in [{"text": marker}, {"reason": marker}, {"type": marker}, {"phase": marker}, {"iteration": True}]:
            with self.assertRaises(HistoryError):
                self.append(event(1, **change))
        self.assertEqual(self.replay(0), [])
        self.assertNotIn(marker.encode(), self.path.read_bytes())

    def test_concurrent_redelivery_and_follow(self):
        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(lambda _: self.append(event(1)), range(5)))
            self.assertEqual(results, [1] * 5)
            token = self.history.ticket(self.owner, self.run)
            follow = pool.submit(self.history.replay, self.owner, self.run, token, 1, True)
            self.append(event(2))
            self.assertEqual(follow.result(timeout=3), [event(2)])


class HistoryHTTPTests(unittest.TestCase):
    def test_cookie_bearer_reconnect_and_origin(self):
        server = LocalApp(("127.0.0.1", 0))
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02})
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        origin = "http://127.0.0.1:" + str(server.server_port)
        headers = {"Origin": origin, "Content-Type": "application/json", "X-CareerProof-Request": "1"}

        def call(method, path, body=None, **extra):
            conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            try:
                conn.request(method, "/api/history" + path, None if body is None else json.dumps(body), {**headers, **extra})
                res = conn.getresponse()
                return res.status, res.headers, res.read().decode()
            finally:
                conn.close()

        status, response, _ = call("POST", "/session", {})
        self.assertEqual(status, 200)
        self.assertIn("HttpOnly", response["Set-Cookie"])
        headers["Cookie"] = response["Set-Cookie"].split(";")[0]
        run = "/" + str(uuid4())
        self.assertEqual(call("POST", run + "/open", {}, Origin="http://invalid.local")[0], 403)
        self.assertEqual(call("POST", run + "/open", {})[0], 200)
        self.assertEqual(call("POST", run + "/append", [event(1), event(2)])[0], 200)
        auth = "Bearer " + json.loads(call("POST", run + "/ticket", {})[2])["token"]
        self.assertEqual(call("GET", run + "/events")[0], 401)
        status, response, body = call("GET", run + "/events", Authorization=auth, **{"Last-Event-ID": "1"})
        self.assertEqual((status, response.get_content_type()), (200, "text/event-stream"))
        self.assertIn("id: 2\n", body)
        self.assertNotIn("id: 1\n", body)
        self.assertEqual(call("GET", run + "/events", Authorization=auth, **{"Last-Event-ID": "2"})[2], ": heartbeat\n\n")
        self.assertEqual(json.loads(call("GET", "")[2])["runs"][0]["seq"], 2)
        self.assertEqual(call("POST", run + "/delete", {})[0], 200)
        self.assertEqual(json.loads(call("GET", "")[2])["runs"], [])
