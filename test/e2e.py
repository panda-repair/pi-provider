"""Exercise the installed local package with Pi and an ADR 0079 slice C fixture on macOS."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import re
import subprocess
import sys
import threading
from contextlib import contextmanager, nullcontext
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]


def module_from(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@contextmanager
def unused_endpoint():
    """Count requests to the endpoint that Pi's provider override supersedes."""
    class Sink(BaseHTTPRequestHandler):
        def record(self):
            self.server.contacts += 1
            self.send_response(403)
            self.end_headers()

        do_GET = do_POST = record

        def log_message(self, *args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Sink) as server:
        server.contacts = 0
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            yield server
        finally:
            server.shutdown()
            thread.join()
        assert server.contacts == 0, "The superseded endpoint received a request."


def picker_ids(output):
    return {line.split()[1] for line in output.splitlines() if line.startswith("panda ")}


def check_fixture_ledger(mock):
    recorder = mock.Recorder(None)
    body = {"model": "auto", "messages": [{"role": "user", "content": "fixture"}]}
    _, first_unkeyed = recorder.admit(None, body, None)
    _, second_unkeyed = recorder.admit(None, body, None)
    assert first_unkeyed["id"] != second_unkeyed["id"]
    _, original = recorder.admit("one-key", body, None)
    action, pending = recorder.admit("one-key", dict(body, seed=44, user="local-user"), None)
    assert action == "replay" and pending["status"] == "running" and original["id"] == pending["id"]
    assert recorder.admit("one-key", dict(body, temperature=0.2), None)[0] == "conflict"
    recorder.settle(original, "completed")
    assert recorder.admit("one-key", body, None)[1]["status"] == "completed"
    assert pending["status"] == "running" and len(recorder.runs) == 3
    return {"unkeyedRequestsIndependent": True, "pendingReplay": True, "ignoredFields": ["seed", "user"],
            "changedTemperatureConflict": True, "settledReplay": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pi", type=Path, required=True, help="stock Pi 1.5.2 or 1.6.0 executable")
    parser.add_argument("--output", type=Path, required=True, help="new directory for isolated state and redacted captures")
    args = parser.parse_args()
    pi = args.pi.resolve()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    if not Path("/usr/bin/sandbox-exec").exists():
        parser.error("This capture runner uses macOS sandbox-exec to restrict client networking to loopback.")
    mock = module_from(ROOT / "test/fixtures/mock_server.py")
    admission = module_from(ROOT / "test/fixtures/admission.py")
    model_ids = mock.PANDA_SELECTORS
    work = out / "work"
    work.mkdir()
    env = {"PATH": os.defpath + ":" + str(Path(subprocess.check_output(["which", "node"], text=True).strip()).parent),
           "LANG": "en_US.UTF-8", "TERM": "dumb", "NO_COLOR": "1", "PI_SKIP_VERSION_CHECK": "1",
           "DO_NOT_TRACK": "1", "PANDA_API_TOKEN": "pnd_it_loopback_fixture", "npm_config_userconfig": str(out / "user.npmrc"),
           "npm_config_globalconfig": str(out / "global.npmrc"), "GIT_CONFIG_GLOBAL": "/dev/null"}
    for key in ("HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
                "PI_CODING_AGENT_DIR", "npm_config_cache"):
        env[key] = str(out / key.lower())
        Path(env[key]).mkdir()
    profile = '(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))' \
              '(deny file-write*)(allow file-write* (subpath ' + json.dumps(str(out)) + ') ' \
              '(literal "/dev/null") (literal "/dev/tty") (subpath "/dev/fd"))'

    def run(arguments, label, expect=0, program=None):
        command = ["/usr/bin/sandbox-exec", "-p", profile, *(program or [str(pi)]), *arguments]
        result = subprocess.run(command, cwd=work, env=env, capture_output=True, text=True,
                                stdin=subprocess.DEVNULL, timeout=60)
        (out / (label + ".stdout")).write_text(result.stdout)
        (out / (label + ".stderr")).write_text(result.stderr)
        if result.returncode != expect:
            raise RuntimeError(f"Pi exited {result.returncode}; see {label}.stderr")
        return result

    env["PANDA_BASE_URL"] = "http://127.0.0.1:1/v1"
    version = run(["--version"], "version").stdout.strip()
    assert version in ("1.5.2", "1.6.0"), version
    run(["install", str(ROOT)], "install")
    summary = {"pi": version, "models": {}}
    seen_keys = set()
    def capture(label, model, fault=None, extension=False, expect=0, native=None, check_cache=False):
        folder = out / "captures" / label
        folder.mkdir(parents=True)
        fixture = work / "capture-fixture.txt"
        marker = "PANDA_READ_" + secrets.token_hex(12)
        fixture.write_text(marker + "\n")
        with (ThreadingHTTPServer(("127.0.0.1", 0), mock.Handler) as server,
              (unused_endpoint() if check_cache else nullcontext()) as decoy):
            server.expected_token = env["PANDA_API_TOKEN"]
            server.refusal = admission.refusal
            server.fixture = fixture
            server.hold = 0.02
            server.recorder = mock.Recorder(folder)
            server.scenario = fault
            if native in ("picker-env", "picker-config"):
                server.models = ("auto:cost", mock.BACKEND_GRANTS[0])
            if native in ("picker-command", "picker-command-auth-rotation"):
                token = server.expected_token
                server.credential_models = {token: ("auto:cost", mock.BACKEND_GRANTS[0]),
                                           token + "_panel": ("panel:panda-quality",), token + "_empty": ()}
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                env["PANDA_BASE_URL"] = f"http://127.0.0.1:{server.server_port}/v1"
                extra = ["-e", str(ROOT / "test/fixtures/referenced-tool.mjs")] if extension else []
                if check_cache:
                    models_file = Path(env["PI_CODING_AGENT_DIR"]) / "models.json"
                    override = {"baseUrl": env["PANDA_BASE_URL"]}
                    models_file.write_text(json.dumps({"providers": {"panda": override}}))
                    env["PANDA_BASE_URL"] = f"http://127.0.0.1:{decoy.server_port}/v1"
                    cold = run(["--list-models", "panda"], label + "-cold")
                    assert not picker_ids(cold.stdout) and server.recorder.next_id == 1
                    env["PI_OFFLINE"] = "1"
                    run(["-p", "--no-session", "--model", "panda/" + model, "Hello"], label + "-offline", 1)
                    env.pop("PI_OFFLINE")
                    assert server.recorder.next_id == 1
                if native:
                    result = run([str(pi.parents[1]), native, model], label, expect,
                                 program=["node", str(ROOT / "test/fixtures/native.mjs")])
                else:
                    result = run([*extra, "-p", "--no-session", "--model", "panda/" + model,
                                  "Read capture-fixture.txt with the read tool and give its first line."], label, expect)
                if check_cache:
                    count = server.recorder.next_id
                    warm = run(["--list-models", "panda"], label + "-warm")
                    assert picker_ids(warm.stdout) == set(model_ids)
                    assert server.recorder.next_id == count
                    config_model = {"id": model, "name": "Configured test model", "input": ["text"],
                                    "reasoning": False, "contextWindow": 258000, "maxTokens": 16384,
                                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}
                    for api in ("openai-completions", "openai-responses"):
                        override["api"] = api
                        override["models"] = [dict(config_model, baseUrl=env["PANDA_BASE_URL"])]
                        models_file.write_text(json.dumps({"providers": {"panda": override}}))
                        refused = run(["-p", "--no-session", "--model", "panda/" + model, "Hello"],
                                      label + "-" + api, expect=1)
                        assert "configured provider endpoint" in refused.stderr
                    assert server.recorder.next_id == count
                    override.pop("models")
                    override.pop("api")
                    models_file.write_text(json.dumps({"providers": {"panda": override}}))
                    store = Path(env["PI_CODING_AGENT_DIR"]) / "models-store.json"
                    current = json.loads(store.read_text())["panda"]
                    assert {row["id"] for row in current["models"]} == set(model_ids)
                    assert env["PANDA_API_TOKEN"] not in json.dumps(current)
                    legacy_tag = hashlib.sha256((override["baseUrl"] + "\0" + server.expected_token).encode()).hexdigest()
                    former = [*current["models"], *(dict(current["models"][0], id=id) for id in mock.BACKEND_GRANTS)]
                    store.write_text(json.dumps({"panda": {**current, "models": former, "etag": "panda-v1-" + legacy_tag}}))
                    assert picker_ids(run(["--list-models", "panda"], label + "-upgrade").stdout) == set(model_ids)
                    assert server.recorder.next_id == count
                    for index, hidden in enumerate(mock.BACKEND_GRANTS):
                        for supplied in (False, True):
                            attrs = {"api": "openai-completions", "models": [dict(config_model, id=hidden)]} if supplied else {}
                            models_file.write_text(json.dumps({"providers": {"panda": {**override, **attrs}}}))
                            result_id = f"{label}-retired-{index}-{int(supplied)}"
                            offered = run(["--list-models", "panda"], result_id + "-list")
                            # A cache-only list can show a models.json entry (README); sending it must still fail.
                            if not supplied:
                                assert hidden not in picker_ids(offered.stdout)
                            run(["-p", "--no-session", "--model", "panda/" + hidden, "Hello"], result_id, expect=1)
                    assert server.recorder.next_id == count
                    override["apiKey"] = "$PANDA_FIXTURE_CUSTOM_TOKEN"
                    models_file.write_text(json.dumps({"providers": {"panda": override}}))
                    env["PANDA_FIXTURE_CUSTOM_TOKEN"] = server.expected_token
                    assert picker_ids(run(["--list-models", "panda"], label + "-custom-warm").stdout) == set(model_ids)
                    env["PANDA_FIXTURE_CUSTOM_TOKEN"] = "pnd_it_rotated_fixture"
                    assert not picker_ids(run(["--list-models", "panda"], label + "-custom-rotate").stdout)
                    env.pop("PANDA_FIXTURE_CUSTOM_TOKEN")
                    assert server.recorder.next_id == count
                    models_file.unlink()
            finally:
                server.shutdown()
                thread.join()
        records = [json.loads(p.read_text()) for p in sorted(folder.glob("*.json"))]
        listed = [r for r in records if r["method"] == "GET" and r["path"] == "/v1/models"]
        chat = [r for r in records if r["method"] == "POST" and r["path"] == "/v1/chat/completions"]
        assert listed and len(records) == len(listed) + len(chat), label
        for record in records:
            header = {k.lower(): v for k, v in record["headers"]}
            assert record["fixture_bearer_verified"] and header.get("authorization") == "[REDACTED]" and record["path"] in ("/v1/models", "/v1/chat/completions"), label
        for post in chat:
            values = [v for k, v in post["headers"] if k.lower() == "idempotency-key"]
            assert len(values) == 1 and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}", values[0]), label
            assert post["body"]["model"] == model and post["body"]["stream"] is True, label
            assert post["body"]["stream_options"]["include_usage"] is True, label
        return chat, listed, marker, result, server.recorder

    def key(r):
        keys = [v for k, v in r["headers"] if k.lower() == "idempotency-key"]
        assert len(keys) == 1
        return keys[0]

    for model in model_ids:
        label = model.replace(":", "-")
        chat, listed, marker, result, _ = capture(label, model, check_cache=model == model_ids[0])
        assert [r["response_mode"] for r in chat] == ["main_read", "main_final"], label
        assert marker not in chat[0]["raw_body"] and marker in result.stdout, label
        assert any(m["role"] == "tool" and marker in str(m["content"]) for m in chat[1]["body"]["messages"]), label
        for r in chat:
            assert key(r) not in seen_keys, label
            seen_keys.add(key(r))
        summary["models"][model] = {"discovery": len(listed), "chat": len(chat), "contractViolations": 0,
                                    "markerInToolResultAndFinalOutput": True}

    summary["mockLedger"] = check_fixture_ledger(mock)
    settings = Path(env["PI_CODING_AGENT_DIR"]) / "settings.json"
    config = json.loads(settings.read_text())
    model = "auto:cost"
    summary["faults"] = {}
    cases = ["definite", "prehold", "concurrency", "funding", "drop_running", "drop_completed", "drop_partial",
             "unknown", "cut_200", "changed_body", "server_500", "upstream", "interrupted"]
    for layer in ("agent", "transport"):
        config["retry"] = {"enabled": layer == "agent", "maxRetries": 3, "baseDelayMs": 5,
                           "provider": {"maxRetries": 3 if layer == "transport" else 0}}
        settings.write_text(json.dumps(config))
        for fault in cases:
            label = layer + "-" + fault
            env["PANDA_FIXTURE_CHANGE_REPLAY"] = str(int(fault == "changed_body"))
            scenario = "drop_completed" if fault == "changed_body" else fault
            if layer == "transport" and fault == "definite":
                scenario = "definite_proxy"
            throttle = fault in ("prehold", "concurrency")
            retry_throttle = throttle and layer == "transport"
            chat, _, marker, result, recorder = capture(label, model, scenario,
                extension=fault == "changed_body", expect=0 if retry_throttle else 1)
            keys = [key(r) for r in chat]
            if retry_throttle:
                assert len(chat) == 3 and keys[0] == keys[1] != keys[2] and marker in result.stdout, label
                assert chat[0]["raw_body"] == chat[1]["raw_body"], label
                assert len(recorder.runs) == 2, label
            else:
                assert len(chat) == 1, label
                if throttle:
                    assert not recorder.runs and "No charge was incurred" in result.stderr, label
                elif fault == "funding":
                    assert not recorder.runs, label
                elif fault == "definite":
                    assert "US$0.00" in result.stderr, label
                else:
                    assert "may have run and been charged" in result.stderr, label
                if fault == "changed_body":
                    assert "Transformed fixture" in chat[0]["raw_body"], label
            summary["faults"][label] = {"http": [r["response_status"] for r in chat], "distinctKeys": len(set(keys)),
                "codes": [r.get("error_code") for r in chat], "recordedRuns": len(recorder.runs), "exit": result.returncode}
        for kind in ("paid", "unknown", "zero"):
            name = "panel_failed_" + kind
            label = layer + "-" + name
            chat, _, _, result, recorder = capture(label, "panel:panda", name, expect=1)
            charges = [operation["cents"] for operation in recorder.runs.values()]
            assert len(chat) == 1 and len(charges) == 1, label
            assert {"paid": "US$0.03", "zero": "US$0.00", "unknown": "settlement amount is unknown"}[kind] in result.stderr, label
            summary["faults"][label] = {"posts": len(chat), "fixtureCents": charges, "exit": result.returncode}
    env.pop("PANDA_FIXTURE_CHANGE_REPLAY")
    chat, listed, _, result, _ = capture("discovery-401", "auto", "discovery-401", expect=1)
    assert not chat and len(listed) == 1 and "HTTP 401" in result.stderr and "inference_token_invalid" in result.stderr
    assert "private-marker" not in result.stderr
    summary["discovery401"] = {"catalogGET": 1, "chatPOST": 0, "safeCodeReported": True}
    summary["rootDialects"] = {}
    dialects = {"local-references": "", "2020-12": "https://json-schema.org/draft/2020-12/schema",
                "2019-09": "http://json-schema.org/draft/2019-09/schema#", "draft-07": "http://json-schema.org/draft-07/schema#",
                "draft-04": "http://json-schema.org/draft-04/schema#", "draft-06": "https://json-schema.org/draft-06/schema",
                "custom": "urn:fixture:unsupported"}
    for label, uri in dialects.items():
        env["PANDA_FIXTURE_DIALECT"] = uri
        accepted = label not in ("draft-04", "draft-06", "custom")
        chat, _, marker, result, _ = capture(label, model, extension=True, expect=0 if accepted else 1)
        if accepted:
            assert len(chat) == 2, label
            for post in chat:
                fn = next(t["function"] for t in post["body"]["tools"] if t["function"]["name"] == "panda_fixture_read")
                schema = fn["parameters"]
                assert schema.get("$schema", "") == uri and schema["properties"]["path"]["$ref"] == "#/$defs/file~1path", label
                assert schema["$defs"]["file/path"]["$ref"] == "#/definitions/path", label
            assert marker in result.stdout and any(m["role"] == "tool" and marker in str(m["content"]) for m in chat[1]["body"]["messages"])
            if not uri:
                summary["localReferences"] = {"tool": fn["name"], "wireParameters": fn["parameters"], "markerRoundTrip": True}
        else:
            assert len(chat) == 1 and chat[0]["response_mode"] == "refused" and chat[0]["param"].startswith("tools["), label
        if uri:
            summary["rootDialects"][label] = {"uri": uri, "chatPosts": len(chat), "exit": result.returncode}
    summary["native"] = {}
    modes = ["summary", "branch", "retired", "usage", "timeout", "malformed", "stream-error", "count", "format",
             "logprobs", "zero", "unequal", "neutral", "history", "large", "malformed-pointer", "null-target",
             "boolean-root", "prefix-and-items", "patterns-and-additional"]
    modes += ["virtual", "standalone", "large-failed-turn", "settled-cut", "settled-length", "content-filter", "summary-length", "branch-length"]
    modes += ["refused-manual", "refused-branch", "panel-context", "routed-context", "oversized-context", "support-cut",
              "settled-abort", "settled-callback", "large-receipt", "sdk-picker", "paid-compaction", "paid-branch"]
    modes += ["picker-env", "picker-config", "picker-command", "picker-command-auth-rotation"]
    modes += ["settled-invalid-trailer", "done-invalid-trailer"]
    modes += ["saved-standalone", "saved-custom-manual", "saved-custom-branch", "saved-default-decoy", "saved-explicit",
              "saved-tool", "aggregate-present", "aggregate-zero", "aggregate-missing", "aggregate-null"]
    for mode in modes:
        target = "auto:quality" if mode == "usage" else "panel:panda" if mode == "timeout" else "auto:cost"
        if mode in ("virtual", "large-failed-turn", "panel-context", "oversized-context", "large-receipt",
                    "settled-invalid-trailer", "done-invalid-trailer"):
            target = "panel:panda"
        if mode.startswith(("saved-", "aggregate-")):
            target = "panel:panda"
        if mode == "routed-context":
            target = "auto:quality"
        fault = {"summary": "cut_200", "branch": "drop_completed", "virtual": "panel_failed_paid",
                 "large-failed-turn": "server_500", "refused-manual": "content-filter", "refused-branch": "content-filter",
                 "support-cut": "cut_200", "settled-abort": "settled-cut", "settled-callback": "settled-cut",
                 "large-receipt": "panel_failed_large"}.get(mode, mode)
        chat, listed, _, _, recorder = capture("native-" + mode, target, fault, native=mode)
        bodies = [r["body"] for r in chat]
        if mode in ("picker-env", "picker-config"):
            assert len(listed) == 1 and not chat, mode
        elif mode == "picker-command":
            assert len(listed) == 3 and not chat and not recorder.runs, mode
        elif mode == "picker-command-auth-rotation":
            assert len(listed) == 2 and not chat and not recorder.runs, mode
        elif mode == "sdk-picker":
            assert not chat and len(listed) == 3, mode
        elif mode.startswith("saved-"):
            admissions = 3 if mode == "saved-default-decoy" else 2 if mode.startswith("saved-custom") else 1
            attempts = admissions + (3 if admissions > 1 else 2 if mode == "saved-standalone" else 1)
            assert len(recorder.runs) == admissions and len(chat) == attempts, mode
            assert [r["response_status"] for r in chat] == [200] * admissions + [409] * (attempts - admissions), mode
        elif mode in ("oversized-context", "paid-compaction"):
            assert len(chat) == 2 and key(chat[0]) != key(chat[1]), mode
        elif mode in ("summary", "branch"):
            assert len(chat) == 2 and key(chat[0]) != key(chat[1]), mode
            assert len(recorder.runs) == 2, mode
        elif mode == "standalone":
            assert len(chat) == 2 and key(chat[0]) != key(chat[1]), mode
        elif mode == "retired":
            assert len(chat) == 3 and not bodies[-1].get("tools")
            assert any(m.get("tool_calls") for m in bodies[-1]["messages"]) and any(m["role"] == "tool" for m in bodies[-1]["messages"])
        else:
            assert len(chat) == 1, mode
            body = bodies[0]
            if mode == "history":
                assert body["tools"] == [] and body["messages"][1]["reasoning_content"] == "Earlier thinking."
            elif mode == "neutral":
                assert body["store"] is False and body["max_tokens"] == 60000 and body["tools"] == []
            elif mode == "large":
                assert chat[0]["body_bytes"] > 65536 and "$ref" in chat[0]["raw_body"]
            elif mode == "timeout":
                assert dict((k.lower(), v) for k, v in chat[0]["headers"])["x-stainless-timeout"] == "15"
        summary["native"][mode] = {"discovery": len(listed), "http": [r["response_status"] for r in chat],
                                   "posts": len(chat), "keys": len({key(r) for r in chat}), "admissions": len(recorder.runs)}
    summary["rewrittenTargets"] = []
    for index, hidden in enumerate(mock.BACKEND_GRANTS):
        env["PANDA_FIXTURE_REPLACEMENT"] = hidden
        chat, listed, _, _, _ = capture("retired-rewrite-" + str(index), "auto", native="rewritten-target")
        assert not chat
        summary["rewrittenTargets"].append({"catalogGET": len(listed), "chatPOST": len(chat)})
    env.pop("PANDA_FIXTURE_REPLACEMENT")
    summary["catalogPolicy"] = {"customWarmListGET": 0, "rotatedCustomVisible": [], "coldListGET": 0, "coldOfflinePromptGET": 0, "warmListGET": 0, "supersededEndpointContacts": 0,
                                "incompatibleModelOverridePosts": 0, "retiredSelectionsPOST": 0,
                                "legacyCacheVisible": list(model_ids)}
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
