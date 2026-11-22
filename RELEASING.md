# Releasing

Releases publish from GitHub Actions through npm trusted publishing. No npm token is stored in the repository.

1. Commit the new stable version in `package.json` and merge it into `main`. Once CI passes on that commit, tag it and push the tag: `git tag v<version> && git push origin v<version>`.
2. The Release workflow checks that the tag matches the version and is on main. It then runs the unit tests and publishes with provenance.

npm's trusted publisher for `@panda-repair/pi-provider` uses owner `panda-repair`, repository `pi-provider`, workflow `release.yml` and environment `npm`, with direct publishing enabled. Before enabling direct publishing, two GitHub settings must be in place:

- the release-tag ruleset, so that only repository admins can create, move or delete `v*` tags;
- in the `npm` environment, **Deployment branches and tags** set to **Selected branches and tags**, with exactly one rule of type **Tag** and the pattern `v*`, and no branches.

## New Pi releases

The package enables its picker only on the Pi versions listed in `index.js`. The watch checks npm's latest Pi version daily. If that version is outside the tested gate and has no existing watch issue, the watch runs a compatibility trial and opens one issue with the result.

To add a version whose trial passed:

- run `node scripts/pi-gate.mjs add <version>`;
- add the version to the README's supported versions and to the CI matrix in `.github/workflows/ci.yml`;
- release as above.

Check the Pi release watch monthly. GitHub disables public-repository schedules after 60 inactive days. To restore it, run `gh workflow enable pi-release-watch.yml`.
