"""Local stdio MCP bridge for a CareerProof writing session."""
import argparse
import http.client
import json
import sys

VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
MAX_BYTES = 1024 * 1024
CODE = {"type": "string", "minLength": 1, "maxLength": 256}
DRAFT_TEXT = {"type": "string", "minLength": 1, "maxLength": 16000}
FACT_IDS = {"type": "array", "minItems": 1, "maxItems": 40, "uniqueItems": True,
            "items": {"type": "string", "minLength": 1, "maxLength": 100}}


def tool(name, description, **fields):
    return {"name": name, "description": description, "inputSchema": {
        "type": "object", "properties": fields, "required": list(fields),
        "additionalProperties": False}}


TOOLS = [
    tool("read_writing_task", "Read the masked writing task for the supplied CareerProof code.", code=CODE),
    tool("submit_draft", "Return a draft with its supporting fact IDs to CareerProof for review.",
         code=CODE, text=DRAFT_TEXT, factIds=FACT_IDS),
]


class LocalHTTPError(ValueError):
    def __init__(self, status):
        super().__init__(status)
        self.status = status


def post(port, path, payload):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request("POST", path, json.dumps(payload).encode("ascii"), headers={
            "Content-Type": "application/json", "Origin": f"http://127.0.0.1:{port}",
            "X-CareerProof-Request": "1"})
        response = conn.getresponse()
        if response.status != 200:
            raise LocalHTTPError(response.status)
        body = response.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            raise ValueError()
        result = json.loads(body.decode("utf-8"))
        if not isinstance(result, dict):
            raise TypeError("Invalid CareerProof response")
        return result
    finally:
        conn.close()


def content(message, failed=False):
    return {"content": [{"type": "text", "text": message}], "isError": failed}


def bounded_string(value, limit):
    return isinstance(value, str) and 0 < len(value) <= limit and bool(value.strip())


def call(name, args, port):
    if not isinstance(args, dict) or not bounded_string(args.get("code"), 256):
        return content("Supply the writing task code from CareerProof.", True)
    try:
        if name == "read_writing_task":
            if set(args) != {"code"}:
                return content("This tool accepts only the writing task code.", True)
            reply = post(port, "/api/agent/read", args)
            if not isinstance(reply.get("instructions"), str) or not isinstance(reply.get("context"), dict):
                raise ValueError()
            reply = {"instructions": reply["instructions"], "context": reply["context"]}
        else:
            refs = args.get("factIds")
            if (set(args) != {"code", "text", "factIds"} or not bounded_string(args["text"], 16000)
                    or not isinstance(refs, list) or not 1 <= len(refs) <= 40
                    or not all(bounded_string(ref, 100) for ref in refs) or len(set(refs)) != len(refs)):
                return content("Supply draft text and a list of distinct supporting fact IDs.", True)
            reply = post(port, "/api/agent/submit", {"code": args["code"],
                        "draft": {"text": args["text"], "factIds": refs}})
            if reply.get("status") != "received":
                raise ValueError()
            reply = {"status": "received"}
        return content(json.dumps(reply, ensure_ascii=False, allow_nan=False))
    except (OSError, http.client.HTTPException, TypeError, ValueError, RecursionError):
        return content("CareerProof could not complete the request. Check the local app and task code.", True)


def error(req_id, code, message):
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


class Session:
    def __init__(self, port):
        self.port = port
        self.state = "new"

    def handle(self, req):
        if not isinstance(req, dict) or req.get("jsonrpc") != "2.0" or not isinstance(req.get("method"), str):
            return error(None, -32600, "Invalid request")
        method = req["method"]
        if "id" not in req:
            if self.state == "initializing" and method == "notifications/initialized":
                self.state = "ready"
            return None
        req_id = req["id"]
        if type(req_id) not in (int, str):
            return error(None, -32600, "Invalid request ID")
        params = req.get("params", {})
        if not isinstance(params, dict):
            return error(req_id, -32602, "Invalid parameters")
        if method == "ping":
            result = {}
        elif method == "initialize" and self.state == "new":
            version = params.get("protocolVersion")
            if not isinstance(version, str):
                return error(req_id, -32602, "Missing protocol version")
            self.state = "initializing"
            result = {"protocolVersion": version if version in VERSIONS else VERSIONS[0],
                      "capabilities": {"tools": {}}, "serverInfo": {"name": "careerproof", "version": "1.0"}}
        elif self.state != "ready":
            return error(req_id, -32002, "Initialize the session first")
        elif method == "tools/list":
            result = {"tools": TOOLS}
        elif method == "tools/call":
            name = params.get("name")
            if name not in ("read_writing_task", "submit_draft"):
                return error(req_id, -32602, "Unknown tool")
            result = call(name, params.get("arguments"), self.port)
        else:
            return error(req_id, -32601, "Method not found")
        return {"jsonrpc": "2.0", "id": req_id, "result": result}


def serve(port):
    session = Session(port)
    source = sys.stdin.buffer
    while line := source.readline(MAX_BYTES + 1):
        if len(line) > MAX_BYTES:
            while line and not line.endswith(b"\n"):
                line = source.readline(MAX_BYTES + 1)
            reply = error(None, -32600, "Request too large")
        else:
            try:
                reply = session.handle(json.loads(line.decode("utf-8")))
            except (ValueError, RecursionError):
                reply = error(None, -32700, "Invalid JSON")
        if reply is not None:
            sys.stdout.buffer.write(json.dumps(reply, separators=(",", ":")).encode("ascii") + b"\n")
            sys.stdout.buffer.flush()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    options = parser.parse_args()
    if not 1 <= options.port <= 65535:
        parser.error("port must be between 1 and 65535")
    try:
        serve(options.port)
    except BrokenPipeError:
        pass
