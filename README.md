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

| Pi selector | With tools enabled |
| --- | --- |
| `panda/glm-5.3` | Call GLM-5.3 directly. |
| `panda/deepseek-v4.1-flash` | Call DeepSeek V4.1 Flash directly. |
| `panda/auto` | Panda Panel → GLM → DeepSeek. |
| `panda/auto:cost` | DeepSeek → GLM. |
| `panda/auto:quality` | Quality Panel → GLM → Panda Panel → DeepSeek. |
| `panda/panel:panda` | DeepSeek and Gemini 3.8 Flash suggest a response. DeepSeek synthesizes it and chooses any tool call. |
| `panda/panel:panda-quality` | The same two members contribute. GLM-5.3 synthesizes their responses and chooses any tool call. |

## Limits and billing

Pi currently budgets 32,768 context tokens and up to 16,384 output tokens for each selector. These are provisional client limits pending Panda's per-model rollout. Panda allows up to 131,072 UTF-8 bytes for conversation text, tool arguments and results, and 16,384 bytes for instructions. It accepts up to 128 messages overall. A multi-member Panel with tools accepts up to 126 after combining initial instructions. Large file reads and long tool histories can reach these limits before Pi's token estimate. [Model limits and rates](src/catalog.js)

For the two named models, Pi estimates cost from Panda's per-million-token ceiling, including separate cache-read rates. The five routed selectors have no fixed price. Pi displays a zero cost for them, while Panda charges for the route that answered. Panels can charge for several model calls. Panda's settlement includes a one-cent minimum when anything answers. Consult Panda's usage and billing for the actual charge. [Panda pricing](https://panda.repair/pricing#pricing-llm-api)

The package sends an `Idempotency-Key` with each logical chat request and reuses it if Pi retries. The next tool turn gets a new key. After a lost response, Panda can return HTTP 409 with the original run's status and charge. The response text cannot be recovered from that receipt. Submitting the prompt again starts a new billable request.

Pi's standard function tools work with Panda's JSON Schema subset. For a custom tool, inline any `$ref` in its parameter schema. An active reference or an unknown schema dialect produces a local error. Panda validates its documented subset, and `strict: true` can reject additional keywords. [Tool calling in the Panda API guide](https://panda.repair/products/llm-api#llm-api-agents-notes)

## Where your data goes

GLM-5.3 and DeepSeek V4.1 Flash run on Cloudflare Workers AI. If Cloudflare refuses a request before execution, Panda can send it to the same model via an OpenRouter zero-data-retention host. A Panel sends the conversation, tool descriptions, arguments and results to its members and uses a synthesizer for the final decision. Both built-in Panels include Gemini 3.8 Flash on Google Vertex AI's global endpoint. A routed request can choose a Panel as shown above. [Panda API guide](https://panda.repair/products/llm-api)

Panda's privacy policy says it retains billing metadata and does not retain API prompts or responses. Gateway prompt logging and caching are disabled. Vertex's global endpoint can process data in multiple regions, and Google may retain prompts for abuse monitoring for up to 90 days. [Panda privacy policy](https://panda.repair/privacy#model-providers)
