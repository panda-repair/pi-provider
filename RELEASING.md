# Releasing

Repository admins are the designated releasers. They approve a commit and its npm tarball by recording the SHA-256 in a protected annotated tag. A repository writer can then dispatch the approved release from `main`.

## Before rollout

Complete these steps before merging the new workflow or pushing its first release tag.

1. In **Actions**, finish or cancel all outstanding runs of the legacy tag-push **Release** workflow, including queued runs and runs waiting for approval.
2. In **Settings → Environments → npm → Deployment branches and tags**, choose **Selected branches and tags**. Replace the old **Tag** rule for `v*` with exactly one **Branch** rule for `main`. Remove all **Tag** rules. Nacho can also require an environment reviewer for a separate go-live decision.
3. In **Settings → Rules → Rulesets**, activate a branch ruleset targeting `main`. Require pull requests and the passing **CI** checks `unit`, `e2e (1.5.2)` and `e2e (1.6.0)`. Block force pushes and branch deletion. Ordinary writers must use pull requests and have no direct-push or bypass permission. Put only the repository-admin role on the bypass list. Nacho chooses the required approval count. One independent approving review is recommended for non-admin pull requests.
4. Keep the active `v*` tag ruleset. Reserve tag creation, updates and deletion for the designated releasers. Keep npm's existing trusted publisher for `@panda-repair/pi-provider` configured with owner `panda-repair`, repository `pi-provider`, workflow filename `release.yml`, environment `npm` and direct publishing enabled.

npm trusts the repository, workflow filename and environment. Changes to `.github/workflows/release.yml`, `.github/workflows/ci.yml` and `.github/scripts/verify-release.mjs` must go through the protected `main` path above. Once these controls are in place, merge the new workflow. Only its publish job can authenticate through GitHub OIDC using npm 11.5.1 or later.

## Review and publish

1. Merge the new stable version in `package.json` and wait for the **CI** main push run on that commit to succeed. From the reviewed commit, use Bash and Node 24 to pack a fresh checkout with umask `022`. Record the printed commit SHA, tag and tarball SHA-256 together.

   ```bash
   (
     set -eu
     umask 022
     sha=$(git rev-parse --verify HEAD)
     out=$(mktemp -d "${TMPDIR:-/tmp}/pi-release.XXXXXXXX")
     git worktree add --quiet --detach "$out/source" "$sha"
     trap 'git worktree remove "$out/source"' EXIT
     tag="v$(node -p 'require(process.argv[1]).version' "$out/source/package.json")"
     file="$out/panda-repair-pi-provider-${tag#v}.tgz"
     (cd "$out" && npm pack --offline --ignore-scripts --loglevel=error --pack-destination "$out" "$out/source" >/dev/null)
     checksum=$(shasum -a 256 "$file")
     digest=${checksum%% *}
     if ! [[ "$digest" =~ ^[0-9a-fA-F]{64}$ ]]; then
       echo 'Expected a 64-character hexadecimal tarball SHA-256.' >&2
       exit 1
     fi
     printf 'Tarball saved to %s\n' "$file" >&2
     printf '%s %s %s\n' "$sha" "$tag" "$digest"
   )
   ```

2. As a designated releaser, substitute the recorded values below. Approve the bytes by recording the digest on its own line in an annotated tag pointing directly to the reviewed commit, even if `main` has advanced. Push the tag and dispatch the workflow with the same values.

   ```sh
   sha='<recorded full commit SHA>'
   tag='<recorded release tag>'
   digest='<recorded tarball SHA-256>'
   git tag -a "$tag" "$sha" -m "Release $tag" -m "tarball-sha256: $digest"
   git push origin "refs/tags/$tag"
   gh workflow run release.yml --repo panda-repair/pi-provider --ref main \
     -f tag="$tag" -f sha="$sha" -f tarball_sha256="$digest"
   ```

The read-only job verifies the annotated tag's approval, `origin/main` ancestry, package identity, stable version and latest CI result for the commit. It packs the commit twice with lifecycle scripts disabled and requires byte-identical archives matching the tag's digest. The publish job independently checks the received tarball against the dispatch digest and publishes that file with public access. If publication needs a retry, select **Re-run all jobs** so the current tag and CI are checked again.

npm generates provenance automatically. Its source revision is the workflow's dispatch SHA on `main`, which can be newer than the tagged commit. Keep the approved SHA and digest together to identify the packaged source.

## New Pi releases

The package enables its picker only on the Pi versions listed in `index.js`. The watch checks npm's latest Pi version daily. If that version is outside the tested gate and has no existing watch issue, the watch runs a compatibility trial and opens one issue with the result.

To add a version whose trial passed:

- run `node scripts/pi-gate.mjs add <version>`;
- add the version to the README's supported versions and to the CI matrix in `.github/workflows/ci.yml`;
- release as above.

Check the Pi release watch monthly. GitHub disables public-repository schedules after 60 inactive days. To restore it, run `gh workflow enable pi-release-watch.yml`.
