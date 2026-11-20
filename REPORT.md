STATUS: complete

# Panda provider for Pi 1.5.2

`@panda-repair/pi-provider@0.1.0` targets the Panda Chat Completions contract with **ADR 0079 slice C enabled**. The package preserves Pi's request, scopes model grants to the selected endpoint and credential, and prevents an automatic second billable run after an uncertain response. All seven selectors completed a local file-read turn. [Setup and limits](README.md) · [Portable results](evidence/pi-1.5.2.json)

## Review findings

The comparison starts at `225cbd1`. Source contracts are Zero `153bfde8` and Panda's coding-agent guide `26b1214`. The installed host was Pi 1.5.2. [Runtime](src) · [Unit and integration checks](test)

| Finding | Change and observed check | Commit |
| --- | --- | --- |
| H1 · Summary retries | Native compaction and branch summaries kept their original key after a disconnect or an interrupted HTTP 200. A new summary used a fresh key even with identical content. Concurrent operations stayed independent. | `a919f15` |
| H2 · Failure settlement | A paid Panel failure and a failure with unknown charges each sent one POST. A validated zero settlement allowed a fresh attempt when Pi elected to retry. The same policy covered a named model with an unknown settlement. | `a919f15` |
| H3 · Discovery destination | Pi's resolved endpoint, credential and network permission govern discovery. Cold and warm lists and an offline cold prompt recorded zero discovery requests. A cold explicit prompt used the selected staging endpoint. Redirects and incompatible per-model overrides sent zero requests to the alternative target. | `354546a`, `a919f15` |
| H4 · Error privacy | Chat, discovery, transport and malformed-stream failures use local wording and bounded data. Pi recognized the context-overflow diagnostic. Synthetic private markers appeared in zero reported errors. | `a919f15` |
| H5 · Tool schemas | Dialects, references, null targets and keyword pairs reached the endpoint intact. The pinned server accepted the valid reference and returned a 400 with a parameter for rejected schemas. | `2116bdb`, `a919f15` |
| H6 · Retired tools | A real Pi session disabled a used tool. The next turn retained its historical tool call and result, with the tool still disabled. Slice C accepted that history and explicit empty tool arrays. | `2116bdb`, `a919f15` |
| H7 · Output requirements | Replacement payloads retained JSON output, `n: 2`, log probabilities, zero and unequal bounds. Each unsupported requirement received its server refusal. Neutral flags and an oversized valid bound were forwarded intact. | `2116bdb`, `a919f15` |
| M1 · Changed request | A changed body after a lost response reused the original key. A 409 conflict terminated both retry layers with the original settlement unknown. | `a919f15` |
| M2 · Rollout | The README and release steps require slice C. Model discovery carries no feature version. The integration fixture exercises C admission. | `2116bdb`, `a919f15` |
| M3 · Routing | Every router requires its own ID and an eligible coding route. A Gemma-only credential hid all routers. A Panda-Panel-only grant could offer balanced and quality routing. Cost also required GLM or DeepSeek. The quality window is 187,000, accounting for tool-free Argon routing. | `354546a`, `a919f15` |
| M4 · Credential scope | Native saved and scoped-environment credentials worked. Rotation, logout and a changed URL invalidated availability. Explicit dispatch rechecked model, credential and endpoint. | `354546a`, `a919f15` |
| M5 · Copy budget | A referenced tool list exceeding 64 KiB reached Panda. Slice C applies the 4,096-copy and 1 MiB reference-work bounds separately from the final 262,144-byte tool list. | `2116bdb`, `a919f15` |
| M6 · Panel usage | Direct and routed Panels retained 310,045 aggregate tokens for accounting. With a 75,000-token member prompt and 15 output tokens, Pi used 75,015 for compaction. A synthesis-only receipt used 160,015. | `a919f15` |
| M7 · Replay wording | Running receipts reported pending, potentially zero charges. Completed and partial receipts showed the validated amount, including US$0.00. | `a919f15` |
| M8 · Panel timeout | Pi's default and configured deadlines produced 300- and 600-second SDK timeout headers. Short idle and provider timeouts failed as configured, and explicit cancellation ended the request. | `a919f15` |

## Release verification

The checkout passed 24 unit tests and 53 native Pi scenarios, including seven file-tool turns, 19 fault cases, seven dialect cases and 20 native host cases. The fixture recorded 55 catalog GETs and 91 Chat POSTs. It checked the expected bearer, a single valid idempotency header and streamed usage. It simulates admission and settlement with synthetic receipts. An independent suite installed the actual tarball offline and passed 71 scenarios with 114 GETs and 77 POSTs. Seventeen captured request bodies were checked with the pinned Zero admission code. The five-minute and ten-minute configurations were exercised with short delayed responses. [Checkout runner](test/e2e.py) · [Recorded results](evidence/pi-1.5.2.json)

The dry run and actual npm pack contained nine files, including the approved MIT license. The archive is 14,076 bytes, with 40,434 bytes unpacked. Its SHA-256 is `93a23b05f081d93fa47fde70f35f7846236e484b27eddae6cacc7299abfe3f05`. The independently installed files matched the checkout byte-for-byte. Results from `225cbd1` and earlier describe a superseded adapter and fixture. [Package manifest](package.json) · [License](LICENSE)

To reproduce from the repository root, use Node on PATH and a new output directory on macOS. The integration runner isolates Pi's home and permits only loopback client networking.

```sh
npm test
npm pack --offline --dry-run --json
python3 -I -B test/e2e.py --pi /path/to/pi --output /path/to/new-evidence
```

## Operating limits

- The public guide gives Pi input estimates of 258,000 for both named models and `auto:cost`, 224,000 for `auto` and both Panels, and 187,000 for `auto:quality`. A 16,384-token default compaction reserve gives thresholds of 241,616, 207,616 and 170,616. Each output ceiling is 16,384. Panda separately enforces bytes, holds and the selected route's output limit. [Coding-agent guide](https://panda.repair/products/llm-api/coding-agents) · [API model limits](https://panda.repair/products/llm-api#llm-api-model-limits)
- Pi's raw catalog includes technical definitions for explicit selection. Its picker and dispatch use the authenticated grant. Pi can leave a fresh cache-only list empty when a token is supplied exclusively through a custom `models.json` variable. An explicit Panda prompt resolves the effective credential. [Catalog and auth](src/provider.js)
- Pi 1.5.2 disables OpenAI SDK retries and has its own transport and agent retry layers. A fresh key requires a definite pre-admission refusal or a validated zero settlement. A transport loss with a trustworthy operation identity keeps the original key. An ambiguous operation stops locally. Replays can communicate status and charge while the earlier answer remains unavailable. [Request handling](src/request.js) · [Error and settlement handling](src/errors.js)
- The named-model rates are customer ceilings. Routed selectors have variable prices. A reported Panda settlement supplies actual USD cost when present. Billing counts each chargeable call and applies the one-cent minimum once per run. [Pricing](https://panda.repair/pricing#pricing-llm-api)

## First public release

1. Confirm slice C is enabled for the intended endpoint and the linked guide and prices are current. With authorization for that endpoint and a scoped inference token, test discovery, a file tool and the settled charge. Production admission, latency and billing are outside this local verification.
2. Review the source and release commit. After repository creation and push are authorized, create the public `panda-repair/pi-provider` repository and push the reviewed branch.
3. The coordinator reports that the `panda-repair` npm organization exists and Nacho owns it. The local checks used isolated npm configuration. At release, use the organization's authorized publishing account.
4. Inspect the release pack, then run `npm publish --access public` with publication approval. Verify a clean `pi install npm:@panda-repair/pi-provider`, `/login panda` and a file-tool turn.
