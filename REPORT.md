STATUS: complete

# Panda for Pi 1.5.2

The release candidate passed 31 unit tests, 87 checkout scenarios and 65 independent scenarios against the offline-installed package. Refused summaries preserved the active conversation. A 75,015-token Panel conversation incurred one US$0.13 fixture charge, and a failed Panel receipt at the full 4 MiB public limit retained its US$0.03 settlement. All network and billing results use loopback fixtures and synthetic credentials. [User guide](README.md) · [Portable measurements](evidence/pi-1.5.2.json)

## Third review

| Finding | Verified behavior on the installed package |
| --- | --- |
| Refused compaction and branch summary | A zero-content `content_filter` ends with a local refusal error. Manual compaction and branch summarization each made one request, retained all six earlier user messages and preserved the leaf. Neither created a checkpoint. Foreground and standalone callers receive the same refusal. [Outcome handling](src/request.js) |
| Panel context and spending | Pi’s native usage fields describe one conversation, including cached input. Both an explicit Panel and an Auto routed to a Panel reported 75,015 tokens. Each made one request while the separate `panda.aggregate_usage` diagnostic retained 310,000 gross prompt tokens. A genuinely large 212,015- or 231,015-token conversation still triggered one summary. The checkout also exercised a 250,015-token conversation. [Usage](src/usage.js) |
| Large failed Panel receipt | At 1,500, 24,714 and 4,194,304 bytes, Pi retained the validated failure code, identifiers and three-cent settlement. The public Zero handler retained all three across two hops and returned a content-free 503 at 4,194,305 bytes. HTTP and SSE tests covered untrusted member text, malformed bytes, split reads and missing or inaccurate lengths. Error reads respect the call deadline and cancellation, with a ten-minute bound for an otherwise unlimited inference call. [HTTP reader](src/errors.js) · [SSE reader](src/stream.js) |
| Active picker credential | A bound session used its own runtime’s validated models configuration for the standard directory, an alternate SDK `agentDir` and a separate `modelsPath`. A matching cache reopened without a discovery request, rotation hid the old grants, and stale dispatch sent no Chat POST. The stock CLI list also accepted Pi’s JSON comments and BOM. Credential commands stayed out of the picker path. [Registration](index.js) · `6dcda1e` |
| Retry settings and cancellation | Explicit provider retry budgets of zero, one and two allowed at most one, two and three physical attempts. Only the two documented pre-admission throttles qualified. They reused the same key and request bytes. Cancelling in backoff reported the known refusal and zero charge. Losing the response to an actual subsequent POST reported the unknown outcome. [Transport](src/request.js) |
| Receipt history | After 1,025 different receipts, the bound session counted a new three-cent receipt once and suppressed recognized replays. A successful split compaction preserved two run IDs and a branch checkpoint preserved one. Each remained distinguishable after eviction and reopen. Failed checkpoints produced no receipt marker. [Accounting](src/usage.js) · [Native checkpoint exercises](test/fixtures/native.mjs) |
| Support identifier | A valid `X-Panda-Request-ID` reached the response callback and final assistant diagnostic after a stream cut before settlement. Other incoming headers and private error or member fields stayed out of retained events. [Stream projection](src/stream.js) |
| Settled finish | A dropped optional usage trailer preserved the completed answer and its three-cent charge. A caller abort at that same finish returned `aborted`. A throwing callback returned a locally worded `error`. Both preserved the known three-cent settlement and stopped after one request. [Final assistant message](src/request.js) |

The conversation, transport and accounting corrections are in `0c6badf`. All five selectors also completed a real Pi file-tool round trip. The checks retained the previous protections for router eligibility, explicit model selectors, endpoint binding, body pass-through, virtual routing after a failure, automatic and manual compaction, transformed prompts and independent standalone calls. The current windows and output caps agree with the guide at `71e0f63`. The server limit comes from Zero slice C at `31d6d025`, in `workers/shared/chat-completions.ts` and `workers/shared/proxy.ts`. [Catalog](src/catalog.js) · [Pi setup and selector guidance](https://panda.repair/products/llm-api/coding-agents/setup#agents-models)

## Release verification

| Archive or check | Result |
| --- | --- |
| Reviewed base `29f7c21` | 11 files, 16,744 bytes packed and 48,610 bytes unpacked. SHA-256 `fc9875966ef70816dee79c5ee01698f76b783d6e0ba77712efd1966acf0e0794`. Its README relocated guide links after the older round-two archive `20535ce1…`. |
| Final runtime `0c6badf` | 11 files, 19,369 bytes packed and 57,533 bytes unpacked. SHA-256 `28399e09186263a0a3f3de03908d5734712ce8f8ce3952783a2eac2e1781271b`. npm’s dry run and actual pack agreed. All files matched the checkout and the local installation of the tarball byte for byte. |
| Checkout | 31 unit tests. The 87 isolation scenarios made 95 catalog GETs and 103 Chat POSTs. JavaScript syntax, Python parsing and Git whitespace checks passed. |
| Independently installed archive | 65 native scenarios and 518 assertions, with 99 catalog GETs, 4,188 Chat POSTs and 4,161 simulated admissions. Four long receipt-history scenarios account for most calls. The independent result’s SHA-256 is `efc9ecd14d89bcdb8a4bbddacc5851f7ad8d37897312977a2f2bec461bde7e69`. |

Pi and pi-ai were 1.5.2, OpenAI SDK was 7.19.0, Node was 24.21.0 and npm was 11.19.0. The bundled runner installs the local package in a fresh Pi home. On macOS it restricts client networking to loopback. [Release manifest](package.json) · [Archive members, hashes and scenario counts](evidence/pi-1.5.2.json)

~~~sh
npm test
npm pack --offline --dry-run --json
npm pack --offline --json --ignore-scripts --pack-destination /path/to/local-output
python3 -I -B test/e2e.py --pi /path/to/pi --output /path/to/new-evidence
~~~

## Host and service boundaries

- Pi adds persisted messages and successful checkpoint usage to its native spending total. Failed manual or branch summaries can carry a charged receipt back to the caller without adding a saved spending entry. A standalone call can likewise return a charge outside a session. Panda’s settlement is authoritative.
- **Existing paid checkpoints.** A successful `29f7c21` checkpoint saved US$0.03 and omitted its run ID. Reopening that session and receiving the same run as a replay added US$0.03 again to Pi’s displayed total. The fixture admitted no second run for that replay. This release records stable run IDs after each successful checkpoint. A process interruption between the checkpoint and its companion receipt entry can leave the same historical ambiguity.
- The adapter retains 1,024 recent receipt identities and checks bound session history for older, identifiable replays. An unbound caller with an evicted or missing identity can still read the settlement. The adapter omits that receipt from the local spending increment when it cannot establish whether it was counted.
- Pi exposes the validated models configuration through runtime internals in 1.5.2. The adapter checks the supported version and available methods. A pre-session SDK service has no extension context. It can explicitly bind its model runtime when it needs to list custom-key grants before a session starts. The stock CLI’s list command uses the same parser as Pi for its known settings file. [Sign-in and discovery](README.md)
- Pi classifies assistant error text for automatic retries and overflow. This package keeps machine details in assistant diagnostics. A failed preventive summary can stop after its own request while Pi continues the separate foreground prompt already submitted by the user. The local tests establish no production admission, latency or billing result.

## First public release

1. Confirm that the production endpoint has slice C enabled, and that the linked guide and prices are current. With authorization for that endpoint and a scoped inference token, exercise discovery, a file tool and a settled charge. The fixture does not establish production admission, latency or billing.
2. Review the local commits. Once repository creation and push are authorized, create the public `panda-repair/pi-provider` repository and push the reviewed branch.
3. The coordinator reports that the panda-repair npm organization exists and Nacho owns it. These checks used isolated, offline npm configuration. At release, use the organization’s authorized publishing account.
4. Inspect the release pack, then run `npm publish --access public` with publication approval. Verify a clean registry installation, interactive sign-in and a file-tool turn. [Installation](README.md) · [MIT license](LICENSE)
