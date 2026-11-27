"""Offline contracts for additional BYOK providers; never makes paid calls."""
import json
import unittest
from unittest.mock import Mock, patch

from backend import drafts


class ExtraProviderTests(unittest.TestCase):
    def payload(self, provider):
        return dict(provider=provider, model=drafts.PRICING["providers"][provider]["model"],
                    question="sample@example.invalid", facts=[{"id": "F1", "text": "검토표 작성"}],
                    confirmed=True, budgetUsd="0.10")

    def response(self, provider, text="검토표 작성", finish=True):
        raw = json.dumps({"text": text, "factIds": ["F1"]})
        if provider == "openai":
            return {"choices": [{"finish_reason": "stop" if finish else "length",
                                 "message": {"content": raw}}],
                    "usage": {"prompt_tokens": 11, "completion_tokens": 3}}
        return {"candidates": [{"finishReason": "STOP" if finish else "MAX_TOKENS",
                                "content": {"parts": [{"text": raw}]}}],
                "usageMetadata": {"promptTokenCount": 11, "candidatesTokenCount": 3}}

    def test_masking_restoration_and_usage(self):
        for provider in ("openai", "gemini"):
            with self.subTest(provider=provider):
                def send(name, path, body, key):
                    self.assertEqual((name, key), (provider, "fake-key"))
                    self.assertNotIn("sample@example.invalid", json.dumps(body))
                    if provider == "openai":
                        self.assertEqual(path, "/v1/chat/completions")
                        self.assertFalse(body["store"])
                        content = body["messages"][1]["content"]
                    else:
                        self.assertTrue(path.endswith(":generateContent"))
                        self.assertEqual(body["generationConfig"]["thinkingConfig"]["thinkingBudget"], 0)
                        content = body["contents"][0]["parts"][0]["text"]
                    return self.response(provider, json.loads(content)["question"])
                result = drafts.make_draft(self.payload(provider), "fake-key", send)
                self.assertEqual(result["text"], "sample@example.invalid")
                self.assertEqual(result["usage"]["costUsd"], str(drafts.usage_cost(11, 3, provider)))

    def test_preflight_rejects_without_dispatch(self):
        for provider in ("openai", "gemini"):
            for override, key in (({"budgetUsd": "0.000001"}, "fake-key"),
                                  ({"confirmed": False}, "fake-key"),
                                  ({"model": "unpriced-model"}, "fake-key"), ({}, None)):
                with self.subTest(provider=provider, override=override):
                    send = Mock()
                    with self.assertRaises(drafts.DraftError):
                        drafts.make_draft({**self.payload(provider), **override}, key, send)
                    send.assert_not_called()

    def test_incomplete_responses_keep_receipts_and_missing_usage_stops(self):
        for provider in ("openai", "gemini"):
            with self.subTest(provider=provider):
                with self.assertRaises(drafts.DraftError) as caught:
                    drafts.make_draft(self.payload(provider), "fake-key",
                                      Mock(return_value=self.response(provider, finish=False)))
                self.assertIsNotNone(caught.exception.usage)
                with self.assertRaises(drafts.DraftError) as caught:
                    drafts.make_draft(self.payload(provider), "fake-key", Mock(return_value={}))
                self.assertEqual(caught.exception.code, "cost_unknown")

    def test_fixed_origins_headers_and_uncertain_transport(self):
        for provider, host, header in (("openai", "api.openai.com", "Authorization"),
                                      ("gemini", "generativelanguage.googleapis.com", "x-goog-api-key")):
            with self.subTest(provider=provider), patch.object(drafts.http.client, "HTTPSConnection") as factory:
                conn = factory.return_value
                conn.request.side_effect = OSError("offline")
                with self.assertRaises(drafts.DraftError) as caught:
                    drafts.request_json(provider, "/paid-endpoint", {}, "fake-key")
                factory.assert_called_once_with(host, timeout=60)
                self.assertIn(header, conn.request.call_args.args[3])
                self.assertNotIn("fake-key", conn.request.call_args.args[1])
                self.assertEqual(caught.exception.code, "cost_unknown")
                conn.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
