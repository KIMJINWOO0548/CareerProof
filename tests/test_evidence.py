import base64
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from uuid import uuid4

from backend.drafts import DraftError
from backend.evidence import dart_company, extract_document, pdf_tool, repo_signals, requires_pdf_path
from backend.history import History, HistoryError


def upload(name, contents):
    return {"filename": name, "contentBase64": base64.b64encode(contents).decode()}


def one_page_pdf():
    text = b"BT /F1 12 Tf 40 100 Td (Evidence: 12 test cases.) Tj ET"
    objects = [b"<</Type/Catalog/Pages 2 0 R>>", b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
               b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
               b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
               b"<</Length " + str(len(text)).encode() + b">>\nstream\n" + text + b"\nendstream"]
    pdf = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf.extend(str(i).encode() + b" 0 obj\n" + obj + b"\nendobj\n")
    xref = len(pdf)
    pdf.extend(b"xref\n0 6\n0000000000 65535 f \n")
    for n in offsets:
        pdf.extend(f"{n:010} 00000 n \n".encode())
    pdf.extend(f"trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF".encode())
    return bytes(pdf)


class PortfolioTest(unittest.TestCase):
    def test_korean_document_previews(self):
        line = "가상 장비에서 회귀 시험 12건을 수행했다."
        for ext, path in [("docx", "word/document.xml"), ("hwpx", "Contents/section0.xml")]:
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as archive:
                archive.writestr(path, "<root><p><t>" + line + "</t></p></root>")
            self.assertEqual(extract_document(upload("demo." + ext, buf.getvalue()))["pages"], [{"page": 1, "text": line}])
        self.assertEqual(extract_document(upload("demo.md", line.encode("utf-8-sig")))["pages"][0]["text"], line)
        with self.assertRaises(DraftError):
            extract_document(upload("demo.docx", b"invalid archive"))

    @unittest.skipUnless(pdf_tool(), "optional pdftotext unavailable")
    def test_real_pdf_text_extraction(self):
        sample = upload("demo.pdf", one_page_pdf())
        if requires_pdf_path(pdf_tool()):
            with self.assertRaises(DraftError) as consent:
                extract_document(sample)
            self.assertEqual(consent.exception.code, "temporary_file_required")
        doc = extract_document({**sample, "allowTemporaryFile": True})
        self.assertIn("12 test cases", doc["pages"][0]["text"])

    def test_repository_checks_link_to_observed_object(self):
        def fetch(host, path):
            self.assertEqual(host, "api.github.com")
            if "/git/trees/" in path:
                self.assertIn("e" * 40, path)
                return {"sha": "e" * 40, "tree": [{"type": "blob", "path": p} for p in ["README.md", "tests/a.py"]], "truncated": True}
            if "/commits/" in path:
                return {"sha": "f" * 40, "commit": {"tree": {"sha": "e" * 40}}}
            return {"default_branch": "main", "language": "Python"}
        obj = repo_signals({"url": "https://github.com/sample/fictional"}, fetch)
        self.assertEqual([i["status"] for i in obj["checks"]], ["present", "present", "unknown", "unknown"])
        self.assertTrue(obj["checks"][1]["url"].endswith("/" + "f" * 40 + "/tests/a.py"))
        with self.assertRaises(DraftError):
            repo_signals({"url": "https://example.com/no/repo"}, fetch)

    def test_dart_fields_have_a_source_and_no_api_key(self):
        result = dart_company({"corpCode": "12345678"}, "k" * 40, lambda _host, _url: {"status": "000", "corp_name": "가상사"})
        self.assertEqual(result["fields"], [{"label":"기업명", "text":"가상사"}])
        self.assertNotIn("k" * 40, json.dumps(result))


class WorkerRecoveryTest(unittest.TestCase):
    def test_restart_marks_loss_and_unsettled_paid_call_once_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.sqlite3"
            owner, run = "test-owner", str(uuid4())
            h = History(path)
            h.open_worker(owner, run, "anthropic")
            event = dict(seq=1, type="iteration_start", phase="running", reason="none", iteration=1, spentMicros=0)
            h.append(owner, run, [event])
            with self.assertRaises(HistoryError):
                h.append(owner, run, [event], client=True)
            with self.assertRaises(HistoryError):
                h.delete(owner, run, client=True)
            h.mark_dispatch(owner, run)
            h.close()
            for _ in range(2):
                h = History(path)
                records = h.replay(owner, run, h.ticket(owner, run), 1, False)
                self.assertEqual([r["reason"] for r in records], ["cost_unknown", "input_required"])
                h.close()
