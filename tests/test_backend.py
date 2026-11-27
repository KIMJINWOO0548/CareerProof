"""Offline provider contracts and loopback-only HTTP integration tests."""

import http.client
import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from unittest.mock import Mock, patch

from backend import drafts
from backend.__main__ import BODY_LIMIT, LocalApp


def example_input(provider="ollama"):
    return {
        "provider": provider,
        "model": "sample-local:1" if provider == "ollama" else drafts.PRICING["model"],
        "question": "검토 과정에서 맡은 역할을 적어주세요.",
        "facts": [{"id": "F-1", "text": "검토표를 작성했습니다."}],
        "confirmed": True,
        "budgetUsd": "0.10",
    }


def cloud_response(candidate):
    return {
        "stop_reason": "tool_use",
        "content": [{"type": "tool_use", "name": "draft", "input": candidate}],
        "usage": {"input_tokens": 87, "output_tokens": 31},
    }


def local_response(candidate):
    return {
        "done": True,
        "done_reason": "stop",
        "message": {"role": "assistant", "content": json.dumps(candidate)},
    }


class ProviderTests(unittest.TestCase):
    def test_cloud_masks_both_calls_restores_text_and_bills_actual_usage(self):
        terms = ["가상별칭", "sample@example.invalid", "010-0000-0000", "000000-1000000"]
        private_text = " / ".join(terms)
        data = example_input("anthropic")
        data.update(question=private_text, redactTerms=[terms[0]])
        data["facts"][0]["text"] = private_text
        seen = []

        def send(provider, path, body, key):
            self.assertEqual((provider, key), ("anthropic", "fake-key"))
            outbound = json.dumps(body, ensure_ascii=False)
            for literal in [*terms, key]:
                self.assertNotIn(literal, outbound)
            context = json.loads(body["messages"][0]["content"])
            self.assertEqual(context["question"], context["facts"][0]["text"])
            self.assertEqual(context["facts"][0]["id"], "F-1")
            masked = context["question"].split(" / ")
            self.assertEqual(len(set(masked)), 4)
            seen.append((path, context))
            if path == "/v1/messages/count_tokens":
                return {"input_tokens": 150}
            self.assertEqual(path, "/v1/messages")
            self.assertGreater(body["max_tokens"], 0)
            return cloud_response({"text": context["facts"][0]["text"], "factIds": ["F-1"]})

        result = drafts.make_draft(data, "fake-key", send)
        self.assertEqual([path for path, _ in seen], ["/v1/messages/count_tokens", "/v1/messages"])
        self.assertEqual(seen[0][1], seen[1][1])
        self.assertEqual((result["text"], result["factIds"]), (private_text, ["F-1"]))
        usage = result["usage"]
        self.assertEqual((usage["inputTokens"], usage["outputTokens"]), (87, 31))
        rates = drafts.PRICING
        expected = (87 * Decimal(rates["usd_per_million_input"])
                    + 31 * Decimal(rates["usd_per_million_output"])) / 1_000_000
        self.assertEqual(Decimal(usage["costUsd"]), expected)

    def test_over_budget_stops_before_paid_generation(self):
        data = dict(example_input("anthropic"), budgetUsd="0.000001")
        send = Mock(return_value={"input_tokens": 1})
        with self.assertRaises(drafts.DraftError) as error:
            drafts.make_draft(data, "fake-key", send)
        self.assertEqual(error.exception.status, 422)
        self.assertEqual([c.args[1] for c in send.call_args_list], ["/v1/messages/count_tokens"])

    def test_invalid_cloud_parameters_stop_before_counting(self):
        for change, key in [
            ({"confirmed": False}, "fake-key"), ({"model": "unpriced"}, "fake-key"),
            ({"budgetUsd": "NaN"}, "fake-key"), ({"budgetUsd": "0"}, "fake-key"),
            ({"budgetUsd": "2"}, "fake-key"), ({}, None), ({"redactTerms": "가상별칭"}, "fake-key"),
            ({"facts": []}, "fake-key"), ({"facts": [{"id": "F", "text": "a"}] * 2}, "fake-key"),
        ]:
            with self.subTest(change=change, key=key):
                send = Mock()
                with self.assertRaises(drafts.DraftError) as error:
                    drafts.make_draft(dict(example_input("anthropic"), **change), key, send)
                self.assertEqual(error.exception.status, 422)
                send.assert_not_called()

    def test_invalid_token_count_never_generates_a_draft(self):
        for value in [None, True, -1, "42"]:
            with self.subTest(value=value):
                send = Mock(return_value={"input_tokens": value})
                with self.assertRaises(drafts.DraftError) as error:
                    drafts.make_draft(example_input("anthropic"), "fake-key", send)
                self.assertEqual(error.exception.status, 502)
                self.assertEqual(send.call_count, 1)

    def test_incomplete_cloud_draft_and_missing_usage_are_rejected(self):
        response = cloud_response({"text": "검토표를 작성했습니다.", "factIds": ["F-1"]})
        for change in [
            {"stop_reason": "max_tokens"}, {"content": []},
            {"content": response["content"] * 2}, {"usage": None},
            {"usage": {"input_tokens": 3, "output_tokens": False}},
        ]:
            with self.subTest(change=change):
                send = Mock(side_effect=[{"input_tokens": 10}, dict(response, **change)])
                with self.assertRaises(drafts.DraftError) as error:
                    drafts.make_draft(example_input("anthropic"), "fake-key", send)
                self.assertEqual(error.exception.status, 502)
                self.assertEqual(send.call_count, 2)

    def test_ollama_local_model_and_json_reply(self):
        candidate = {"text": "검토표를 작성했습니다.", "factIds": ["F-1"]}
        send = Mock(side_effect=[{"details": {}}, local_response(candidate)])
        result = drafts.make_draft(example_input(), send=send)
        self.assertEqual(result, {**candidate, "usage": None})
        self.assertEqual([c.args[1] for c in send.call_args_list], ["/api/show", "/api/chat"])
        provider, _, chat = send.call_args.args
        self.assertEqual(provider, "ollama")
        self.assertFalse(chat["stream"])
        self.assertGreater(chat["options"]["num_predict"], 0)
        self.assertEqual(json.loads(chat["messages"][-1]["content"])["facts"], example_input()["facts"])

    def test_ollama_requires_local_model_and_no_cloud_key(self):
        for model, key in [("sample-cloud:1", None), ("sample-local:1", "fake-key")]:
            with self.subTest(model=model):
                send = Mock()
                with self.assertRaises(drafts.DraftError) as error:
                    drafts.make_draft(dict(example_input(), model=model), key, send)
                self.assertEqual(error.exception.status, 422)
                send.assert_not_called()
        for field in ("remote_model", "remote_host"):
            with self.subTest(field=field):
                send = Mock(return_value={field: "remote"})
                with self.assertRaises(drafts.DraftError) as error:
                    drafts.make_draft(example_input(), send=send)
                self.assertEqual(error.exception.status, 422)
                self.assertEqual([c.args[1] for c in send.call_args_list], ["/api/show"])

    def test_ollama_rejects_truncated_and_invalid_candidates(self):
        valid = {"text": "검토표를 작성했습니다.", "factIds": ["F-1"]}
        response = local_response(valid)
        for invalid in [
            dict(response, done=False), dict(response, done_reason="length"),
            dict(response, message={"content": "not JSON"}),
            local_response(dict(valid, unexpected=True)),
            local_response(dict(valid, factIds=["F-2"])), local_response(dict(valid, factIds=[])),
            local_response(dict(valid, text="[CPMASK_unknown_1]")),
        ]:
            with self.subTest(response=invalid):
                send = Mock(side_effect=[{}, invalid])
                with self.assertRaises(drafts.DraftError) as error:
                    drafts.make_draft(example_input(), send=send)
                self.assertEqual(error.exception.status, 502)

    def test_transport_maps_errors_without_returning_provider_bodies(self):
        for status, expected in [(401, 403), (403, 403), (404, 422), (429, 429), (503, 502)]:
            with self.subTest(status=status), patch.object(http.client, "HTTPSConnection") as connect:
                connection = connect.return_value
                response = connection.getresponse.return_value
                response.status = status
                response.read.return_value = b"private upstream details"
                with self.assertRaises(drafts.DraftError) as error:
                    drafts.request_json("anthropic", "/v1/messages", {"value": 1}, "fake-key")
                self.assertEqual(error.exception.status, expected)
                self.assertNotIn("private upstream details", str(error.exception))
                self.assertNotIn("fake-key", str(error.exception))
                self.assertEqual(connection.request.call_args.args[3]["x-api-key"], "fake-key")
                connection.close.assert_called_once()

    def test_transport_bounds_decoding_and_handles_timeouts(self):
        for content in [b"not JSON", b"[]", b"x" * (drafts.MAX_RESPONSE_BYTES + 1), TimeoutError()]:
            with self.subTest(kind=type(content).__name__), patch.object(http.client, "HTTPConnection") as connect:
                connection = connect.return_value
                response = connection.getresponse.return_value
                response.status = 200
                if isinstance(content, Exception):
                    response.read.side_effect = content
                    expected = 503
                else:
                    response.read.return_value = content
                    expected = 502
                with self.assertRaises(drafts.DraftError) as error:
                    drafts.request_json("ollama", "/api/chat", {"model": "sample"})
                self.assertEqual(error.exception.status, expected)
                response.read.assert_called_once_with(drafts.MAX_RESPONSE_BYTES + 1)
                connection.close.assert_called_once()


class LocalHTTPTests(unittest.TestCase):
    def setUp(self):
        self.draft = Mock(return_value={"text": "검토표를 작성했습니다.", "factIds": ["F-1"], "usage": None})
        self.server = LocalApp(("127.0.0.1", 0), self.draft)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.03})
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.origin = "http://127.0.0.1:" + str(self.server.server_port)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.assertFalse(self.thread.is_alive())

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, response.headers, response.read()
        finally:
            connection.close()

    def post(self, *, path="/api/draft", body=None, **changes):
        headers = {"Origin": self.origin, "Content-Type": "application/json", "X-CareerProof-Request": "1"}
        headers.update(changes)
        return self.request("POST", path, body=body if body is not None else b'{"question":"q"}', headers=headers)

    def test_frontend_entry_assets_and_head(self):
        for path, mime in [
            ("/", "text/html"), ("/index.html", "text/html"), ("/app.css", "text/css"),
            ("/design.css", "text/css"), ("/app.js", "text/javascript"),
            ("/analysis.js", "text/javascript"), ("/workspace.js", "text/javascript"),
        ]:
            with self.subTest(path=path):
                status, headers, body = self.request("GET", path)
                self.assertEqual(status, 200)
                self.assertEqual(headers.get_content_type(), mime)
                self.assertEqual(int(headers["Content-Length"]), len(body))
                self.assertGreater(len(body), 0)
                self.assertEqual(headers["Cache-Control"], "no-store")
        head_status, head_headers, head_body = self.request("HEAD", "/")
        self.assertEqual((head_status, head_body), (200, b""))
        self.assertGreater(int(head_headers["Content-Length"]), 0)
        self.assertEqual(self.request("GET", "/backend/pricing.json")[0], 404)
        self.assertEqual(self.request("GET", "/", headers={"Host": "example.invalid"})[0], 403)

    def test_post_success_and_validation_failures(self):
        status, headers, body = self.post(**{"X-LLM-API-Key": "fake-key"})
        self.assertEqual((status, headers.get_content_type()), (200, "application/json"))
        self.assertEqual(json.loads(body), self.draft.return_value)
        self.draft.assert_called_once_with({"question": "q"}, "fake-key")
        for changes, expected in [
            ({"path": "/api/missing"}, 404), ({"Origin": "https://example.invalid"}, 403),
            ({"X-CareerProof-Request": ""}, 403), ({"Content-Type": "text/plain"}, 415),
            ({"body": b"invalid JSON"}, 400), ({"body": b""}, 413),
            ({"Content-Length": str(BODY_LIMIT + 1)}, 413),
        ]:
            with self.subTest(changes=changes):
                status, _, body = self.post(**changes)
                self.assertEqual(status, expected)
                self.assertIsInstance(json.loads(body)["error"], str)
        self.assertEqual(self.draft.call_count, 1)

    def test_busy_conflict_and_slot_recovery_after_provider_failure(self):
        started, release = threading.Event(), threading.Event()
        candidate = self.draft.return_value

        def draft(data, key):
            if data == {"request": "first"}:
                started.set()
                if not release.wait(timeout=5):
                    self.fail("Timed out waiting for concurrent client")
                raise drafts.DraftError(503, "제공자 응답이 지연되었습니다.")
            return candidate

        self.draft.side_effect = draft
        with ThreadPoolExecutor(max_workers=1) as callers:
            first = callers.submit(self.post, body=b'{"request":"first"}')
            try:
                self.assertTrue(started.wait(timeout=5))
                self.assertEqual(self.post()[0], 409)
            finally:
                release.set()
            status, _, body = first.result(timeout=5)
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["error"], "제공자 응답이 지연되었습니다.")
        status, _, body = self.post()
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), candidate)
        self.assertEqual(self.draft.call_count, 2)


if __name__ == "__main__":
    unittest.main()
