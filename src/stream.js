import { describeError, settlement, unknownOutcome } from "./errors.js";

const maxFrame = 1_048_576;
const encoder = new TextEncoder();
const finishReasons = new Set(["stop", "length", "tool_calls", "function_call", "content_filter"]);

async function* frames(body) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "", data = [], event = "", size = 0;
  // Panda emits standard SSE data frames. Support split UTF-8, CRLF and multiline data.
  for await (const bytes of body) {
    pending += decoder.decode(bytes, { stream: true });
    let start = 0;
    for (let i = 0; i < pending.length; i++) {
      if (pending[i] !== "\n" && pending[i] !== "\r") continue;
      if (pending[i] === "\r" && i === pending.length - 1) break;
      const line = pending.slice(start, i);
      if (pending[i] === "\r" && pending[i + 1] === "\n") i++;
      start = i + 1;
      size += line.length;
      if (size > maxFrame) throw new Error();
      if (!line) {
        if (data.length || event === "error") yield { data: data.join("\n"), event };
        data = []; event = ""; size = 0;
      } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("event:")) event = line.slice(6).trim();
    }
    pending = pending.slice(start);
    if (size + pending.length > maxFrame) throw new Error();
  }
  decoder.decode();
  if (pending.trim() || data.length) throw new Error();
}

export function pandaEventStream(response, state, canDisplay) {
  async function* read() {
    let done = false;
    try {
      for await (const frame of frames(response.body)) {
        if (frame.data === "[DONE]" && frame.event !== "error") {
          if (!state.finish) throw new Error();
          done = true;
          break;
        }
        const chunk = JSON.parse(frame.data);
        const error = chunk?.error ?? chunk?.choices?.[0]?.error ?? chunk?.choices?.[0]?.delta?.error;
        if (frame.event === "error" || error != null) {
          if (!state.settled) state.failure = describeError(200, { error: error ?? chunk, panda: chunk?.panda }, response.headers, canDisplay);
          break;
        }
        if (!Array.isArray(chunk?.choices)) throw new Error();
        const choice = chunk.choices[0];
        const reason = choice?.finish_reason;
        if (reason) {
          if (!finishReasons.has(reason)) throw new Error();
          state.finish = reason;
          state.settled = settlement(undefined, chunk.panda);
          if (state.settled?.status === "running") state.settled = undefined;
          if (reason === "content_filter") choice.finish_reason = "stop";
        }
        // The original OpenAI adapter still parses all normal text, tools and usage.
        yield encoder.encode("data: " + JSON.stringify(chunk) + "\n\n");
      }
      if ((!state.finish || (!done && !state.settled)) && !state.failure) throw new Error();
    } catch {
      if (!state.settled) state.failure ??= { message: unknownOutcome };
    }
    yield encoder.encode("data: [DONE]\n\n");
  }
  return new Response(ReadableStream.from(read()), {
    status: response.status, headers: { "content-type": "text/event-stream" },
  });
}
