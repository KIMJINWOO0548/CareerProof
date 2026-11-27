import json
import shutil
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4
from unittest.mock import patch

from backend.drafts import PRICING
from backend.history import History
from backend.workers import WorkerError, WorkerManager


FACT = "가상장치의 재연결 시험 12건을 담당했습니다."


def start_payload(provider="ollama", **change):
    workspace = {"format":"careerproof-workspace", "version":1, "company":"가상조직", "role":"시험",
                 "facts":[{"id":"F-1", "text":FACT, "verified":True, "source":"가상 기록"}],
                 "questions":[{"id":"q1", "title":"시험 경험", "kind":"self_intro", "limit":500,
                               "rule":{"maxChars":500}, "revisions":[], "headRevisionId":None, "approvedRevisionId":None}]}
    return dict({"runId":str(uuid4()), "commandId":str(uuid4()), "workspace":workspace, "questionId":"q1",
                 "initial":{"text":"", "factIds":["F-1"]}, "maxIterations":1, "target":None,
                 "provider":provider, "model":PRICING["model"] if provider == "anthropic" else "test:local",
                 "budgetUsd":0.02, "confirmed":True}, **change)


def action(kind, snap, **fields):
    return dict(kind=kind, commandId=str(uuid4()), baseVersion=snap["version"], **fields)


@unittest.skipUnless(shutil.which("node"), "Server worker requires Node.js")
class WorkerIntegration(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "history.sqlite3"
        self.history = History(self.path)
        self.addCleanup(self.history.close)
        self.calls, self.started, self.release = [], threading.Event(), threading.Event()

        def generate(body, key):
            self.calls.append((body, key))
            self.started.set()
            self.release.wait(timeout=5)
            usage = {"inputTokens":10, "outputTokens":8, "costUsd":"0.000050"} if key else None
            return {"text":FACT, "factIds":["F-1"], "usage":usage}

        self.manager = WorkerManager(self.history, generate)
        self.addCleanup(self.manager.close)
        self.addCleanup(self.release.set)
        self.owner = "hash-a"

    def wait(self, run, predicate):
        end = time.monotonic() + 6
        while time.monotonic() < end:
            snap = self.manager.get(self.owner, run)
            if predicate(snap["state"]):
                return snap
            time.sleep(0.015)
        self.fail("Worker did not reach expected state: " + str(snap["state"]["phase"]))

    def test_detached_completion_privacy_and_owner(self):
        p = start_payload()
        initial = self.manager.create(self.owner, p)
        self.assertEqual(initial["version"], 1)
        self.assertTrue(self.started.wait(3))
        self.assertEqual(self.manager.list(self.owner)[0]["id"], p["runId"])
        self.assertEqual(self.manager.list("hash-b"), [])
        with self.assertRaises(WorkerError) as missing:
            self.manager.get("hash-b", p["runId"])
        self.assertEqual(missing.exception.status, 404)
        self.assertNotIn("workspace", self.manager.get(self.owner, p["runId"], summary=True))
        with self.assertRaises(WorkerError) as conflict:
            self.manager.create(self.owner, start_payload())
        self.assertEqual(conflict.exception.code, "run_active")
        replay = self.manager.create(self.owner, p)
        self.assertEqual(initial, replay)
        self.release.set()
        finished = self.wait(p["runId"], lambda state: state["phase"] == "completed")
        self.assertEqual(finished["state"]["best"]["text"], FACT)
        self.assertEqual(len(self.calls), 1)
        events = self.history.list_runs(self.owner)
        self.assertEqual(events[0]["phase"], "completed")
        self.assertNotIn(FACT.encode(), self.path.read_bytes())

    def test_two_tabs_pause_edit_resume_compare_and_swap(self):
        p = start_payload(maxIterations=2)
        start = self.manager.create(self.owner, p)
        self.assertTrue(self.started.wait(3))
        rid = start["id"]
        pause = action("pause", start)
        paused = self.manager.command(self.owner, rid, pause)
        self.assertEqual(paused["state"]["phase"], "pausing")
        self.assertEqual(self.manager.command(self.owner, rid, pause), paused)
        self.release.set()
        paused = self.wait(rid, lambda s: s["phase"] == "paused")
        edit = action("edit", paused, initial={"text":FACT, "factIds":["F-1"]}, workspace=paused["workspace"], baseRevisionId=None)
        competing = dict(edit, commandId=str(uuid4()))
        with ThreadPoolExecutor(max_workers=2) as callers:
            futures = [callers.submit(self.manager.command, self.owner, rid, cmd) for cmd in (edit, competing)]
            winners = [f for f in futures if not f.exception()]
            losers = [f.exception() for f in futures if f.exception()]
        self.assertEqual(len(winners), 1)
        self.assertEqual([e.code for e in losers], ["stale_version"])
        saved = winners[0].result()
        q = saved["workspace"]["questions"][0]
        self.assertEqual(len(q["revisions"]), 1)
        resume = action("resume", saved, workspace=saved["workspace"], initial=saved["initial"], baseRevisionId=q["headRevisionId"])
        self.manager.command(self.owner, rid, resume)
        final = self.wait(rid, lambda s: s["phase"] == "completed")
        approve = action("approve", final, workspace=final["workspace"], baseRevisionId=q["headRevisionId"],
                         revisionId=q["headRevisionId"])
        approved = self.manager.command(self.owner, rid, approve)
        self.assertEqual(approved["workspace"]["questions"][0]["approvedRevisionId"], q["headRevisionId"])
        self.assertEqual(self.manager.command(self.owner, rid, approve), approved)
        deletion = action("delete", approved)
        self.assertTrue(self.manager.delete(self.owner, rid, deletion)["deleted"])
        self.assertTrue(self.manager.delete(self.owner, rid, deletion)["deleted"])
        self.assertEqual(self.history.list_runs(self.owner), [])

    def test_late_cloud_settlement_survives_cancel(self):
        p = start_payload("anthropic")
        start = self.manager.create(self.owner, p, "fake-private-key")
        self.assertTrue(self.started.wait(3))
        rid = start["id"]
        stopped = self.manager.command(self.owner, rid, action("cancel", start))
        self.assertEqual(stopped["state"]["phase"], "cancelled")
        self.assertTrue(stopped["state"]["usagePending"])
        with self.assertRaises(WorkerError):
            self.manager.delete(self.owner, rid, action("delete", stopped))
        self.release.set()
        final = self.wait(rid, lambda s: s["phase"] == "cancelled" and not s["usagePending"])
        self.assertAlmostEqual(final["state"]["spentUsd"], 0.00005)
        self.assertIsNone(final["state"]["best"])
        self.assertNotIn("fake-private-key", json.dumps(final))
        self.assertNotIn(b"fake-private-key", self.path.read_bytes())

    def test_cloud_pause_requires_fresh_consent_and_key(self):
        p = start_payload("anthropic", maxIterations=2, redactTerms=["가상이름"])
        s = self.manager.create(self.owner, p, "first-key")
        self.assertTrue(self.started.wait(3))
        self.manager.command(self.owner, s["id"], action("pause", s))
        self.release.set()
        paused = self.wait(s["id"], lambda state: state["phase"] == "paused")
        resume = action("resume", paused, workspace=p["workspace"], initial=p["initial"], baseRevisionId=None, confirmed=True)
        with self.assertRaises(WorkerError) as missing:
            self.manager.command(self.owner, s["id"], resume)
        self.assertEqual(missing.exception.code, "key_required")
        self.manager.command(self.owner, s["id"], dict(resume, commandId=str(uuid4())), "second-key")
        final = self.wait(s["id"], lambda st: st["phase"] == "completed")
        self.assertAlmostEqual(final["state"]["spentUsd"], 0.00010)
        self.assertEqual([key for _, key in self.calls], ["first-key", "second-key"])
        self.assertEqual(self.calls[1][0]["redactTerms"], ["가상이름"])
        self.assertEqual(self.calls[1][0]["budgetUsd"], "0.01995")

    def test_invalid_workspace_creates_no_paid_attempt(self):
        p = start_payload("anthropic")
        p["workspace"]["format"] = "unknown"
        with self.assertRaises(WorkerError):
            self.manager.create(self.owner, p, "test-key")
        self.assertEqual(self.calls, [])
        self.assertEqual(self.manager.list(self.owner), [])
        self.assertEqual(self.history.list_runs(self.owner), [])

    def test_worker_timeout_keeps_unknown_charge_until_late_settlement(self):
        p = start_payload("anthropic")
        with patch("backend.workers.CALL_WAIT", 0.3):
            snap = self.manager.create(self.owner, p, "private-key")
            self.assertTrue(self.started.wait(2))
            stopped = self.wait(snap["id"], lambda state: state["reason"] == "cost_unknown")
        self.assertTrue(stopped["state"]["usageUnknown"])
        self.assertFalse(self.manager.list(self.owner)[0]["canDelete"])
        self.release.set()
        final = self.wait(snap["id"], lambda state: state["reason"] == "input_required")
        self.assertAlmostEqual(final["state"]["spentUsd"], 0.00005)
        self.assertFalse(final["state"]["usageUnknown"])
        self.assertIsNone(final["state"]["best"])
        self.assertTrue(self.manager.list(self.owner)[0]["canDelete"])
        self.assertEqual(len(self.calls), 1)

    def test_timeout_after_cancel_preserves_terminal_state_and_late_cost(self):
        p = start_payload("anthropic")
        with patch("backend.workers.CALL_WAIT", 0.4):
            snap = self.manager.create(self.owner, p, "private-key")
            self.assertTrue(self.started.wait(2))
            self.manager.command(self.owner, snap["id"], action("cancel", snap))
            unknown = self.wait(snap["id"], lambda state: state["usageUnknown"])
        self.assertEqual(unknown["state"]["phase"], "cancelled")
        self.release.set()
        settled = self.wait(snap["id"], lambda state: state["spentUsd"] > 0)
        self.assertEqual(settled["state"]["phase"], "cancelled")
        self.assertFalse(settled["state"]["usageUnknown"])
