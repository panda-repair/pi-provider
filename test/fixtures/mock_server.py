"""Record one local client prompt; serve only a scripted read and short replies."""
import datetime as dt
import json
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit

PANDA_SELECTORS = ("auto", "auto:cost", "auto:quality", "panel:panda", "panel:panda-quality")
# These raw grants make a router eligible. The integration runner never selects a backend for a successful turn.
_grant_file = Path(__file__).resolve().parents[2] / "src" / "routing-backend-grants.json"
BACKEND_GRANTS = tuple(json.loads(_grant_file.read_text(encoding="utf-8")))
MODELS = (*PANDA_SELECTORS, *BACKEND_GRANTS, "unknown-test-model")
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
        self.chat_count = 0
        self.runs = {}

    def admit(self, key, body, scenario):
        """Single-account fixture. Preserve raw capture and ignore seed/user for key matching."""
        with self.lock:
            self.chat_count += 1
            request = {k: v for k, v in body.items() if k not in ("seed", "user")}
            if scenario and scenario.startswith("saved-"):
                # Deliver a previous receipt on demand without admitting another fixture run.
                last = body.get("messages", [{}])[-1].get("content")
                for previous in self.runs.values():
                    if "FIXTURE_RECEIPT_" + previous["id"] in str(last):
                        return "replay", dict(previous)
            if key is not None and key in self.runs:
                run = self.runs[key]
                return ("replay" if run["request"] == request else "conflict"), dict(run)
            faults = {"prehold", "concurrency", "funding", "server_500", "upstream", "interrupted", "definite", "definite_proxy", "drop_running", "drop_completed",
                      "drop_partial", "cut_200", "unknown", "panel_failed_paid", "panel_failed_large", "panel_failed_unknown", "panel_failed_zero"}
            fault = scenario if self.chat_count == 1 and scenario in faults else None
            if fault in ("prehold", "concurrency", "funding"):
                return fault, None
            status = {"definite": "failed", "definite_proxy": "failed", "drop_partial": "partial",
                      "drop_running": "running"}.get(fault, "completed" if fault else "running")
            number = f"{len(self.runs) + 1:032x}"
            if fault and fault.startswith("panel_failed_"):
                status = "failed"
            cents = None if status == "running" else 0 if status == "failed" else 1
            if fault in ("panel_failed_paid", "panel_failed_large", "panel_failed_unknown"):
                cents = 3
            run = {"request": request, "id": "run-" + number, "request_id": "req_" + number,
                   "status": status, "cents": cents}
            self.runs[key if key is not None else object()] = run
            return fault or "normal", run

    def settle(self, run, status):
        with self.lock:
            run["status"] = status
            run["cents"] = 0 if status == "failed" else 1

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
    if any(tool.get("function", {}).get("name") == "panda_fixture_read" for tool in tools):
        return "panda_fixture_read", {"path": str(fixture)}
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

    def reply(self, status, kind, data, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)
        self.wfile.flush()
        self.close_connection = True

    @staticmethod
    def settlement(run, replay=False):
        amount = lambda cents: {"schema_version": "panda.usd-amount.v1", "currency": "USD", "minor_units": str(cents)}
        return {"version": "panda.chat.v1", "replay": replay, "request_id": run["request_id"], "run_id": run["id"],
                "status": run["status"], "charge": None if run["cents"] is None else amount(run["cents"]),
                "held": None if run["status"] == "running" else amount(0)}

    def fault(self, action, run, record):
        response_headers = {}
        receipt = None
        if run:
            record["run_id"] = run["id"]
            response_headers["X-Panda-Request-ID"] = run["id"]
        if action == "normal":
            return False
        record["response_mode"] = action
        if action in ("drop_running", "drop_completed", "drop_partial", "cut_200"):
            if action == "cut_200":
                record["response_status"] = 200
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", "4096")
                self.send_header("X-Panda-Request-ID", "fixture.502.trace")
                self.send_header("X-Private", "private-marker-header")
                self.end_headers()
                self.wfile.write(b": partial event stream\n\n")
                self.wfile.flush()
                time.sleep(0.04)
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            return True
        if action == "replay":
            status, code = 409, "mixture_already_" + run["status"]
            response_headers.update({"Idempotency-Replayed": "true", "x-should-retry": "false"})
            receipt = self.settlement(run, replay=True)
        elif action.startswith("panel_failed_"):
            status, code = 502, "answer_invalid"
            receipt = self.settlement(run)
            if action == "panel_failed_unknown":
                del receipt["charge"]
        else:
            status, code = {"prehold": (429, "throttle_workspace_rate_limited"), "definite": (503, "model_unavailable"),
                            "definite_proxy": (503, "model_unavailable"),
                            "unknown": (503, "outcome_unknown"), "conflict": (409, "mixture_idempotency_conflict"),
                            "concurrency": (429, "throttle_mixture_concurrency_exhausted"),
                            "funding": (429, "throttle_commercial_balance_source_bound_exceeded"),
                            "server_500": (500, "internal_error"), "upstream": (503, "inference_upstream_unavailable"),
                            "interrupted": (503, "interrupted")}[action]
            if action in ("definite", "definite_proxy"):
                receipt = self.settlement(run)
            if action in ("prehold", "concurrency"):
                response_headers["Retry-After"] = "0"
            elif action != "definite_proxy":
                response_headers["x-should-retry"] = "false"
        record.update(response_status=status, error_code=code)
        error_type = "server_error" if status >= 500 else "invalid_request_error"
        envelope = {"error": {"type": error_type, "code": code, "message": code}}
        if receipt:
            envelope["panda"] = receipt
            record["receipt"] = receipt
        if action == "panel_failed_large":
            envelope["panda"] = dict(receipt, agents=[{"answer": "private-marker-member" * 1800}])
        self.reply(status, "application/json", compact(envelope).encode(), response_headers)
        return True

    def capture(self):
        state = self.server
        record = state.recorder.start(self)
        admitted = None
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
            grants = getattr(state, "credential_models", {state.expected_token: getattr(state, "models", MODELS)})
            authorization = self.headers.get("Authorization", "")
            token = authorization.removeprefix("Bearer ") if authorization.startswith("Bearer ") else None
            record.update(body=body, raw_body=raw_text, body_bytes=len(raw), fixture_bearer_verified=token in grants)
            route = urlsplit(self.path).path
            status, content_type = 200, "application/json"
            if self.command == "GET" and route == "/v1/models":
                record.update(response_mode="models")
                if state.scenario == "discovery-401" or token not in grants:
                    record.update(response_status=401)
                    self.reply(401, "application/json", compact({"error": {"code": "inference_token_invalid",
                        "message": "private-marker-token"}}).encode())
                    return
                result = {"object": "list", "data": [{"id": m, "object": "model", "owned_by": "mock"} for m in grants[token]]}
                payload = compact(result).encode()
            elif self.command == "POST" and route == "/v1/chat/completions" and isinstance(body, dict):
                rejected = state.refusal(body) if hasattr(state, "refusal") else None
                if rejected:
                    status, code, param = rejected
                    record.update(response_status=status, error_code=code, response_mode="refused", param=param)
                    error = {"message": "Fixture refused this request.", "type": "invalid_request_error", "code": code, "param": param}
                    self.reply(status, "application/json", compact({"error": error}).encode(), {"x-should-retry": "false"})
                    return
                action, run = state.recorder.admit(self.headers.get("Idempotency-Key"), body, getattr(state, "scenario", None))
                if self.fault(action, run, record):
                    return
                admitted = run
                mode, delta, reason = answer_for(body, state.fixture)
                record.update(response_mode=mode)
                time.sleep(state.hold)
                base = {"id": "chatcmpl-local-%d" % record["id"], "created": int(time.time()), "model": body.get("model", "")}
                usage = {"prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60}
                mode = getattr(state, "scenario", None)
                panel_usage = mode in ("usage", "panel-context", "routed-context", "oversized-context") and state.recorder.chat_count == 1
                if panel_usage:
                    usage = {"prompt_tokens": 310000, "completion_tokens": 45, "total_tokens": 310045,
                             "prompt_tokens_details": {"cached_tokens": 9000}}
                if body.get("stream"):
                    content_type = "text/event-stream"
                    base["object"] = "chat.completion.chunk"
                    if "tool_calls" in delta:
                        delta = {"tool_calls": [dict(index=0, **delta["tool_calls"][0])]}
                    if mode in ("settled-cut", "settled-length", "content-filter", "summary-length", "branch-length"):
                        delta = {"content": "The paid partial answer."} if mode != "content-filter" else {}
                        reason = {"content-filter": "content_filter", "settled-cut": "stop"}.get(mode, "length")
                    choices = [{"index": 0, "delta": d, "finish_reason": end} for d, end in
                               [({"role": "assistant"}, None), (delta, None), ({}, reason)]]
                    chunks = [dict(base, choices=[c]) for c in choices]
                    if mode in ("paid-compaction", "paid-branch") or (mode or "").startswith("saved-"):
                        state.recorder.settle(admitted, "completed")
                        admitted["cents"] = 3
                        chunks[-1]["panda"] = dict(self.settlement(admitted), mode="single")
                    aggregate_test = (mode or "").startswith("aggregate-")
                    if aggregate_test:
                        state.recorder.settle(admitted, "completed")
                        admitted["cents"] = 3
                        chunks[-1]["panda"] = dict(self.settlement(admitted), mode="panel",
                            agents=[{"usage": {"input_tokens": 1200, "output_tokens": 4}}],
                            synthesis={"usage": {"input_tokens": 1800, "output_tokens": 10}})
                        counts = (0, 0) if mode == "aggregate-zero" else (3000, 24)
                        usage = None if mode == "aggregate-null" else dict(prompt_tokens=counts[0],
                            completion_tokens=counts[1], total_tokens=sum(counts))
                    if mode in ("settled-cut", "settled-length", "content-filter", "summary-length", "branch-length"):
                        state.recorder.settle(admitted, "completed")
                        admitted["cents"] = 0 if mode == "content-filter" else 3
                        chunks[-1]["panda"] = dict(self.settlement(admitted), mode="single")
                        if mode == "content-filter":
                            chunks[-1]["panda"]["status"] = "failed"
                        else:
                            partial = "".join("data: " + compact(chunk) + "\n\n" for chunk in chunks).encode()
                            record.update(response_status=200, receipt=chunks[-1]["panda"])
                            self.send_response(200)
                            self.send_header("Content-Type", "text/event-stream")
                            self.send_header("Content-Length", str(len(partial) + 4096))
                            self.end_headers()
                            self.wfile.write(partial)
                            self.wfile.flush()
                            time.sleep(0.035)
                            self.close_connection = True
                            self.connection.shutdown(socket.SHUT_RDWR)
                            return
                    if panel_usage:
                        def call(tokens):
                            return {"usage": {"input_tokens": tokens, "output_tokens": 15, "cached_input_tokens": 1200}}
                        prompt = 250000 if mode == "oversized-context" else 75000
                        state.recorder.settle(admitted, "completed")
                        admitted["cents"] = 13
                        chunks[-1]["panda"] = dict(self.settlement(admitted), mode="panel",
                            agents=[call(prompt), call(75000)], synthesis=call(160000))
                    if (body.get("stream_options") or {}).get("include_usage") and mode != "aggregate-missing":
                        chunks.append(dict(base, choices=[], usage=usage))
                    payload = ("".join("data: " + compact(chunk) + "\n\n" for chunk in chunks) +
                               "data: [DONE]\n\n").encode("utf-8")
                    if mode == "malformed":
                        payload = ("data: " + compact(chunks[1]) + "\n\ndata: {private-marker-invalid-json\n\n").encode()
                    elif mode == "stream-error":
                        error = {"error": {"code": "answer_invalid", "message": "private-marker-server-error",
                                           "metadata": {"raw": "private-marker-body"}}}
                        payload = ("data: " + compact(chunks[1]) + "\n\ndata: " + compact(error) + "\n\n").encode()
                else:
                    base["object"] = "chat.completion"
                    msg = dict({"role": "assistant", "content": None}, **delta)
                    payload = compact(dict(base, choices=[{"index": 0, "message": msg, "finish_reason": reason}], usage=usage)).encode()
            else:
                status, record["response_mode"] = 404, "unsupported_route"
                payload = compact({"error": {"message": "Route not provided by this Chat Completions fixture.", "type": "invalid_request_error", "code": "route_not_found"}}).encode()
            record.update(response_status=status, response_content_type=content_type)
            if admitted and admitted["status"] == "running":
                state.recorder.settle(admitted, "completed")
            self.reply(status, content_type, payload)
        except (BrokenPipeError, ConnectionResetError) as error:
            record["connection_error"] = type(error).__name__
        except Exception as error:
            if admitted and admitted["status"] == "running":
                state.recorder.settle(admitted, "failed")
            record.update(mock_error=repr(error), response_status=500)
            self.reply(500, "application/json", compact({"error": str(error)}).encode())
        finally:
            state.recorder.end(record)

    do_GET = do_POST = do_HEAD = do_OPTIONS = do_PUT = do_DELETE = do_PATCH = capture
