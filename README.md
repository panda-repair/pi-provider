# Panda for Pi

Use Panda’s five models with Pi’s built-in coding tools: Panda Mini, Panda Auto, Panda Mix, Panda Mix Pro and Panda Max. This package supports Pi 1.5.2 and 1.6.0 and requires a Panda endpoint with ADR 0079 slice C enabled.

## Install and sign in

```sh
pi install npm:@panda-repair/pi-provider
```

Start Pi, enter `/login panda`, and paste a personal Panda inference token beginning with `pnd_it_`. Pi shows the full token as you enter it, then saves it in its credential store. For headless use or to keep the token off the Pi screen, set `PANDA_API_TOKEN` before starting Pi or configure a credential command in Pi’s `models.json`. The token saved by `/login` takes precedence over `PANDA_API_TOKEN`. To switch to the environment token, use `/logout`, choose Panda, and restart Pi. [Pi setup guide](https://panda.repair/products/llm-api/coding-agents/setup#agents-pi)

```sh
pi --list-models panda
pi --model panda/panel:panda
```

To install a local checkout, run `pi install /path/to/pi-provider` with its absolute path.

Startup and `--list-models` read Pi's catalog cache. A new login or an explicit Panda prompt can refresh `GET /v1/models` using Pi's selected endpoint, effective credential and network policy. A cold list can be empty. Start Pi with `--model panda/auto` or use interactive `/login panda` to establish the catalog. Cached grants are bound to the credential and endpoint. Panda Mini, Panda Auto and Panda Max also need a grant for a model they can run with tools, which Panda’s dashboard adds when you make a token for them. A cache-only `--list-models panda` can occasionally show ungranted selectors or an unsupported model listed in `models.json`. Sending a chat request requires a supported selector with a matching cached grant for the credential and endpoint. After a token is revoked or loses a model grant, Pi can still use a stale grant with `PI_OFFLINE=1` or through a virtual model that selects Panda. While the grant is stale, each new submission to the denied model on either path sends one foreground chat POST, plus any summary request from compaction (see [Limits and billing](#limits-and-billing)). Panda rejects each request with HTTP 401 or 403 before admission, at no charge. To refresh the list online, open `/model` or restart your interactive Pi session.

For a custom credential in Pi’s active `models.json`, use `"$MY_PANDA_TOKEN"` or `"${MY_PANDA_TOKEN}"`. The picker matches the current variable, literal token or non-command template to the signed cache on every lookup. Rotating or removing the token hides its previous grants. An explicit Panda prompt can establish grants for the new token. A saved Panda login takes precedence over a configured credential command. With only a command, a fresh `--list-models panda` normally stays empty because cache-only listing and filtering never run it. Open the online `/model` picker to run the command once and see the grants returned by one `GET /v1/models`, or start Pi with `--model panda/<selector>`. After a credential command returns a new token, `/model` autocomplete can still offer models from the previous token’s catalog until you reopen `/model`. If you select a model the new token cannot use, submitting a prompt may trigger a catalog refresh (`GET /v1/models`). Pi rejects that prompt before sending a chat request.

SDK sessions bind the picker to their own model runtime, including a custom `agentDir` or `modelsPath`. A services-only SDK client that lists models before binding a session can register `withPandaModelRuntime(runtime)` from this package as an inline extension factory and pass the same `runtime` as Pi’s `modelRuntime`. Pi uses the session’s runtime while the session is open and restores the caller-supplied runtime after disposal. Without a binding the pre-session picker hides grants for unverifiable custom credentials.

Requests go to `https://app.panda.repair/v1` by default. For staging, set `PANDA_BASE_URL` to the trusted staging API base including its `/v1` path before starting Pi. An explicit provider base URL in Pi’s `models.json` takes precedence. Both discovery and chat use the selected provider endpoint. Panda supports Pi’s `openai-completions` protocol.

## Pick a model

Use the complete selector, including `panda/` and any colon. All five accept text and function tools. Pi executes the selected tool locally and sends its result in the next request. The package accepts text input only and exposes no adjustable thinking level. With tools, Panda Mini answers each step with one model, Panda Mix and Panda Mix Pro mix every step, and Panda Auto and Panda Max can run a mix.

| Model | Pi selector | Pi context window (tokens) | What it does |
| --- | --- | ---: | --- |
| Panda Mini | `panda/auto:cost` | 258,000 | One low-cost model, every time. |
| Panda Auto | `panda/auto` | 224,000 | Picks the right model for each request. |
| Panda Mix | `panda/panel:panda` | 224,000 | Two models answer, and one combines their answers. |
| Panda Mix Pro | `panda/panel:panda-quality` | 224,000 | The same mix, with a stronger model combining. |
| Panda Max | `panda/auto:quality` | 187,000 | Panda’s best answer, mixed or single. |

## Limits and billing

Pi advertises **16,384 output tokens** for all five models. Tool-free work such as titles and summaries can run differently from tool calls. For example, Panda Max’s window also covers its requests without tools, and its reference request size in the guide is 751,413 bytes, where it would set aside US$5.25. The windows assume a token made for the models you use: a token made another way can send Panda Mini’s, Panda Auto’s and Panda Max’s requests without tools to a model with a smaller window. Some requests without tools stop at 4,096 output tokens. The advertised limits are planning estimates for Pi. Panda applies the limits of what each request runs. [Model guidance for coding agents](https://panda.repair/products/llm-api/coding-agents/setup#agents-models)

Panda counts framed UTF-8 bytes and reserves the requested output. Panda Mix and Panda Mix Pro allow about 900,000 conversation bytes at the full output cap in the guide’s sample, a little less than one model would, because the model that combines needs room for the answers. A request can carry up to 1,024 messages and 65,536 bytes of system and developer instructions combined. A mix with tools allows 1,022 caller messages, counting combined system and developer instructions as one. Tools, framing and the hold can reduce the available space. [Panda API model limits](https://panda.repair/products/llm-api#llm-api-model-limits)

Pi compacts when its estimated conversation size exceeds the window minus `compaction.reserveTokens`. With the default 16,384 reserve, the thresholds are 241,616, 207,616 and 170,616 tokens for the 258,000, 224,000 and 187,000 windows. For a mix, including one that Panda Auto or Panda Max runs, Pi’s context checks and `/session` token totals use the largest prompt among the models that answer, plus the final output. If their usage is unavailable, the extension uses the combining call’s prompt or estimates the request locally. When Panda reports aggregate counters, the assistant’s `panda.aggregate_usage` diagnostic preserves them, including reported zeros. An absent or null trailer leaves the aggregate unknown and omits the diagnostic. Pi’s USD spending total uses the validated settlement for the full run.

Published prices are ceilings. Under Panda’s API billing contract, you pay 3/2 of Panda’s cost for each chargeable call, capped at the published price for its usage. Panda works out each call’s cost from the usage or cost its provider reports. Panda sums the charges and applies a one-cent minimum **once per run** when a chargeable call answers. With Panda Mix or Panda Mix Pro, or when Panda Auto or Panda Max runs a mix, you pay for each call that answers, up to three. If the combining call fails, the answers that came back are still charged. All five models have variable prices. Pi shows the reported USD settlement when Panda supplies it. [Panda pricing](https://panda.repair/pricing#pricing-llm-api)

Each Pi call opens with its own idempotency key. Panda failures stop that call, including compaction, branch summaries and virtual-model requests. After a dropped connection, incomplete stream or unknown server outcome, the request may have run and been charged. Submitting the prompt again as a new Pi call starts a new run and may charge you again. If Panda has already reported a settled finish, Pi keeps the answer and reported charge even if the optional usage trailer is lost. A content filter ends the call with a refusal and preserves the active history. Pi cannot save that refusal as a compaction or branch summary. A caller cancellation or response callback failure still ends the call and retains any settlement Panda has already supplied.

The adapter retries only Panda’s two pre-admission throttles for concurrency and workspace rate limits. The adapter makes at most two further attempts with the same key and identical request bytes. A lower `maxRetries` applies, including zero. Cancelling while waiting after a confirmed pre-admission throttle reports that the attempt incurred no charge. It honors `Retry-After`, cancellation and the configured idle timeout, with a total wait budget of 60 seconds. A retry veto or a longer required delay stops the call. Pi’s HTTP client can also resend the original key and body after HTTP 421, even with `maxRetries: 0`. If Panda already admitted the request, it can return a 409 replay of the original run without a second charge.

A running receipt means the charge is pending and may be zero. A settled receipt shows the reported charge, including zero. A replay cannot recover the answer. Pi recognizes a charge the session has already saved when the entry retains its run ID. An unsaved standalone result can report the amount again. When a stream cuts early, its validated Panda request ID remains available in the error diagnostic for a billing inquiry. A failed checkpoint or standalone call can report a charge without creating a Pi spending entry. A request that exceeds the input limit stops. You can compact or shorten the conversation and submit it again. Pi can still compact a growing conversation before a call. If that preventive summary fails, Pi can continue the foreground prompt you already submitted.

Custom extensions that save Panda spending in a checkpoint, tool result or explicit usage entry should keep the returned `usage.cost`, including its `pandaRunIds`. When combining costs, retain the IDs for the Panda charges included in the sum. Pi uses saved charge records to recognize later receipts, including after reopening the session. Older checkpoints and extensions that save only a numeric total can lose the ID, as can cloning a split-compaction checkpoint or combining nested-tool costs. Stock Pi processes each delivered settlement once. In these ID-loss cases, its displayed total can include the charge twice only if it receives the same receipt again. Separately, a custom SDK caller that appends the same usage twice can display the charge twice after one settlement, even when both entries retain the ID. Neither case creates another Panda charge.

## Timeouts

Panda sends headers when it admits a streamed request and sends a keepalive every 15 seconds while waiting for an answer. Long runs, such as a mix, work with Pi’s default five-minute HTTP idle timeout. The adapter times the wait for headers, resets its timer whenever response bytes arrive and stops it at the end of the response, even while a Pi hook is processing an earlier event.

Pi chooses the adapter’s timeout from the per-call `timeoutMs`, then `retry.provider.timeoutMs`, then its global `httpIdleTimeoutMs` setting. When Pi supplies no timeout, all five models use ten minutes. An explicit per-call or provider value of zero disables the adapter’s timer. Pi’s HTTP client also enforces its global idle timeout on the socket and can close a silent connection sooner.

## Custom tool schemas

Pi sends tool schemas, local references, dialect markers and earlier tool calls as supplied. Panda validates these against its active ADR 0079 rules. Release compatibility requires slice C to be active on the endpoint. Model discovery does not advertise this feature. Supported root dialects include 2020-12, 2019-09 and draft-07. Slice C accepts retired-tool history and up to 128 tool declarations in 262,144 normalized bytes. Reference expansion allows up to 4,096 copies and 1 MiB of copied definitions across a request. Explicit options, empty tool arrays, historical calls and output bounds reach Panda as supplied by Pi or another extension. Panda handles neutral flags and reports unsupported requirements with a code and parameter when available. [Panda tool contract](https://panda.repair/products/llm-api#llm-api-agents-notes)

## Where your data goes

Panda receives the selected model, conversation text, tool definitions, tool-call arguments and tool results. In a mix, every model reads the conversation, with your tool descriptions, arguments and results. Without tools, Panda Auto and Panda Max read up to 2,000 characters from the start of your latest user message to pick how to answer. [Panda API guide](https://panda.repair/products/llm-api)

Panda's privacy policy says it retains billing metadata and does not retain API prompts or responses. It also says which providers process your requests and what they may keep. [Panda privacy policy](https://panda.repair/privacy)

## License

MIT. [License text](LICENSE)
