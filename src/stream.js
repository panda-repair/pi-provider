import { describeError, maxAnswerBytes, settlement, supportId, unknownOutcome } from "./errors.js";

const encoder = new TextEncoder();
const finishReasons = new Set(["stop", "length", "tool_calls", "function_call", "content_filter"]);
class InvalidStream extends Error {}

async function* lines(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  let fragments = [], size = 0, afterCR = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxAnswerBytes) throw new InvalidStream();
      let text;
      try { text = decoder.decode(value, { stream: true }); } catch { throw new InvalidStream(); }
      if (!text) continue;
      let start = afterCR && text[0] === "\n" ? 1 : 0;
      afterCR = false;
      for (let i = start; i < text.length; i++) {
        if (text[i] !== "\n" && text[i] !== "\r") continue;
        fragments.push(text.slice(start, i));
        yield fragments.join("");
        fragments = [];
        if (text[i] === "\r") {
          if (i + 1 === text.length) afterCR = true;
          else if (text[i + 1] === "\n") i++;
        }
        start = i + 1;
      }
      if (start < text.length) fragments.push(text.slice(start));
    }
    decoder.decode();
    if (fragments.length) throw new Error();
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

async function* frames(body, signal) {
  let data = [], event = "";
  for await (const line of lines(body, signal)) {
    if (!line) {
      if (data.length || event === "error") yield { data: data.join("\n"), event };
      data = []; event = "";
    } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    else if (line.startsWith("event:")) event = line.slice(6).trim();
  }
  if (data.length) throw new Error();
}

export function pandaEventStream(response, state, canDisplay, signal, usage) {
  const id = supportId(response.headers);
  if (id) state.supportId = id;
  const consumer = new AbortController();
  const reading = AbortSignal.any([signal, consumer.signal]);
  state.cancelBody = () => {
    consumer.abort();
    if (!response.body.locked) void response.body.cancel().catch(() => {});
  };
  async function* read() {
    let done = false;
    try {
      if (Number(response.headers.get("content-length")) > maxAnswerBytes) {
        void response.body.cancel().catch(() => {});
        throw new InvalidStream();
      }
      for await (const frame of frames(response.body, reading)) {
        if (frame.data === "[DONE]" && frame.event !== "error") {
          if (!state.finish) throw new Error();
          done = true;
          break;
        }
        let chunk;
        try { chunk = JSON.parse(frame.data); } catch { throw new InvalidStream(); }
        const error = chunk?.error ?? chunk?.choices?.[0]?.error ?? chunk?.choices?.[0]?.delta?.error;
        if (frame.event === "error" || error != null) {
          state.failure = describeError(200, { error: error ?? chunk, panda: chunk?.panda }, response.headers, canDisplay);
          break;
        }
        if (!Array.isArray(chunk?.choices)) throw new InvalidStream();
        const reason = chunk.choices[0]?.finish_reason;
        if (reason) {
          if (!finishReasons.has(reason)) throw new InvalidStream();
          state.finish = reason;
          state.settled = settlement(undefined, chunk.panda);
          if (state.settled?.status === "running") state.settled = undefined;
        }
        if (chunk.panda) {
          usage.chunk(chunk);
          // Panel member answers belong to Panda. Forward only the validated public receipt.
          chunk.panda = settlement(undefined, chunk.panda);
        }
        yield encoder.encode("data: " + JSON.stringify(chunk) + "\n\n");
      }
      if ((!state.finish || (!done && !state.settled)) && !state.failure) throw new Error();
    } catch (error) {
      // Only losing the optional trailer after a validated finish can end successfully.
      if (error instanceof InvalidStream && state.settled) state.failure ??= { message: "Panda returned a settlement followed by an invalid stream." };
      else if (!state.settled) state.failure ??= { message: unknownOutcome };
    }
    yield encoder.encode("data: [DONE]\n\n");
  }
  const framesToSend = read();
  const body = new ReadableStream({
    async pull(controller) {
      const next = await framesToSend.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel() { state.cancelBody(); return framesToSend.return(); },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status,
    headers: { "content-type": "text/event-stream", ...(id && { "x-panda-request-id": id }) } });
}
