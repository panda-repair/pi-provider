STATUS: complete

# Panda provider for Pi 1.5.2

`@panda-repair/pi-provider@0.1.0` is ready for release review. All seven supported selectors completed a real Pi file-read round trip against the loopback mock. The package is local and unpublished. Production acceptance and billing remain untested. [Setup and model selection](README.md) · [Recorded results](evidence/pi-1.5.2.json)

## What ships

The Pi extension registers `panda` with its native OpenAI Chat Completions adapter, a masked personal-token login and `PANDA_API_TOKEN` support. Authenticated discovery intersects the server's list with seven text-only, tool-capable definitions. The dispatch check also protects explicit selectors that Pi invents when a model is missing. Model grants are in memory, scoped to the current credential and endpoint. The server remains authoritative if permissions change between refreshes. [Registration](index.js) · [Provider and discovery](src/provider.js)

The catalog retains developer messages and streaming usage. It disables storage, reasoning effort, prompt cache keys and long cache retention. A Panda-scoped request hook removes unsupported parameters, preserves supported tool requests, and emits at most one output limit within the selected model's cap. The provider also checks the final payload after other extensions have run. [Catalog](src/catalog.js) · [Request handling](src/request.js)

Pi 1.5.2 disables the OpenAI SDK's own retries. Pi can retry the HTTP call itself, and its agent can separately reopen a failed stream. The extension assigns a UUID per logical request and reuses it through both retry paths. It preserves the previous key when another extension changes a replay's bytes, allowing Panda to reject the change with HTTP 409. An ambiguous replay after multiple matching concurrent failures stops locally. A completed tool turn or a new user run gets a fresh key. Pi's outer agent retry can still issue a keyed repeat on some 5xx responses carrying `x-should-retry: false`. Panda's replay receipt can include the original status and charge without returning the lost text. [Retry tests](test/request.test.js)

## Verification

The checks used Pi CLI and Pi AI 1.5.2, OpenAI SDK 7.19.0, Node 24.21.0 and npm 11.19.0. Pi used isolated home, configuration and cache directories. macOS restricted its network to loopback. All credentials, model decisions and server responses were synthetic.

| Check | Observed result |
| --- | --- |
| Unit and syntax | `npm test` passed 11/11. `node --check` passed for the entry point, three source modules and both JavaScript test files. |
| Seven selectors | Each made one authenticated model-list GET and two chat POSTs. Pi's default tools included `read`, `bash`, `edit` and `write`. A random marker first appeared in the local file, then in the tool result and terminal output. The original contract checker reported zero violations. |
| Independent run | The original checker accepted 52 Panda requests across 21 scenarios, including 25 GETs and 27 POSTs. On a 503 and a dropped connection, the retry repeated the exact bytes and key, then the tool result used a new key. Two sessions sent identical first bodies with different keys. Changing the temperature after a disconnect reused the key and the mock returned 409. |
| Discovery and isolation | Native credential rotation changed the available list from seven to two to zero after HTTP 401. Two explicitly selected unavailable IDs produced zero chat POSTs. A different provider using the same wire model retained its `store` field and received no Panda key. |
| Package | `npm pack --dry-run --json` listed six files, 20,117 bytes unpacked. A real local pack matched source bytes. A fresh installation of its contents completed `panda/panel:panda-quality` with zero checker violations. Archive SHA-256 was `32aea86190d032d5853dfd09e1cb527fef5f92c0d6ae1380077579cbd132c025`. |

The portable evidence records per-model counts, retry identities, access decisions and source hashes. The checkout includes a loopback server and contract checker drawn from the original capture experiment. The seven-selector run passed both with those fixtures and with the original scripts supplied separately. [Evidence](evidence/pi-1.5.2.json) · [Integration runner](test/e2e.py) · [Test fixtures](test/fixtures)

From the repository root, run the following with a Pi 1.5.2 executable and a new output directory. The integration command requires macOS, Python 3 and Node on `PATH`. Pass `--capture-tools /path/to/codex-capture` to run the archived originals instead.

```sh
npm test
npm pack --dry-run --json
python3 -I -B test/e2e.py --pi /path/to/pi --output /path/to/new-evidence
```

## Release decisions

- Confirm the license and copyright holder before publication. The manifest contains the requested provisional `MIT` value. Add the approved license text and align the manifest with it.
- Confirm the per-model limits when Panda's API change ships. All seven currently use provisional 32,768-token context and 16,384-token output budgets. The Chat contract's separate byte limits also apply. Update the catalog in one place. [Model definitions](src/catalog.js)
- Confirm the price ceilings against the released catalog. The named-model input, output, cache-read and cache-write rates come from Zero `cb676cac`, `advisor_pricing.py` and the commercial catalog. Customer-facing examples agree on the two ordinary rates in the web app snapshot `10b870a6`. The five routed selectors use Pi's numeric zero placeholders. Panda's actual settlements can differ from Pi's estimate. [Panda pricing](https://panda.repair/pricing#pricing-llm-api)

## First public release

1. After the API rollout, run an authorized staging smoke test with a scoped inference token. Set `PANDA_BASE_URL` to the staging API, inspect `pi --list-models panda`, exercise a file-read turn and confirm the settled usage in Panda. Review the local commit and commit the final license, catalog and release metadata.
2. Create the approved public repository from the reviewed checkout with `gh repo create panda-repair/pi-provider --public --source=. --remote=origin`, then `git push -u origin main`.
3. Create or confirm the `panda-repair` organization on npm and grant the release maintainer publish access to its scope. Authenticate with the organization's approved release account and two-factor authentication. Confirm its identity with `npm whoami`.
4. Rerun the checks above and inspect the final pack manifest, including the approved license. From the reviewed release commit run `npm publish --access public`. In a clean Pi installation run `pi install npm:@panda-repair/pi-provider`, sign in with `/login panda` and repeat a model-list and tool-call smoke test.
