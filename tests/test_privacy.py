"""Synthetic owner-isolation and complete-erasure checks; never touch user files."""
import hashlib
import http.client
import json
import threading
import unittest
from uuid import uuid4

from backend.__main__ import LocalApp
from backend.history import History, HistoryError
from backend.workers import Run, WorkerError, WorkerManager


def event(phase="completed", reason="none", kind="run_state"):
    return dict(seq=1, type=kind, phase=phase, reason=reason, iteration=0, spentMicros=0)


class PrivacyTests(unittest.TestCase):
    def test_all_rows_owner_scope_and_cascade(self):
        history = History()
        self.addCleanup(history.close)
        for _ in range(36):
            rid = str(uuid4())
            history.open_run("owner", rid)
            history.append("owner", rid, [event()])
        history.open_run("other", rid)
        history.append("other", rid, [event()])
        self.assertEqual(len(history.list_runs("owner")), 30)
        self.assertEqual(history.erase_owner("owner"), 36)
        self.assertEqual(history.list_runs("owner"), [])
        self.assertEqual(len(history.list_runs("other")), 1)
        self.assertEqual(history.db.execute("SELECT count(*) FROM run_events").fetchone()[0], 1)

    def test_active_pending_and_historical_unknown(self):
        history = History()
        self.addCleanup(history.close)
        rid = str(uuid4())
        history.open_worker("owner", rid)
        history.append("owner", rid, [event("running")])
        history.mark_dispatch("owner", rid)
        with self.assertRaises(HistoryError):
            history.erase_owner("owner")
        history.append("owner", rid, [dict(event("paused", "cost_unknown", "budget_update"), seq=2)])
        history.mark_dispatch("owner", rid)
        with self.assertRaises(HistoryError):
            history.erase_owner("owner")
        # A restart records pending dispatch as historical cost_unknown.
        with history.condition, history.db:
            history._interrupt_lost_workers()
        self.assertEqual(history.erase_owner("owner"), 1)
        self.assertEqual(history.db.execute("SELECT count(*) FROM worker_runs").fetchone()[0], 0)

    def test_stale_tab_running_metadata_does_not_prevent_confirmed_erasure(self):
        history = History()
        self.addCleanup(history.close)
        rid = str(uuid4())
        history.open_run("owner", rid)
        history.append("owner", rid, [event("running")])
        self.assertEqual(history.erase_owner("owner"), 1)

    def test_worker_snapshot_lock_and_inflight_protection(self):
        history = History()
        manager = WorkerManager(history, lambda *_: None)
        self.addCleanup(history.close)
        self.addCleanup(manager.close)
        rid = str(uuid4())
        history.open_worker("owner", rid)
        history.append("owner", rid, [event()])
        run = Run("owner", rid, {}, {}, {}, {"phase": "completed"})
        manager.runs[("owner", rid)] = run
        other = Run("other", str(uuid4()), {}, {}, {}, {"phase": "running"})
        manager.runs[("other", other.id)] = other
        for flag in ("inflight", "usagePending", "control"):
            if flag == "control": run.control.acquire()
            elif flag == "usagePending": run.state[flag] = True
            else: run.inflight = "synthetic-call"
            with self.assertRaises(WorkerError): manager.erase_owner("owner")
            self.assertIn(("owner", rid), manager.runs)
            if flag == "control": run.control.release()
            elif flag == "usagePending": run.state[flag] = False
            else: run.inflight = None
        run.dead = True
        run.state["usageUnknown"] = True
        self.assertEqual(manager.erase_owner("owner"), 1)
        self.assertNotIn(("owner", rid), manager.runs)
        self.assertIn(("other", other.id), manager.runs)

    def test_http_requires_origin_cookie_confirmation_and_idle_provider(self):
        server = LocalApp(("127.0.0.1", 0))
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .01})
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        origin = f"http://127.0.0.1:{server.server_port}"
        token = "a" * 64
        headers = {"Origin": origin, "Content-Type": "application/json", "X-CareerProof-Request": "1",
                   "Cookie": f"cp_history_{server.server_port}={token}"}
        owner = hashlib.sha256(token.encode()).hexdigest()
        rid = str(uuid4())
        server.history.open_run(owner, rid)
        server.history.append(owner, rid, [event()])

        def call(body, **changes):
            conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            try:
                conn.request("POST", "/api/history/erase", json.dumps(body), {**headers, **changes})
                response = conn.getresponse()
                return response.status, json.loads(response.read())
            finally: conn.close()

        confirmed = {"confirm": "erase-browser-workspace"}
        self.assertEqual(call(confirmed, Origin="http://elsewhere.invalid")[0], 403)
        self.assertEqual(call(confirmed, Cookie="")[0], 401)
        self.assertEqual(call({})[0], 422)
        server.draft_slot.acquire()
        try: self.assertEqual(call(confirmed)[0], 409)
        finally: server.draft_slot.release()
        self.assertEqual(len(server.history.list_runs(owner)), 1)
        status, result = call(confirmed)
        self.assertEqual(status, 200)
        self.assertEqual(result, {"deleted": True, "runs": 1, "receiptTtlSeconds": 600})
        self.assertEqual(call(confirmed)[0], 200)


if __name__ == "__main__":
    unittest.main()
