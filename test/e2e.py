"""Exercise the installed local package with Pi and the original capture experiment on macOS."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pi", type=Path, required=True, help="Pi 1.5.2 executable")
    parser.add_argument("--capture-tools", type=Path, default=ROOT / "test" / "fixtures",
                        help="override the bundled test server and contract checker with the original capture experiment")
    parser.add_argument("--output", type=Path, required=True, help="new directory for isolated state and redacted captures")
    args = parser.parse_args()
    pi = args.pi.resolve()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    if not Path("/usr/bin/sandbox-exec").exists():
        parser.error("This capture runner uses macOS sandbox-exec to restrict client networking to loopback.")
    mock = module_from(args.capture_tools / "mock_server.py")
    checker = module_from(args.capture_tools / "check_captures.py")
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

    def run(arguments, label):
        command = ["/usr/bin/sandbox-exec", "-p", profile, str(pi), *arguments]
        result = subprocess.run(command, cwd=work, env=env, capture_output=True, text=True,
                                stdin=subprocess.DEVNULL, timeout=60)
        (out / (label + ".stdout")).write_text(result.stdout)
        (out / (label + ".stderr")).write_text(result.stderr)
        if result.returncode:
            raise RuntimeError(f"Pi exited {result.returncode}; see {label}.stderr")
        return result.stdout

    env["PANDA_BASE_URL"] = "http://127.0.0.1:1/v1"
    version = run(["--version"], "version").strip()
    assert version == "1.5.2", version
    run(["install", str(ROOT)], "install")
    summary = {"pi": version, "models": {}}
    seen_keys = set()
    for model in MODEL_IDS:
        label = model.replace(":", "-")
        folder = out / "captures" / label
        folder.mkdir(parents=True)
        fixture = work / "capture-fixture.txt"
        marker = "PANDA_READ_" + secrets.token_hex(12)
        fixture.write_text(marker + "\n")
        with ThreadingHTTPServer(("127.0.0.1", 0), mock.Handler) as server:
            server.fixture = fixture
            server.hold = 0.02
            server.recorder = mock.Recorder(folder)
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                env["PANDA_BASE_URL"] = f"http://127.0.0.1:{server.server_port}/v1"
                final = run(["-p", "--no-session", "--model", "panda/" + model,
                             "Read capture-fixture.txt with the read tool and give its first line."], label)
            finally:
                server.shutdown()
                thread.join()
        records = [json.loads(p.read_text()) for p in sorted(folder.glob("*.json"))]
        listed = [r for r in records if r["method"] == "GET" and r["path"] == "/v1/models"]
        chat = [r for r in records if r["method"] == "POST" and r["path"] == "/v1/chat/completions"]
        rows = [checker.analyze(r) for r in records]
        assert listed and len(records) == len(listed) + 2, label
        assert [r["response_mode"] for r in chat] == ["main_read", "main_final"], label
        assert marker not in chat[0]["raw_body"] and marker in final, label
        assert any(m["role"] == "tool" and marker in str(m["content"]) for m in chat[1]["body"]["messages"]), label
        assert all(r["body"]["model"] == model for r in chat), label
        assert all(not row["violations"] for row in rows), [(row["id"], row["violations"]) for row in rows]
        for r in chat:
            keys = [value for k, value in r["headers"] if k.lower() == "idempotency-key"]
            assert len(keys) == 1 and keys[0] not in seen_keys, label
            seen_keys.add(keys[0])
        summary["models"][model] = {"discovery": len(listed), "chat": len(chat), "contractViolations": 0,
                                    "markerInToolResultAndFinalOutput": True}
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
