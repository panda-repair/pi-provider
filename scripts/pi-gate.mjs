// Lists or extends the Pi versions that the package enables its picker on.
// "add" changes index.js and test/e2e.py in place so CI can try a new Pi release.
import { readFileSync, writeFileSync } from "node:fs";

const gate = /verifiedPickerHost = (\[[^\]]*\])\.includes\(VERSION\)/;
const assertion = /assert version in \(([^)]*)\), version/;
const [command, version] = process.argv.slice(2);

const index = readFileSync("index.js", "utf8");
const match = index.match(gate);
if (!match) throw new Error("The version gate in index.js has changed.");
const verified = JSON.parse(match[1]);

if (command === "list") {
  console.log(verified.join(" "));
} else if (command === "add") {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error(`Not a release version: ${version}`);
  if (verified.includes(version)) throw new Error(`Pi ${version} is already verified.`);
  const next = [...verified, version];
  const e2e = readFileSync("test/e2e.py", "utf8");
  if (!assertion.test(e2e)) throw new Error("The version check in test/e2e.py has changed.");
  writeFileSync("index.js", index.replace(gate, `verifiedPickerHost = ${JSON.stringify(next).replaceAll(",", ", ")}.includes(VERSION)`));
  writeFileSync("test/e2e.py", e2e.replace(assertion, `assert version in (${next.map(v => JSON.stringify(v)).join(", ")}), version`));
} else {
  throw new Error("Usage: node scripts/pi-gate.mjs list | add <version>");
}
