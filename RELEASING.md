# Releasing

A maintainer approves a commit and the SHA-256 of its npm tarball, then dispatches `release.yml` from protected `main`. Only the publish job can authenticate to npm.

## Review and publish

1. Merge the new stable version in `package.json` and wait for the **CI** main push run on that commit to succeed. Select the exact commit you reviewed and record its full SHA, tag and tarball SHA-256. Use Node 24 and a fresh checkout with umask `022` so local file permissions reproduce the release bytes.

   ```sh
   sha=$(git rev-parse HEAD)
   out=$(mktemp -d)
   (umask 022 && git worktree add --detach "$out/source" "$sha" &&
     cd "$out" && npm pack --offline --ignore-scripts --pack-destination "$out" "$out/source")
   tag="v$(node -p 'require(process.argv[1]).version' "$out/source/package.json")"
   file="$out/panda-repair-pi-provider-${tag#v}.tgz"
   digest=$(shasum -a 256 "$file" | cut -d ' ' -f1)
   printf '%s %s %s\n' "$sha" "$tag" "$digest"
   git worktree remove "$out/source"
   ```

2. As a designated releaser, approve the bytes by recording the digest on its own line in the annotated tag. Tag the recorded SHA, even if `main` has advanced. Push the tag and dispatch the workflow with the same values.

   ```sh
   git tag -a "$tag" "$sha" -m "Release $tag" -m "tarball-sha256: $digest"
   git push origin "refs/tags/$tag"
   gh workflow run release.yml --repo panda-repair/pi-provider --ref main \
     -f tag="$tag" -f sha="$sha" -f tarball_sha256="$digest"
   ```

The read-only job verifies the annotated tag's approval, `origin/main` ancestry, package identity, stable version and latest CI result for the commit. It packs the commit twice with lifecycle scripts disabled and requires byte-identical archives matching the tag's digest. The publish job independently checks the received tarball against the dispatch digest and publishes that file with public access. If publication needs a retry, select **Re-run all jobs** so the current tag and CI are checked again.

npm generates provenance automatically. Its source revision is the workflow's dispatch SHA on `main`, which can be newer than the tagged commit. Keep the approved SHA and digest together to identify the packaged source.

## Publishing settings

npm's trusted publisher for `@panda-repair/pi-provider` stays configured for owner `panda-repair`, repository `pi-provider`, workflow `release.yml` and environment `npm`, with direct publishing enabled. GitHub OIDC supplies the publishing identity to npm 11.5.1 or later.

- Protect `main`, including changes to CI and the release workflow.
- Reserve creation, updates and deletion of `v*` tags for the designated releasers (repository admins) in the release-tag ruleset. The digest they put in the tag approves the exact tarball.
- Set the `npm` environment's **Deployment branches and tags** to **Selected branches and tags**. Keep exactly one **Branch** rule for `main` and remove any **Tag** rules.
- The project owner can also require a reviewer on the `npm` environment for a separate go-live decision.

## New Pi releases

The package enables its picker only on the Pi versions listed in `index.js`. The watch checks npm's latest Pi version daily. If that version is outside the tested gate and has no existing watch issue, the watch runs a compatibility trial and opens one issue with the result.

To add a version whose trial passed:

- run `node scripts/pi-gate.mjs add <version>`;
- add the version to the README's supported versions and to the CI matrix in `.github/workflows/ci.yml`;
- release as above.

Check the Pi release watch monthly. GitHub disables public-repository schedules after 60 inactive days. To restore it, run `gh workflow enable pi-release-watch.yml`.
