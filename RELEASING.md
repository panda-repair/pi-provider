# Releasing

Releases publish from GitHub Actions through npm trusted publishing. No npm token is stored in the repository.

1. On main, after review and green CI, set `version` in `package.json` to the new `MAJOR.MINOR.PATCH`.
2. Tag that commit and push the tag: `git tag v<version> && git push origin v<version>`.
3. The Release workflow checks that the tag matches the version and is on main. It then runs the unit tests and publishes with provenance.

npm's trusted publisher for `@panda-repair/pi-provider` uses owner `panda-repair`, repository `pi-provider`, workflow `release.yml` and environment `npm`, with direct publishing enabled. Only repository admins can create, move or delete `v*` tags.

## New Pi releases

The package enables its picker only on the Pi versions listed in `index.js`. The Pi release watch tries each new Pi release once a day and opens one issue per version.

To add a version whose trial passed:

- run `node scripts/pi-gate.mjs add <version>`;
- add the version to the README's supported versions and to the CI matrix in `.github/workflows/ci.yml`;
- release as above.

Check the Pi release watch monthly. GitHub disables public-repository schedules after 60 inactive days. To restore it, run `gh workflow enable pi-release-watch.yml`.
