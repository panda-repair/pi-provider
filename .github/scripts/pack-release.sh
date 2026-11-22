#!/usr/bin/env bash
# Pack a clean checkout of the supplied commit without running package scripts.
set -euo pipefail
sha=${1:?Supply the full commit SHA}
output=${2:?Supply an absolute output filename}
[[ "$sha" =~ ^[0-9a-f]{40}$ && "$output" == /* && ! -e "$output" && ! -L "$output" ]]
umask 022
work=$(mktemp -d "${TMPDIR:-/tmp}/pi-pack.XXXXXXXX")
root=$(git rev-parse --show-toplevel)
cleanup() {
  if [[ -f "$work/source/.git" ]]; then
    git -C "$root" -c core.hooksPath=/dev/null worktree remove --force "$work/source"
  fi
  rm -rf "$work"
}
trap cleanup EXIT
git -c core.hooksPath=/dev/null worktree add --quiet --detach "$work/source" "$sha"
[[ "$(git -C "$work/source" rev-parse HEAD)" == "$sha" ]]
git show "$sha:package.json" > "$work/reviewed-package.json"
(
  cd "$work"
  npm pack --offline --ignore-scripts --pack-destination "$work" "$work/source"
)
packages=("$work"/*.tgz)
[[ ${#packages[@]} == 1 && -f "${packages[0]}" && ! -L "${packages[0]}" ]]
tar -xzOf "${packages[0]}" package/package.json | cmp - "$work/reviewed-package.json"
mv "${packages[0]}" "$output"
