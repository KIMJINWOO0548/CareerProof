"""Synthetic transports only: no provider, key, network, or paid traffic."""
import copy
import json
import unittest
from decimal import Decimal

from backend.committee import ROLES, review_application
from backend.drafts import DraftError, PRICING


def request(mode="fast", provider="ollama"):
    return {"scope": "application", "mode": mode, "provider": provider,
            "model": PRICING["providers"][provider]["model"] if provider in PRICING["providers"] else "local-test",
            "budgetUsd": "1", "confirmed": True, "redactTerms": ["홍길동"],
            "answers": [{"id": "answer-1", "title": "지원 동기 홍길동", "text": "😀 첫 경험\n  성과를 확인했습니다."}],
            "requirements": ["채용요건 홍길동 hr@example.com"],
            "portfolio": "포트폴리오 홍길동 tech@example.com"}


class Fake:
    """Reusable example: inject Fake() as send= into review_application."""
    def __init__(self, mutate=None):
        self.calls = []
        self.mutate = mutate
        self.payloads = []

    def __call__(self, provider, path, body, key=None):
        self.calls.append((provider, path, copy.deepcopy(body)))
        if path == "/api/show":
            return {}
        if path.endswith("count_tokens"):
            return {"input_tokens": 100}
        payload = json.loads(body["contents"][0]["parts"][0]["text"] if provider == "gemini" else body["messages"][-1]["content"])
        self.payloads.append(payload)
        persons = [{"id": r["id"], "criteria": [{"id": c["id"], "level": "L4", "deductions": []} for c in r["criteria"]]} for r in payload["rubrics"]]
        raw = {"personas": persons}
        if self.mutate:
            self.mutate(raw, payload)
        if provider == "anthropic":
            return {"usage": {"input_tokens": 100, "output_tokens": 100}, "stop_reason": "tool_use", "content": [{"type": "tool_use", "name": "review", "input": raw}]}
        if provider == "openai":
            return {"usage": {"prompt_tokens": 100, "completion_tokens": 100},
                    "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(raw)}}]}
        if provider == "gemini":
            return {"usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 100},
                    "candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": json.dumps(raw)}]}}]}
        return {"done": True, "message": {"content": json.dumps(raw)}}


class CommitteeTests(unittest.TestCase):
    def test_additional_providers_fast_deep_and_strict_schema(self):
        for provider in ("openai", "gemini"):
            for mode, calls in (("fast", 1), ("deep", 15)):
                with self.subTest(provider=provider, mode=mode):
                    fake = Fake()
                    data = request(mode, provider)
                    data["writerModel"] = "secret-writer"
                    data["answers"][0]["text"] += " 홍길동 private@example.com"
                    result = review_application(data, "fake", fake)
                    self.assertTrue(result["total"]["complete"])
                    self.assertEqual(result["total"]["samples"], 1 if mode == "fast" else 3)
                    self.assertEqual(len(fake.calls), calls)
                    wire = json.dumps(fake.calls, ensure_ascii=False)
                    for secret in ("홍길동", "private@example.com", "secret-writer"):
                        self.assertNotIn(secret, wire)
                    for _, _, body in fake.calls:
                        schema = (body["response_format"]["json_schema"]["schema"] if provider == "openai"
                                  else body["generationConfig"]["responseJsonSchema"])
                        def strict(node):
                            if isinstance(node, dict):
                                if node.get("type") == "object":
                                    self.assertFalse(node["additionalProperties"])
                                    self.assertEqual(set(node["required"]), set(node["properties"]))
                                for v in node.values(): strict(v)
                            elif isinstance(node, list):
                                for v in node: strict(v)
                        strict(schema)
                    if mode == "deep":
                        self.assertTrue(all(len(p["contexts"]) == 1 for p in fake.payloads))
                    from backend.drafts import usage_cost
                    self.assertEqual(Decimal(result["usage"]["costUsd"]), calls * usage_cost(100, 100, provider))

    def test_additional_providers_budget_receipts_and_unknown_stop(self):
        for provider in ("openai", "gemini"):
            with self.subTest(provider=provider):
                data = request("deep", provider)
                fake = Fake()
                result = review_application({**data, "budgetUsd": "0.000001"}, "fake", fake)
                self.assertEqual(len(fake.calls), 0)
                self.assertEqual(result["total"]["max"], 0)
                fake = Fake()
                def broken(p, path, body, key):
                    if len(fake.calls) == 1:
                        raise DraftError(503, "offline", "cost_unknown")
                    return fake(p, path, body, key)
                result = review_application(data, "fake", broken)
                self.assertEqual(len(result["calls"]), 2)
                self.assertIsNone(result["usage"]["costUsd"])
                self.assertGreater(Decimal(result["usage"]["knownCostUsd"]), 0)
                self.assertFalse(result["total"]["complete"])
                fake = Fake()
                def truncated(p, path, body, key):
                    r = fake(p, path, body, key)
                    if p == "openai": r["choices"][0]["finish_reason"] = "length"
                    else: r["candidates"][0]["finishReason"] = "MAX_TOKENS"
                    return r
                result = review_application(data, "fake", truncated)
                self.assertEqual(len(result["calls"]), 1)
                self.assertGreater(Decimal(result["usage"]["costUsd"]), 0)
                self.assertEqual(result["total"]["max"], 0)
                # A paid first call can leave too little of the total budget for another.
                fake = Fake()
                def nearly_spent(p, path, body, key):
                    r = fake(p, path, body, key)
                    if p == "openai": r["usage"]["completion_tokens"] = 620000
                    else: r["usageMetadata"]["candidatesTokenCount"] = 2498000
                    return r
                result = review_application(data, "fake", nearly_spent)
                self.assertEqual(len(result["calls"]), 1)
                self.assertGreater(Decimal(result["usage"]["costUsd"]), Decimal("0.99"))
                self.assertIsNotNone(result["usage"]["costUsd"])
                result = review_application(data, "fake", lambda *args: {})
                self.assertIsNone(result["usage"]["costUsd"])
                self.assertEqual(len(result["calls"]), 1)
                for override, key in (({"model":"unpriced"}, "fake"), ({"confirmed":False}, "fake"), ({}, None)):
                    with self.assertRaises(DraftError):
                        review_application({**data, **override}, key, lambda *args: self.fail("unexpected dispatch"))

    def test_same_writer_warning_stays_out_of_provider_context(self):
        for provider in ("ollama", "anthropic", "openai", "gemini"):
            data = request(provider=provider)
            data["writerModel"] = data["model"]
            fake = Fake()
            result = review_application(data, None if provider == "ollama" else "fake", fake)
            self.assertTrue(any("자기 선호" in w for w in result["warnings"]))
            self.assertNotIn("writerModel", json.dumps(fake.payloads))

    def test_normal_max_and_shuffle_invariance(self):
        a = review_application(request(), send=Fake())
        def shuffle(raw, _):
            raw["personas"].reverse()
            for p in raw["personas"]:
                p["criteria"].reverse()
        b = review_application(request(), send=Fake(shuffle))
        self.assertEqual(a["total"], b["total"])
        self.assertEqual(a["total"], {"value": 100, "max": 100, "range": None, "samples": 1, "complete": True})
        self.assertEqual(len(a["calls"]), 2)

    def test_false_quote_and_wrong_reference_excluded(self):
        for bad in ({"answerId": "a1", "quote": "가짜 근거"}, {"answerId": "unknown", "quote": "첫 경험"}):
            def mutate(raw, _, bad=bad):
                raw["personas"][0]["criteria"][0].update(level="L1", deductions=[{**bad, "reason": "근거 부족", "fix": "실제 역할 추가"}])
            result = review_application(request(), send=Fake(mutate))
            self.assertEqual(result["total"]["max"], 80)
            self.assertFalse(result["personas"][0]["valid"])
            self.assertTrue(result["warnings"])

    def test_normalized_quote_unicode_original_span(self):
        def mutate(raw, _):
            raw["personas"][0]["criteria"][0].update(level="L3", deductions=[{"answerId": "a1", "quote": "첫 경험 성과", "reason": "역할 불명확", "fix": "본인 행동 추가"}])
        data = request()
        result = review_application(data, send=Fake(mutate))
        d = result["personas"][0]["deductions"][0]
        self.assertEqual(d["start"], 2)
        self.assertEqual(d["quote"], data["answers"][0]["text"][d["start"]:d["end"]])
        self.assertEqual(d["quote"], "첫 경험\n  성과")
        self.assertEqual(result["total"]["value"], 97.6)

    def test_missing_duplicate_and_numeric_level_invalid(self):
        for mutation in (lambda r: r["personas"].pop(), lambda r: r["personas"].append(r["personas"][0]), lambda r: r["personas"][0]["criteria"][0].update(level=3)):
            fake = Fake(lambda raw, _: mutation(raw))
            result = review_application(request(), send=fake)
            self.assertFalse(result["total"]["complete"])
            self.assertLess(result["total"]["max"], 100)

    def test_deep_rotation_and_context_visibility(self):
        fake = Fake()
        result = review_application(request("deep"), send=fake)
        self.assertEqual(result["total"]["samples"], 3)
        self.assertTrue(result["total"]["complete"])
        self.assertEqual(len(fake.calls), 16)
        orders = [fake.payloads[i]["levelOrder"] for i in (0, 5, 10)]
        self.assertEqual(len({tuple(o) for o in orders}), 3)
        for payload in fake.payloads:
            self.assertEqual(len(payload["contexts"]), 1)
            rid, ctx = next(iter(payload["contexts"].items()))
            self.assertEqual("portfolio" in ctx, rid in ("tech", "peer"))
            self.assertEqual("requirements" in ctx, rid in ("tech", "peer"))
        self.assertEqual(result["total"]["range"], [100, 100])

    def test_deep_median_range(self):
        counter = {r[0]: 0 for r in ROLES}
        def mutate(raw, _):
            p = raw["personas"][0]
            trial = counter[p["id"]]
            counter[p["id"]] += 1
            if trial < 2:
                for c in p["criteria"]:
                    c.update(level=["L1", "L3"][trial], deductions=[{"answerId": "a1", "quote": "첫 경험", "reason": "구체성 부족", "fix": "행동 추가"}])
        result = review_application(request("deep"), send=Fake(mutate))
        self.assertEqual(result["total"]["value"], 70)
        self.assertEqual(result["total"]["range"], [0, 100])

    def test_individual_anchors_and_not_assessable(self):
        fake = Fake()
        review_application(request(), send=fake)
        self.assertEqual([sum(c["weight"] for c in r["criteria"]) for r in fake.payloads[0]["rubrics"]], [20,20,18,17,25])
        self.assertTrue(all(set(c["anchors"]) == {"L1","L2","L3","L4"} for r in fake.payloads[0]["rubrics"] for c in r["criteria"]))
        def missing(raw, _):
            for p in raw["personas"]:
                if p["id"] == "hr":
                    for c in p["criteria"]:
                        c.update(level="not_assessable", reason="회사 가치 자료 미확보", deductions=[])
        result = review_application(request(), send=Fake(missing))
        self.assertEqual(result["total"]["max"], 82)
        self.assertEqual(result["total"]["value"], 82)
        self.assertFalse(result["total"]["complete"])

    def test_paired_round_range_not_sum_of_role_extrema(self):
        count = {r[0]: 0 for r in ROLES}
        def mutate(raw, _):
            p = raw["personas"][0]
            trial = count[p["id"]]; count[p["id"]] += 1
            if (p["id"] == "tech" and trial == 0) or (p["id"] == "peer" and trial == 1):
                for c in p["criteria"]:
                    c.update(level="L1", deductions=[{"answerId":"a1","quote":"첫 경험","reason":"근거 부족","fix":"추가"}])
        result = review_application(request("deep"), send=Fake(mutate))
        self.assertEqual(result["total"]["value"], 80)
        self.assertEqual(result["total"]["range"], [80,100])
        self.assertEqual(result["total"]["samples"], 3)

    def test_all_l3_arithmetic_and_incomparable_coverage(self):
        def l3(raw, _):
            for p in raw["personas"]:
                for c in p["criteria"]:
                    c.update(level="L3", deductions=[{"answerId":"a1","quote":"첫 경험","reason":"보강 가능","fix":"조건 추가"}])
        result = review_application(request(), send=Fake(l3))
        self.assertEqual(result["total"]["value"], 70)
        def missing(raw, payload):
            l3(raw, payload)
            if raw["personas"][0]["id"] == "hr":
                raw["personas"] = []
        result = review_application(request(), send=Fake(lambda raw,payload: (l3(raw,payload), raw.update(personas=[p for p in raw["personas"] if p["id"]!="hr"]))))
        self.assertEqual(result["total"]["value"], 57.4)
        self.assertEqual(result["total"]["max"], 82)

    def test_punctuation_normalization_preserves_original_span(self):
        data=request();data["answers"][0]["text"]='😀 “구현” — 검증'
        def mutate(raw, _):
            raw["personas"][0]["criteria"][0].update(level="L3", deductions=[{"answerId":"a1","quote":'"구현" - 검증',"reason":"조건 부족","fix":"추가"}])
        result=review_application(data,send=Fake(mutate))
        self.assertEqual(result["personas"][0]["deductions"][0]["quote"], '“구현” — 검증')

    def test_unknown_provider_fields_are_not_returned(self):
        def mutate(raw, _):
            c=raw["personas"][0]["criteria"][0]
            c.update(level="L3", deductions=[{"answerId":"a1","quote":"첫 경험","reason":"근거 부족","fix":"추가","secret":"not allowed"}])
        result=review_application(request(), send=Fake(mutate))
        self.assertNotIn("secret", json.dumps(result))

    def test_padding_does_not_change_rubric_or_score(self):
        data = request()
        a = review_application(data, send=Fake())
        data["answers"][0]["text"] += " 문장 반복" * 100
        b = review_application(data, send=Fake())
        self.assertEqual(a["total"], b["total"])

    def test_mask_all_fields_and_hide_writer(self):
        data = request(provider="anthropic")
        data["writerModel"] = "private-writer"
        data["answers"][0]["text"] += " 홍길동 person@example.com 010-1234-5678"
        fake = Fake()
        result = review_application(data, key="fake", send=fake)
        wire = json.dumps(fake.calls, ensure_ascii=False)
        for secret in ("홍길동", "person@example.com", "hr@example.com", "tech@example.com", "010-1234-5678", "private-writer"):
            self.assertNotIn(secret, wire)
        self.assertEqual(Decimal(result["usage"]["costUsd"]), Decimal("0.0006"))
        self.assertEqual(len(fake.calls), 2)

    def test_budget_preflight_and_unknown_stop(self):
        data = request("deep", "anthropic")
        data["budgetUsd"] = "0.001"
        fake = Fake()
        result = review_application(data, key="fake", send=fake)
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(result["total"]["max"], 0)
        data["budgetUsd"] = "1"
        fake = Fake()
        def broken(provider, path, body, key=None):
            if path == "/v1/messages":
                raise DraftError(503, "connection lost", "cost_unknown")
            return fake(provider, path, body, key)
        result = review_application(data, key="fake", send=broken)
        self.assertIsNone(result["usage"]["costUsd"])
        self.assertEqual(len(result["calls"]), 2)

    def test_paid_invalid_output_keeps_charge_and_actual_budget_stops(self):
        fake = Fake(lambda raw, _: raw.update(personas=[]))
        result = review_application(request(provider="anthropic"), key="fake", send=fake)
        self.assertEqual(Decimal(result["usage"]["costUsd"]), Decimal("0.0006"))
        fake = Fake()
        def overspend(provider, path, body, key=None):
            result = fake(provider, path, body, key)
            if path == "/v1/messages":
                result["usage"]["output_tokens"] = 300000
            return result
        result = review_application(request("deep", "anthropic"), key="fake", send=overspend)
        self.assertEqual(len(result["calls"]), 2)
        self.assertGreater(float(result["usage"]["costUsd"]), 1)

    def test_local_zero_budget_and_remote_rejected(self):
        data = request()
        data["budgetUsd"] = 0
        self.assertTrue(review_application(data, send=Fake())["total"]["complete"])
        with self.assertRaises(DraftError):
            review_application(data, send=lambda *args: {"remote_host": "example"})


if __name__ == "__main__":
    unittest.main()
