# Panda for Pi

Use Panda's text models, Panels and automatic routing with Pi's built-in coding tools. This package targets Pi 1.5.2 and requires a Panda endpoint with ADR 0079 slice C enabled.

## Install and sign in

```sh
pi install npm:@panda-repair/pi-provider
```

Start Pi, enter `/login panda`, and paste a personal Panda inference token beginning with `pnd_it_` at the masked prompt. Pi saves it in its credential store. For a headless session, set `PANDA_API_TOKEN` in the environment before starting Pi. The token saved by `/login` takes precedence over `PANDA_API_TOKEN`. To switch to the environment token, use `/logout`, choose Panda, and restart Pi. [Panda coding-agent guide](https://panda.repair/products/llm-api/coding-agents)

```sh
pi --list-models panda
pi --model panda/panel:panda
```

To install a local checkout, run `pi install /path/to/pi-provider` with its absolute path.

Startup and `--list-models` read Pi's catalog cache. A new login or an explicit Panda prompt can refresh `GET /v1/models` using Pi's selected endpoint, effective credential and network policy. A cold list can be empty. Start Pi with `--model panda/glm-5.3` or use interactive `/login panda` to establish the catalog. Cached grants are bound to the credential and endpoint. A router needs its own grant and at least one of Panda Panel, GLM or DeepSeek. Cost routing requires one of the two direct models. Pi can resolve a typed model from its technical inventory, but the provider checks its grant before sending chat. A token supplied exclusively through a custom `models.json` variable may need an explicit prompt to populate availability in a new Pi process.

Requests go to `https://app.panda.repair/v1` by default. For staging, set `PANDA_BASE_URL` to the trusted staging API base including its `/v1` path before starting Pi. An explicit provider base URL in Pi’s `models.json` takes precedence. Both discovery and chat use the selected provider endpoint. Panda supports Pi’s `openai-completions` protocol.

## Pick a model

Use the complete selector, including `panda/` and any colon. All seven accept text and function tools. Pi executes the selected tool locally and sends its result in the next request. The package accepts text input only and exposes no adjustable thinking level. With tools enabled, each `auto` selector picks the first option your token permits from its row, before the selected model or Panel runs.

| Pi selector | Pi context window (tokens) | With tools enabled |
| --- | ---: | --- |
| `panda/glm-5.3` | 258,000 | Call GLM-5.3 directly. |
| `panda/deepseek-v4.1-flash` | 258,000 | Call DeepSeek V4.1 Flash directly. |
| `panda/auto` | 224,000 | Panda Panel → GLM → DeepSeek. |
| `panda/auto:cost` | 258,000 | DeepSeek → GLM. |
| `panda/auto:quality` | 187,000 | Quality Panel → GLM → Panda Panel → DeepSeek. |
| `panda/panel:panda` | 224,000 | DeepSeek and Gemini 3.8 Flash suggest a response. DeepSeek synthesizes it and chooses any tool call. |
| `panda/panel:panda-quality` | 224,000 | The same two members contribute. GLM-5.3 synthesizes their responses and chooses any tool call. |

## Limits and billing

Pi advertises **16,384 output tokens** for all seven selectors. Tool-free work such as titles and summaries can take a different route. For example, `auto:quality` can reach Gemini 4 Argon, which admits 751,413 rendered input bytes at the US$5.25 hold cap in the guide’s example. All three routers can fall back to Gemma on a tool-free request, with 239,616 rendered bytes in the guide’s example. GLM Flash also has a smaller 4,096-token output cap. The advertised limits are planning estimates for Pi. Panda applies the selected route’s limits to each request. [Panda coding-agent guide](https://panda.repair/products/llm-api/coding-agents)

Panda counts framed UTF-8 bytes and reserves the requested output. At the full output cap, GLM-5.3 and DeepSeek V4.1 Flash allow 1,032,192 rendered input bytes. The two Panels allow about 900,000 conversation bytes in the guide’s sample because synthesis needs space for member answers. A request can carry up to 1,024 messages and 65,536 bytes of system and developer instructions combined. Tools, framing and the hold can reduce the available space. [Panda API model limits](https://panda.repair/products/llm-api#llm-api-model-limits)

Pi compacts when its estimated conversation size exceeds the window minus `compaction.reserveTokens`. With the default 16,384 reserve, the thresholds are 241,616, 207,616 and 170,616 tokens for the 258,000, 224,000 and 187,000 windows. For a Panel, including an automatically routed Panel, Pi retains all usage components for accounting. For compaction, the extension uses the largest reported member prompt plus the final output. If member usage is unavailable, it uses the synthesis prompt or estimates the request locally.

Prices are ceilings. You pay 3/2 of each chargeable call’s reported cost up to its ceiling. Panda sums those calls and applies a one-cent minimum **once per run** when a chargeable call answers. With either built-in Panel, you pay for each call that answers, up to three. A failed synthesis can still leave member charges. Pi uses per-model estimates for the two named models and shows the reported USD settlement when Panda supplies it. Routed selectors have no fixed tariff. [Panda pricing](https://panda.repair/pricing#pricing-llm-api)

If a connection drops or a stream ends before its outcome is known, Pi can retry the same operation with its original key. This also applies to compaction and branch summaries. A fresh-key retry requires evidence that the failed attempt cost zero. A settled failure with a positive or unknown charge stops. A key/body conflict also stops because the original settlement is unknown.

A replay receipt can say that the earlier request is running, completed or partially completed. A running charge is pending and may be zero. A settled receipt shows the reported charge, including zero, when available. The answer cannot be recovered through a replay. Submitting again starts a separate, potentially billable run.

## Panel timeouts

Panels can take several minutes before returning their first response. For a ten-minute deadline in Pi 1.5.2, set the following in Pi’s `settings.json`. Pi’s default HTTP idle timeout is five minutes. If you also set `retry.provider.timeoutMs`, it selects the provider deadline independently. Explicit per-call and Pi timeouts are preserved.

```json
{ "httpIdleTimeoutMs": 600000, "retry": { "provider": { "timeoutMs": 600000 } } }
```

## Custom tool schemas

Pi sends tool schemas, local references, dialect markers and earlier tool calls as supplied. Panda validates these against its active ADR 0079 rules. Release compatibility requires slice C to be active on the endpoint. Model discovery does not advertise this feature. Supported root dialects include 2020-12, 2019-09 and draft-07. Slice C accepts retired-tool history and up to 128 tool declarations in 262,144 normalized bytes. Reference expansion allows up to 4,096 copies and 1 MiB of copied definitions across a request. Explicit options, empty tool arrays, historical calls and output bounds reach Panda as supplied by Pi or another extension. Panda handles neutral flags and reports unsupported requirements with a code and parameter when available. [Panda tool contract](https://panda.repair/products/llm-api#llm-api-agents-notes)

## Where your data goes

GLM-5.3 and DeepSeek V4.1 Flash run on Cloudflare Workers AI. If Cloudflare refuses a request before execution, Panda can send it to the same model via an OpenRouter zero-data-retention host. A Panel sends the conversation, tool descriptions, arguments and results to its members and uses a synthesizer for the final decision. Both built-in Panels include Gemini 3.8 Flash on Google Vertex AI's global endpoint. A routed request can choose a Panel as shown above. [Panda API guide](https://panda.repair/products/llm-api)

Panda's privacy policy says it retains billing metadata and does not retain API prompts or responses. Gateway prompt logging and caching are disabled. Vertex's global endpoint can process data in multiple regions, and Google may retain prompts for abuse monitoring for up to 90 days. [Panda privacy policy](https://panda.repair/privacy#model-providers)

## License

MIT. [License text](LICENSE)
