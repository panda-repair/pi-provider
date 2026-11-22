import { describeError, maxAnswerBytes, settlement, supportId, unknownOutcome } from "./errors.js";

const encoder = new TextEncoder();
const finishReasons = new Set(["stop", "length", "tool_calls", "function_call", "content_filter"]);
class InvalidStream extends Error {}

// Read the transport independently of Pi's asynchronous response and event hooks.
// A single growable byte buffer also bounds the backlog for many tiny chunks.
function receive(response, idle, consumer) {
  const reader = response.body.getReader();
  const signal = AbortSignal.any([idle.signal, consumer.signal]);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const buffer = new ArrayBuffer(0, { maxByteLength: maxAnswerBytes });
  const bytes = new Uint8Array(buffer);
  let received = 0, ended = false, failure, wake;

  void (async () => {
    try {
      if (Number(response.headers.get("content-length")) > maxAnswerBytes) throw new InvalidStream();
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        if (!value.byteLength) continue;
        const end = received + value.byteLength;
        if (end > maxAnswerBytes) throw new InvalidStream();
        idle.reset();
        if (end > bytes.length) buffer.resize(Math.min(maxAnswerBytes, Math.max(end, bytes.length * 2, 4096)));
        bytes.set(value, received);
        received = end;
        wake?.();
      }
    } catch (error) {
      failure = error;
    } finally {
      idle.stop();
      signal.removeEventListener("abort", cancel);
      cancel();
      reader.releaseLock();
      ended = true;
      wake?.();
    }
  })();

  return (async function* () {
    let offset = 0;
    for (;;) {
      if (offset < received) {
        const chunk = bytes.subarray(offset, received);
        offset = received;
        yield chunk;
      } else if (ended) {
        if (failure) throw failure;
        return;
      } else {
        await new Promise(resolve => { wake = resolve; });
        wake = undefined;
      }
    }
  })();
}

async function* lines(chunks) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  function decode(bytes, stream) {
    try { return decoder.decode(bytes, { stream }); } catch { throw new InvalidStream(); }
  }
  const lf = 0x0a, cr = 0x0d;
  let line = "", afterCR = false;
  for await (const bytes of chunks) {
    let start = afterCR && bytes[0] === lf ? 1 : 0;
    afterCR = false;
    for (let i = start; i < bytes.length; i++) {
      if (bytes[i] !== lf && bytes[i] !== cr) continue;
      // Decode through this delimiter only. A later invalid byte must not erase a complete frame.
      yield line + decode(bytes.subarray(start, i + 1), true).slice(0, -1);
      line = "";
      if (bytes[i] === cr) {
        if (i + 1 === bytes.length) afterCR = true;
        else if (bytes[i + 1] === lf) i++;
      }
      start = i + 1;
    }
    if (start < bytes.length) line += decode(bytes.subarray(start), true);
  }
  decode(undefined, false);
  if (line) throw new Error();
}

async function* frames(chunks) {
  let data = [], event = "";
  for await (const line of lines(chunks)) {
    if (!line) {
      if (data.length || event === "error") yield { data: data.join("\n"), event };
      data = []; event = "";
    } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    else if (line.startsWith("event:")) event = line.slice(6).trim();
  }
  if (data.length) throw new Error();
}

export function pandaEventStream(response, state, canDisplay, idle, usage) {
  const id = supportId(response.headers);
  if (id) state.supportId = id;
  const consumer = new AbortController();
  state.cancelBody = () => consumer.abort();
  const chunks = receive(response, idle, consumer);
  async function* read() {
    let done = false;
    try {
      for await (const frame of frames(chunks)) {
        consumer.signal.throwIfAborted();
        idle.callerSignal?.throwIfAborted();
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
        usage.chunk(chunk);
        if (chunk.panda) {
          // Panel member answers belong to Panda. Forward only the validated public receipt.
          chunk.panda = settlement(undefined, chunk.panda);
        }
        yield encoder.encode("data: " + JSON.stringify(chunk) + "\n\n");
      }
      if ((!state.finish || (!done && !state.settled)) && !state.failure) throw new Error();
    } catch (error) {
      // Only losing the optional trailer after a validated finish can end successfully.
      if (error instanceof InvalidStream && state.settled) {
        state.failure ??= { invalidTrailer: true, message: "Panda returned a settlement followed by an invalid stream." };
      } else if (!state.settled) state.failure ??= { message: unknownOutcome };
    } finally {
      state.cancelBody();
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
