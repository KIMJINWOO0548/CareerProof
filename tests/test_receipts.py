"""Process-local idempotency and billing behavior without a provider connection."""

import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, patch

from backend.drafts import DraftError
from backend.receipts import DraftReceipts


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.receipts = DraftReceipts(ttl=120, capacity=2, clock=lambda: self.now)
        self.addCleanup(self.receipts.close)
        self.request_id = str(uuid.uuid4())
        self.data = {"facts": [{"id": "F1", "text": "가상 프로젝트 원문"}], "provider": "anthropic"}
        self.key = "fictional-key"
        self.operation = Mock(return_value={"text": "검토본", "factIds": ["F1"]})

    def run_draft(self):
        return self.receipts.execute(self.request_id, self.data, self.key, self.operation)

    def test_no_id_preserves_independent_calls_and_errors(self):
        self.request_id = None
        self.run_draft()
        self.operation.side_effect = DraftError(429, "제공자 요청 한도", "provider_error")
        with self.assertRaises(DraftError):
            self.run_draft()
        self.assertEqual(self.operation.call_count, 2)

    def test_only_hyphenated_v4_ids_start_an_operation(self):
        for invalid in ["", "not-a-uuid", self.request_id.replace("-", ""), str(uuid.UUID(int=0)), 42]:
            with self.subTest(invalid=invalid), self.assertRaises(DraftError) as caught:
                self.receipts.execute(invalid, self.data, self.key, self.operation)
            self.assertEqual(caught.exception.status, 422)
        self.operation.assert_not_called()

    def test_equivalent_json_replays_isolated_result_and_conflicts_keep_first_call(self):
        returned = self.run_draft()
        returned["factIds"].clear()
        equivalent = {"provider": "anthropic", "facts": [{"text": "가상 프로젝트 원문", "id": "F1"}]}
        self.assertEqual(self.receipts.execute(self.request_id.upper(), equivalent, self.key, self.operation),
                         self.operation.return_value)
        for data, key in [(dict(self.data, previousText="다른 본문"), self.key), (self.data, "different-key")]:
            with self.subTest(key=key), self.assertRaises(DraftError) as caught:
                self.receipts.execute(self.request_id, data, key, self.operation)
            self.assertEqual((caught.exception.status, caught.exception.code), (409, "request_conflict"))
        self.assertEqual(self.run_draft(), self.operation.return_value)
        self.operation.assert_called_once()
        self.assertNotIn("가상 프로젝트 원문", repr(self.receipts._entries))
        self.assertNotIn(self.key, repr(self.receipts._entries))

    def test_busy_receipt_survives_elapsed_ttl_and_capacity_pressure(self):
        entered, release = threading.Event(), threading.Event()

        def perform():
            entered.set()
            if not release.wait(5):
                self.fail("active call did not finish")
            return {"text": "검토본"}

        self.operation.side_effect = perform
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(self.run_draft)
            try:
                self.assertTrue(entered.wait(5))
                self.now += 121
                with self.assertRaises(DraftError) as caught:
                    self.run_draft()
                self.assertEqual(caught.exception.code, "request_in_progress")
                self.receipts.execute(str(uuid.uuid4()), {}, None, lambda: {})
                with self.assertRaises(DraftError) as caught:
                    self.receipts.execute(str(uuid.uuid4()), {}, None, self.operation)
                self.assertEqual(caught.exception.code, "receipt_capacity")
            finally:
                release.set()
            self.assertEqual(future.result(5), {"text": "검토본"})
        self.assertEqual(self.run_draft(), {"text": "검토본"})
        self.operation.assert_called_once()
        self.now += 121
        self.run_draft()
        self.assertEqual(self.operation.call_count, 2)

    def test_timer_discards_expired_response_while_server_is_idle(self):
        with patch("backend.receipts.threading.Timer") as timer:
            self.run_draft()
            timer.return_value.start.assert_called_once()
            delay, callback = timer.call_args.args
            self.assertEqual(delay, 120)
            self.now += delay
            callback()
            self.assertEqual(self.receipts._entries, {})
            timer.assert_called_once()

    def test_budget_known_charge_and_unconfirmed_charge_errors_replay(self):
        usage = {"inputTokens": 10, "outputTokens": 3, "costUsd": "0.000025"}
        for status, code, cost in [
            (422, "budget_limit", None), (502, "provider_error", usage), (503, "cost_unknown", None),
        ]:
            with self.subTest(code=code):
                self.request_id = str(uuid.uuid4())
                self.operation.reset_mock()
                self.operation.side_effect = DraftError(status, "고정 오류 문구", code, usage=cost)
                for _ in range(2):
                    with self.assertRaises(DraftError) as caught:
                        self.run_draft()
                    error = caught.exception
                    self.assertEqual((error.status, str(error), error.code, error.usage),
                                     (status, "고정 오류 문구", code, cost))
                    if error.usage:
                        error.usage.clear()
                self.operation.assert_called_once()
                self.now += 121

    def test_pre_dispatch_slot_conflict_can_retry_same_id(self):
        self.operation.side_effect = [DraftError(409, "다른 요청 처리 중", "provider_busy"), {"text": "완료"}]
        with self.assertRaises(DraftError) as caught:
            self.run_draft()
        self.assertEqual(caught.exception.code, "provider_busy")
        self.assertEqual(self.run_draft(), {"text": "완료"})
        self.assertEqual(self.run_draft(), {"text": "완료"})
        self.assertEqual(self.operation.call_count, 2)

    def test_unexpected_paid_error_is_sanitized_and_never_dispatched_again(self):
        self.operation.side_effect = RuntimeError("fictional-key in upstream error")
        for _ in range(2):
            with self.assertRaises(DraftError) as caught:
                self.run_draft()
            self.assertEqual(caught.exception.code, "cost_unknown")
            self.assertNotIn("fictional-key", str(caught.exception))
        self.operation.assert_called_once()
