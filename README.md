# Panda for Pi

Use Panda's text models, Panels and automatic routing with Pi's built-in coding tools. This package targets Pi 1.5.2 and requires a Panda endpoint with ADR 0079 slice C enabled.

## Install and sign in

```sh
pi install npm:@panda-repair/pi-provider
```

Start Pi, enter `/login panda`, and paste a personal Panda inference token beginning with `pnd_it_` at the masked prompt. Pi saves it in its credential store. For a headless session, set `PANDA_API_TOKEN` in the environment before starting Pi. A saved credential takes precedence. To switch to the environment token, use `/logout`, choose Panda, and restart Pi. [Panda coding-agent guide](https://panda.repair/products/llm-api/coding-agents)

```sh
pi --list-models panda
pi --model panda/panel:panda
```

To install a local checkout, run `pi install /path/to/pi-provider` with its absolute path.

The package authenticates to `GET /v1/models` at startup. The list contains only supported selectors available to the current token. A missing token, a failed discovery or a fresh offline session leaves the list empty. Restart Pi to refresh access after a workspace grant changes. In Pi 1.5.2, use the interactive `/login` command for this extension.

Requests go to `https://app.panda.repair/v1` by default. For staging, set `PANDA_BASE_URL` to the trusted staging API base including its `/v1` path before starting Pi. Both discovery and chat send the bearer token to that address.

## Pick a model

Use the complete selector, including `panda/` and any colon. All seven accept text and function tools. Pi executes the selected tool locally and sends its result in the next request. The package accepts text input only and exposes no adjustable thinking level. With tools enabled, each `auto` selector picks the first option your token permits from its row, before the selected model or Panel runs.

| Pi selector | Pi context window (tokens) | With tools enabled |
| --- | ---: | --- |
| `panda/glm-5.3` | 258,000 | Call GLM-5.3 directly. |
| `panda/deepseek-v4.1-flash` | 258,000 | Call DeepSeek V4.1 Flash directly. |
| `panda/auto` | 224,000 | Panda Panel → GLM → DeepSeek. |
| `panda/auto:cost` | 258,000 | DeepSeek → GLM. |
| `panda/auto:quality` | 224,000 | Quality Panel → GLM → Panda Panel → DeepSeek. |
| `panda/panel:panda` | 224,000 | DeepSeek and Gemini 3.8 Flash suggest a response. DeepSeek synthesizes it and chooses any tool call. |
| `panda/panel:panda-quality` | 224,000 | The same two members contribute. GLM-5.3 synthesizes their responses and chooses any tool call. |

## Limits and billing

All seven selectors allow up to **16,384 output tokens**. The Pi windows follow Panda's coding-agent guide. For each selector, the guide takes the smallest request limit among the routes it can use with tools, divides the bytes by four and rounds down to the nearest 1,000 tokens. With automatic compaction enabled, Pi summarizes older turns when its estimate exceeds the window minus `compaction.reserveTokens`. The default reserve of 16,384 gives thresholds of 241,616 tokens for the 258,000 window and 207,616 for the 224,000 window. [Panda coding-agent guide](https://panda.repair/products/llm-api/coding-agents)

Panda counts framed UTF-8 input bytes and reserves the requested output. At the full output cap, GLM-5.3 and DeepSeek V4.1 Flash allow 1,032,192 rendered input bytes. The two Panels allow about 900,000 bytes of conversation because synthesis needs room for the members' answers. A request can contain up to 1,024 messages and 65,536 bytes of system and developer instructions combined. Tools, framing and the US$5.25 hold cap can reduce the room available to your conversation. [Panda API model limits](https://panda.repair/products/llm-api#llm-api-model-limits)

For the two named models, Pi estimates cost from Panda's per-million-token ceiling, including separate cache-read rates. The five routed selectors have no fixed price. Pi displays a zero cost for them, while Panda charges for the route that answered. Panels can charge for several model calls. Panda's settlement includes a one-cent minimum when anything answers. Consult Panda's usage and billing for the actual charge. [Panda pricing](https://panda.repair/pricing#pricing-llm-api)

If Pi retries a dropped connection, an interrupted stream or an error with an unknown outcome, the package keeps the original `Idempotency-Key`. A definite error such as `model_unavailable`, a normal tool follow-up or a new prompt uses a fresh key on the next request.

After a lost response, Panda can return an HTTP 409 replay receipt. If the earlier identical request is still running, Pi stops. That request will be charged when it completes, its answer cannot be recovered, and resubmitting starts and charges a second run. If the receipt says the earlier run finished or partially completed, Pi reports that it was charged and its reply was lost.

## Custom tool schemas

Pi sends tool schemas, local references, dialect markers and earlier tool calls as supplied. Panda validates these against its active ADR 0079 rules. Supported root dialects include 2020-12, 2019-09 and draft-07. Slice C accepts retired-tool history and up to 128 tool declarations in 262,144 normalized bytes. Reference expansion allows up to 4,096 copies and 1 MiB of copied definitions across a request. An explicit unsupported option or conflicting output bound gets a server refusal. [Panda tool contract](https://panda.repair/products/llm-api#llm-api-agents-notes)

## Where your data goes

GLM-5.3 and DeepSeek V4.1 Flash run on Cloudflare Workers AI. If Cloudflare refuses a request before execution, Panda can send it to the same model via an OpenRouter zero-data-retention host. A Panel sends the conversation, tool descriptions, arguments and results to its members and uses a synthesizer for the final decision. Both built-in Panels include Gemini 3.8 Flash on Google Vertex AI's global endpoint. A routed request can choose a Panel as shown above. [Panda API guide](https://panda.repair/products/llm-api)

Panda's privacy policy says it retains billing metadata and does not retain API prompts or responses. Gateway prompt logging and caching are disabled. Vertex's global endpoint can process data in multiple regions, and Google may retain prompts for abuse monitoring for up to 90 days. [Panda privacy policy](https://panda.repair/privacy#model-providers)

## License

MIT. [License text](LICENSE)
