STATUS: complete

# Panda for Pi 1.5.2

Saved session spending now determines whether Pi has counted a Panda charge. The release passed 32 unit tests and 97 checkout scenarios. The offline-installed archive passed 41 focused native scenarios and the established 69-case retry suite. All requests used loopback fixtures, synthetic credentials and simulated settlements. [User guide](README.md) · [Portable results and archive hashes](evidence/pi-1.5.2.json)

## Fourth review

| Finding | Observed result |
| --- | --- |
| Custom checkpoints | A custom compaction or branch summary saved one three-cent Panda call and discarded another. After reopening the session, replay of the saved call added zero. The discarded call’s first saved receipt added three cents and its next replay added zero. Copying the returned usage, using another signal and using a different provider for the checkpoint all preserved the correct attribution. [Saved usage tests](test/fixtures/saved-usage.mjs) |
| Standalone calls | A standalone three-cent result left session spending at zero. The first foreground receipt recorded three cents, including when the same runtime or a separate session handled it. Saved assistant messages, tool results and explicit usage entries identified a paid run after restart. A zero-cost entry or detached marker could not claim an unpaid contribution. [Accounting](src/usage.js) |
| Caller-owned model runtime | A caller-supplied runtime listed its permitted `auto:cost` before, during and after normal session disposal. Rotating the credential hid that grant. This sequence made one discovery GET and zero Chat POSTs. [SDK picker test](test/fixtures/sdk-picker.mjs) |
| Missing Panel usage trailer | Reported aggregate usage was 3,024 tokens, or zero with a genuine zero trailer. Missing and null trailers and a socket close after the settled finish omitted the aggregate diagnostic. Each case retained the completed answer, 1,210 native conversation tokens and the full US$0.03 settlement. [Usage tests](test/usage.test.js) |
| Historical checker | Its four revised expectations cover terminal foreground refusal and the three unbound custom-credential picker cases. It exited 0 with 549 assertions. Across all 69 cases, seven per-case wire fields matched the original historical results and a fresh run on the reviewed baseline. Checker SHA-256 `a49788965fd359d58656aaf10dcfaaed39218db5e993d123aff96e00c84c7684`. [Measurements](evidence/pi-1.5.2.json) |

Runtime and checkout tests are in `851f7a1`. All five selectors completed a file-tool round trip. Refused summaries still preserved the six prior user messages. Both direct and routed Panels reported 75,015 native tokens from a 310,000-token aggregate prompt and retained the US$0.13 fixture charge. The suite also checked an actual oversized conversation and sanitized a failed Panel receipt at the inclusive 4 MiB public limit. The catalog follows the coding-agent guide at `71e0f63`. The public response bound comes from Zero slice C at `31d6d025`. [Catalog](src/catalog.js) · [Coding-agent guide](https://panda.repair/products/llm-api/coding-agents/setup#agents-models)

## Release verification

| Archive or check | Result |
| --- | --- |
| Reviewed baseline `7a6fb13` | 11 files, 19,369 bytes packed and 57,533 bytes unpacked. SHA-256 `28399e09186263a0a3f3de03908d5734712ce8f8ce3952783a2eac2e1781271b`. The preceding reviewed base `29f7c21` produced `fc9875966ef70816dee79c5ee01698f76b783d6e0ba77712efd1966acf0e0794`. |
| Final runtime `851f7a1` | 11 files, 19,875 bytes packed and 59,225 bytes unpacked. SHA-256 `d258276bebb3d42f4dbc8161c290325b47fd90dd882125d75540487ada2834f0`. Dry and actual packs agreed. Every member matched the checkout and offline npm installation byte for byte. |
| Checkout | 32 unit tests and 97 isolated Pi scenarios, with 113 catalog GETs and 130 Chat POSTs. JavaScript syntax, Python parsing and Git whitespace checks passed. |
| Focused installed archive | 41 native scenarios and 620 assertions, including cross-archive checks. The fixture recorded 130 catalog GETs, 2,186 Panda Chat POSTs and 2,101 simulated admissions. Two separate loopback calls used the foreign provider. Two checkpoint cases each generated 1,025 independent admissions to exercise a long saved history. |
| Established retry suite | 69 native scenarios and 549 assertions, with 92 catalog GETs, 84 Chat POSTs and 55 simulated admissions. The comparison covered request counts, admissions, key equality, response actions, discovery GETs, selected physical models and off-origin attempts. |

The test host used Pi and pi-ai 1.5.2, OpenAI SDK 7.19.0, Node 24.21.0 and npm 11.19.0. The checkout runner installs the local package in a fresh Pi home and restricts client networking to loopback on macOS. [Archive manifest](package.json) · [Release and historical measurements](evidence/pi-1.5.2.json)

~~~sh
npm test
npm pack --offline --dry-run --json
npm pack --offline --json --ignore-scripts --pack-destination /path/to/local-output
python3 -I -B test/e2e.py --pi /path/to/pi --output /path/to/new-evidence
~~~

## Accounting boundaries

- An extension can preserve the stable IDs by copying Panda’s returned `usage.cost`. A negative outcome can report a valid charge. Standalone or failed summary results affect Pi’s spending only when a consumer saves the usage. Entries in other sessions have independent spending histories.
- Pi discards extra usage fields when it combines the two legs of its own split compaction. After Pi saves that checkpoint, the extension records the IDs of its positively identified, charged Panda legs. A same-signal incidental call stays outside this record. An interrupted process between those two writes can leave an entry without provenance.
- A custom extension that saves numeric totals alone also loses the run ID. An older `29f7c21` checkpoint saved US$0.03 without an ID. In the migration test a later receipt raised the local total by another US$0.03 without a second fixture admission. A later response for an identifiable saved run contributes zero.
- Pi’s `appendUsage` writes the values supplied by its caller. Writing the same previously returned three-cent snapshot twice directly, or writing two snapshots obtained before either was saved, produced US$0.06 in Pi’s local total. Neither write invokes the provider. SDK consumers control which snapshots they append.
- Pi 1.5.2 exposes the active validated model configuration through runtime internals. The extension checks this interface before using it. An SDK service can bind its own runtime for pre-session lookups. [Sign-in and discovery](README.md)

## First public release

1. Confirm that the production endpoint has slice C enabled, and that the linked guide and prices are current. With authorization for that endpoint and a scoped inference token, exercise discovery, a file tool and a settled charge. The fixture does not establish production admission, latency or billing.
2. Review the local commits. Once repository creation and push are authorized, create the public `panda-repair/pi-provider` repository and push the reviewed branch.
3. The coordinator reports that the panda-repair npm organization exists and Nacho owns it. These checks used isolated, offline npm configuration. At release, use the organization’s authorized publishing account.
4. Inspect the release pack, then run `npm publish --access public` with publication approval. Verify a clean registry installation, interactive sign-in and a file-tool turn. [Installation](README.md) · [MIT license](LICENSE)
