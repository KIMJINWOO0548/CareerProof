"""Offline contracts for the trusted drafting instructions."""

import json
import unittest
from unittest.mock import Mock

from backend import drafts
from backend.writing_skill import DOCUMENT_KINDS, writing_instructions


class WritingSkillTests(unittest.TestCase):
    def test_mode_and_compatibility(self):
        rules = ["자기소개서는 첫 문장", "경력기술서는 업무", "포트폴리오는 독자가", "이력서 양식은 문항"]
        for kind, rule in zip(DOCUMENT_KINDS, rules, strict=True):
            with self.subTest(kind=kind):
                policy = writing_instructions(kind)
                self.assertIn(rule, policy)
                self.assertEqual(sum(other in policy for other in rules), 1)
        self.assertEqual(writing_instructions(), writing_instructions("self_intro"))

    def test_invalid_kind_cannot_dispatch(self):
        data = {"question": "경험", "facts": [{"id": "A", "text": "검토표 작성"}]}
        self.assertNotIn("documentKind", drafts.input_context(data))
        for invalid in ("", "bogus", None, [], {}):
            with self.subTest(invalid=invalid):
                send = Mock()
                with self.assertRaises(drafts.DraftError) as caught:
                    drafts.make_draft({**data, "documentKind": invalid}, send=send)
                self.assertEqual(caught.exception.status, 422)
                send.assert_not_called()

    def test_provider_messages_keep_skill_and_user_data_separate(self):
        for provider in ("ollama", "openai", "anthropic", "gemini"):
            with self.subTest(provider=provider):
                local = provider == "ollama"
                data = {"provider": provider, "model": "local" if local else drafts.PRICING["providers"][provider]["model"],
                        "confirmed": True, "budgetUsd": "1", "documentKind": "portfolio",
                        "question": "질문 문구", "facts": [{"id": "A", "text": "sample@example.invalid"}]}
                checked = []

                def capture(name, path, body, key=None, *, checked=checked):
                    if path == "/api/show":
                        return {}
                    if name == "gemini":
                        system = body["systemInstruction"]["parts"][0]["text"]
                        content = body["contents"][0]["parts"][0]["text"]
                    elif name == "anthropic":
                        system = body["system"]
                        content = body["messages"][0]["content"]
                    else:
                        system, user = body["messages"]
                        self.assertEqual((system["role"], user["role"]), ("system", "user"))
                        system, content = system["content"], user["content"]
                    self.assertIn(writing_instructions("portfolio"), system)
                    self.assertIn(drafts.POLICY, system)
                    self.assertNotIn("질문 문구", system)
                    context = json.loads(content)
                    self.assertEqual(context["documentKind"], "portfolio")
                    self.assertEqual(context["question"], "질문 문구")
                    self.assertEqual("sample@example.invalid" in content, name == "ollama")
                    checked.append(path)
                    if path.endswith("/count_tokens"):
                        return {"input_tokens": 300}
                    raise StopIteration

                with self.assertRaises(StopIteration):
                    drafts.make_draft(data, None if local else "sample-key", capture)
                self.assertEqual(len(checked), 2 if provider == "anthropic" else 1)
