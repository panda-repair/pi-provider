# Panda for Pi

Use Panda’s three Auto selectors and two Panels with Pi’s built-in coding tools. This package supports Pi 1.5.2 and 1.6.0 and requires a Panda endpoint with ADR 0079 slice C enabled.

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

Startup and `--list-models` read Pi's catalog cache. A new login or an explicit Panda prompt can refresh `GET /v1/models` using Pi's selected endpoint, effective credential and network policy. A cold list can be empty. Start Pi with `--model panda/auto` or use interactive `/login panda` to establish the catalog. Cached grants are bound to the credential and endpoint. Routers need both their own grant and a tool-capable backend. A Panda Panel grant can also qualify balanced and quality routing. Cost routing requires one of its two underlying backends. A cache-only `--list-models panda` can occasionally show ungranted selectors or an unsupported model listed in `models.json`. Sending a chat request requires a supported selector with a matching cached grant for the credential and endpoint. After a token is revoked or loses a model grant, Pi can still use a stale grant with `PI_OFFLINE=1` or through a virtual model that selects Panda. While the grant is stale, each new submission to the denied model on either path sends one foreground chat POST, plus any summary request from compaction (see [Limits and billing](#limits-and-billing)). Panda rejects each request with HTTP 401 or 403 before admission, at no charge. To refresh the list online, open `/model` or restart your interactive Pi session.

For a custom credential in Pi’s active `models.json`, use `"$MY_PANDA_TOKEN"` or `"${MY_PANDA_TOKEN}"`. The picker matches the current variable, literal token or non-command template to the signed cache on every lookup. Rotating or removing the token hides its previous grants. An explicit Panda prompt can establish grants for the new token. A saved Panda login takes precedence over a configured credential command. With only a command, a fresh `--list-models panda` normally stays empty because cache-only listing and filtering never run it. Open the online `/model` picker to run the command once and see the grants returned by one `GET /v1/models`, or start Pi with `--model panda/<selector>`. After a credential command returns a new token, `/model` autocomplete can still offer models from the previous token’s catalog until you reopen `/model`. If you select a model the new token cannot use, submitting a prompt may trigger a catalog refresh (`GET /v1/models`). Pi rejects that prompt before sending a chat request.

SDK sessions bind the picker to their own model runtime, including a custom `agentDir` or `modelsPath`. A services-only SDK client that lists models before binding a session can register `withPandaModelRuntime(runtime)` from this package as an inline extension factory and pass the same `runtime` as Pi’s `modelRuntime`. Pi uses the session’s runtime while the session is open and restores the caller-supplied runtime after disposal. Without a binding the pre-session picker hides grants for unverifiable custom credentials.

Requests go to `https://app.panda.repair/v1` by default. For staging, set `PANDA_BASE_URL` to the trusted staging API base including its `/v1` path before starting Pi. An explicit provider base URL in Pi’s `models.json` takes precedence. Both discovery and chat use the selected provider endpoint. Panda supports Pi’s `openai-completions` protocol.

## Pick a model

Use the complete selector, including `panda/` and any colon. All five accept text and function tools. Pi executes the selected tool locally and sends its result in the next request. The package accepts text input only and exposes no adjustable thinking level. With tools enabled, each `auto` selector picks the first option your token permits from its row, before the selected model or Panel runs.

| Pi selector | Pi context window (tokens) | With tools enabled |
| --- | ---: | --- |
| `panda/auto` | 224,000 | Use the Panda Panel first, then the first permitted text backend. |
| `panda/auto:cost` | 258,000 | Choose the first permitted text backend in Panda’s cost-routing order. |
| `panda/auto:quality` | 187,000 | Choose the quality Panel when permitted. The other choices, in order, are a text backend, the Panda Panel and a second text backend. |
| `panda/panel:panda` | 224,000 | Two members suggest a response. One member combines their answers and chooses any tool call. |
| `panda/panel:panda-quality` | 224,000 | The same two members contribute. A separate synthesizer selects the final answer and any tool call. |

## Limits and billing

Pi advertises **16,384 output tokens** for all five selectors. Tool-free work such as titles and summaries can take a different route. For example, `auto:quality` can reach Gemini 4 Argon, which admits 751,413 rendered input bytes at the US$5.25 hold cap in the guide’s example. For Pi-eligible credentials, `auto` and `auto:cost` can fall back to Gemma on tool-free requests when the token omits the preferred routes. The guide’s Gemma example admits 239,616 rendered bytes. Some tool-free routes cap output at 4,096 tokens. The advertised limits are planning estimates for Pi. Panda applies the selected route’s limits to each request. [Model guidance for coding agents](https://panda.repair/products/llm-api/coding-agents/setup#agents-models)

Panda counts framed UTF-8 bytes and reserves the requested output. The two Panels allow about 900,000 conversation bytes at the full output cap in the guide’s sample because synthesis needs space for member answers. A request can carry up to 1,024 messages and 65,536 bytes of system and developer instructions combined. A multi-member Panel using tools allows 1,022 caller messages, counting combined system and developer instructions as one. Tools, framing and the hold can reduce the available space. [Panda API model limits](https://panda.repair/products/llm-api#llm-api-model-limits)

Pi compacts when its estimated conversation size exceeds the window minus `compaction.reserveTokens`. With the default 16,384 reserve, the thresholds are 241,616, 207,616 and 170,616 tokens for the 258,000, 224,000 and 187,000 windows. For a Panel, including an automatically routed Panel, Pi’s context checks and `/session` token totals use the largest member prompt plus the final output. If member usage is unavailable, the extension uses the synthesis prompt or estimates the request locally. When Panda reports aggregate counters, the assistant’s `panda.aggregate_usage` diagnostic preserves them, including reported zeros. An absent or null trailer leaves the aggregate unknown and omits the diagnostic. Pi’s USD spending total uses the validated settlement for the full run.

Published prices are ceilings. Under Panda’s API billing contract, you pay 3/2 of Panda’s cost for each chargeable call, capped at the published price for its usage. Gemini, used in both built-in Panels, reports token counts that Panda prices at Google’s applicable token rates. For OpenRouter calls, Panda’s cost includes the 5.5% fee it pays on credits. Panda sums the charges and applies a one-cent minimum **once per run** when a chargeable call answers. With either built-in Panel, you pay for each call that answers, up to three. A failed synthesis can still leave member charges. All five selectors have variable prices. Pi shows the reported USD settlement when Panda supplies it. [Panda pricing](https://panda.repair/pricing#pricing-llm-api)

Each Pi call opens with its own idempotency key. Panda failures stop that call, including compaction, branch summaries and virtual-model requests. After a dropped connection, incomplete stream or unknown server outcome, the request may have run and been charged. Submitting the prompt again as a new Pi call starts a new run and may charge you again. If Panda has already reported a settled finish, Pi keeps the answer and reported charge even if the optional usage trailer is lost. A content filter ends the call with a refusal and preserves the active history. Pi cannot save that refusal as a compaction or branch summary. A caller cancellation or response callback failure still ends the call and retains any settlement Panda has already supplied.

The adapter retries only Panda’s two pre-admission throttles for concurrency and workspace rate limits. The adapter makes at most two further attempts with the same key and identical request bytes. A lower `maxRetries` applies, including zero. Cancelling while waiting after a confirmed pre-admission throttle reports that the attempt incurred no charge. It honors `Retry-After`, cancellation and the caller’s deadline, with a total wait budget of 60 seconds. A retry veto or a longer required delay stops the call. Pi’s HTTP client can also resend the original key and body after HTTP 421, even with `maxRetries: 0`. If Panda already admitted the request, it can return a 409 replay of the original run without a second charge.

A running receipt means the charge is pending and may be zero. A settled receipt shows the reported charge, including zero. A replay cannot recover the answer. Pi recognizes a charge the session has already saved when the entry retains its run ID. An unsaved standalone result can report the amount again. When a stream cuts early, its validated Panda request ID remains available in the error diagnostic for a billing inquiry. A failed checkpoint or standalone call can report a charge without creating a Pi spending entry. A request that exceeds the input limit stops. You can compact or shorten the conversation and submit it again. Pi can still compact a growing conversation before a call. If that preventive summary fails, Pi can continue the foreground prompt you already submitted.

Custom extensions that save Panda spending in a checkpoint, tool result or explicit usage entry should keep the returned `usage.cost`, including its `pandaRunIds`. When combining costs, retain the IDs for the Panda charges included in the sum. Pi uses saved charge records to recognize later receipts, including after reopening the session. Older checkpoints and extensions that save only a numeric total can lose the ID, as can cloning a split-compaction checkpoint or combining nested-tool costs. Stock Pi processes each delivered settlement once. In these ID-loss cases, its displayed total can include the charge twice only if it receives the same receipt again. Separately, a custom SDK caller that appends the same usage twice can display the charge twice after one settlement, even when both entries retain the ID. Neither case creates another Panda charge.

## Panel timeouts

Panels can take several minutes before returning their first response. For a ten-minute deadline, set the following in Pi’s `settings.json`. Pi’s default HTTP idle timeout is five minutes. If you also set `retry.provider.timeoutMs`, it selects the provider deadline independently. Explicit per-call and Pi timeouts are preserved.

```json
{ "httpIdleTimeoutMs": 600000, "retry": { "provider": { "timeoutMs": 600000 } } }
```

## Custom tool schemas

Pi sends tool schemas, local references, dialect markers and earlier tool calls as supplied. Panda validates these against its active ADR 0079 rules. Release compatibility requires slice C to be active on the endpoint. Model discovery does not advertise this feature. Supported root dialects include 2020-12, 2019-09 and draft-07. Slice C accepts retired-tool history and up to 128 tool declarations in 262,144 normalized bytes. Reference expansion allows up to 4,096 copies and 1 MiB of copied definitions across a request. Explicit options, empty tool arrays, historical calls and output bounds reach Panda as supplied by Pi or another extension. Panda handles neutral flags and reports unsupported requirements with a code and parameter when available. [Panda tool contract](https://panda.repair/products/llm-api#llm-api-agents-notes)

## Where your data goes

For tool-free requests with a Pi-eligible credential, `auto` can send a writing request directly to GLM-5.3 Flash on OpenRouter, and `auto:quality` can send a request directly to Gemini on Google Vertex AI. Under Zero ADR 0070’s routing rules, these two selectors can send up to 2,000 characters from the start of the latest user message to Cloudflare Workers AI to classify the task.

Panda runs some text backends on Cloudflare Workers AI. If Cloudflare refuses a request before execution, Panda can send it to the same model via an OpenRouter zero-data-retention host. A Panel sends the conversation, tool descriptions, arguments and results to its members and uses a synthesizer for the final decision. Both built-in Panels include Gemini 3.8 Flash on Google Vertex AI's global endpoint. A routed request can choose a Panel as shown above. [Panda API guide](https://panda.repair/products/llm-api)

Panda's privacy policy says it retains billing metadata and does not retain API prompts or responses. Gateway prompt logging and caching are disabled. Vertex's global endpoint can process data in multiple regions, and Google may retain prompts for abuse monitoring for up to 90 days. [Panda privacy policy](https://panda.repair/privacy#model-providers)

## License

MIT. [License text](LICENSE)
