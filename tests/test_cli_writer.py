import asyncio
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from scripts import careerproof_cli as cli

CODE = "C" * 43
TASK = {"instructions": "한국어로 작성", "context": {"facts": [{"id": "F1", "text": "마스킹된 사실"}]}}
DRAFT = {"text": "사실을 기록했습니다.", "factIds": ["F1"]}


@contextmanager
def fake_cli(provider, program):
    """Keep the production CLI arguments while substituting a synthetic child."""
    build = cli.command
    def fake_args(provider, executable, directory, model):
        args = build(provider, executable, directory, model)
        return [sys.executable, "-X", "utf8", "-c", program, *args[1:]]
    def local_api(port, path, payload):
        if path == "/api/agent/claim":
            return TASK
        return {"status": "received"}
    with patch.object(cli, "native_executable", return_value=provider), patch.object(cli, "command", fake_args), \
            patch.object(cli, "post", side_effect=local_api) as api:
        yield api


class NativeWriterTest(unittest.TestCase):
    def test_both_native_calls_and_privacy_boundary(self):
        common = """
import json, os, pathlib, sys
args = sys.argv[1:]
prompt = sys.stdin.buffer.read().decode("utf-8")
assert "마스킹된 사실" in prompt and "한국어로 작성" in prompt
assert "C" * 43 not in prompt + str(args) + str(os.environ)
assert "OPENAI_API_KEY" not in os.environ and "ANTHROPIC_API_KEY" not in os.environ
assert pathlib.Path.cwd().name.startswith("careerproof-writer-")
assert args[args.index("--model") + 1] == "example/writer:2"
draft = {"text": "사실을 기록했습니다.", "factIds": ["F1"]}
"""
        for provider, script in {
            "codex": """
assert args[0] == "exec" and args[-1] == "-"
for flag in ("--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check"):
    assert flag in args
assert args[args.index("-s")+1] == "read-only"
assert "shell_tool" in args and "hooks" in args and "plugins" in args
schema = json.loads(pathlib.Path(args[args.index("--output-schema")+1]).read_text())
assert set(schema["required"]) == set(draft)
print(json.dumps(draft))
""", "claude": """
for flag in ("-p", "--no-session-persistence", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands"):
    assert flag in args
assert args[args.index("--tools")+1] == ""
assert json.loads(args[args.index("--mcp-config")+1]) == {"mcpServers": {}}
assert set(json.loads(args[args.index("--json-schema")+1])["required"]) == set(draft)
print(json.dumps({"structured_output":draft,"result":"internal model text"}))
""",
        }.items():
            with self.subTest(provider=provider), fake_cli(provider, common + script) as api, \
                    patch.dict(os.environ, {"OPENAI_API_KEY": CODE, "ANTHROPIC_API_KEY": CODE}):
                cli.write_once(provider, 8765, CODE, "example/writer:2")
                self.assertEqual([args.args for args in api.call_args_list], [
                    (8765, "/api/agent/claim", {"code": CODE}),
                    (8765, "/api/agent/submit", {"code": CODE, "draft": DRAFT})])

    def test_failure_never_submits_or_exposes_output(self):
        for provider, script in [
            ("codex", "print('PRIVATE'); raise SystemExit(9)"),
            ("codex", "print('PRIVATE')"),
            ("codex", """print('{"text":"PRIVATE","factIds":["F2"]}')"""),
            ("claude", """print('{"result":"PRIVATE"}')"""),
            ("codex", "print('PRIVATE' * 100000)"),
        ]:
            with self.subTest(script=script), fake_cli(provider, script) as api:
                with self.assertRaises(cli.WriterError) as error:
                    cli.write_once(provider, 8765, CODE)
                self.assertNotIn("PRIVATE", str(error.exception))
                self.assertEqual(api.call_count, 1)

    def test_timeout_and_missing_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(cli.WriterError, "timed out"):
                asyncio.run(cli.run_process([sys.executable, "-c", "import time; time.sleep(8)"],
                                            directory, b"", timeout=0.1))
            with patch.dict(os.environ, {"PATH": directory}), self.assertRaisesRegex(cli.WriterError, "not found"):
                cli.native_executable("codex")

    def test_invalid_code_and_piped_entry_point(self):
        with patch.object(cli, "post") as api:
            with self.assertRaisesRegex(cli.WriterError, "43-character"):
                cli.write_once("codex", 8765, "invalid")
            api.assert_not_called()
        result = subprocess.run([sys.executable, str(Path(cli.__file__)), "codex"],
                                input=b"private-invalid-code\n", capture_output=True, timeout=5, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertNotIn(b"private-invalid-code", result.stderr)
        self.assertIn(b"43-character", result.stderr)

    def test_model_validation_requires_no_native_or_network_calls(self):
        with patch.object(cli, "native_executable") as native, patch.object(cli, "post") as api:
            for model in ("-p", "a b", "model\nkey", "a" * 121, CODE):
                with self.subTest(model=model), self.assertRaisesRegex(cli.WriterError, "model identifier"):
                    cli.write_once("claude", 8765, CODE, model)
            native.assert_not_called()
            api.assert_not_called()
        with tempfile.TemporaryDirectory() as directory:
            for provider in ("codex", "claude"):
                self.assertNotIn("--model", cli.command(provider, provider, directory))

    def test_already_claimed_code_never_starts_cli(self):
        with patch.object(cli, "native_executable", return_value="codex"), \
                patch.object(cli, "post", side_effect=cli.LocalHTTPError(409)) as api, \
                patch.object(cli, "run_process") as run:
            with self.assertRaisesRegex(cli.WriterError, "already used"):
                cli.write_once("codex", 8765, CODE)
            api.assert_called_once_with(8765, "/api/agent/claim", {"code": CODE})
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
