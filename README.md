# Panda for Pi

Use Panda's text models, Panels and automatic routing with Pi's built-in coding tools. This package targets Pi 1.5.2.

## Install and sign in

From a checkout, run `pi install /path/to/pi-provider` with the package's absolute path. After the first npm release, use the registry command below.

```sh
pi install npm:@panda-repair/pi-provider
```

Start Pi, enter `/login panda`, and paste a personal Panda inference token beginning with `pnd_it_` at the masked prompt. Pi saves it in its credential store. For a headless session, set `PANDA_API_TOKEN` in the environment before starting Pi. A saved credential takes precedence. To switch to the environment token, use `/logout`, choose Panda, and restart Pi. [Panda API guide](https://panda.repair/products/llm-api)

```sh
pi --list-models panda
pi --model panda/panel:panda
```

The package authenticates to `GET /v1/models` at startup. The list contains only supported selectors available to the current token. A missing token, a failed discovery or a fresh offline session leaves the list empty. Restart Pi to refresh access after a workspace grant changes. In Pi 1.5.2, use the interactive `/login` command for this extension.

Requests go to `https://app.panda.repair/v1` by default. For staging, set `PANDA_BASE_URL` to the trusted staging API base including its `/v1` path before starting Pi. Both discovery and chat send the bearer token to that address.

## Pick a model

Use the complete selector, including `panda/` and any colon. All seven accept text and function tools. Pi executes the selected tool locally and sends its result in the next request. The package accepts text input only and exposes no adjustable thinking level. With tools enabled, each `auto` selector picks the first option your token permits from its row, before the selected model or Panel runs.

| Pi selector | Pi context window (tokens) | With tools enabled |
| --- | ---: | --- |
| `panda/glm-5.3` | 262,144 | Call GLM-5.3 directly. |
| `panda/deepseek-v4.1-flash` | 262,144 | Call DeepSeek V4.1 Flash directly. |
| `panda/auto` | 225,280 | Panda Panel → GLM → DeepSeek. |
| `panda/auto:cost` | 262,144 | DeepSeek → GLM. |
| `panda/auto:quality` | 187,392 | Quality Panel → GLM → Panda Panel → DeepSeek. |
| `panda/panel:panda` | 225,280 | DeepSeek and Gemini 3.8 Flash suggest a response. DeepSeek synthesizes it and chooses any tool call. |
| `panda/panel:panda-quality` | 225,280 | The same two members contribute. GLM-5.3 synthesizes their responses and chooses any tool call. |

## Limits and billing

All seven selectors allow up to **16,384 output tokens**. With automatic compaction enabled, Pi 1.5.2 summarizes older turns when its context estimate exceeds the selected window minus `compaction.reserveTokens` (16,384 by default). For `panda/auto:quality`, the default threshold is 171,008 tokens. Pi uses reported usage when available and estimates uncounted text by dividing its JavaScript string length by four. [Model limits and rates](src/catalog.js)

The windows are planning estimates for coding text, using roughly four rendered bytes per Pi token. Panda's target admission rules in ADR 0079 D5/D7 count framed UTF-8 input bytes and reserve the requested output. Panels also need room for synthesis, and a route can reach the US$5.25 per-run hold cap. Tool definitions, instructions, text encoding and the route available to your token can bring the server limit forward. Recheck the estimates against production at publication.

For the two named models, Pi estimates cost from Panda's per-million-token ceiling, including separate cache-read rates. The five routed selectors have no fixed price. Pi displays a zero cost for them, while Panda charges for the route that answered. Panels can charge for several model calls. Panda's settlement includes a one-cent minimum when anything answers. Consult Panda's usage and billing for the actual charge. [Panda pricing](https://panda.repair/pricing#pricing-llm-api)

If Pi retries a dropped connection, an interrupted stream or an error with an unknown outcome, the package keeps the original `Idempotency-Key`. A definite error such as `model_unavailable`, a normal tool follow-up or a new prompt uses a fresh key on the next request.

After a lost response, Panda can return an HTTP 409 replay receipt. If the earlier identical request is still running, Pi stops. That request will be charged when it completes, its answer cannot be recovered, and resubmitting starts and charges a second run. If the receipt says the earlier run finished or partially completed, Pi reports that it was charged and its reply was lost.

## Custom tool schemas

The package accepts a root `$schema` for JSON Schema **2020-12**, **2019-09** or **draft-07**. Use `json-schema.org/draft/2020-12/schema`, `json-schema.org/draft/2019-09/schema` or `json-schema.org/draft-07/schema` with an `http://` or `https://` prefix. Each also accepts a single trailing `#`. The package strips the marker before sending the tool to Panda. Draft-04, draft-06, unknown dialects and a marker below the schema root fail locally before chat dispatch.

Local references of the form `#/$defs/Name` and `#/definitions/Name` resolve within each tool. Modern and unmarked schemas apply annotation siblings such as `description` or `default` over the definition. Draft-07 ignores those annotations. Put validation constraints in the definition. Property names and literal values in `const`, `enum`, `default` and `examples` retain their meaning.

The package expands acyclic references up to 32 levels and 65,536 bytes of copies across the request. When references expand, the written-out tool list must also fit this client-side byte limit. Remote, missing and cyclic targets produce a local error. Panda checks its documented schema subset, and `strict: true` can reject additional keywords. [Tool calling in the Panda API guide](https://panda.repair/products/llm-api#llm-api-agents-notes)

## Where your data goes

GLM-5.3 and DeepSeek V4.1 Flash run on Cloudflare Workers AI. If Cloudflare refuses a request before execution, Panda can send it to the same model via an OpenRouter zero-data-retention host. A Panel sends the conversation, tool descriptions, arguments and results to its members and uses a synthesizer for the final decision. Both built-in Panels include Gemini 3.8 Flash on Google Vertex AI's global endpoint. A routed request can choose a Panel as shown above. [Panda API guide](https://panda.repair/products/llm-api)

Panda's privacy policy says it retains billing metadata and does not retain API prompts or responses. Gateway prompt logging and caching are disabled. Vertex's global endpoint can process data in multiple regions, and Google may retain prompts for abuse monitoring for up to 90 days. [Panda privacy policy](https://panda.repair/privacy#model-providers)

## License

MIT. [License text](LICENSE)
