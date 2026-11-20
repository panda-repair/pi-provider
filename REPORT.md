STATUS: complete

# Panda for Pi 1.5.2

Round two replaces the retry policy in revision `93fd94f`. A dropped response, a paid failure, a malformed stream and a funding veto all stop the Panda call. A new user request starts with a new key. Only the two recognized pre-admission throttles may repeat, inside the same stream with the same key and body. The archive passed 25 unit tests, 75 checkout scenarios and 69 independent installed-package scenarios. All charges in these checks were simulated. [User guide](README.md) · [Portable evidence](evidence/pi-1.5.2.json)

## Second review

| Finding | Current behavior and observed result | Change |
| --- | --- | --- |
| 1. Lost response followed by 429 | A dropped request, including the race where a later request could observe an unresolved admission, stopped after one POST. For a recognized concurrency or workspace throttle, at most three attempts reused one UUID and the identical serialized body. Backoff honored the server delay, abort, deadline and cumulative 60-second budget. A veto stopped the first attempt. | [Transport](src/request.js) · `f2d54d4` |
| 2. Virtual model switches after a charge | A virtual route configured to switch Panels on retry stayed on its original selection. One failed POST reported US$0.03 to the session. A funding-source 429, transport loss and incomplete 200 also stopped without a virtual retry. | [Terminal errors](src/errors.js) · `f2d54d4` |
| 3. Transformed foreground history | A real context extension cloned and edited the foreground message. A lost response produced one POST. Standalone calls through Pi’s extension registry and concurrent calls with the same content each received their own key. | [Native fixtures](test/fixtures) · `f2d54d4` |
| 4. Retained error text | Previously published partial messages remained free of the synthetic diagnostic after malformed SSE and structured error frames. At the native SDK boundary the HTTP error contained only local wording, allowlisted code and parameter, verified identifiers and validated settlement. | [SSE handling](src/stream.js) · [Event handling](index.js) · `f2d54d4` |
| Settled output | A settled finish frame followed by a lost usage trailer retained its answer and US$0.03. A complete content-filter refusal returned normally at zero charge. A settled, truncated foreground answer stayed visible with a truncation notice. Native compaction and branch summaries rejected truncated checkpoints. | [Outcome handling](src/request.js) · `f2d54d4` |
| Session totals | A paid foreground failure increased Pi spending by US$0.03. A repeated receipt in the same process and a receipt after reopening the saved session each left the total at US$0.03. An unrecognized amount was never presented as zero settlement. | [Usage](src/usage.js) · `f2d54d4` |
| Credential visibility | The picker hid prior grants on rotation, restored the matching custom-variable cache on a fresh process, and respected the saved token. Literal credentials and non-command variable templates were exercised. A revoked explicit prompt showed the sanitized HTTP 401 and made zero Chat POSTs. | [Provider](src/provider.js) · `63358d0` |
| Retry delays and summaries | A failed foreground call produced no paid post-failure threshold summary. A failed preventive summary stopped after one request. Pi could still issue the separate foreground request the user had already submitted. Manual compaction and branch failures each sent one POST. | [Session hooks](index.js) · `f2d54d4` |

## Earlier coverage

Pi exposes three Auto selectors and two Panels. Each selector completed a real file read and returned its marker. The retired backends remain private routing grants. The checkout also exercises cold and warm cache behavior, offline listing, destination and credential checks, selector substitution, ADR 0079 slice C tool declarations, retired-tool history, explicit request fields, aggregate Panel accounting and caller-supplied timeouts. The original H1–H7 and M1–M8 findings covered these areas. Revision `93fd94f` records the earlier per-finding commits and verification. Its retry counts and archive digest are historical. [Catalog](src/catalog.js) · [Checkout runner](test/e2e.py)

The guide’s planning windows are 258,000 for cost routing, 224,000 for balanced routing and both Panels, and 187,000 for quality routing. Every output ceiling is 16,384. A multi-member Panel using tools allows 1,022 caller messages. Earlier local contract comparisons used Zero slice C. The second review pinned Zero `31d6d025` and the guide `3b03e3c`. [Coding-agent guide](https://panda.repair/products/llm-api/coding-agents) · [API model limits](https://panda.repair/products/llm-api#llm-api-model-limits)

## Release verification

| Check | Result |
| --- | --- |
| Checkout | 25 unit tests. The 75 bundled real-Pi scenarios recorded 79 catalog GETs and 94 Chat POSTs. |
| Offline archive install | 69 native Pi scenarios and 549 assertions. The independent transport observed 92 catalog GETs, 84 Chat POSTs and 55 fixture admissions. It also compared 17 cases at `93fd94f`. |
| Packaging | npm’s dry run and actual pack agreed. All 11 archive members matched the checkout and the independent offline installation byte for byte. The archive is 16,712 bytes, with 48,576 bytes unpacked. |
| Archive SHA-256 | `20535ce1f3137f82b8316693a290180e38ca48d823ebb21affa9ae59f9d33692` |

The installed host was Pi 1.5.2 with OpenAI SDK 7.19.0, Node 24.21.0 and npm 11.19.0. The checkout runner uses isolated homes and restricts the Pi client to loopback. Use a fresh output directory on macOS. [Release manifest](package.json) · [Verification evidence](evidence/pi-1.5.2.json)

~~~sh
npm test
npm pack --offline --dry-run --json
python3 -I -B test/e2e.py --pi /path/to/pi --output /path/to/new-evidence
~~~

## Host and service boundaries

- Pi records spending from persisted messages and successful checkpoints. A failed manual compaction or branch summary returned a validated US$0.03 provider error after one POST. Pi discarded that failed summary and its native session total remained US$0.00. A standalone extension can also receive a charge without saving a session entry. Panda’s settlement remains authoritative.
- Pi has no structured terminal-retry field on an assistant error in 1.5.2. The package tests diagnostic text against both native classifiers and retains the machine fields in the assistant diagnostics. For settled truncation, native foreground callbacks distinguish a user turn from Pi’s checkpoint requests. A custom SDK caller supplying its own callback combination controls its own use of the result.
- The receipt cache covers 1,024 recent identities. An identifiable replay also consults the bound Pi session’s saved receipts. After eviction or when a replay lacks a verified run ID, a replay’s documented charge stays visible and the adapter conservatively refrains from adding it to spending again.
- The standard Pi picker can resolve literals and declared environment references without network access. It leaves credential commands to an explicit inference. Embedded clients can use their own credential stores and models paths. Dispatch always verifies the credential, endpoint and allowed selector. The guide documents the startup and refresh behavior. [Sign-in and discovery](README.md)
- At revision `93fd94f`, Pi’s startup availability snapshot could occasionally be empty when resuming an older session. The failed resume made zero network requests. On the same saved state, explicitly selecting `panda/auto` with the new prompt recovered six out of six times. That historical check also reproduced the fallback on the two earlier revisions.

## First public release

1. Confirm that the production endpoint has slice C enabled, and that the linked guide and prices are current. With authorization for that endpoint and a scoped inference token, exercise discovery, a file tool and a settled charge. The fixture does not establish production admission, latency or billing.
2. Review the local commits. Once repository creation and push are authorized, create the public `panda-repair/pi-provider` repository and push the reviewed branch.
3. The coordinator reports that the panda-repair npm organization exists and Nacho owns it. These checks used isolated, offline npm configuration. At release, use the organization’s authorized publishing account.
4. Inspect the release pack, then run `npm publish --access public` with publication approval. Verify a clean registry installation, interactive sign-in and a file-tool turn. [Installation](README.md) · [MIT license](LICENSE)
