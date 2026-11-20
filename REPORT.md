STATUS: complete

# Panda provider for Pi 1.5.2

`@panda-repair/pi-provider@0.1.0` is ready for release review under the approved MIT license. The seven Pi selectors use the context and output settings from Panda's coding-agent guide. Each completed a file-read turn. The package was built locally. Production admission and billing remain untested. [Setup](README.md) · [License](LICENSE) · [Recorded results](evidence/pi-1.5.2.json)

## What ships

The Pi extension registers `panda` with its native OpenAI Chat Completions adapter, a masked personal-token login and `PANDA_API_TOKEN` support. Authenticated discovery intersects the server's list with seven text-only, tool-capable definitions. The dispatch check also protects explicit selectors that Pi invents when a model is missing. Model grants are in memory, scoped to the current credential and endpoint. The server remains authoritative if permissions change between refreshes. [Registration](index.js) · [Provider and discovery](src/provider.js)

The catalog retains developer messages and streaming usage. It disables storage, reasoning effort, prompt cache keys and long cache retention. A Panda-scoped request hook removes unsupported parameters, preserves supported tool requests, and emits at most one output limit within the selected model's cap. The provider also checks the final payload after other extensions have run. [Catalog](src/catalog.js) · [Request handling](src/request.js)

### Context windows

GLM-5.3, DeepSeek V4.1 Flash and `auto:cost` use 258,000 context tokens. Both Panels, `auto` and `auto:quality` use 224,000. Every selector allows 16,384 output tokens. The source is the coding-agent guide in webappv1 PR #97, revision `6ebf36eb81b836d3428fac1b2893915302877f94`. Its estimates use the smallest byte limit among the selector's tool-capable routes, divide by four and round down to the nearest thousand. [Panda coding-agent guide](https://panda.repair/products/llm-api/coding-agents)

Zero ADR 0079 D5/D7 at `92fe1a7c` defines server admission. The request can include 65,536 bytes of system and developer text and 1,024 messages. Conversation capacity depends on the model, the tools sent, space for Panel synthesis and the hold cap. [API model limits](https://panda.repair/products/llm-api#llm-api-model-limits)

### Retries and charges

Pi 1.5.2 disables the OpenAI SDK's own retries. Its transport can repeat an HTTP call and its agent can reopen a failed stream. The package follows the same key policy in both paths whenever Pi elects to retry.

| Outcome | Action on Pi's next attempt |
| --- | --- |
| No HTTP response, stream cut after 200, HTTP 500, or HTTP 503 with `interrupted`, `outcome_unknown`, `mixture_store_unavailable` or `inference_upstream_unavailable` | Keep the key. The previous run may have executed. An undocumented or unreadable server failure gets the same treatment. |
| Definite HTTP 4xx, including an actual 408 or pre-admission 429. HTTP 502 with `answer_invalid`, `answer_incomplete` or `no_answers`. HTTP 503 with `model_unavailable` or `model_refused`. | Start with a fresh key if the host retries. A Panel may already have incurred member charges even when its final answer failed. |
| HTTP 409 with `mixture_already_running` | Stop after the receipt. The earlier identical request is still running and will be charged when it completes. Its answer cannot be recovered. Resubmitting starts and charges a second run. The pending receipt keeps its original request ID and null charge and held amounts. |
| HTTP 409 with `mixture_already_completed` or `mixture_already_partial` | Stop after the receipt. Show that the earlier request finished and was charged, its reply was lost, and submitting again will charge again. Preserve the status, code and available request ID. |

An ordinary unmarked 409 is definite. `mixture_already_failed` and `mixture_idempotency_conflict` use a fresh key if the host retries. An explicitly marked replay whose status cannot be identified safely keeps its key. Error inspection reads a clone with a 16 KiB limit and a one-second timeout. A changed body after an uncertain outcome keeps the old key so Panda can report a conflict. Multiple indistinguishable uncertain attempts stop locally. A tool follow-up or new submission starts a new request. Pi can still elect to retry some 5xx responses in its outer agent even when Panda supplies `x-should-retry: false`. [Retry regressions](test/request.test.js)

### Local schema references

The package's existing root-dialect handling agrees with `92fe1a7c`. It strips the canonical 2020-12, 2019-09 and draft-07 URIs, each using lowercase HTTP or HTTPS and an optional terminal `#`. Draft-04, draft-06, unknown roots and nested dialect markers fail locally. Modern and unmarked references retain annotation siblings, while draft-07 ignores them. [Schema behavior](README.md) · [Schema tests](test/request.test.js)

Local-reference expansion follows the earlier ADR 0079 slice `beea6489`. The client still enforces a shared 65,536-byte copy budget and checks the expanded tool list against that size. The newer server revision separately allows up to 4,096 copies and 1 MiB of copied definitions, with a 262,144-byte limit on normalized tools. The server applies its remaining schema checks independently.

## Verification

The checks used Pi CLI and Pi AI 1.5.2, OpenAI SDK 7.19.0, Node 24.21.0 and npm 11.19.0. Pi used isolated home, configuration and cache directories. macOS restricted its network to loopback. All credentials, model decisions and server responses were synthetic.

| Check | Observed result |
| --- | --- |
| Unit and syntax | `npm test` passed 19/19. Both `src/catalog.js` and `src/request.js` passed `node --check`. Tests cover all seven exact model windows and output caps, all 12 supported root URI spellings and 17 rejected markers. |
| Checkout integration | 27 scenarios made 27 GETs and 52 POSTs with zero contract violations. Each of the seven models returned a marker first seen in a local file. Native custom tools completed turns with 2020-12, 2019-09 and draft-07, with the marker absent on both POSTs and annotation behavior preserved. Draft-04, draft-06 and a custom root each exited locally after discovery with zero chat POSTs. |
| Public guide and installation syntax | All seven catalog and README rows matched the guide's computed values. Pi 1.5.2 parsed the guide's `npm:@panda-repair/pi-provider` as a scoped npm package. |
| Installed catalog and compaction | The native registry returned all seven exact windows and output caps from a fresh archive install. The CLI displayed `258K` or `224K` and `16.4K` output. With Pi's default reserve, the compaction check stayed false at 241,616 and 207,616 tokens, respectively, and became true one token above each threshold. The probe made three authenticated fixture GETs. |
| Root-dialect comparison on `714683e` | All 28 cases agreed with Zero `92fe1a7c`. The packaged provider sent 12 supported root URI forms and an unmarked schema together in one normalized Chat POST. Draft-04, draft-06 and a nested marker reached no Chat POST. The independent run also passed 73 tests from the pinned Zero checkout. |
| Prior run still in progress | In both the agent-retry and transport-retry cases, two POSTs used the same key for one admitted fixture run. After the dropped response, the second POST returned `409 mixture_already_running`. Pi exited with the original request ID. The run was still pending with null charge and held amounts and no second admission. |
| Independent running-replay checks on `02cdeef` | Nine scenarios passed. When the real agent was made to re-enter after the 409, `d4e5292` sent a third POST with a fresh key and admitted a second run. The fixed package returned the cached receipt twice locally. Its one admitted run was still pending. |
| Definite 503 and lost reply | With `model_unavailable`, three POSTs used three keys for the refusal, successful retry and tool follow-up. The fixture recorded two answered runs. With a committed run and dropped connection, two POSTs shared one key for one charged fixture run. The second returned completed or partial 409, then Pi stopped. |
| Independent wire and failure checks on `d4e5292` | All 40 Pi scenarios passed. The original checker accepted 124 requests, 40 GETs and 84 POSTs. Checks included both native retry paths, client timeout versus HTTP 408, cut 200 streams, oversized or delayed error bodies, unmarked 409s, marked unreadable replays, and local tool-reference errors. |
| Reference comparison on `d4e5292` | All 104 effective admission decisions agreed with Zero slice B. Normalization matched directly on 101. Three schemas were rejected earlier by the extension and also refused by Zero before dispatch. Inputs were preserved and both inline/reference pairs matched. |
| Package | `npm pack --dry-run --json` and an actual pack listed seven files including the MIT license, 11,051 bytes compressed and 29,911 bytes unpacked. Archive SHA-256 `542a7c457c95acd1c4270ffa3a178c165a29487cd6274fed67545367518899a4`. |

The portable evidence records error codes, admissions, simulated charges, grouped request keys, schema comparison counts and file hashes. The single-account fixture supports unkeyed calls, running and settled replays, and changed-request conflicts. It excludes `seed` and `user` from its request comparison and retains raw captures locally. [Evidence](evidence/pi-1.5.2.json) · [Integration runner](test/e2e.py) · [Test fixtures](test/fixtures)

From the repository root, run the following with a Pi 1.5.2 executable and a new output directory. The integration command requires macOS, Python 3 and Node on `PATH`. The optional `--capture-tools /path/to/codex-capture` runs the seven ordinary turns with the archived originals. The bundled fixture exercises the additional retry and custom-tool scenarios.

```sh
npm test
npm pack --dry-run --json
python3 -I -B test/e2e.py --pi /path/to/pi --output /path/to/new-evidence
```

## Release decisions

- Recheck production admission and the two public guide links at publication. The coordinator's pre-release check found the coding-agent page returned HTTP 404 and the main API page lacked the model-limits anchor. Both targets are present in PR #97. [Model definitions](src/catalog.js)
- Confirm the price ceilings against the released catalog. The named-model input, output, cache-read and cache-write rates come from Zero `cb676cac`, `advisor_pricing.py` and the commercial catalog. Customer-facing examples agree on the two ordinary rates in the web app snapshot `10b870a6`. The five routed selectors use Pi's numeric zero placeholders. Panda's actual settlements can differ from Pi's estimate. [Panda pricing](https://panda.repair/pricing#pricing-llm-api)

## First public release

1. After the API rollout, run an authorized staging smoke test with a scoped inference token. Set `PANDA_BASE_URL` to the staging API, inspect `pi --list-models panda`, exercise a file-read turn and confirm the settled usage in Panda. Review the local commit and commit any changes to the release catalog or metadata.
2. Create the approved public repository from the reviewed checkout with `gh repo create panda-repair/pi-provider --public --source=. --remote=origin`, then `git push -u origin main`.
3. The project coordinator reports that the `panda-repair` npm organization exists and Nacho owns it. These local tests used isolated npm configuration. At release, use the organization's authorized publishing account and two-factor authentication.
4. Rerun the checks above and inspect the final pack manifest, including the approved license. From the reviewed release commit run `npm publish --access public`. In a clean Pi installation run `pi install npm:@panda-repair/pi-provider`, sign in with `/login panda` and repeat a model-list and tool-call smoke test.
