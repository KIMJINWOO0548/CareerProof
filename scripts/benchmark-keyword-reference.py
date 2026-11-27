"""Compare keyword presence on the same synthetic inputs using both production matchers.

From CareerProof, with Python, Node.js and Git available:
  git clone https://github.com/srbhr/Resume-Matcher.git <local-checkout>
  git -C <local-checkout> checkout --detach 959e4587dab33d7ff849d822b8182e11e7669dfc
  python scripts/benchmark-keyword-reference.py --resume-matcher <local-checkout>

The benchmark reads only two verified Git blobs from the supplied checkout, with
no network or third-party Python dependencies required during the benchmark.
"""

import argparse
import ast
import hashlib
import json
import logging
import os
import re
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests/fixtures/keyword-reference.json"
COMMIT = "959e4587dab33d7ff849d822b8182e11e7669dfc"
SERVICES = "apps/backend/app/services"


def compile_verified_definitions(checkout, filename, sha256, names):
    object_name = f"{COMMIT}:{SERVICES}/{filename}"
    # Read committed bytes to avoid depending on checkout line ending settings.
    source = subprocess.check_output(
        [
            "git",
            "--no-replace-objects",
            "-C",
            str(checkout),
            "cat-file",
            "blob",
            object_name,
        ],
        env={**os.environ, "GIT_NO_LAZY_FETCH": "1"},
    )
    if hashlib.sha256(source).hexdigest() != sha256:
        raise ValueError(f"Unexpected SHA-256 for {object_name}")
    allowed = set(names)
    selected = []
    for node in ast.parse(source, filename=filename).body:
        if isinstance(node, ast.FunctionDef) and node.name in allowed:
            selected.append(node)
        elif isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Name) and target.id in allowed:
                selected.append(node)
    if len(selected) != len(allowed):
        raise ValueError(f"Unexpected definitions for {object_name}")
    return compile(ast.Module(body=selected, type_ignores=[]), filename, "exec")


def load_resume_matcher(checkout):
    # The verified helper definitions require only these standard library globals.
    # Leave the external app's import graph and other module initialization out.
    namespace = {"re": re, "Any": Any, "logger": logging.getLogger(__name__)}
    text_match = compile_verified_definitions(
        checkout,
        "text_match.py",
        "10c10b5987c5c15dcf759097a46a5bc40e1e4ad1cd26b663529f791a3ece653a",
        ("_CJK_CHAR_CLASS", "_CJK_RE", "keyword_in_text"),
    )
    refiner = compile_verified_definitions(
        checkout,
        "refiner.py",
        "4439b679d9348d226a3be8decfa5b0cef3a58ba16ff30a2c364b2ad6f1540774",
        ("job_keyword_terms", "calculate_keyword_match", "_extract_all_text"),
    )
    # Both code objects come from hash-verified Git blobs with fixed AST definitions.
    exec(text_match, namespace)  # noqa: S102
    exec(refiner, namespace)  # noqa: S102
    return namespace["calculate_keyword_match"]


def careerproof_predictions(inputs):
    node_code = """
        import { readFileSync } from "node:fs";
        import { termsIn } from "./frontend/research.js";
        const inputs = JSON.parse(readFileSync(0, "utf8"));
        process.stdout.write(JSON.stringify(inputs.map(({ term, text }) =>
          termsIn(text).includes(term)
        )));
    """
    output = subprocess.check_output(
        ["node", "--input-type=module", "-e", node_code],
        cwd=ROOT,
        input=json.dumps(inputs).encode("utf-8"),
    )
    return json.loads(output)


def resume_matcher_predictions(inputs, checkout):
    calculate_keyword_match = load_resume_matcher(checkout)
    predictions = []
    for case in inputs:
        score = calculate_keyword_match(
            {"summary": case["text"]}, {"required_skills": [case["term"]]}
        )
        if score not in (0.0, 100.0):
            raise ValueError(f"Expected a binary single-keyword score, got {score}")
        predictions.append(score == 100.0)
    return predictions


def show_results(name, cases, predictions):
    print(f"\n{name}")
    if len(cases) != len(predictions) or any(type(p) is not bool for p in predictions):
        raise ValueError(f"Expected one boolean prediction per case from {name}")
    positive = sum(case["present"] for case in cases)
    negative = len(cases) - positive
    false_positives = []
    false_negatives = []
    for case, predicted in zip(cases, predictions, strict=True):
        if predicted != case["present"]:
            failures = false_positives if predicted else false_negatives
            failures.append(case["id"])
    true_positive = positive - len(false_negatives)
    true_negative = negative - len(false_positives)
    correct = true_positive + true_negative
    print(f"  Accuracy {correct}/{len(cases)} ({correct / len(cases):.1%})")
    print(f"  True positive {true_positive}/{positive}")
    print(f"  True negative {true_negative}/{negative}")
    print(
        f"  False positive {len(false_positives)}/{negative} ({len(false_positives) / negative:.1%})"
    )
    print(f"    Cases: {', '.join(false_positives) or 'none'}")
    print(
        f"  False negative {len(false_negatives)}/{positive} ({len(false_negatives) / positive:.1%})"
    )
    print(f"    Cases: {', '.join(false_negatives) or 'none'}")
    groups = dict.fromkeys(case["group"] for case in cases)
    for group in groups:
        outcomes = [
            predicted == case["present"]
            for case, predicted in zip(cases, predictions, strict=True)
            if case["group"] == group
        ]
        print(f"  {group}: {sum(outcomes)}/{len(outcomes)} correct")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--resume-matcher",
        required=True,
        type=Path,
        help="trusted local Resume Matcher Git checkout",
    )
    args = parser.parse_args()
    cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
    inputs = [{"term": case["term"], "text": case["text"]} for case in cases]
    careerproof = careerproof_predictions(inputs)
    resume_matcher = resume_matcher_predictions(inputs, args.resume_matcher)

    positives = sum(case["present"] for case in cases)
    print(
        f"Keyword presence on {len(cases)} synthetic cases ({positives} present, {len(cases) - positives} absent)"
    )
    print(f"Resume Matcher reference commit {COMMIT}")
    print(
        "Both tools receive the same canonical term and text and apply their built-in matching rules."
    )
    print("The benchmark measures keyword presence in pre-extracted text.")
    print(
        "CareerProof requirement coverage uses verified source-linked facts and checks for same-clause actions."
    )
    show_results("CareerProof termsIn", cases, careerproof)
    show_results("Resume Matcher calculate_keyword_match", cases, resume_matcher)


if __name__ == "__main__":
    main()
