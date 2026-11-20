STATUS: complete

# Panda provider for Pi 1.5.2

`@panda-repair/pi-provider@0.1.0` is ready for release review under the approved MIT license. All seven selectors completed a Pi file-read round trip. An independent replay-aware mock verified that a lost, charged fixture run led to a terminal receipt without a second admission. The package is local and unpublished. Production acceptance and billing remain untested. [Setup](README.md) · [License](LICENSE) · [Recorded results](evidence/pi-1.5.2.json)

## What ships

The Pi extension registers `panda` with its native OpenAI Chat Completions adapter, a masked personal-token login and `PANDA_API_TOKEN` support. Authenticated discovery intersects the server's list with seven text-only, tool-capable definitions. The dispatch check also protects explicit selectors that Pi invents when a model is missing. Model grants are in memory, scoped to the current credential and endpoint. The server remains authoritative if permissions change between refreshes. [Registration](index.js) · [Provider and discovery](src/provider.js)

The catalog retains developer messages and streaming usage. It disables storage, reasoning effort, prompt cache keys and long cache retention. A Panda-scoped request hook removes unsupported parameters, preserves supported tool requests, and emits at most one output limit within the selected model's cap. The provider also checks the final payload after other extensions have run. [Catalog](src/catalog.js) · [Request handling](src/request.js)

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

The extension implements the accepted reference forms from Zero's draft ADR 0079, slice B, revision `beea6489`. It resolves local JSON Pointers into each tool's root `$defs` or `definitions`, applies annotations according to the root dialect, and preserves literal JSON values and map names. It rejects unsupported dialects, remote or missing targets, cycles, deeper than 32 references and expansion over 65,536 bytes across the tool list. This is the slice-B and captured-service byte budget. Pi's provisional 32,768-token catalog context remains in effect. [Schema behavior](README.md) · [Schema tests](test/request.test.js)

## Verification

The checks used Pi CLI and Pi AI 1.5.2, OpenAI SDK 7.19.0, Node 24.21.0 and npm 11.19.0. Pi used isolated home, configuration and cache directories. macOS restricted its network to loopback. All credentials, model decisions and server responses were synthetic.

| Check | Observed result |
| --- | --- |
| Unit and syntax | `npm test` passed 18/18 and the changed JavaScript passed `node --check`. The new test forced both retry layers to re-enter. The prior version sent four HTTP calls. The fixed version sent two, then returned the cached 409 to both layers. |
| Checkout integration | 21 scenarios made 21 GETs and 46 POSTs with zero contract violations. Each of the seven models returned a marker first seen in a local file. An additional real Pi tool executed with its chained local references expanded on the wire. |
| Prior run still in progress | In both the agent-retry and transport-retry cases, two POSTs used the same key for one admitted fixture run. After the dropped response, the second POST returned `409 mixture_already_running`. Pi exited with the original request ID. The run was still pending with null charge and held amounts and no second admission. |
| Independent running-replay checks | Nine scenarios passed. When the real agent was made to re-enter after the 409, `d4e5292` sent a third POST with a fresh key and admitted a second run. The fixed package returned the cached receipt twice locally. Its one admitted run was still pending. |
| Definite 503 and lost reply | With `model_unavailable`, three POSTs used three keys for the refusal, successful retry and tool follow-up. The fixture recorded two answered runs. With a committed run and dropped connection, two POSTs shared one key for one charged fixture run. The second returned completed or partial 409, then Pi stopped. |
| Independent wire and failure checks on `d4e5292` | All 40 Pi scenarios passed. The original checker accepted 124 requests, 40 GETs and 84 POSTs. Checks included both native retry paths, client timeout versus HTTP 408, cut 200 streams, oversized or delayed error bodies, unmarked 409s, marked unreadable replays, and local tool-reference errors. |
| Reference comparison on `d4e5292` | All 104 effective admission decisions agreed with Zero slice B. Normalization matched directly on 101. Three schemas were rejected earlier by the extension and also refused by Zero before dispatch. Inputs were preserved and both inline/reference pairs matched. |
| Package | `npm pack --dry-run --json` and an actual pack listed seven files including the approved MIT license, 10,704 bytes compressed and 28,715 bytes unpacked. All packed bytes matched source. An install of the packed contents completed real file-read turns for all seven selectors, covering 21 requests with zero contract violations. The archive SHA-256 is `7088be84244b8e6a58665efe64f3022d07da0ae4896f8ba2220acf791d1875b7`. |

The portable evidence records error codes, admissions, simulated charges, grouped request keys, schema comparison counts and file hashes. The single-account fixture supports unkeyed calls, running and settled replays, and changed-request conflicts. It excludes `seed` and `user` from its request comparison and retains raw captures locally. [Evidence](evidence/pi-1.5.2.json) · [Integration runner](test/e2e.py) · [Test fixtures](test/fixtures)

From the repository root, run the following with a Pi 1.5.2 executable and a new output directory. The integration command requires macOS, Python 3 and Node on `PATH`. The optional `--capture-tools /path/to/codex-capture` runs the seven ordinary turns with the archived originals. The bundled fixture exercises the additional retry and custom-tool scenarios.

```sh
npm test
npm pack --dry-run --json
python3 -I -B test/e2e.py --pi /path/to/pi --output /path/to/new-evidence
```

## Release decisions

- Confirm the per-model limits when Panda's API change ships. All seven currently use provisional 32,768-token context and 16,384-token output budgets. The Chat contract's separate byte limits also apply. Update the catalog in one place. [Model definitions](src/catalog.js)
- Confirm the price ceilings against the released catalog. The named-model input, output, cache-read and cache-write rates come from Zero `cb676cac`, `advisor_pricing.py` and the commercial catalog. Customer-facing examples agree on the two ordinary rates in the web app snapshot `10b870a6`. The five routed selectors use Pi's numeric zero placeholders. Panda's actual settlements can differ from Pi's estimate. [Panda pricing](https://panda.repair/pricing#pricing-llm-api)

## First public release

1. After the API rollout, run an authorized staging smoke test with a scoped inference token. Set `PANDA_BASE_URL` to the staging API, inspect `pi --list-models panda`, exercise a file-read turn and confirm the settled usage in Panda. Review the local commit and commit any changes to the release catalog or metadata.
2. Create the approved public repository from the reviewed checkout with `gh repo create panda-repair/pi-provider --public --source=. --remote=origin`, then `git push -u origin main`.
3. The project coordinator reports that the `panda-repair` npm organization exists and Nacho owns it. These local tests used isolated npm configuration. At release, use the organization's authorized publishing account and two-factor authentication.
4. Rerun the checks above and inspect the final pack manifest, including the approved license. From the reviewed release commit run `npm publish --access public`. In a clean Pi installation run `pi install npm:@panda-repair/pi-provider`, sign in with `/login panda` and repeat a model-list and tool-call smoke test.
