"""Admission cases exercised by the Pi integration tests on ADR 0079 slice C."""
import re


def refusal(body):
    for field, supported in (("n", (None, 1)), ("logprobs", (None, False)), ("top_logprobs", (None,))):
        if field in body and body[field] not in supported:
            return 400, "unsupported_parameter", field
    if "response_format" in body and body["response_format"] not in (None, {"type": "text"}):
        return 400, "unsupported_parameter", "response_format"
    for field in ("max_tokens", "max_completion_tokens"):
        if field in body and (type(body[field]) is not int or body[field] < 1):
            return 400, "invalid_request", field
    if "max_tokens" in body and "max_completion_tokens" in body and body["max_tokens"] != body["max_completion_tokens"]:
        return 400, "conflicting_parameters", "max_tokens"
    for i, tool in enumerate(body.get("tools") or []):
        schema = tool.get("function", {}).get("parameters", {})
        dialect = schema.get("$schema")
        if "$schema" in schema and (not isinstance(dialect, str) or not re.fullmatch(
                r"https?://json-schema\.org/(?:draft/2020-12|draft/2019-09|draft-07)/schema#?", dialect)):
            return 400, "invalid_request", f"tools[{i}].function.parameters"
        # Representative slice-C refusals. The production API owns full schema validation.
        reference = schema.get("$ref")
        rejected = False
        if isinstance(reference, str):
            rejected = bool(re.search(r"%(?![0-9a-fA-F]{2})", reference))
            if reference.startswith("#/$defs/"):
                target = (schema.get("$defs") or {}).get(reference.removeprefix("#/$defs/"))
                rejected |= not isinstance(target, dict)
        if dialect or reference:
            rejected |= "prefixItems" in schema and "items" in schema
            rejected |= "patternProperties" in schema and schema.get("additionalProperties") is False
        if rejected:
            return 400, "invalid_request", f"tools[{i}].function.parameters"
    return None
