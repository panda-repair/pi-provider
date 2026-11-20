"""Record one local client prompt; serve only a scripted read and short replies."""
import datetime as dt
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit

MODELS = ("glm-5.3", "panel:panda", "auto:cost")
SENSITIVE_HEADERS = {"authorization", "proxy-authorization", "x-api-key", "api-key", "cookie"}


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds")


def publish(path, data):
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(data, encoding="utf-8")
    os.replace(temp, path)


class Recorder:
    def __init__(self, directory):
        self.directory = directory
        self.lock = threading.Lock()
        self.active = {}
        self.next_id = 1

    def start(self, handler):
        with self.lock:
            ident = self.next_id
            self.next_id += 1
            record = {
                "id": ident, "method": handler.command, "path": handler.path,
                "http_version": handler.request_version,
                "headers": [[k, "[REDACTED]" if k.lower() in SENSITIVE_HEADERS else v]
                            for k, v in handler.headers.raw_items()],
                "started_utc": utc(), "started_ns": time.monotonic_ns(),
                "overlap_ids": list(self.active), "response_status": None,
            }
            for other in self.active.values():
                other["overlap_ids"].append(ident)
            self.active[ident] = record
            return record

    def end(self, record):
        with self.lock:
            record["ended_ns"] = time.monotonic_ns()
            record["ended_utc"] = utc()
            self.active.pop(record["id"])
        publish(self.directory / ("%03d.json" % record["id"]),
                json.dumps(record, ensure_ascii=False, indent=2) + "\n")


def function_for_read(tools, fixture):
    for entry in tools:
        func = entry.get("function", {})
        name = func.get("name", "")
        props = func.get("parameters", {}).get("properties", {})
        label = name.lower().split("__")[-1]
        if label in ("read", "read_file", "readfile", "view", "read_text_file", "text_editor"):
            key = next((k for k in ("filePath", "path", "file_path", "target_file", "filename", "filepath") if k in props), None)
            if key:
                arguments = {key: str(fixture)}
                if label == "text_editor" and "command" in props:
                    arguments["command"] = "view"
                return name, arguments
    return None


def answer_for(body, fixture):
    messages = body.get("messages") or []
    tools = body.get("tools") or []
    observed_call = any(c.get("id") == "call_capture_read" for m in messages for c in (m.get("tool_calls") or []))
    if observed_call:
        tool_text = " ".join(compact(m.get("content", "")) for m in messages if m.get("role") == "tool")
        # Only echo the marker when the client's *tool result* contains it.
        expected = fixture.read_text(encoding="utf-8").splitlines()[0]
        if expected in tool_text:
            return "main_final", {"content": "Fixture read confirmed: " + expected}, "stop"
        return "main_unverified", {"content": "The returned tool result did not contain the fixture marker."}, "stop"
    read = function_for_read(tools, fixture)
    has_prompt = any(m.get("role") == "user" and fixture.name in compact(m.get("content", "")) for m in messages)
    if read and has_prompt:
        name, args = read
        call = {"id": "call_capture_read", "type": "function", "function": {"name": name, "arguments": compact(args)}}
        return "main_read", {"tool_calls": [call]}, "tool_calls"
    return "side_text", {"content": "Read a scratch fixture"}, "stop"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def reply(self, status, kind, data):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.wfile.flush()
        self.close_connection = True

    def capture(self):
        state = self.server
        record = state.recorder.start(self)
        try:
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                pieces = []
                while True:
                    size = int(self.rfile.readline().split(b";", 1)[0], 16)
                    if not size:
                        while self.rfile.readline() not in (b"", b"\r\n"):
                            pass
                        break
                    pieces.append(self.rfile.read(size))
                    self.rfile.readline()
                raw = b"".join(pieces)
            else:
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            raw_text = raw.decode("utf-8")
            try:
                body = json.loads(raw_text) if raw_text else None
            except ValueError:
                body = None
            record.update(body=body, raw_body=raw_text, body_bytes=len(raw))
            route = urlsplit(self.path).path
            status, content_type = 200, "application/json"
            if self.command == "GET" and route == "/v1/models":
                record.update(response_mode="models")
                result = {"object": "list", "data": [{"id": m, "object": "model", "owned_by": "mock"} for m in MODELS]}
                payload = compact(result).encode()
            elif self.command == "POST" and route == "/v1/chat/completions" and isinstance(body, dict):
                mode, delta, reason = answer_for(body, state.fixture)
                record.update(response_mode=mode)
                time.sleep(state.hold)
                base = {"id": "chatcmpl-local-%d" % record["id"], "created": int(time.time()), "model": body.get("model", "")}
                usage = {"prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60}
                if body.get("stream"):
                    content_type = "text/event-stream"
                    base["object"] = "chat.completion.chunk"
                    if "tool_calls" in delta:
                        delta = {"tool_calls": [dict(index=0, **delta["tool_calls"][0])]}
                    choices = [{"index": 0, "delta": d, "finish_reason": end} for d, end in
                               [({"role": "assistant"}, None), (delta, None), ({}, reason)]]
                    chunks = [dict(base, choices=[c]) for c in choices]
                    if (body.get("stream_options") or {}).get("include_usage"):
                        chunks.append(dict(base, choices=[], usage=usage))
                    payload = ("".join("data: " + compact(chunk) + "\n\n" for chunk in chunks) +
                               "data: [DONE]\n\n").encode("utf-8")
                else:
                    base["object"] = "chat.completion"
                    msg = dict({"role": "assistant", "content": None}, **delta)
                    payload = compact(dict(base, choices=[{"index": 0, "message": msg, "finish_reason": reason}], usage=usage)).encode()
            else:
                status, record["response_mode"] = 404, "unsupported_route"
                payload = compact({"error": {"message": "Route not provided by this Chat Completions fixture.", "type": "invalid_request_error", "code": "route_not_found"}}).encode()
            record.update(response_status=status, response_content_type=content_type)
            self.reply(status, content_type, payload)
        except (BrokenPipeError, ConnectionResetError) as error:
            record["connection_error"] = type(error).__name__
        except Exception as error:
            record.update(mock_error=repr(error), response_status=500)
            self.reply(500, "application/json", compact({"error": str(error)}).encode())
        finally:
            state.recorder.end(record)

    do_GET = do_POST = do_HEAD = do_OPTIONS = do_PUT = do_DELETE = do_PATCH = capture
