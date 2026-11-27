"""User-triggered portfolio previews and fixed-origin public evidence lookups."""

import base64
import binascii
import http.client
import io
import json
import os
import re
import shutil
import subprocess
import threading
import time
import tempfile
from contextlib import nullcontext
from functools import lru_cache
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlencode
from xml.etree import ElementTree as ET

from .drafts import DraftError

FILE_LIMIT = 5 * 1024 * 1024
TEXT_LIMIT = 100_000
_cache = {}
_lock = threading.Lock()


def extracted(pages, kind, warning=""):
    views = []
    remaining = TEXT_LIMIT
    for i, page in enumerate(pages, 1):
        page = page.replace("\x00", "").strip()
        if not page:
            continue
        if len(page) > remaining:
            warning = "미리보기는 처음 100,000자까지 표시합니다."
        if remaining:
            views.append({"page": i, "text": page[:remaining]})
        remaining -= min(remaining, len(page))
    if not views:
        warning = "추출할 텍스트가 없습니다. 이미지 문서는 원문을 직접 붙여 넣으세요."
    return {"kind": kind, "pages": views, "warning": warning}


def pdf_tool():
    path = shutil.which("pdftotext")
    if path or os.name != "nt":
        return path
    git = shutil.which("git")
    if git:
        root = Path(git).resolve().parent.parent
        for subdir in ("ucrt64", "mingw64", "usr"):
            tool = root / subdir / "bin" / "pdftotext.exe"
            if tool.is_file():
                return str(tool)
    return None


@lru_cache(maxsize=2)
def requires_pdf_path(tool):
    version = subprocess.run([tool, "-v"], capture_output=True, timeout=3,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    banner = (version.stdout + version.stderr).lower()
    # Poppler also credits Glyph & Cog but accepts '-' as its input stream.
    return b"glyph & cog" in banner and b"poppler" not in banner


def pdf_pages(content, allow_temporary):
    tool = pdf_tool()
    if not tool:
        raise DraftError(422, "PDF 추출기 pdftotext를 찾을 수 없습니다. Docker 구성을 쓰거나 텍스트를 붙여 넣으세요.")
    if b"%PDF-" not in content[:1024]:
        raise DraftError(422, "PDF 파일 형식을 확인하세요.")
    on_disk = requires_pdf_path(tool)
    if on_disk and not allow_temporary:
        raise DraftError(422, "이 기기의 PDF 추출기는 임시 파일을 사용합니다. 허용하거나 텍스트를 직접 붙여 넣으세요.", "temporary_file_required")
    with (tempfile.TemporaryDirectory(prefix="careerproof-pdf-") if on_disk else nullcontext(None)) as directory:
        source = "-"
        if directory:
            source = str(Path(directory) / "document.pdf")
            Path(source).write_bytes(content)
        return read_pdf_process(tool, source, content)


def read_pdf_process(tool, source, content):
    with subprocess.Popen([tool, "-f", "1", "-l", "30", "-layout", "-enc", "UTF-8", source, "-"],
                          stdin=subprocess.PIPE if source == "-" else subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)) as process:
        # Close the reader at the preview limit, even for large compressed streams.
        def feed():
            if process.stdin is None:
                return
            try:
                process.stdin.write(content)
                process.stdin.close()
            except (BrokenPipeError, OSError):
                pass

        writer = threading.Thread(target=feed, daemon=True)
        writer.start()
        timer = threading.Timer(12, process.kill)
        timer.start()
        try:
            raw = process.stdout.read(4 * TEXT_LIMIT + 1)
            clipped = len(raw) > 4 * TEXT_LIMIT
            if clipped:
                process.kill()
            if process.wait() and not clipped:
                raise DraftError(422, "PDF를 읽을 수 없습니다. 암호·손상 여부를 확인하거나 원문을 붙여 넣으세요.")
        finally:
            timer.cancel()
            writer.join(timeout=1)
    return extracted(raw.decode("utf-8", errors="replace").split("\f"), "pdf",
                     "앞 30쪽까지 추출합니다. 표의 열 순서와 이미지 속 글은 원본과 대조하세요.")


def xml_pages(content, kind):
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            if len(archive.infolist()) > 2000:
                raise ValueError()
            names = (["word/document.xml"] if kind == "docx" else
                     sorted((n for n in archive.namelist() if re.fullmatch(r"Contents/section\d{1,4}\.xml", n)),
                            key=lambda n: int(re.search(r"\d+", n)[0])))
            if not names or sum(archive.getinfo(n).file_size for n in names) > 8 * 1024 * 1024:
                raise ValueError()
            pages = []
            for name in names:
                xml = archive.read(name)
                if b"<!DOCTYPE" in xml.upper().replace(b"\x00", b""):
                    raise ValueError()
                doc = ET.fromstring(xml)
                paragraphs = ["".join(t.text or "" for t in p.iter() if t.tag.rsplit("}", 1)[-1] == "t")
                              for p in doc.iter() if p.tag.rsplit("}", 1)[-1] == "p"]
                pages.append("\n".join(paragraphs))
            return extracted(pages, kind, "문서 순서로 추출한 텍스트입니다. 표와 도형 배치는 원본에서 확인하세요.")
    except (KeyError, ValueError, RuntimeError, OSError, ET.ParseError, zipfile.BadZipFile):
        raise DraftError(422, "지원하는 문서 구조를 읽을 수 없습니다. 텍스트를 붙여 넣으세요.") from None


def extract_document(data):
    if not isinstance(data, dict) or not isinstance(data.get("filename"), str):
        raise DraftError(422, "문서 파일을 선택하세요.")
    try:
        content = base64.b64decode(data["contentBase64"], validate=True)
    except (KeyError, TypeError, ValueError, binascii.Error):
        raise DraftError(422, "파일 내용을 읽을 수 없습니다.") from None
    if not 0 < len(content) <= FILE_LIMIT:
        raise DraftError(413, "문서는 5MiB 이내의 파일을 선택하세요.")
    kind = Path(data["filename"]).suffix.lower().lstrip(".")
    if kind in {"txt", "md"}:
        try:
            return extracted([content.decode("utf-8-sig")], kind)
        except UnicodeError:
            raise DraftError(422, "텍스트 파일을 UTF-8로 저장하거나 원문을 붙여 넣으세요.") from None
    if kind == "pdf":
        return pdf_pages(content, data.get("allowTemporaryFile") is True)
    if kind in {"docx", "hwpx"}:
        return xml_pages(content, kind)
    raise DraftError(422, "PDF, Markdown, TXT, DOCX 또는 HWPX 파일을 선택하세요.")


def public_json(host, path):
    conn = http.client.HTTPSConnection(host, timeout=8)
    try:
        conn.request("GET", path, headers={"User-Agent": "CareerProof-local", "Accept": "application/json"})
        response = conn.getresponse()
        if response.status in (403, 429):
            raise DraftError(429, "자료 제공처의 조회 한도 또는 접근 권한을 확인하세요.")
        if response.status != 200:
            raise DraftError(422, "공개 자료를 찾을 수 없습니다. 주소 또는 식별자를 확인하세요.")
        raw = response.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise DraftError(422, "조회할 자료가 너무 큽니다. 근거 파일을 직접 선택하세요.")
        return json.loads(raw)
    except (OSError, ValueError, http.client.HTTPException):
        raise DraftError(503, "자료 제공처에 연결할 수 없습니다. 잠시 뒤 다시 시도하세요.") from None
    finally:
        conn.close()


def cached(key, fn, ttl):
    now = time.monotonic()
    with _lock:
        entry = _cache.get(key)
        if entry and now < entry[0]:
            return entry[1]
    result = fn()
    with _lock:
        if len(_cache) >= 128:
            del _cache[min(_cache, key=lambda k: _cache[k][0])]
        _cache[key] = (now + ttl, result)
    return result


def repo_signals(data, fetch=public_json):
    url = data.get("url") if isinstance(data, dict) else None
    m = re.fullmatch(r"https://github\.com/([a-zA-Z0-9][a-zA-Z0-9-]{0,38})/([\w.-]{1,100})/?", url or "", re.ASCII) if isinstance(url, str) else None
    if not m or m[2] in (".", ".."):
        raise DraftError(422, "https://github.com/소유자/저장소 형식의 공개 저장소 주소를 입력하세요.")
    owner, repo = m.groups()
    host = "api.github.com"
    api = f"/repos/{owner}/{repo}"
    html = f"https://github.com/{owner}/{repo}"

    def load():
        info = fetch(host, api)
        branch = quote(info["default_branch"], safe="")
        head = fetch(host, api + "/commits/" + branch)
        commit = head["sha"]
        tree = fetch(host, api + "/git/trees/" + head["commit"]["tree"]["sha"] + "?recursive=1")
        files = [i["path"] for i in tree.get("tree", []) if i.get("type") == "blob"]
        checks = []
        for label, pattern in [
            ("README", r"^readme(?:\.[^/]+)?$"), ("테스트", r"(^|/)(tests?|__tests__)/|(?:^|/)(test_[^/]+|[^/]+\.(?:test|spec)\.[^/]+)$"),
            ("CI 설정", r"^\.github/workflows/[^/]+\.ya?ml$"), ("라이선스", r"^(?:licen[sc]e|copying)(?:\.[^/]+)?$"),
        ]:
            path = next((p for p in files if re.search(pattern, p, re.I)), None)
            checks.append({"label": label, "status": "present" if path else "unknown" if tree.get("truncated") else "missing",
                           "path": path, "url": html + "/blob/" + commit + "/" + quote(path) if path else html})
        return {"url": html, "sha": commit, "language": info.get("language"), "pushedAt": info.get("pushed_at"),
                "retrievedAt": datetime.now(timezone.utc).isoformat(), "checks": checks, "truncated": bool(tree.get("truncated"))}
    return cached(("github", html.lower()), load, 3600) if fetch is public_json else load()


def dart_company(data, key, fetch=public_json):
    code = data.get("corpCode") if isinstance(data, dict) else None
    if not isinstance(code, str) or not re.fullmatch(r"[0-9]{8}", code):
        raise DraftError(422, "DART 고유번호 8자리를 입력하세요.")
    if not isinstance(key, str) or not re.fullmatch(r"[0-9a-zA-Z]{40}", key):
        raise DraftError(422, "OpenDART 인증키를 확인하세요.")

    def load():
        obj = fetch("opendart.fss.or.kr", "/api/company.json?" + urlencode({"crtfc_key": key, "corp_code": code}))
        if obj.get("status") != "000":
            raise DraftError(422, "DART 기업개황을 조회하지 못했습니다. 고유번호·키·잔여 한도를 확인하세요.")
        fields = [(label, obj.get(k)) for label, k in [("기업명", "corp_name"), ("업종 코드", "induty_code"),
                                                        ("설립일", "est_dt"), ("종목 코드", "stock_code")]]
        return {"source": "OpenDART 기업개황", "corpCode": code, "url": "https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019002",
                "retrievedAt": datetime.now(timezone.utc).isoformat(), "fields": [{"label": label, "text": value} for label, value in fields if value]}
    return cached(("dart", code), load, 7 * 86400) if fetch is public_json else load()
