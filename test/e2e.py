"""Exercise the installed local package with Pi and an ADR 0079 slice C fixture on macOS."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import re
import subprocess
import sys
import threading
from http.server import ThreadingHTTPServer

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
MODEL_IDS = ("glm-5.3", "deepseek-v4.1-flash", "auto", "auto:cost", "auto:quality", "panel:panda", "panel:panda-quality")


def module_from(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_fixture_ledger(mock):
    recorder = mock.Recorder(None)
    body = {"model": "glm-5.3", "messages": [{"role": "user", "content": "fixture"}]}
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
    parser.add_argument("--pi", type=Path, required=True, help="Pi 1.5.2 executable")
    parser.add_argument("--output", type=Path, required=True, help="new directory for isolated state and redacted captures")
    args = parser.parse_args()
    pi = args.pi.resolve()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    if not Path("/usr/bin/sandbox-exec").exists():
        parser.error("This capture runner uses macOS sandbox-exec to restrict client networking to loopback.")
    mock = module_from(ROOT / "test/fixtures/mock_server.py")
    admission = module_from(ROOT / "test/fixtures/admission.py")
    mock.MODELS = (*MODEL_IDS, "unknown-test-model")
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
    assert version == "1.5.2", version
    run(["install", str(ROOT)], "install")
    summary = {"pi": version, "models": {}}
    seen_keys = set()
    def capture(label, model, fault=None, extension=False, expect=0, native=None, check_cache=False):
        folder = out / "captures" / label
        folder.mkdir(parents=True)
        fixture = work / "capture-fixture.txt"
        marker = "PANDA_READ_" + secrets.token_hex(12)
        fixture.write_text(marker + "\n")
        with ThreadingHTTPServer(("127.0.0.1", 0), mock.Handler) as server:
            server.expected_token = env["PANDA_API_TOKEN"]
            server.refusal = admission.refusal
            server.fixture = fixture
            server.hold = 0.02
            server.recorder = mock.Recorder(folder)
            server.scenario = fault
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                env["PANDA_BASE_URL"] = f"http://127.0.0.1:{server.server_port}/v1"
                extra = ["-e", str(ROOT / "test/fixtures/referenced-tool.mjs")] if extension else []
                if check_cache:
                    cold = run(["--list-models", "panda"], label + "-cold")
                    assert "glm-5.3" not in cold.stdout and server.recorder.next_id == 1
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
                    assert all(model_id in warm.stdout for model_id in MODEL_IDS)
                    assert server.recorder.next_id == count
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

    for model in MODEL_IDS:
        label = model.replace(":", "-")
        chat, listed, marker, result, _ = capture(label, model, check_cache=model == MODEL_IDS[0])
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
    model = "glm-5.3"
    summary["faults"] = {}
    cases = ["definite", "prehold", "drop_running", "drop_completed", "drop_partial", "unknown", "cut_200", "changed_body"]
    for layer in ("agent", "transport"):
        for fault in cases:
            if layer == "transport" and fault in ("unknown", "cut_200", "changed_body"):
                # The shipped service vetoes transport retries for its semantic 503s.
                # SSE consumption occurs after that layer, and onPayload runs once per stream.
                continue
            config["retry"] = {"enabled": layer == "agent", "baseDelayMs": 10,
                               "provider": {"maxRetries": 1 if layer == "transport" else 0}}
            settings.write_text(json.dumps(config))
            success = fault in ("definite", "prehold")
            label = layer + "-" + fault
            env["PANDA_FIXTURE_CHANGE_REPLAY"] = "1" if fault == "changed_body" else "0"
            scenario = "drop_completed" if fault == "changed_body" else fault
            if layer == "transport" and fault == "definite":
                # Model a gateway that omits x-should-retry so Pi elects to retry inside one stream.
                scenario = "definite_proxy"
            chat, _, marker, result, recorder = capture(label, model, scenario,
                extension=fault == "changed_body", expect=0 if success else 1)
            assert len(chat) == (3 if success else 2), (label, len(chat))
            keys = [key(r) for r in chat]
            if success:
                assert len(set(keys)) == len(keys) and marker in result.stdout, label
            else:
                assert keys[0] == keys[1] and len(recorder.runs) == 1, label
                assert chat[-1]["response_status"] == 409, label
                if fault == "changed_body":
                    assert chat[-1]["error_code"] == "mixture_idempotency_conflict", label
                elif fault == "drop_running":
                    assert chat[-1]["error_code"] == "mixture_already_running", label
                    receipt = chat[-1]["receipt"]
                    assert receipt["charge"] is None and receipt["held"] is None and receipt["status"] == "running", label
                    assert receipt["run_id"] == chat[0]["run_id"] and receipt["run_id"] in result.stderr, label
                    assert next(iter(recorder.runs.values()))["status"] == "running", label
                    assert all(part in result.stderr for part in ("still running", "may be zero",
                        "answer cannot be recovered", "separate, potentially billable run")), label
                else:
                    assert chat[-1]["error_code"] == ("mixture_already_partial" if fault == "drop_partial" else "mixture_already_completed"), label
                    assert "earlier request finished" in result.stderr and "US$0.01" in result.stderr, label
            summary["faults"][label] = {"http": [r["response_status"] for r in chat], "distinctKeys": len(set(keys)),
                "codes": [r.get("error_code") for r in chat], "recordedRuns": len(recorder.runs),
                "chargedFixtureRuns": sum((run["cents"] or 0) > 0 for run in recorder.runs.values()),
                "exit": result.returncode, "contractViolations": 0}
            if fault == "drop_running":
                summary["faults"][label]["receipt"] = {k: receipt[k] for k in ("status", "charge", "held")}
    for layer in ("agent", "transport"):
        config["retry"] = {"enabled": layer == "agent", "baseDelayMs": 10, "provider": {"maxRetries": int(layer == "transport")}}
        settings.write_text(json.dumps(config))
        for kind in ("paid", "unknown", "zero"):
            name = "panel_failed_" + kind
            label = layer + "-" + name
            chat, _, marker, result, recorder = capture(label, "panel:panda", name, expect=0 if kind == "zero" else 1)
            charges = [operation["cents"] for operation in recorder.runs.values()]
            if kind == "zero":
                assert len(chat) == 3 and len({key(r) for r in chat}) == 3 and marker in result.stdout, label
            else:
                assert len(chat) == 1 and charges == [3], label
                assert ("US$0.03" if kind == "paid" else "amount is unknown") in result.stderr, label
            summary["faults"][label] = {"posts": len(chat), "fixtureCents": charges, "exit": result.returncode}
    env.pop("PANDA_FIXTURE_CHANGE_REPLAY")
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
    for mode in modes:
        target = "auto:quality" if mode == "usage" else "panel:panda" if mode == "timeout" else "glm-5.3"
        fault = {"summary": "cut_200", "branch": "drop_completed"}.get(mode, mode)
        chat, listed, _, _, recorder = capture("native-" + mode, target, fault, native=mode)
        bodies = [r["body"] for r in chat]
        if mode in ("summary", "branch"):
            assert len(chat) == 3 and key(chat[0]) == key(chat[1]) != key(chat[2]), mode
            assert chat[0]["raw_body"] == chat[1]["raw_body"] and len(recorder.runs) == 2, mode
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
    summary["catalogPolicy"] = {"coldListGET": 0, "coldOfflinePromptGET": 0, "warmListGET": 0}
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
