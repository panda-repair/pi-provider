STATUS: complete

# Panda provider for Pi 1.5.2

`@panda-repair/pi-provider@0.1.0` is ready for release review under the approved MIT license. The Pi 1.5.2 registry returned the requested context window and output cap for every selector, and all seven completed a file-read turn. The root tool-schema dialects matched the pinned Zero implementation. The package is local and unpublished. Production admission and billing remain untested. [Setup](README.md) · [License](LICENSE) · [Recorded results](evidence/pi-1.5.2.json)

## What ships

The Pi extension registers `panda` with its native OpenAI Chat Completions adapter, a masked personal-token login and `PANDA_API_TOKEN` support. Authenticated discovery intersects the server's list with seven text-only, tool-capable definitions. The dispatch check also protects explicit selectors that Pi invents when a model is missing. Model grants are in memory, scoped to the current credential and endpoint. The server remains authoritative if permissions change between refreshes. [Registration](index.js) · [Provider and discovery](src/provider.js)

The catalog retains developer messages and streaming usage. It disables storage, reasoning effort, prompt cache keys and long cache retention. A Panda-scoped request hook removes unsupported parameters, preserves supported tool requests, and emits at most one output limit within the selected model's cap. The provider also checks the final payload after other extensions have run. [Catalog](src/catalog.js) · [Request handling](src/request.js)

### Context windows

The catalog uses conservative Pi token estimates for Zero ADR 0079 D5/D7 at `92fe1a7c2e1923f902d5d30d1407cf13ba0bd38c`. GLM-5.3, DeepSeek V4.1 Flash and `auto:cost` use 262,144. Both built-in Panels and `auto` use 225,280. `auto:quality` uses 187,392. All seven keep 16,384 maximum output tokens. These are client planning values derived from the rendered-byte, synthesis and hold limits. Pi's automatic compaction uses the selected window and the user's reserve. Actual admission depends on the selected route and request. [Windows and default compaction](README.md)

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
| Installed catalog and compaction | The native registry returned the exact limits for all seven selectors. The CLI rounded the windows to `262.1K`, `225.3K` and `187.4K` and the output cap to `16.4K`. With Pi's default reserve, compaction begins above 245,760, 208,896 or 171,008 tokens for the three window sizes, respectively. |
| Root-dialect comparison | All 28 cases agreed with Zero `92fe1a7c`. The packaged provider sent 12 supported root URI forms and an unmarked schema together in one normalized Chat POST. Draft-04, draft-06 and a nested marker reached no Chat POST. The independent run also passed 73 tests from the pinned Zero checkout. |
| Prior run still in progress | In both the agent-retry and transport-retry cases, two POSTs used the same key for one admitted fixture run. After the dropped response, the second POST returned `409 mixture_already_running`. Pi exited with the original request ID. The run was still pending with null charge and held amounts and no second admission. |
| Independent running-replay checks on `02cdeef` | Nine scenarios passed. When the real agent was made to re-enter after the 409, `d4e5292` sent a third POST with a fresh key and admitted a second run. The fixed package returned the cached receipt twice locally. Its one admitted run was still pending. |
| Definite 503 and lost reply | With `model_unavailable`, three POSTs used three keys for the refusal, successful retry and tool follow-up. The fixture recorded two answered runs. With a committed run and dropped connection, two POSTs shared one key for one charged fixture run. The second returned completed or partial 409, then Pi stopped. |
| Independent wire and failure checks on `d4e5292` | All 40 Pi scenarios passed. The original checker accepted 124 requests, 40 GETs and 84 POSTs. Checks included both native retry paths, client timeout versus HTTP 408, cut 200 streams, oversized or delayed error bodies, unmarked 409s, marked unreadable replays, and local tool-reference errors. |
| Reference comparison on `d4e5292` | All 104 effective admission decisions agreed with Zero slice B. Normalization matched directly on 101. Three schemas were rejected earlier by the extension and also refused by Zero before dispatch. Inputs were preserved and both inline/reference pairs matched. |
| Package | `npm pack --dry-run --json` and an actual pack listed seven files including the MIT license, 11,052 bytes compressed and 29,694 bytes unpacked. Five scenarios from a fresh archive installation made eight requests with zero checker violations. Archive SHA-256 `c5c1477b35639721c3df3c61524ebde46beb460397da85894db26f344ea7f788`. |

The portable evidence records error codes, admissions, simulated charges, grouped request keys, schema comparison counts and file hashes. The single-account fixture supports unkeyed calls, running and settled replays, and changed-request conflicts. It excludes `seed` and `user` from its request comparison and retains raw captures locally. [Evidence](evidence/pi-1.5.2.json) · [Integration runner](test/e2e.py) · [Test fixtures](test/fixtures)

From the repository root, run the following with a Pi 1.5.2 executable and a new output directory. The integration command requires macOS, Python 3 and Node on `PATH`. The optional `--capture-tools /path/to/codex-capture` runs the seven ordinary turns with the archived originals. The bundled fixture exercises the additional retry and custom-tool scenarios.

```sh
npm test
npm pack --dry-run --json
python3 -I -B test/e2e.py --pi /path/to/pi --output /path/to/new-evidence
```

## Release decisions

- Recheck the per-selector context estimates and production admission behavior at publication. The target branch, native Pi catalog and local wire checks are the evidence for this revision. [Model definitions](src/catalog.js)
- Confirm the price ceilings against the released catalog. The named-model input, output, cache-read and cache-write rates come from Zero `cb676cac`, `advisor_pricing.py` and the commercial catalog. Customer-facing examples agree on the two ordinary rates in the web app snapshot `10b870a6`. The five routed selectors use Pi's numeric zero placeholders. Panda's actual settlements can differ from Pi's estimate. [Panda pricing](https://panda.repair/pricing#pricing-llm-api)

## First public release

1. After the API rollout, run an authorized staging smoke test with a scoped inference token. Set `PANDA_BASE_URL` to the staging API, inspect `pi --list-models panda`, exercise a file-read turn and confirm the settled usage in Panda. Review the local commit and commit any changes to the release catalog or metadata.
2. Create the approved public repository from the reviewed checkout with `gh repo create panda-repair/pi-provider --public --source=. --remote=origin`, then `git push -u origin main`.
3. The project coordinator reports that the `panda-repair` npm organization exists and Nacho owns it. These local tests used isolated npm configuration. At release, use the organization's authorized publishing account and two-factor authentication.
4. Rerun the checks above and inspect the final pack manifest, including the approved license. From the reviewed release commit run `npm publish --access public`. In a clean Pi installation run `pi install npm:@panda-repair/pi-provider`, sign in with `/login panda` and repeat a model-list and tool-call smoke test.
