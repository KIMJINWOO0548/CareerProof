"""Deterministic fictional PDF extraction benchmark; standard library only.

Run: python scripts/benchmark_pdf.py --output-dir <temporary-directory>
Add --external-dir <directory> to score independently collected transcripts.
PDF bytes and gold are fixed before either extractor runs. No network is used.
"""

import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
import unicodedata
import zlib
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.evidence import DraftError, pdf_pages, pdf_tool


def normalized(text):
    """NFKC + casefold, removing whitespace only (including layout/newlines)."""
    return "".join(unicodedata.normalize("NFKC", text).casefold().split())


def tokens(text):
    return re.findall(r"\w+", unicodedata.normalize("NFKC", text).casefold())


def fixture(name, pages, spans, order, description):
    return {
        "id": name,
        "filename": name + ".pdf",
        "pages": pages,
        "spans": spans,
        "order": order,
        "description": description,
        "kind": "selectable",
    }


def fixtures():
    # Each page is explicit (x, y, text); gold comes from these authored lines.
    return [
        fixture(
            "01_english_control",
            [
                [
                    (48, 740, "FICTIONAL RESUME - Mira Vale"),
                    (48, 710, "Project Aurora: shipped 17 regression checks."),
                    (48, 680, "Reduced sandbox latency from 240 ms to 180 ms."),
                    (48, 650, "Evidence ID: AURORA-17; all facts are invented."),
                ]
            ],
            ["shipped 17 regression checks", "240 ms to 180 ms", "AURORA-17"],
            [
                ["shipped 17 regression checks", "240 ms to 180 ms"],
                ["240 ms to 180 ms", "AURORA-17"],
            ],
            "English single-column control",
        ),
        fixture(
            "02_korean_technical",
            [
                [
                    (48, 740, "가상 이력서 김하늘"),
                    (48, 710, "별빛 프로젝트에서 회귀 시험 열일곱 건을 작성했다."),
                    (48, 680, "가상 센서의 지연 시간을 사분의 일로 줄였다."),
                    (48, 650, "검증 기록은 달빛 보고서에 보관했다."),
                ]
            ],
            ["회귀 시험 열일곱 건", "지연 시간을 사분의 일로", "달빛 보고서"],
            [
                ["회귀 시험 열일곱 건", "지연 시간을 사분의 일로"],
                ["지연 시간을 사분의 일로", "달빛 보고서"],
            ],
            "Korean technical prose, Unicode CMap",
        ),
        fixture(
            "03_two_columns",
            [
                [
                    (40, 740, "FICTIONAL TWO COLUMN RESUME"),
                    (40, 700, "EXPERIENCE"),
                    (40, 670, "Orbit simulator: 23 checks."),
                    (40, 640, "Maple parser: 9 edge cases."),
                    (330, 700, "SKILLS"),
                    (330, 670, "Python and SQL practice."),
                    (330, 640, "Rust sandbox: 4 modules."),
                ]
            ],
            [
                "Orbit simulator: 23 checks",
                "Maple parser: 9 edge cases",
                "Python and SQL practice",
                "Rust sandbox: 4 modules",
            ],
            [
                ["Orbit simulator: 23 checks", "Maple parser: 9 edge cases"],
                ["Python and SQL practice", "Rust sandbox: 4 modules"],
            ],
            "Two columns; only within-column order is required, inter-column order unspecified",
        ),
        fixture(
            "04_multipage",
            [
                [
                    (48, 740, "FICTIONAL PROJECT LOG - PAGE ONE"),
                    (48, 700, "Cedar prototype passed 31 checks."),
                    (48, 670, "첫 단계에서 가상 자료를 정리했다."),
                ],
                [
                    (48, 740, "FICTIONAL PROJECT LOG - PAGE TWO"),
                    (48, 700, "Cedar follow-up resolved 8 anomalies."),
                    (48, 670, "마지막 단계에서 결과를 검토했다."),
                ],
            ],
            [
                "passed 31 checks",
                "첫 단계에서 가상 자료",
                "resolved 8 anomalies",
                "마지막 단계에서 결과",
            ],
            [
                ["passed 31 checks", "첫 단계에서 가상 자료"],
                ["첫 단계에서 가상 자료", "resolved 8 anomalies"],
                ["resolved 8 anomalies", "마지막 단계에서 결과"],
            ],
            "Two pages with English and Korean evidence",
        ),
        fixture(
            "05_technical_symbols",
            [
                [
                    (48, 740, "FICTIONAL TECHNICAL NOTES"),
                    (48, 710, "C++ / C# / SQL: 42 synthetic cases."),
                    (48, 680, "p95=12.5ms; error_rate < 0.7%; batch_size=64."),
                    (48, 650, "API v2.4: /sandbox/check?mode=dry-run"),
                    (48, 620, "Trace code: ZEPHYR_0042; owner: fictional."),
                ]
            ],
            ["C++ / C# / SQL", "p95=12.5ms", "error_rate < 0.7%", "ZEPHYR_0042"],
            [["C++ / C# / SQL", "p95=12.5ms"], ["p95=12.5ms", "ZEPHYR_0042"]],
            "ASCII punctuation, identifiers, decimal and technical notation",
        ),
        {
            "id": "06_image_only",
            "filename": "06_image_only.pdf",
            "pages": [[]],
            "spans": [],
            "order": [],
            "kind": "image_only",
            "visual_text": "SCAN ONLY 27 TESTS",
            "description": "Raster-only invented evidence. Empty extraction is abstention, never a perfect text score.",
        },
    ]


def stream(data, extra=b""):
    return (
        b"<< /Length "
        + str(len(data)).encode()
        + b" "
        + extra
        + b">>\nstream\n"
        + data
        + b"\nendstream"
    )


def raster():
    # Locally authored 5x7 bitmap glyphs, deliberately no PDF text objects.
    rows = {
        "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
        "C": ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
        "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
        "N": ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
        "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
        "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
        "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
        "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
        "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
        "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
        "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
        " ": ["00000"] * 7,
    }
    label = "SCAN ONLY 27 TESTS"
    width, height = len(label) * 6 + 4, 11
    pixels = bytearray([255] * width * height)
    for i, char in enumerate(label):
        for y, row in enumerate(rows[char]):
            for x, bit in enumerate(row):
                if bit == "1":
                    pixels[(y + 2) * width + i * 6 + x + 2] = 0
    return width, height, zlib.compress(bytes(pixels), 9)


def make_pdf(item):
    objects = [b"", b"", b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"]
    chars = sorted(
        {
            c
            for page in item["pages"]
            for _, _, line in page
            for c in line
            if ord(c) > 127
        }
    )
    # Identity encoding + explicit Unicode map avoids external CMap/font files.
    # Readers may substitute a font for display; extraction is self-contained.
    objects.append(
        b"<</Type/Font/Subtype/Type0/BaseFont/FictionalKorean/Encoding/Identity-H/DescendantFonts[5 0 R]/ToUnicode 6 0 R>>"
    )
    objects.append(
        b"<</Type/Font/Subtype/CIDFontType2/BaseFont/FictionalKorean/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/FontDescriptor 7 0 R/CIDToGIDMap/Identity/DW 1000/W[32 126 500]>>"
    )
    cmap = (
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n"
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
        "/CMapName /FictionalUnicode def /CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n"
    )
    # Include ASCII because Korean lines include spaces and punctuation.
    codes = sorted(set(range(32, 127)) | {ord(c) for c in chars})
    for start in range(0, len(codes), 100):
        chunk = codes[start : start + 100]
        cmap += (
            f"{len(chunk)} beginbfchar\n"
            + "".join(f"<{c:04X}> <{c:04X}>\n" for c in chunk)
            + "endbfchar\n"
        )
    cmap += "endcmap CMapName currentdict /CMap defineresource pop end end"
    objects.append(stream(cmap.encode("ascii")))
    objects.append(
        b"<</Type/FontDescriptor/FontName/FictionalKorean/Flags 4/FontBBox[0 -200 1000 900]/ItalicAngle 0/Ascent 880/Descent -120/CapHeight 700/StemV 80>>"
    )
    image_id = None
    if item["kind"] == "image_only":
        width, height, pixels = raster()
        objects.append(
            stream(
                pixels,
                f"/Type/XObject/Subtype/Image/Width {width}/Height {height}/ColorSpace/DeviceGray/BitsPerComponent 8/Filter/FlateDecode ".encode(),
            )
        )
        image_id = len(objects)
    page_ids = []
    for page in item["pages"]:
        commands = []
        for x, y, line in page:
            if any(ord(c) > 127 for c in line):
                commands.append(
                    f"BT /F2 11 Tf 1 0 0 1 {x} {y} Tm <{line.encode('utf-16-be').hex()}> Tj ET"
                )
            else:
                escaped = (
                    line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
                )
                commands.append(f"BT /F1 11 Tf 1 0 0 1 {x} {y} Tm ({escaped}) Tj ET")
        if image_id:
            commands.append("q 510 0 0 55 40 650 cm /Scan Do Q")
        objects.append(stream("\n".join(commands).encode("ascii")))
        content_id = len(objects)
        image_resource = f"/XObject<</Scan {image_id} 0 R>>" if image_id else ""
        objects.append(
            f"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R/F2 4 0 R>>{image_resource}>>/Contents {content_id} 0 R>>".encode()
        )
        page_ids.append(len(objects))
    objects[0] = b"<</Type/Catalog/Pages 2 0 R>>"
    objects[1] = (
        f"<</Type/Pages/Count {len(page_ids)}/Kids[{' '.join(f'{i} 0 R' for i in page_ids)}]>>".encode()
    )
    pdf = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf.extend(f"{i} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = len(pdf)
    pdf.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010} 00000 n \n".encode())
    pdf.extend(
        f"trailer\n<</Size {len(offsets)}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    return bytes(pdf)


def score(item, text):
    if item["kind"] == "image_only":
        return {
            "status": "abstained" if not text.strip() else "text_returned",
            "text_metrics": None,
            "extracted_characters": len(text),
            "note": "Separate raster sentinel: no OCR expected; abstention is not evidence recovery.",
        }
    haystack = normalized(text)
    found = {span: haystack.find(normalized(span)) for span in item["spans"]}
    missing = [span for span, index in found.items() if index < 0]
    gold = "\n".join(line for page in item["pages"] for _, _, line in page)
    expected, actual = Counter(tokens(gold)), Counter(tokens(text))
    matched = sum((expected & actual).values())
    extra = actual - expected
    duplicates = sum(n for token, n in extra.items() if token in expected)
    relations = [
        {
            "before": a,
            "after": b,
            "observed": found[a] >= 0 and found[b] >= 0,
            "correct": found[a] < found[b] if found[a] >= 0 and found[b] >= 0 else None,
        }
        for a, b in item["order"]
    ]
    observed = sum(r["observed"] for r in relations)
    return {
        "status": "observed",
        "span_recall": (len(found) - len(missing)) / len(found),
        "missing_spans": missing,
        "token_precision": matched / sum(actual.values()) if actual else 0,
        "token_recall": matched / sum(expected.values()),
        "extraneous_token_count": sum(extra.values()),
        "duplicate_excess_token_count": duplicates,
        "extraneous_tokens": dict(extra),
        "order_accuracy": sum(r["correct"] is True for r in relations) / observed
        if observed
        else None,
        "order_coverage": observed / len(relations),
        "order_relations": relations,
    }


def transcript_text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(transcript_text(v) for v in value)
    if isinstance(value, dict):
        for key in ("pages", "tokens", "text", "str"):
            if key in value:
                return transcript_text(value[key])
    raise ValueError(
        "Transcript must contain text, pages, tokens, or PDF.js str fields"
    )


def write_json(path, data):
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def validate_capture(directory, items):
    """A recorded capture must match both the input PDFs and observed outputs."""
    metadata = directory / "capture.json"
    if not metadata.is_file():
        return
    records = json.loads(metadata.read_text(encoding="utf-8"))["fixtures"]
    if len(records) != len(items) or {r["id"] for r in records} != {
        i["id"] for i in items
    }:
        raise ValueError("capture.json contains a different fixture set")
    by_id = {record["id"]: record for record in records}
    for item in items:
        record = by_id[item["id"]]
        if record["sha256"] != item["sha256"]:
            raise ValueError(f"Captured PDF differs from generated PDF: {item['id']}")
        transcripts = [directory / (item["id"] + ext) for ext in (".txt", ".json")]
        existing = [path for path in transcripts if path.exists()]
        if record["status"] == "unobserved" and not existing:
            continue
        if record["status"] not in {"observed", "abstained"} or len(existing) != 1:
            raise ValueError(
                f"Capture status does not match saved transcript: {item['id']}"
            )
        if (
            hashlib.sha256(existing[0].read_bytes()).hexdigest()
            != record["transcript_sha256"]
        ):
            raise ValueError(f"Captured transcript has changed: {item['id']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--external-dir", type=Path)
    parser.add_argument("--external-label", default="OpenResume")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "careerproof").mkdir(exist_ok=True)
    items = fixtures()
    manifest = {
        "version": 1,
        "fictional": True,
        "fixture_source": "scripts/benchmark_pdf.py",
        "normalization": "NFKC + casefold + remove whitespace for spans/order; Unicode word-token multisets for precision/recall",
        "limitations": [
            "Six synthetic fixtures are not a population benchmark or an OCR evaluation.",
            "Korean uses nonembedded Identity-H CID text and an explicit ToUnicode map; renderer substitution may vary.",
            "Two-column inter-column ordering is intentionally unspecified.",
            "Duplicate excess counts repeated expected tokens beyond gold; does not detect every structural duplicate.",
            "No cross-tool latency comparison: UI and local extraction timings are incomparable.",
        ],
        "fixtures": [],
    }
    for item in items:
        data = make_pdf(item)
        (args.output_dir / item["filename"]).write_bytes(data)
        manifest["fixtures"].append(
            {**item, "sha256": hashlib.sha256(data).hexdigest()}
        )
    write_json(args.output_dir / "manifest.json", manifest)
    if args.external_dir:
        if not args.external_dir.is_dir():
            parser.error("external transcripts directory does not exist")
        try:
            validate_capture(args.external_dir, manifest["fixtures"])
        except (KeyError, ValueError, OSError) as exc:
            parser.error(str(exc))
    tool = pdf_tool()
    banner = None
    if tool:
        proc = subprocess.run(
            [tool, "-v"],
            capture_output=True,
            timeout=3,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        banner = (proc.stdout + proc.stderr).decode("utf-8", errors="replace").strip()
    report = {
        "manifest_sha256": hashlib.sha256(
            (args.output_dir / "manifest.json").read_bytes()
        ).hexdigest(),
        "extractor": {"path": tool, "banner": banner},
        "latency_comparison": None,
        "results": {},
    }
    labels = ["CareerProof"] + ([args.external_label] if args.external_dir else [])
    if len(set(labels)) != len(labels):
        parser.error("external label must differ from CareerProof")
    for label in labels:
        results = []
        for item in items:
            row = {"id": item["id"]}
            try:
                if label == "CareerProof":
                    start = time.perf_counter()
                    document = pdf_pages(
                        (args.output_dir / item["filename"]).read_bytes(), True
                    )
                    row["local_extraction_seconds_not_comparable_to_ui"] = (
                        time.perf_counter() - start
                    )
                    write_json(
                        args.output_dir / "careerproof" / (item["id"] + ".json"),
                        document,
                    )
                    text = transcript_text(document)
                    row["extracted_pages"] = len(document["pages"])
                    row["warning"] = document["warning"]
                else:
                    candidates = [
                        args.external_dir / (item["id"] + ext)
                        for ext in (".json", ".txt")
                    ]
                    existing = [p for p in candidates if p.is_file()]
                    if len(existing) != 1:
                        row.update(
                            status="unobserved",
                            reason="Exactly one matching .txt or .json transcript required",
                        )
                        results.append(row)
                        continue
                    path = existing[0]
                    raw = path.read_text(encoding="utf-8-sig")
                    text = (
                        transcript_text(json.loads(raw))
                        if path.suffix == ".json"
                        else raw
                    )
                    row["transcript_sha256"] = hashlib.sha256(
                        path.read_bytes()
                    ).hexdigest()
                row.update(score(item, text))
            except (DraftError, OSError, ValueError, subprocess.SubprocessError) as exc:
                row.update(status="error", reason=str(exc))
            results.append(row)
        selectable = [r for r in results if r["id"] != "06_image_only"]
        scored = [r for r in selectable if r["status"] == "observed"]
        report["results"][label] = {
            "selectable_fixture_coverage": f"{len(scored)}/{len(selectable)}",
            "mean_span_recall_observed_only": sum(r["span_recall"] for r in scored)
            / len(scored)
            if scored
            else None,
            "mean_token_precision_observed_only": sum(
                r["token_precision"] for r in scored
            )
            / len(scored)
            if scored
            else None,
            "span_recall_all_selectable_missing_observations_zero": sum(
                r["span_recall"] for r in scored
            )
            / len(selectable),
            "image_only_sentinel": results[-1],
            "fixtures": results,
        }
    write_json(args.output_dir / "report.json", report)
    print(
        json.dumps(
            {
                "output_dir": str(args.output_dir.resolve()),
                "report": "report.json",
                "coverage": {
                    k: v["selectable_fixture_coverage"]
                    for k, v in report["results"].items()
                },
            },
            ensure_ascii=False,
        )
    )
    return (
        1
        if any(
            r["status"] == "error" for r in report["results"]["CareerProof"]["fixtures"]
        )
        else 0
    )


if __name__ == "__main__":
    raise SystemExit(main())
