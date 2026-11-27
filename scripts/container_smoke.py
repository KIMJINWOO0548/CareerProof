"""Confirm the packaged Node worker and PDF extractor via the local HTTP surface."""
import base64
import http.cookiejar
import json
import sys
from pathlib import Path
from urllib.request import HTTPCookieProcessor, Request, build_opener

root = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(root), str(root / "tests")]
from test_evidence import one_page_pdf


def main():
    origin = "http://127.0.0.1:8765"
    client = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def api(path, data=None):
        req = Request(origin + path, data=json.dumps(data).encode() if data is not None else None,
                      headers={"Origin": origin, "Content-Type": "application/json", "X-CareerProof-Request": "1"})
        with client.open(req, timeout=20) as response:
            return json.load(response)

    api("/api/history/session", {})
    assert api("/api/runs")["available"], "Node worker unavailable"
    document = api("/api/extract", {"filename": "fixture.pdf", "contentBase64": base64.b64encode(one_page_pdf()).decode()})
    assert "12 test cases" in document["pages"][0]["text"], "Packaged PDF extraction failed"
    print("Container HTTP, worker detection and PDF extraction passed")


if __name__ == "__main__":
    main()
