"""Exercise the local pairing API without invoking an assistant or provider."""
import http.client
import json
import re
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

from backend.__main__ import LocalApp


class AgentTaskTests(unittest.TestCase):
    def setUp(self):
        self.server = LocalApp(("127.0.0.1", 0))
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01})
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.port = self.server.server_port
        self.data = {"question": "예시회사에서의 역할은?", "redactTerms": ["예시회사"],
                     "facts": [{"id": "f1", "text": "메일 pilot@example.test 로 일정을 알렸다."}]}

    def post(self, route, data, owner=None, **overrides):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        headers = {"Origin": f"http://127.0.0.1:{self.port}", "Content-Type": "application/json",
                   "X-CareerProof-Request": "1"}
        if owner:
            headers["Cookie"] = f"cp_history_{self.port}=" + owner * 64
        try:
            conn.request("POST", "/api/" + route, json.dumps(data), {**headers, **overrides})
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def start(self, owner="a"):
        status, result = self.post("agent/start", self.data, owner)
        self.assertEqual(status, 200, result)
        self.assertRegex(result["code"], r"^[A-Za-z0-9_-]{43}$")
        return result

    def test_mask_submit_and_owner_restore(self):
        start = self.start()
        code = {"code": start["code"]}
        self.assertEqual(self.post("agent/result", code, "a"), (200, {"status": "pending"}))
        status, shared = self.post("agent/read", code)
        self.assertEqual(status, 200)
        self.assertEqual(shared["context"], start["preview"])
        self.assertTrue(shared["instructions"])
        snapshot = json.dumps(shared["context"], ensure_ascii=False)
        self.assertNotIn("예시회사", snapshot)
        self.assertNotIn("pilot@example.test", snapshot)
        mask = re.search(r"\[CPMASK_\w+\]", shared["context"]["facts"][0]["text"])[0]
        sibling = self.start()
        self.assertEqual(self.post("agent/submit", {"code": sibling["code"], "draft": {
            "text": mask, "factIds": ["f1"]}})[0], 422)
        self.assertEqual(self.post("agent/result", {"code": sibling["code"]}, "a"),
                         (200, {"status": "pending"}))
        draft = {"text": mask + " 로 알렸다.", "factIds": ["f1"]}
        def submit(value):
            return self.post("agent/submit", {**code, "draft": value})

        for invalid in ({"text": "문장", "factIds": []}, {**draft, "factIds": ["f2"]},
                        {**draft, "text": "[CPMASK_other_1]"}, {**draft, "text": "pilot@example.test"}):
            self.assertEqual(submit(invalid)[0], 422)
        self.assertEqual(submit(draft), (200, {"status": "received"}))
        self.assertEqual(submit({**draft, "text": "  " + draft["text"]})[0], 200)
        self.assertEqual(submit({**draft, "text": "다른 문장"})[0], 409)
        for _ in range(2):
            self.assertEqual(self.post("agent/result", code, "a"),
                             (200, {"status": "ready", "text": "pilot@example.test 로 알렸다.", "factIds": ["f1"]}))

    def test_simultaneous_claims_reserve_one_execution(self):
        code = {"code": self.start()["code"]}
        expected = self.post("agent/read", code)
        barrier = threading.Barrier(2)

        def claim():
            barrier.wait(timeout=3)
            return self.post("agent/claim", code)

        with ThreadPoolExecutor(max_workers=2) as executor:
            calls = [executor.submit(claim) for _ in range(2)]
            replies = [call.result(timeout=5) for call in calls]
        self.assertCountEqual([status for status, _ in replies], [200, 409])
        self.assertIn(expected, replies)
        self.assertEqual(self.post("agent/result", code, "a"), (200, {"status": "pending"}))
        self.assertEqual(self.post("agent/cancel", code, "a")[0], 200)
        self.assertEqual(self.post("agent/claim", code)[0], 404)
        self.assertEqual(self.post("agent/claim", {"code": self.start()["code"]})[0], 200)

    def test_cannot_claim_after_interactive_submission(self):
        code = {"code": self.start()["code"]}
        draft = {"text": "연락했다.", "factIds": ["f1"]}
        self.assertEqual(self.post("agent/submit", {**code, "draft": draft})[0], 200)
        self.assertEqual(self.post("agent/claim", code)[0], 409)
        self.assertEqual(self.post("agent/result", code, "a"), (200, {"status": "ready", **draft}))

    def test_auth_isolation_cancel_and_erase(self):
        self.assertEqual(self.post("agent/start", self.data)[0], 401)
        first = {"code": self.start()["code"]}
        second = {"code": self.start("b")["code"]}
        for headers in ({"Origin": "http://other.invalid"}, {"Host": "other.invalid"},
                        {"X-CareerProof-Request": ""}):
            self.assertEqual(self.post("agent/read", first, **headers)[0], 403)
        for op in ("cancel", "result"):
            self.assertEqual(self.post("agent/" + op, first)[0], 401)
            self.assertEqual(self.post("agent/" + op, first, "b")[0], 404)
        self.assertEqual(self.post("history/erase", {"confirm": "erase-browser-workspace"}, "a")[0], 200)
        self.assertEqual(self.post("agent/read", first)[0], 404)
        self.assertEqual(self.post("agent/read", second)[0], 200)
        self.assertEqual(self.post("agent/cancel", second, "b"), (200, {}))
        self.assertEqual(self.post("agent/read", second)[0], 404)

    def test_idle_expiry_and_caps(self):
        store = self.server.agent_tasks
        store.ttl = .25
        store.owner_limit = 1
        store.total_limit = 2
        first = self.start()["code"]
        self.assertEqual(self.post("agent/start", self.data, "a")[0], 429)
        self.start("b")
        self.assertEqual(self.post("agent/start", self.data, "c")[0], 429)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            with store.condition:
                if not store.tasks:
                    break
            time.sleep(.015)
        with store.condition:
            self.assertFalse(store.tasks)
        self.assertEqual(self.post("agent/result", {"code": first}, "a")[0], 404)

    def test_only_selected_inputs_allowed(self):
        for data in ({**self.data, "previousText": "다른 문항"}, {**self.data, "documentKind": {}},
                     {**self.data, "facts": []}, {**self.data, "redactTerms": "회사"}):
            self.assertEqual(self.post("agent/start", data, "a")[0], 422)
