"""Check benchmark scoring against authored synthetic gold, not app output."""

import hashlib
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from scripts.benchmark_pdf import (
    fixture,
    fixtures,
    make_pdf,
    score,
    transcript_text,
    validate_capture,
)


class PdfBenchmarkTest(unittest.TestCase):
    def setUp(self):
        self.item = fixture(
            "small",
            [[(40, 700, "Alpha 17 checks"), (40, 670, "Beta 8 cases")]],
            ["Alpha 17 checks", "Beta 8 cases"],
            [["Alpha 17 checks", "Beta 8 cases"]],
            "synthetic",
        )

    def test_metrics_penalize_extraneous_and_duplicate_text(self):
        result = score(
            self.item, "Alpha 17 checks Beta 8 cases Alpha 17 checks invented"
        )
        self.assertEqual(result["span_recall"], 1)
        self.assertEqual(result["token_precision"], 6 / 10)
        self.assertEqual(result["extraneous_token_count"], 4)
        self.assertEqual(result["duplicate_excess_token_count"], 3)

    def test_order_errors_and_missing_relations_are_distinct(self):
        reversed_result = score(self.item, "Beta 8 cases Alpha 17 checks")
        self.assertEqual(reversed_result["order_accuracy"], 0)
        self.assertEqual(reversed_result["order_coverage"], 1)
        missing_result = score(self.item, "Alpha 17 checks")
        self.assertEqual(missing_result["span_recall"], 0.5)
        self.assertEqual(missing_result["order_coverage"], 0)
        self.assertIsNone(missing_result["order_accuracy"])
        self.assertEqual(missing_result["missing_spans"], ["Beta 8 cases"])

    def test_normalization_and_empty_output(self):
        self.assertEqual(
            score(self.item, "ＡＬＰＨＡ\n17 checks\tBeta 8 cases")["span_recall"], 1
        )
        empty = score(self.item, "")
        self.assertEqual(empty["token_precision"], 0)
        self.assertEqual(empty["span_recall"], 0)

    def test_image_only_is_separate_abstention(self):
        item = fixtures()[-1]
        result = score(item, "")
        self.assertEqual(result["status"], "abstained")
        self.assertIsNone(result["text_metrics"])
        self.assertNotIn("span_recall", result)
        self.assertEqual(score(item, "SCAN ONLY 27 TESTS")["status"], "text_returned")

    def test_deterministic_pdf_bytes_and_transcript_inputs(self):
        for item in fixtures():
            with self.subTest(item=item["id"]):
                self.assertEqual(make_pdf(item), make_pdf(item))
                self.assertTrue(make_pdf(item).startswith(b"%PDF-"))
        self.assertEqual(
            transcript_text(
                {"pages": [{"page": 1, "text": "Alpha"}, {"page": 2, "text": "Beta"}]}
            ),
            "Alpha\nBeta",
        )
        self.assertEqual(
            transcript_text({"tokens": [{"str": "Alpha"}, {"str": "Beta"}]}),
            "Alpha\nBeta",
        )
        with self.assertRaises(ValueError):
            transcript_text({"unrecognized": "shape"})

    def test_saved_openresume_capture_matches_exact_synthetic_inputs(self):
        directory = Path(__file__).parent / "fixtures" / "openresume-observed"
        items = [
            {"id": item["id"], "sha256": hashlib.sha256(make_pdf(item)).hexdigest()}
            for item in fixtures()
        ]
        validate_capture(directory, items)
        self.assertTrue((directory / "capture.json").is_file())

    def test_capture_rejects_mixed_inputs_and_edited_transcripts(self):
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            item = {"id": "test", "sha256": "original"}
            record = dict(
                item,
                status="observed",
                transcript_sha256=hashlib.sha256(b"seen").hexdigest(),
            )
            (directory / "capture.json").write_text(
                json.dumps({"fixtures": [record]}), encoding="utf-8"
            )
            (directory / "test.txt").write_bytes(b"seen")
            with self.assertRaisesRegex(ValueError, "Captured PDF differs"):
                validate_capture(directory, [dict(item, sha256="changed")])
            (directory / "test.txt").write_bytes(b"edited")
            with self.assertRaisesRegex(ValueError, "transcript has changed"):
                validate_capture(directory, [item])


if __name__ == "__main__":
    unittest.main()
