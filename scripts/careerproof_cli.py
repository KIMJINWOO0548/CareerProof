"""Submit one CareerProof draft through the user's locally authenticated CLI."""
import argparse
import asyncio
import getpass
import http.client
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

if __package__:
    from .careerproof_mcp import LocalHTTPError, bounded_string, post
else:
    from careerproof_mcp import LocalHTTPError, bounded_string, post

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.drafts import DRAFT_SCHEMA, MODEL_NAME

CODE = re.compile(r"[A-Za-z0-9_-]{43}")
OUTPUT_LIMIT = 512 * 1024
TIMEOUT = 180
# Native clients locate their own saved login. Do not inherit provider keys,
# endpoint overrides, shell startup scripts or application-specific variables.
NATIVE_ENV = ("PATH", "HOME", "USER", "LOGNAME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
              "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR",
              "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
              "DBUS_SESSION_BUS_ADDRESS", "CODEX_HOME", "CLAUDE_CONFIG_DIR")


class WriterError(Exception):
    """Only fixed, user-facing messages may be passed to this exception."""


def native_executable(provider):
    name = provider + (".exe" if os.name == "nt" else "")
    for entry in os.get_exec_path():
        directory = Path(entry)
        executable = directory / name
        if directory.is_absolute() and executable.is_file() and os.access(executable, os.X_OK):
            return str(executable)
    raise WriterError(f"{name} was not found on PATH. Install or locate the official CLI and sign in separately.")


def command(provider, executable, directory, model=None):
    schema = json.dumps(DRAFT_SCHEMA, separators=(",", ":"))
    selection = ["--model", model] if model is not None else []
    if provider == "claude":
        return [executable, "-p", *selection, "--safe-mode", "--tools", "", "--disallowedTools", "mcp__*",
                "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence",
                "--disable-slash-commands", "--setting-sources", "", "--output-format", "json",
                "--json-schema", schema]
    schema_path = Path(directory, "draft-schema.json")
    schema_path.write_text(schema, encoding="utf-8")
    args = [executable, "exec", *selection, "--ignore-user-config", "--ignore-rules", "--ephemeral",
            "-s", "read-only", "--skip-git-repo-check", "--output-schema", str(schema_path),
            "-c", 'web_search="disabled"']
    for feature in ("shell_tool", "unified_exec", "apps", "plugins", "hooks", "browser_use",
                    "in_app_browser", "skill_search", "tool_suggest", "image_generation",
                    "multi_agent", "multi_agent_v2", "code_mode", "view_image"):
        args.extend(["--disable", feature])
    return [*args, "--enable", "skip_host_skill_discovery", "-"]


async def run_process(args, directory, prompt, timeout=TIMEOUT):
    """Stream bounded bytes in both directions without persisting the task."""
    loop = asyncio.get_running_loop()
    finished = loop.create_future()
    closed = loop.create_future()
    output = bytearray()

    class Output(asyncio.SubprocessProtocol):
        def connection_made(self, transport):
            self.transport = transport
            stdin = transport.get_pipe_transport(0)
            stdin.write(prompt)
            stdin.close()

        def pipe_data_received(self, fd, data):
            if len(output) + len(data) > OUTPUT_LIMIT:
                if not finished.done():
                    finished.set_exception(WriterError("The CLI response exceeded the size limit."))
            else:
                output.extend(data)

        def connection_lost(self, exc):
            if not finished.done():
                finished.set_result(self.transport.get_returncode())
            closed.set_result(None)

    env = {name: os.environ[name] for name in NATIVE_ENV if name in os.environ}
    transport, _ = await loop.subprocess_exec(Output, *args, cwd=directory, env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        if await asyncio.wait_for(finished, timeout) != 0:
            raise WriterError("The CLI failed. Check its login and that its version supports the required flags.")
    except TimeoutError:
        raise WriterError("The CLI timed out. No draft was submitted.") from None
    finally:
        transport.close()
        await closed
    return bytes(output)


def write_once(provider, port, code, model=None):
    if not CODE.fullmatch(code):
        raise WriterError("Enter the 43-character task code shown in CareerProof.")
    if model is not None and (not MODEL_NAME.fullmatch(model) or code in model):
        raise WriterError("Use a model identifier of up to 120 letters, digits, dots, slashes, colons, underscores or hyphens, starting with a letter or digit.")
    executable = native_executable(provider)
    try:
        task = post(port, "/api/agent/claim", {"code": code})
    except LocalHTTPError as error:
        if error.status == 409:
            raise WriterError("This code was already used. Check the original task or create a new code in CareerProof.") from None
        raise
    instructions, context = task.get("instructions"), task.get("context")
    if not isinstance(instructions, str) or not isinstance(context, dict):
        raise WriterError("CareerProof returned an invalid writing task.")
    facts = context.get("facts")
    if not isinstance(facts, list) or not facts or not all(
            isinstance(f, dict) and bounded_string(f.get("id"), 100) for f in facts):
        raise WriterError("CareerProof returned invalid fact IDs.")
    allowed = {fact["id"] for fact in facts}
    prompt = instructions + "\n\n" + json.dumps(context, ensure_ascii=False)
    if code in prompt:
        raise WriterError("The writing material contains the task code. Edit the task before sending.")
    with TemporaryDirectory(prefix="careerproof-writer-") as directory:
        args = command(provider, executable, directory, model)
        raw = asyncio.run(run_process(args, directory, prompt.encode("utf-8")))
    try:
        draft = json.loads(raw.decode("utf-8"))
        if provider == "claude":
            if not isinstance(draft, dict) or draft.get("is_error"):
                raise ValueError()
            draft = draft.get("structured_output")
        if not isinstance(draft, dict) or draft.keys() != {"text", "factIds"}:
            raise ValueError()
        refs = draft["factIds"]
        if (not bounded_string(draft["text"], 16000) or not isinstance(refs, list) or not refs
                or not all(isinstance(ref, str) and ref in allowed for ref in refs)
                or len(set(refs)) != len(refs)):
            raise ValueError()
        draft["text"].encode("utf-8")
    except (ValueError, RecursionError):
        raise WriterError("The CLI returned an invalid draft or unsupported fact IDs. No draft was submitted.") from None
    if post(port, "/api/agent/submit", {"code": code, "draft": draft}).get("status") != "received":
        raise WriterError("CareerProof did not confirm receipt. Check the task in the app.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog=(
        "Each code allows one native CLI attempt. After a failed attempt, create a new task code to try again."))
    parser.add_argument("provider", choices=("codex", "claude"))
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model", metavar="NAME", help="Native CLI model ID or alias (default: CLI selection)")
    options = parser.parse_args()
    if not 1 <= options.port <= 65535:
        parser.error("port must be between 1 and 65535")
    try:
        if sys.stdin.isatty():
            code = getpass.getpass("CareerProof task code: ")
        else:
            code = sys.stdin.buffer.readline(46).decode("ascii").rstrip("\r\n")
        write_once(options.provider, options.port, code, options.model)
    except WriterError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, TypeError, ValueError, EOFError, RecursionError, http.client.HTTPException):
        print("Could not complete the request. Check the local app, task code and CLI installation.", file=sys.stderr)
        return 1
    print("Draft received. Review it in CareerProof.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
