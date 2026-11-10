import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { command } from "../../dist/command.js";
import { releaseFixture } from "./release-fixture.js";
import { parse } from "yaml";

export async function checkActions(t, archive) {
  for (const file of [".github/workflows/release.yml", "action.yml"]) {
    const source = await readFile(fileURLToPath(new URL(`../../${file}`, import.meta.url)), "utf8");
    const definition = parse(source);
    const steps = file === "action.yml" ? definition.runs.steps : definition.jobs.release.steps;
    const preparation = steps.findIndex((step) => step.run?.startsWith("npm exec --offline -- npr prepare "));
    const completion = steps.findIndex((step) => step.run?.startsWith("npm exec --offline -- npr complete "));
    assert.ok(preparation >= 0 && completion === preparation + 2, `Missing checkpoint handoff in ${file}`);
    const upload = steps[preparation + 1];
    assert.match(upload.uses, /^actions\/upload-artifact@/u);
    assert.equal(upload.with["if-no-files-found"], "error");
    assert.equal(upload.with["include-hidden-files"], true);
    assert.equal(upload.if, undefined);
    assert.equal(steps[completion].if, undefined);
    const fixture = await releaseFixture(t);
    const bin = join(fixture.directory, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "package.json"), '{"type":"module"}\n');
    await writeFile(join(fixture.cwd, ".gitignore"), "node_modules/\n");
    await command("npm", ["install", "--save-dev", "--ignore-scripts", "--no-audit", "--no-fund", archive], {
      cwd: fixture.cwd,
    });
    await writeFile(join(fixture.cwd, "npr.config.js"),
      'export default { changelog: { format: "intridea" }, verification: { attempts: 2, delay: 0 } };\n');
    await fixture.git("add", ".");
    await fixture.git("commit", "-m", "Install release tooling");
    await fixture.git("push", "origin", "master");
    const publication = join(fixture.directory, "publication.json");
    const hosted = join(fixture.directory, "hosted.json");
    const npm = join(bin, "npm-shim.mjs");
    const realNpm = process.env.npm_execpath;
    await writeFile(npm, `
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
const publication = ${JSON.stringify(publication)};
if (args[0] === "view") {
  if (existsSync(publication)) process.stdout.write(readFileSync(publication));
  else { process.stdout.write('{"error":{"code":"E404"}}'); process.exitCode = 1; }
} else if (args[0] === "publish") {
  if (existsSync(publication)) throw new Error("Duplicate publication");
  const bytes = readFileSync(args[1]);
  const metadata = JSON.parse(execFileSync("tar", ["-xOf", args[1], "package/package.json"], { encoding: "utf8" }));
  writeFileSync(publication, JSON.stringify({
    name: metadata.name, version: metadata.version,
    dist: {
      integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
      shasum: createHash("sha1").update(bytes).digest("hex"),
    },
  }));
} else {
  const result = spawnSync(process.execPath, [${JSON.stringify(realNpm)}, ...args], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}
`);
    const shell = join(bin, "script-shell");
    const quotedNpm = "'" + npm.replaceAll("'", "'\\''") + "'";
    await writeFile(shell, `#!/bin/sh\nexport npm_execpath=${quotedNpm}\nexec /bin/sh "$@"\n`, { mode: 0o755 });
    await writeFile(join(bin, "gh"), `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
const hosted = ${JSON.stringify(hosted)};
if (args[0] === "api") {
  if (existsSync(hosted)) process.stdout.write("HTTP/2.0 200 OK\\n\\n" + readFileSync(hosted, "utf8"));
  else { process.stdout.write("HTTP/2.0 404 Not Found\\n\\n{}"); process.exitCode = 1; }
} else if (args[0] === "release" && args[1] === "create") {
  if (existsSync(hosted)) throw new Error("Duplicate hosted release");
  writeFileSync(hosted, JSON.stringify({
    tag_name: args[2], name: args[args.indexOf("--title") + 1],
    body: readFileSync(args[args.indexOf("--notes-file") + 1], "utf8"),
    draft: false, prerelease: false,
    assets: [{ name: basename(args[3]), digest: "sha256:" + createHash("sha256").update(readFileSync(args[3])).digest("hex") }],
  }));
} else throw new Error("Unexpected hosted operation");
`, { mode: 0o755 });
    const artifacts = join(fixture.directory, "npr-release");
    const env = {
      ...process.env,
      PATH: bin + delimiter + process.env.PATH,
      npm_config_script_shell: shell,
      NPR_CONFIG: "npr.config.js", NPR_VERSION: "0.2.0", NPR_TIMEZONE: "America/New_York",
      NPR_ARTIFACTS: artifacts, RUNNER_TEMP: fixture.directory, NPR_DEFAULT_BRANCH: "master",
      GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/master",
      GITHUB_STEP_SUMMARY: join(fixture.directory, "summary.md"), GH_TOKEN: "isolated-test-only",
    };
    await command("bash", ["-euo", "pipefail", "-c", steps[preparation].run], { cwd: fixture.cwd, env });
    await assert.rejects(readFile(publication), { code: "ENOENT" });
    const durable = join(fixture.directory, "uploaded-checkpoint");
    await cp(artifacts, durable, { recursive: true });
    const checkpoint = await readFile(join(durable, "checkpoint.json"), "utf8");
    const output = await command("bash", ["-euo", "pipefail", "-c", steps[completion].run], { cwd: fixture.cwd, env });
    assert.match(output, /\[npr\] verified: @npr-test\/example@0.2.0/u);
    assert.equal(JSON.parse(await readFile(hosted, "utf8")).tag_name, "v0.2.0");
    assert.equal(JSON.parse(await readFile(join(fixture.cwd, "package.json"), "utf8")).version, "0.2.1");
    const before = await readFile(publication, "utf8");
    await command("bash", ["-euo", "pipefail", "-c",
      'npm exec --offline -- npr verify --artifacts "$NPR_ARTIFACTS"',
    ], { cwd: fixture.cwd, env });
    assert.equal(await readFile(publication, "utf8"), before);
    assert.equal(JSON.parse(await readFile(join(artifacts, "release.json"), "utf8")).verification, "verified");
    await command("bash", ["-euo", "pipefail", "-c", steps[completion].run], { cwd: fixture.cwd, env });
    assert.equal(await readFile(publication, "utf8"), before);
    assert.equal(await readFile(join(durable, "checkpoint.json"), "utf8"), checkpoint);
  }
}
