"""Confirm the packaged Node worker and PDF extractor via the local HTTP surface."""
import base64
import http.cookiejar
import json
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener
from uuid import uuid4

root = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(root), str(root / "tests")]
from test_evidence import one_page_pdf
from test_workers import FACT, start_payload


def main():
    origin = "http://127.0.0.1:8765"
    client = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def api(path, data=None):
        req = Request(origin + path, data=json.dumps(data).encode() if data is not None else None,
                      headers={"Origin": origin, "Content-Type": "application/json", "X-CareerProof-Request": "1"})
        try:
            with client.open(req, timeout=20) as response:
                return json.load(response)
        except HTTPError as error:
            raise RuntimeError(f"{path} returned {error.code}: {error.read(512).decode()}") from error

    api("/api/history/session", {})
    task = api("/api/agent/start", {"question": "담당 업무", "documentKind": "career_desc",
                                   "facts": [{"id": "F-1", "text": FACT}]})
    code = {"code": task["code"]}
    assert "경력기술서는" in api("/api/agent/claim", code)["instructions"], "Packaged writing skill unavailable"
    api("/api/agent/submit", {**code, "draft": {"text": FACT, "factIds": ["F-1"]}})
    assert api("/api/agent/result", code)["text"] == FACT
    api("/api/agent/cancel", code)
    assert api("/api/runs")["available"], "Node worker unavailable"
    # This eligible baseline already meets the target and completes before any model call.
    payload = start_payload(target=100, initial={"text": FACT + "가" * 310, "factIds": ["F-1"]}, budgetUsd=0)
    snapshot = api("/api/runs", payload)
    run_path = "/api/runs/" + payload["runId"]
    deadline = time.monotonic() + 10
    while snapshot["state"]["phase"] != "completed" and time.monotonic() < deadline:
        time.sleep(0.1)
        snapshot = api(run_path + "?state=1")
    assert snapshot["state"]["reason"] == "target_reached" and snapshot["state"]["iteration"] == 0, snapshot["state"]
    api(run_path + "/delete", {"commandId": str(uuid4()), "baseVersion": snapshot["version"]})
    document = api("/api/extract", {"filename": "fixture.pdf", "contentBase64": base64.b64encode(one_page_pdf()).decode()})
    assert "12 test cases" in document["pages"][0]["text"], "Packaged PDF extraction failed"
    print("Container HTTP, writing skill round trip, zero-call worker completion and PDF extraction passed")


if __name__ == "__main__":
    main()
