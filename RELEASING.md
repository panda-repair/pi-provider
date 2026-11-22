# Releasing

Repository admins are the designated releasers. They approve a commit and its npm tarball by recording the SHA-256 in a protected annotated tag. A repository writer can then dispatch the approved release from `main`.

## Before rollout

Complete these steps before merging the new workflow or pushing its first release tag.

1. First, in **Settings → Rules → Rulesets**, activate (or confirm) a branch ruleset targeting `main`. Require pull requests and the passing **CI** checks `unit`, `e2e (1.5.2)` and `e2e (1.6.0)`. Block force pushes and branch deletion. Ordinary writers must use pull requests and have no direct-push or bypass permission. Put only the repository-admin role on the bypass list. Nacho chooses the required approval count. One independent approving review is recommended for non-admin pull requests.
2. In **Actions**, finish or cancel all outstanding runs of the legacy tag-push **Release** workflow, including queued runs and runs waiting for approval.
3. Only then, in **Settings → Environments → npm → Deployment branches and tags**, choose **Selected branches and tags**. Replace the old **Tag** rule for `v*` with exactly one **Branch** rule for `main`. Remove all **Tag** rules. Nacho can also require an environment reviewer for a separate go-live decision.
4. Keep the active `v*` tag ruleset. Reserve tag creation, updates and deletion for the designated releasers. Keep npm's existing trusted publisher for `@panda-repair/pi-provider` configured with owner `panda-repair`, repository `pi-provider`, workflow filename `release.yml`, environment `npm` and direct publishing enabled.

npm trusts the repository, workflow filename and environment. Changes to the release and CI workflows and their scripts in `.github/scripts/` must go through the protected `main` path above. Once these controls are in place, merge the new workflow. Only its publish job can authenticate through GitHub OIDC using npm 11.5.1 or later.

## Review and publish

1. Merge the reviewed stable version in `package.json` to `main`. Wait for the latest **CI** **push** run for that exact commit to succeed. Open its **canonical-package** job summary. It links the raw `canonical-pi-provider-<attempt>.tgz` and gives its artifact ID, commit SHA and SHA-256. Copy those three values from the same attempt. If the artifact expired or a partial rerun lacks one, use **Re-run all jobs**. A commit predating the canonical job must be replaced by a reviewed commit that includes it.
2. As a designated releaser, start in a clean checkout of the reported commit. In Bash, substitute the three values below. The commands verify the downloaded bytes against the summary, then compare every filename and its SHA-256 with a local package. Different compressors can produce different archive bytes for identical contents. The tag approves the **CI archive’s digest**. Any failed check stops the commands before tagging or dispatch.

   ```bash
   (
     set -euo pipefail
     sha='<full commit SHA from the canonical job>'
     digest='<SHA-256 from the same summary>'
     artifact_id='<artifact ID from the same summary>'
     [[ "$sha" =~ ^[0-9a-f]{40}$ && "$digest" =~ ^[0-9a-fA-F]{64}$ && "$artifact_id" =~ ^[1-9][0-9]*$ ]]
     head=$(git rev-parse --verify HEAD)
     changes=$(git status --porcelain)
     [[ "$head" == "$sha" && -z "$changes" ]]
     out=$(mktemp -d "${TMPDIR:-/tmp}/panda-approval.XXXXXXXX")
     gh api "repos/panda-repair/pi-provider/actions/artifacts/$artifact_id/zip" > "$out/ci.tgz"
     printf '%s  %s\n' "$digest" "$out/ci.tgz" | shasum -a 256 --check --strict
     bash .github/scripts/pack-release.sh "$sha" "$out/local.tgz"
     python3 .github/scripts/compare-package.py "$out/ci.tgz" "$out/local.tgz"

     tag="v$(node -p 'require("./package.json").version')"
     git tag -a "$tag" "$sha" -m "Release $tag" -m "tarball-sha256: $digest"
     git push origin "refs/tags/$tag"
     gh workflow run release.yml --repo panda-repair/pi-provider --ref main \
       -f tag="$tag" -f sha="$sha" -f tarball_sha256="$digest"
   )
   ```

The read-only job checks the protected tag, `origin/main` ancestry, package identity, stable version and latest main-push CI artifact. It packs two clean checkouts with lifecycle scripts disabled and requires byte-identical archives matching the tag. The publish job checks the transferred tarball against the dispatch digest and publishes that file with public access. To retry the release, select **Re-run all jobs** so the current tag and CI are checked again.

Use Node **24.21.0** for the comparison build. When changing the toolchain, update the `canonical-package` job in `.github/workflows/ci.yml` and every `setup-node` step in `.github/workflows/release.yml` together. Approve the digest from a successful main push that built with the new pin.

npm generates provenance automatically. Its source revision is the workflow's dispatch SHA on `main`, which can be newer than the tagged commit. Keep the approved SHA and digest together to identify the packaged source.

## New Pi releases

The package enables its picker only on the Pi versions listed in `index.js`. The watch checks npm's latest Pi version daily. If that version is outside the tested gate and has no existing watch issue, the watch runs a compatibility trial and opens one issue with the result.

To add a version whose trial passed:

- run `node scripts/pi-gate.mjs add <version>`;
- add the version to the README's supported versions and to the CI matrix in `.github/workflows/ci.yml`;
- release as above.

Check the Pi release watch monthly. GitHub disables public-repository schedules after 60 inactive days. To restore it, run `gh workflow enable pi-release-watch.yml`.
