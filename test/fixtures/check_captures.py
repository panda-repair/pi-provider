"""Check captured Chat Completions requests against Zero's supplied cb676cac contract."""
import collections
import decimal
import json
import re
from urllib.parse import urlsplit

TOP = set("model messages max_completion_tokens max_tokens temperature top_p stop stream stream_options seed user n tools tool_choice parallel_tool_calls response_format logprobs top_logprobs panda".split())
RESERVED = {"$ref", "$defs", "definitions", "$id", "$schema"}
CHECKED = {"type", "properties", "required", "enum", "const", "items", "additionalProperties", "description"}
MAPS = {"properties", "patternProperties", "dependentSchemas", "dependencies", "$defs", "definitions"}
DATA = {"const", "enum", "default", "examples", "dependentRequired", "required"}
SCHEMA_ARRAY = {"allOf", "oneOf", "anyOf", "prefixItems"}
SCHEMA_SINGLE = {"items", "additionalProperties", "not", "if", "then", "else", "contains",
                 "propertyNames", "additionalItems", "unevaluatedItems", "unevaluatedProperties",
                 "contentSchema"}
NAME = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
BANNED_HEADERS = {"origin", "x-tenant-id", "x-workspace-id", "x-panda-workspace-id", "x-panda-service-credential"}


def nbytes(s):
    return len(s.encode("utf-8"))


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def top_value_raw(raw, key):
    """Slice the actual wire value, preserving JSON escaping, whitespace and key order."""
    decoder = json.JSONDecoder()
    i = raw.index("{") + 1
    while i < len(raw):
        while i < len(raw) and raw[i] in " \n\t\r,":
            i += 1
        if i >= len(raw) or raw[i] == "}":
            return None
        name, i = decoder.raw_decode(raw, i)
        while raw[i] in " \n\t\r:":
            i += 1
        begin = i
        _, i = decoder.raw_decode(raw, i)
        if name == key:
            return raw[begin:i]
    return None


def walk_strings(value, path):
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, list):
        for i, item in enumerate(value):
            yield from walk_strings(item, "%s[%d]" % (path, i))
    elif isinstance(value, dict):
        for k, v in value.items():
            yield path + "." + k + " (key)", k
            yield from walk_strings(v, path + "." + k)


def walk_numbers(value, path):
    if isinstance(value, bool):
        return
    if isinstance(value, (int, decimal.Decimal)):
        yield path, value
    elif isinstance(value, dict):
        for k, v in value.items():
            yield from walk_numbers(v, path + "." + k)
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from walk_numbers(v, "%s[%d]" % (path, i))


def numbers(value, path, fail):
    for key, n in walk_numbers(value, path):
        absolute = abs(n)
        excess_precision = isinstance(n, decimal.Decimal) and len(n.normalize().as_tuple().digits) > 15
        if absolute > 2 ** 53 - 1 or 0 < absolute < decimal.Decimal("2.2250738585072014e-308") or excess_precision:
            fail(key, str(n), "number outside the contract's range or significant-digit limit")


def schema_stats(schema, path, strict, issues, findings, checked_depth=1, checked=True):
    if not isinstance(schema, dict):
        return
    if checked:
        findings["max_checked_depth"] = max(findings["max_checked_depth"], checked_depth)
        if checked_depth > 8:
            issues(path, checked_depth, "checked schema depth exceeds 8")
    for k, v in schema.items():
        p = path + "." + k
        findings["schema_keywords"].add(k)
        if k in RESERVED:
            issues(p, v, "reserved schema keyword")
        elif k not in CHECKED and strict:
            issues(p, v, "unchecked keyword with strict=true")
        if k in DATA:
            continue
        if k == "additionalProperties" and checked and not isinstance(v, bool):
            issues(p, v, "checked additionalProperties must be boolean")
        if k in MAPS and isinstance(v, dict):
            if k == "properties" and checked and len(v) > 128:
                issues(p, len(v), "more than 128 properties")
            for key, child in v.items():
                if isinstance(child, dict):
                    schema_stats(child, p + "." + key, strict, issues, findings,
                                 checked_depth + 1, checked and k == "properties")
        elif k in SCHEMA_ARRAY and isinstance(v, list):
            for i, child in enumerate(v):
                schema_stats(child, "%s[%d]" % (p, i), strict, issues, findings,
                             checked_depth + 1, False)
        elif k == "items" and isinstance(v, list):
            for i, child in enumerate(v):
                schema_stats(child, "%s[%d]" % (p, i), strict, issues, findings, checked_depth + 1, False)
        elif k in SCHEMA_SINGLE and isinstance(v, dict):
            schema_stats(v, p, strict, issues, findings, checked_depth + 1, checked and k == "items")


def analyze(record):
    violations = []
    def fail(path, value, rule):
        violations.append({"path": path, "value": value, "rule": rule})

    b = record.get("body")
    raw = record.get("raw_body") or ""
    row = {"id": record["id"], "route": record["method"] + " " + record["path"],
           "mode": record.get("response_mode"), "status": record.get("response_status"),
           "stream": None, "model": None, "system_bytes": 0, "conversation_bytes": 0,
           "user_bytes": 0, "assistant_text_bytes": 0, "argument_bytes": 0, "tool_result_bytes": 0,
           "messages": 0, "panel_messages": None, "roles": [], "tools": 0,
           "tools_bytes": 0, "tools_compact_bytes": 0, "description_chars": {}, "schema_keywords": set(),
           "max_checked_depth": 0, "tokens": {}, "body_bytes": record["body_bytes"],
           "overlap_ids": record["overlap_ids"], "started_ns": record["started_ns"],
           "ended_ns": record["ended_ns"], "violations": violations}
    if nbytes(raw) != row["body_bytes"] or (raw and json.loads(raw) != b):
        raise ValueError("Captured raw wire body and parsed request disagree")
    route = urlsplit(record["path"])
    model_list = record["method"] == "GET" and route.path == "/v1/models"
    if "?" in record["path"]:
        fail("request.query", route.query, "query string refused")
    header_values = collections.defaultdict(list)
    for k, v in record["headers"]:
        header_values[k.lower()].append(v)
        if k.lower() in BANNED_HEADERS:
            fail("headers." + k, v, "workspace/Origin header refused")
        if k.lower() in ("authorization", "proxy-authorization", "x-api-key", "api-key", "cookie") and v != "[REDACTED]":
            raise ValueError("Credential-bearing capture header was not redacted")
    if len(header_values["authorization"]) != 1:
        fail("headers.Authorization", len(header_values["authorization"]), "requires one bearer credential")
    for key in header_values.get("idempotency-key", []):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}", key):
            fail("headers.Idempotency-Key", key, "invalid idempotency key")
    if row["body_bytes"] > 1048576:
        fail("body", row["body_bytes"], "body exceeds 1 MiB")
    if model_list:
        return finish(row)
    if route.path != "/v1/chat/completions" or record["method"] != "POST":
        fail("request.route", row["route"], "outside the Chat Completions API in the supplied contract")
        for k in ("system_bytes", "conversation_bytes", "user_bytes", "assistant_text_bytes", "argument_bytes",
                  "tool_result_bytes", "messages", "roles", "tools", "tools_bytes", "tools_compact_bytes",
                  "description_chars", "schema_keywords", "max_checked_depth", "tokens"):
            row[k] = None
        if route.path == "/v1/responses" and isinstance(b, dict):
            row["model"] = b.get("model")
            row["stream"] = b.get("stream", False)
            row["responses_input_items"] = len(b["input"]) if isinstance(b.get("input"), list) else None
            row["responses_tool_count"] = len(b["tools"]) if isinstance(b.get("tools"), list) else None
        return row
    if not isinstance(b, dict):
        fail("body", b, "expected a JSON object")
        return finish(row)
    row["model"], row["stream"] = b.get("model"), b.get("stream", False)
    for key in b.keys() - TOP:
        fail(key, b[key], "unknown top-level field")
    if not isinstance(row["model"], str) or not row["model"]:
        fail("model", row["model"], "model required")
    for key in ("max_completion_tokens", "max_tokens"):
        if key in b:
            row["tokens"][key] = b[key]
            if type(b[key]) is not int or not 1 <= b[key] <= 16384:
                fail(key, b[key], "output limit outside 1–16,384")
    if len(row["tokens"]) == 2 and len(set(row["tokens"].values())) != 1:
        fail("max_tokens", b["max_tokens"], "both output limits supplied with different values")
    for key, maximum in (("temperature", 2), ("top_p", 1)):
        if key in b and b[key] is not None and (type(b[key]) not in (int, float) or not 0 <= b[key] <= maximum):
            fail(key, b[key], "sampling value outside supported range")
    if b.get("n") is not None and (type(b["n"]) is not int or b["n"] != 1):
        fail("n", b["n"], "at most one choice")
    if b.get("logprobs") is not None and b["logprobs"] is not False:
        fail("logprobs", b["logprobs"], "logprobs unavailable")
    if b.get("top_logprobs") is not None:
        fail("top_logprobs", b["top_logprobs"], "top_logprobs unavailable")
    if b.get("response_format") not in (None, {"type": "text"}):
        fail("response_format", b["response_format"], "only text response format")
    if "stream" in b and type(b["stream"]) is not bool:
        fail("stream", b["stream"], "expected boolean")
    if "stream_options" in b:
        opts = b["stream_options"]
        if not b.get("stream") or not isinstance(opts, dict):
            fail("stream_options", opts, "stream options require streaming and an object")
        elif set(opts) - {"include_usage"} or "include_usage" in opts and type(opts["include_usage"]) is not bool:
            fail("stream_options", opts, "only boolean include_usage supported")
    if b.get("stop") is not None:
        stops = b["stop"] if isinstance(b["stop"], list) else [b["stop"]]
        if len(stops) > 4 or any(not isinstance(s, str) or not 1 <= nbytes(s) <= 256 for s in stops):
            fail("stop", b["stop"], "up to four stop strings, 1–256 bytes each")
    if "parallel_tool_calls" in b and type(b["parallel_tool_calls"]) is not bool:
        fail("parallel_tool_calls", b["parallel_tool_calls"], "expected boolean")
    if "panda" in b and (not isinstance(b["panda"], dict) or set(b["panda"]) != {"synthesizer_model"}
                         or not str(row["model"]).startswith("panel:")):
        fail("panda", b["panda"], "only a Panel synthesizer override is documented")
    tool_names = set()
    tools = b.get("tools")
    if "tools" in b:
        if not isinstance(tools, list):
            fail("tools", tools, "expected a function declaration array")
            tools = []
        row["tools"] = len(tools)
        row["tools_bytes"] = nbytes(top_value_raw(raw, "tools"))
        row["tools_compact_bytes"] = nbytes(compact(tools))
        if not 1 <= len(tools) <= 64:
            fail("tools", len(tools), "tool declaration count outside 1–64")
        if row["tools_compact_bytes"] > 65536:
            fail("tools", row["tools_compact_bytes"], "compact tools exceed 65,536 UTF-8 bytes")
        tool_numbers = json.loads(top_value_raw(raw, "tools"), parse_float=decimal.Decimal) or []
        numbers(tool_numbers, "tools", fail)
        for i, tool in enumerate(tools):
            p = "tools[%d]" % i
            if not isinstance(tool, dict) or tool.get("type") != "function" or not isinstance(tool.get("function"), dict):
                fail(p, tool, "expected a function declaration")
                continue
            f = tool["function"]
            name = f.get("name")
            if not isinstance(name, str) or not NAME.fullmatch(name) or name in tool_names:
                fail(p + ".function.name", name, "invalid or duplicated function name")
            tool_names.add(name)
            if "description" in f:
                desc = f["description"]
                row["description_chars"][name] = len(desc) if isinstance(desc, str) else None
                if not isinstance(desc, str) or len(desc) > 4096:
                    fail(p + ".function.description", desc, "description exceeds 4,096 characters or is not a string")
            for key in f.keys() - {"name", "parameters", "strict", "description"}:
                fail(p + ".function." + key, f[key], "unknown declaration member")
            if "strict" in f and type(f["strict"]) is not bool:
                fail(p + ".function.strict", f["strict"], "strict must be boolean")
            if "parameters" in f:
                schema, sp = f["parameters"], p + ".function.parameters"
                if not isinstance(schema, dict):
                    fail(sp, schema, "parameters must be a schema object")
                    continue
                for sk, string in walk_strings(schema, sp):
                    if len(string) > 4096:
                        fail(sk, string, "schema string exceeds 4,096 characters")
                schema_stats(schema, sp, f.get("strict") is True, fail, row)
    choice = b.get("tool_choice")
    named_choice = (isinstance(choice, dict) and choice.get("type") == "function" and
                    isinstance(choice.get("function"), dict) and choice["function"].get("name") in tool_names)
    if choice is not None and choice not in ("auto", "none", "required") and not named_choice:
        fail("tool_choice", choice, "unsupported tool choice or undeclared named function")
    analyze_messages(b, row, fail)
    return finish(row)


def analyze_messages(b, row, fail):
    ms = b.get("messages")
    if not isinstance(ms, list):
        fail("messages", ms, "expected a message array")
        return
    row["messages"] = len(ms)
    if not 1 <= len(ms) <= 128:
        fail("messages", len(ms), "message count outside 1–128")
    front = 0
    pending = set()
    for i, m in enumerate(ms):
        p = "messages[%d]" % i
        if not isinstance(m, dict):
            fail(p, m, "expected message object")
            continue
        role = m.get("role")
        row["roles"].append(role)
        if role not in ("system", "developer", "user", "assistant", "tool"):
            fail(p + ".role", role, "unsupported role")
        if role in ("system", "developer"):
            if i == front:
                front += 1
            else:
                fail(p + ".role", role, "system/developer message follows conversation")
        content = m.get("content")
        if isinstance(content, str):
            size = nbytes(content)
        elif isinstance(content, list):
            size = 0
            for j, part in enumerate(content):
                if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str):
                    size += nbytes(part["text"])
                else:
                    fail(p + ".content[%d].type" % j, part.get("type") if isinstance(part, dict) else part, "expected a text part")
        elif content is None and role == "assistant" and m.get("tool_calls"):
            size = 0
        else:
            fail(p + ".content", content, "expected a string or text part array")
            size = 0
        if role in ("system", "developer"):
            row["system_bytes"] += size
        elif role in ("user", "assistant", "tool"):
            row[{"user": "user_bytes", "assistant": "assistant_text_bytes", "tool": "tool_result_bytes"}[role]] += size
        if role == "tool":
            call_id = m.get("tool_call_id")
            if call_id not in pending:
                fail(p + ".tool_call_id", call_id, "unknown or repeated tool result")
            else:
                pending.remove(call_id)
        else:
            if pending:
                fail(p, sorted(pending), "a prior assistant call is unanswered")
                pending.clear()
            calls = m.get("tool_calls", [])
            if "tool_calls" in m and (role != "assistant" or not isinstance(calls, list) or not 1 <= len(calls) <= 16):
                fail(p + ".tool_calls", len(calls) if isinstance(calls, list) else calls, "expected 1–16 assistant calls")
            if not isinstance(calls, list):
                continue
            for j, c in enumerate(calls):
                cp = p + ".tool_calls[%d]" % j
                if not isinstance(c, dict) or c.get("type") != "function" or not isinstance(c.get("function"), dict):
                    fail(cp, c, "expected function call")
                    continue
                call_id = c.get("id")
                if not isinstance(call_id, str) or not call_id or call_id in pending:
                    fail(cp + ".id", call_id, "missing or duplicate call ID")
                else:
                    pending.add(call_id)
                args = c["function"].get("arguments")
                if isinstance(args, str):
                    row["argument_bytes"] += nbytes(args)
                    try:
                        obj = json.loads(args, parse_float=decimal.Decimal)
                        if not isinstance(obj, dict):
                            raise ValueError()
                        numbers(obj, cp + ".function.arguments", fail)
                    except ValueError:
                        fail(cp + ".function.arguments", args, "arguments must encode one JSON object")
                else:
                    fail(cp + ".function.arguments", args, "expected JSON-encoded argument string")
    if pending:
        fail("messages", sorted(pending), "unanswered tool call at end of history")
    if "user" not in row["roles"]:
        fail("messages", row["roles"], "at least one user message is required")
    row["conversation_bytes"] = sum(row[k] for k in ("user_bytes", "assistant_text_bytes", "argument_bytes", "tool_result_bytes"))
    if row["conversation_bytes"] > 131072:
        fail("messages", row["conversation_bytes"], "conversation exceeds 131,072 UTF-8 bytes")
    if row["system_bytes"] > 16384:
        fail("messages", row["system_bytes"], "system/developer text exceeds 16,384 UTF-8 bytes")
    if row["model"] in ("panel:panda", "panel:panda-quality") and row["tools"]:
        row["panel_messages"] = len(ms) - max(front - 1, 0)
        if row["panel_messages"] > 126:
            fail("messages", row["panel_messages"], "selected multi-member Panel with tools has room for 126 caller messages")


def finish(row):
    row["schema_keywords"] = sorted(row["schema_keywords"])
    return row
