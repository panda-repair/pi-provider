import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const url = "repos/panda-repair/pi-provider/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=" +
    process.env.REVIEWED_SHA.toLowerCase() + "&per_page=100";
  require("node:assert/strict").deepEqual(args, ["api", "--paginate", "--slurp", url]);
  if (process.env.FAIL_API) throw new Error("Fixture API failure");
  return process.env.RUN_PAGES;
};
require("node:module").syncBuiltinESMExports();`);
  const green = {
    run_number: 9, name: "CI", path: ".github/workflows/ci.yml", event: "push", head_branch: "main",
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
