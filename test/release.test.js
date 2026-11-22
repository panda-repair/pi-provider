import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("../.github/scripts/verify-release.mjs", import.meta.url));

test("the release guard checks the tagged package and the latest canonical main push CI", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-provider-release-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const repo = { id: 1466849378, full_name: "panda-repair/pi-provider" };
  const env = {
    PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(cwd, "no.gitconfig"),
    GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_EMAIL: "test@example.invalid",
    GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY_ID: String(repo.id), GITHUB_REPOSITORY: repo.full_name, GITHUB_OUTPUT: join(cwd, "output"),
  };
  const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const approval = "tarball-sha256: " + "A".repeat(64);
  const tagRelease = (tag, target, message = approval) => git("tag", "-am", "Release fixture", "-m", message, tag, target);
  function commit(version, fields = {}) {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "@panda-repair/pi-provider", version, ...fields }));
    git("add", "package.json");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  }
  const side = commit("0.0.9");
  tagRelease("v0.0.9", side);
  git("switch", "-q", "--orphan", "approved");
  const sha = commit("0.1.1", { publishConfig: { access: "public", registry: "https://registry.npmjs.org/" } });
  tagRelease("v0.1.1", sha);
  git("tag", "v1.1.0", sha);
  tagRelease("v1.2.0", sha, "No approval yet");
  tagRelease("v1.3.0", sha, approval + "\n" + approval);
  tagRelease("v1.4.0", sha, approval + "\nTarball-sha256: malformed");
  tagRelease("v1.5.0", sha, "tarball-sha256: " + "G".repeat(64));
  tagRelease("v1.6.0", sha, "-----BEGIN PGP SIGNATURE-----\n" + approval + "\n-----END PGP SIGNATURE-----");
  const badManifests = [
    ["v0.2.0", "0.2.0\n", {}, /manifest/],
    ["v0.3.0", "0.3.0\0", {}, /manifest/],
    ["v0.4.0", 4, {}, /manifest/],
    ["v0.5.0", "0.5.1", {}, /manifest/],
    ["v0.6.0", "0.6.0", { name: "@example/other" }, /manifest/],
    ["v0.7.0", "0.7.0", { publishConfig: { "@panda-repair:registry": "https://elsewhere.invalid/" } }, /publishConfig/],
    ["v0.8.0", "0.8.0", { publishConfig: { provenance: false } }, /publishConfig/],
  ];
  const tagged = badManifests.map(([tag, version, fields, error]) => {
    const commitSha = commit(version, fields);
    tagRelease(tag, commitSha);
    return [tag, commitSha, error];
  });
  const main = commit("1.0.0");
  git("update-ref", "refs/remotes/origin/main", main);

  // The workflow's real guard and Git commands run against the local history. Only gh is substituted.
  const stub = join(cwd, "offline-gh.cjs");
  writeFileSync(stub, `const cp = require("node:child_process"), original = cp.execFileSync;
cp.execFileSync = (file, args, options) => {
  if (file !== "gh") return original(file, args, options);
  if (args.length === 2) {
    const runs = JSON.parse(process.env.RUN_PAGES).flatMap(page => page.workflow_runs);
    const latest = runs.reduce((a, b) => a.run_number > b.run_number ? a : b);
    const name = "canonical-pi-provider-" + latest.run_attempt + ".tgz";
    const url = "repos/panda-repair/pi-provider/actions/runs/" + latest.id + "/artifacts?name=" + name + "&per_page=100";
    require("node:assert/strict").deepEqual(args, ["api", url]);
    if (process.env.FAIL_ARTIFACT) throw new Error("Fixture artifact API failure");
    return process.env.ARTIFACT_LIST ?? JSON.stringify({ total_count: 1, artifacts: [
      { id: 123, name, expired: false, digest: "sha256:" + "a".repeat(64), workflow_run: { id: latest.id, head_sha: latest.head_sha } }
    ] });
  }
  const url = "repos/panda-repair/pi-provider/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=" +
    process.env.REVIEWED_SHA.toLowerCase() + "&per_page=100";
  require("node:assert/strict").deepEqual(args, ["api", "--paginate", "--slurp", url]);
  if (process.env.FAIL_API) throw new Error("Fixture API failure");
  return process.env.RUN_PAGES;
};
require("node:module").syncBuiltinESMExports();`);
  const green = {
    id: 201, run_attempt: 2, run_number: 9, name: "CI", path: ".github/workflows/ci.yml", event: "push", head_branch: "main",
    head_sha: sha, repository: repo, head_repository: repo, status: "completed", conclusion: "success",
  };
  const page = (runs, total = runs.length) => [{ total_count: total, workflow_runs: runs }];
  function check(name, overrides = {}, pages = page([green]), error) {
    return t.test(name, () => {
      writeFileSync(env.GITHUB_OUTPUT, "");
      const result = spawnSync(process.execPath, ["--require", stub, guard], { cwd, encoding: "utf8", env: {
        ...env, TAG: "v0.1.1", REVIEWED_SHA: sha, TARBALL_SHA256: "A".repeat(64), RUN_PAGES: JSON.stringify(pages), ...overrides,
      } });
      assert.equal(result.status, error ? 1 : 0, result.stderr);
      if (error) assert.match(result.stderr, error);
      assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), error ? "" :
        `sha=${sha}\nversion=0.1.1\napproved_digest=${"a".repeat(64)}\n`);
    });
  }

  await check("annotated tag still resolves after main has advanced");
  const artifact = { id: 123, name: "canonical-pi-provider-2.tgz", expired: false, digest: "sha256:" + "a".repeat(64) };
  for (const [label, artifacts] of [
    ["legacy CI with no package", []], ["ambiguous artifacts", [artifact, artifact]],
    ["expired package", [{ ...artifact, expired: true }]],
    ["artifact from another run", [{ ...artifact, workflow_run: { id: 99, head_sha: sha } }]],
    ["package from an older attempt", [{ ...artifact, name: "canonical-pi-provider-1.tgz" }]],
    ["tag approved different archive bytes", [{ ...artifact, digest: "sha256:" + "b".repeat(64) }]],
  ]) await check(label, { ARTIFACT_LIST: JSON.stringify({ total_count: artifacts.length, artifacts }) }, undefined, /canonical CI artifact/);
  await check("unavailable artifact API", { FAIL_ARTIFACT: "yes" }, undefined, /read the canonical CI artifact/);
  await check("missing attempt", {}, page([{ ...green, run_attempt: undefined }]), /run ID and attempt/);
  const directTag = git("rev-parse", "refs/tags/v0.1.1");
  git("-c", "advice.nestedTag=false", "tag", "-f", "-a", "-m", "Outer approval", "-m", approval,
    "-m", `object ${sha}\ntype commit`, "v0.1.1", directTag);
  await check("a correctly approved outer tag must point directly to the commit, even when its message repeats the headers",
    {}, undefined, /exact reviewed commit/);
  git("update-ref", "refs/tags/v0.1.1", directTag);
  await check("case-insensitive dispatch digest", { TARBALL_SHA256: "a".repeat(64) });
  await check("uppercase SHA and canonical path with ref", { REVIEWED_SHA: sha.toUpperCase() }, page([{ ...green, path: green.path + "@main" }]));
  for (const [name, overrides, error] of [
    ["fork with a different ID", { GITHUB_REPOSITORY_ID: "1" }, /canonical/],
    ["another repository", { GITHUB_REPOSITORY: "elsewhere/pi-provider" }, /canonical/],
    ["tag dispatch", { GITHUB_REF: "refs/tags/v0.1.1" }, /canonical/],
    ["tag push", { GITHUB_EVENT_NAME: "push" }, /canonical/],
    ["short SHA", { REVIEWED_SHA: sha.slice(0, 7) }, /full commit SHA/],
    ["short digest", { TARBALL_SHA256: "b".repeat(63) }, /SHA-256/],
    ["nonstable version", { TAG: "v01.0.1" }, /stable/],
    ["missing tag", { TAG: "v8.0.0" }, /annotated/],
    ["lightweight tag", { TAG: "v1.1.0" }, /annotated/],
    ["missing digest", { TAG: "v1.2.0" }, /one tarball-sha256/],
    ["duplicate digest", { TAG: "v1.3.0" }, /one tarball-sha256/],
    ["mixed valid and malformed lines", { TAG: "v1.4.0" }, /one tarball-sha256/],
    ["malformed digest", { TAG: "v1.5.0" }, /one tarball-sha256/],
    ["line in the signature only", { TAG: "v1.6.0" }, /one tarball-sha256/],
    ["dispatch digest differs from the tag", { TARBALL_SHA256: "0".repeat(64) }, /tag's approval/],
    ["tag points elsewhere", { REVIEWED_SHA: main }, /exact reviewed commit/],
    ["off-main release", { TAG: "v0.0.9", REVIEWED_SHA: side }, /must be on main/],
  ]) await check(name, overrides, undefined, error);
  for (const [TAG, REVIEWED_SHA, error] of tagged) {
    await check("invalid release manifest at " + TAG, { TAG, REVIEWED_SHA }, undefined, error);
  }
  await check("unavailable CI API", { FAIL_API: "yes" }, undefined, /read the CI/);
  await check("missing CI evidence", {}, page([]), /complete list/);
  await check("incomplete pages", {}, page([green], 2), /complete list/);
  await check("ambiguous run numbers", {}, page([green, green]), /complete list/);
  const newer = { ...green, run_number: 10 };
  await check("pending latest run", {}, page([{ ...newer, status: "in_progress", conclusion: null }, green]), /successful/);
  await check("failed latest run", {}, page([green, { ...newer, conclusion: "failure" }]), /successful/);
  await check("latest run succeeded", {}, page([{ ...green, conclusion: "failure" }, newer]));
  for (const [name, fields] of [
    ["wrong CI name", { name: "Release" }], ["other workflow", { path: ".github/workflows/other.yml" }],
    ["other workflow ref", { path: green.path + "@topic" }], ["pull request", { event: "pull_request" }],
    ["fork CI", { repository: { ...repo, id: 7 } }], ["fork head", { head_repository: { ...repo, full_name: "fixture/fork" } }],
    ["another branch", { head_branch: "topic" }], ["another commit", { head_sha: main }],
  ]) await check(name, {}, page([{ ...green, ...fields }]), /canonical main push/);
  git("update-ref", "-d", "refs/remotes/origin/main");
  await check("missing exact remote main", {}, undefined, /Missing origin\/main/);
});

test("the canonical CI artifact and the release's two packs obey the same approval", t => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8").split("\n  canonical-package:\n")[1];
  const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(ci, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(ci, /github\.repository == 'panda-repair\/pi-provider'/);
  assert.match(ci, /permissions:\s*contents: read\n/);
  assert.match(ci, /archive: false/);
  assert.match(ci, /steps\.package\.outputs\.artifact-digest/);
  assert.match(ci, /GITHUB_STEP_SUMMARY/);
  const pin = ci.match(/node-version: "(\d+\.\d+\.\d+)"/)[1];
  assert.deepEqual([...release.matchAll(/node-version: (.+)/g)].map(match => match[1]), Array(2).fill('"' + pin + '"'));

  const canonicalPack = ci.match(/^        run: (bash \.github\/scripts\/pack-release\.sh .+)$/m)[1];
  const step = release.split("      - name: Pack the reviewed commit twice and check its digest\n")[1];
  const releasePack = step.split("        run: |\n")[1].split("\n      - name:")[0].replace(/^ {10}/gm, "");
  const cwd = mkdtempSync(join(tmpdir(), "canonical-package-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const scripts = join(cwd, ".github", "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "pack-release.sh"),
    'set -eu\n[[ "$1" == "$GITHUB_SHA" ]]\nprintf reviewed > "$2"\nif [[ "${DIVERGE:-}" && "$2" == */second-* ]]; then printf different >> "$2"; fi\n');
  const sha = "1".repeat(40);
  const env = { PATH: process.env.PATH, RUNNER_TEMP: cwd, GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: sha, REVIEWED_SHA: sha };
  const run = (shell, extra = {}) => spawnSync("bash", ["-eo", "pipefail", "-c", shell], { cwd, env: { ...env, ...extra }, encoding: "utf8" });
  assert.equal(run(canonicalPack).status, 0);
  const artifact = readFileSync(join(cwd, "canonical-pi-provider-2.tgz"));
  const digest = createHash("sha256").update(artifact).digest("hex");
  assert.equal(run(releasePack, { TARBALL_SHA256: digest }).status, 0);
  assert.equal(run(releasePack, { TARBALL_SHA256: "b".repeat(64) }).status, 1);
  assert.equal(run(releasePack, { TARBALL_SHA256: digest, DIVERGE: "1" }).status, 1);
});

test("package content approval ignores compression and checks the package file set", t => {
  const helper = fileURLToPath(new URL("../.github/scripts/compare-package.py", import.meta.url));
  const cwd = mkdtempSync(join(tmpdir(), "package-comparison-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync("python3", ["-I", "-B", "-W", "ignore::UserWarning", "-c", `
import io, tarfile
for case in ("canonical", "local", "changed", "missing", "duplicate", "link"):
    with tarfile.open(case + ".tgz", "w:gz", compresslevel=1 if case == "local" else 9) as package:
        def add(name, content):
            member = tarfile.TarInfo(name)
            member.size = len(content)
            package.addfile(member, io.BytesIO(content))
        add("package/package.json", b"changed" if case == "changed" else b"approved")
        if case != "missing":
            add("package/LICENSE", b"license")
        if case == "duplicate":
            add("package/LICENSE", b"again")
        if case == "link":
            member = tarfile.TarInfo("package/link")
            member.type, member.linkname = tarfile.SYMTYPE, "LICENSE"
            package.addfile(member)
`], { cwd });
  const compare = (a, b) => spawnSync("python3", ["-I", "-B", helper, a + ".tgz", b + ".tgz"], { cwd, encoding: "utf8" });
  assert.notDeepEqual(readFileSync(join(cwd, "canonical.tgz")), readFileSync(join(cwd, "local.tgz")));
  const match = compare("canonical", "local");
  assert.equal(match.status, 0, match.stderr);
  assert.ok(match.stdout.includes("package/package.json"));
  for (const change of ["changed", "missing"]) assert.equal(compare("canonical", change).status, 1);
  for (const unsafe of ["duplicate", "link"]) assert.equal(compare(unsafe, unsafe).status, 1);
});
