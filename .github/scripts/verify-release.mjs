import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const repository = "panda-repair/pi-provider";
const repositoryId = 1466849378;
const workflow = ".github/workflows/ci.yml";

function run(executable, args, failure) {
  try {
    return execFileSync(executable, args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    throw new Error(failure);
  }
}

function canonicalRepo(repo) {
  return repo?.id === repositoryId && repo.full_name === repository;
}

function approvedDigest(tag, sha, submitted) {
  // Git separates the signature without running a verifier. Keep the tag message's original lines.
  const format = "%(objecttype)%00%(*objectname)%00%(contents)%00%(contents:signature)";
  const record = run("git", ["tag", "--list", tag, "--format=" + format], "Could not read the release tag.");
  const fields = record.slice(0, -1).split("\0");
  const [type, target, contents, signature] = fields;
  if (fields.length !== 4 || type !== "tag" || !contents.endsWith(signature)) {
    throw new Error("Expected an annotated release tag.");
  }
  if (target !== sha) throw new Error("The release tag must point to the exact reviewed commit.");
  const message = contents.slice(0, contents.length - signature.length);
  const lines = message.split("\n").filter(line => line.trimStart().toLowerCase().startsWith("tarball-sha256"));
  const digest = /^tarball-sha256: ([a-fA-F0-9]{64})$/.exec(lines[0])?.[1].toLowerCase();
  if (!digest || lines.length !== 1) throw new Error("Expected one tarball-sha256: <64 hex> line in the tag message.");
  if (digest !== submitted.toLowerCase()) throw new Error("The dispatch digest must match the protected tag's approval.");
  return digest;
}

function checkCI(sha) {
  const url = `repos/${repository}/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${sha}&per_page=100`;
  const pages = JSON.parse(run("gh", ["api", "--paginate", "--slurp", url], "Could not read the CI runs."));
  const runs = pages.flatMap(page => page.workflow_runs);
  if (!runs.length || pages.some(page => page.total_count !== runs.length) ||
      new Set(runs.map(run => run.run_number)).size !== runs.length) {
    throw new Error("Expected a complete list of CI runs for the reviewed commit.");
  }

  const paths = [workflow, workflow + "@main", workflow + "@refs/heads/main", workflow + "@" + sha];
  for (const run of runs) {
    if (run.name !== "CI" || !paths.includes(run.path) || !canonicalRepo(run.repository) ||
        !canonicalRepo(run.head_repository) || run.event !== "push" || run.head_branch !== "main" ||
        run.head_sha !== sha || !Number.isSafeInteger(run.run_number) || run.run_number < 1) {
      throw new Error("CI evidence must identify the canonical main push for the reviewed commit.");
    }
  }
  const latest = runs.reduce((newest, run) => run.run_number > newest.run_number ? run : newest);
  if (latest.status !== "completed" || latest.conclusion !== "success") {
    throw new Error("The latest main push CI run for the reviewed commit must be complete and successful.");
  }
}

function checkManifest(manifest, tag) {
  if (manifest.name !== "@panda-repair/pi-provider" || typeof manifest.version !== "string" ||
      "v" + manifest.version !== tag) {
    throw new Error("The reviewed manifest must name @panda-repair/pi-provider and its version must exactly match the tag.");
  }
  // npm applies publishConfig from the tarball before choosing a registry for OIDC.
  if (manifest.publishConfig !== undefined) {
    const allowed = new Map([
      ["registry", "https://registry.npmjs.org/"], ["@panda-repair:registry", "https://registry.npmjs.org/"],
      ["access", "public"], ["tag", "latest"], ["provenance", true],
    ]);
    const config = manifest.publishConfig;
    if (!config || typeof config !== "object" || Array.isArray(config) ||
        Object.entries(config).some(([key, value]) => !allowed.has(key) || value !== allowed.get(key))) {
      throw new Error("The package's publishConfig must agree with the public npm release settings.");
    }
  }
}

function verify() {
  const { GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_REPOSITORY, GITHUB_REPOSITORY_ID,
    TAG, REVIEWED_SHA, TARBALL_SHA256, GITHUB_OUTPUT } = process.env;
  if (GITHUB_EVENT_NAME !== "workflow_dispatch" || GITHUB_REF !== "refs/heads/main" ||
      GITHUB_REPOSITORY_ID !== String(repositoryId) || GITHUB_REPOSITORY !== repository) {
    throw new Error("Dispatch the release from the canonical repository's main branch.");
  }
  const stableTag = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
  if (!stableTag.test(TAG) || !/^[0-9a-f]{40}$/i.test(REVIEWED_SHA) || !/^[0-9a-f]{64}$/i.test(TARBALL_SHA256)) {
    throw new Error("Supply a stable vMAJOR.MINOR.PATCH tag, a full commit SHA and a tarball SHA-256.");
  }
  const sha = REVIEWED_SHA.toLowerCase();
  const digest = approvedDigest(TAG, sha, TARBALL_SHA256);
  const main = run("git", ["show-ref", "--verify", "--hash", "refs/remotes/origin/main"], "Missing origin/main.").trim();
  run("git", ["merge-base", "--is-ancestor", sha, main], "The reviewed commit must be on main.");
  const manifest = JSON.parse(run("git", ["show", sha + ":package.json"], "Missing package.json in the reviewed commit."));
  checkManifest(manifest, TAG);
  checkCI(sha);
  appendFileSync(GITHUB_OUTPUT, `sha=${sha}\nversion=${manifest.version}\napproved_digest=${digest}\n`);
}

try {
  verify();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
