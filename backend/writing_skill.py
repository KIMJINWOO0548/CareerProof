"""Read trusted writing guidance from the bundled portable skill."""

from pathlib import Path

DOCUMENT_KINDS = ("self_intro", "career_desc", "portfolio", "resume_form")
_SKILL = Path(__file__).resolve().parents[1] / "skills" / "careerproof-resume" / "SKILL.md"


def writing_instructions(document_kind="self_intro"):
    if document_kind not in DOCUMENT_KINDS:
        raise ValueError("지원하는 문서 종류를 선택하세요.")
    body = _SKILL.read_text(encoding="utf-8").split("---\n", 2)[2]
    common, *modes = body.strip().split("\n## ")
    sections = dict(mode.split("\n", 1) for mode in modes)
    return common.strip() + "\n\n" + sections[document_kind].strip()
