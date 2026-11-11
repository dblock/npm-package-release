import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { command } from "../../dist/command.js";
import { releaseFixture } from "./release-fixture.js";
import { selfReleaseFixture } from "./self-release.js";
import { parse } from "yaml";

export async function checkActions(t, archive, files = [".github/workflows/release.yml", "action.yml"]) {
  for (const file of files) {
    const selfRelease = file === ".github/workflows/self-release.yml";
    const semantic = file === ".github/workflows/release.yml";
    const releasedVersion = semantic ? "1.0.0" : "0.2.0";
    const source = await readFile(fileURLToPath(new URL(`../../${file}`, import.meta.url)), "utf8");
    const definition = parse(source);
    let releaseDefinition = definition;
    if (selfRelease) {
      assert.equal(definition.jobs.release.uses, "./.github/workflows/release.yml");
      releaseDefinition = parse(await readFile(
        fileURLToPath(new URL(`../../${definition.jobs.release.uses}`, import.meta.url)), "utf8",
      ));
    }
    const steps = file === "action.yml" ? definition.runs.steps : releaseDefinition.jobs.release.steps;
    const executable = "npm exec --offline -- npr";
    const preparation = steps.findIndex((step) => step.run?.startsWith(`${executable} prepare `));
    const publicationStep = steps.findIndex((step) => step.run?.startsWith(`${executable} release `));
    assert.ok(preparation >= 0 && publicationStep === preparation + 2, `Missing prepublication upload in ${file}`);
    const upload = steps[preparation + 1];
    assert.match(upload.uses, /^actions\/upload-artifact@/u);
    assert.equal(upload.with["if-no-files-found"], "error");
    assert.equal(upload.with["include-hidden-files"], true);
    assert.equal(upload.if, undefined);
    assert.equal(steps[publicationStep].if, undefined);
    const fixture = selfRelease ?
      await selfReleaseFixture(t, fileURLToPath(new URL("../../", import.meta.url)), true) :
      await releaseFixture(t);
    const bin = join(fixture.directory, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "package.json"), '{"type":"module"}\n');
    if (!selfRelease) {
      await writeFile(join(fixture.cwd, ".gitignore"), "node_modules/\n");
      await command("npm", ["install", "--save-dev", "--ignore-scripts", "--no-audit", "--no-fund", archive], {
        cwd: fixture.cwd,
      });
      await writeFile(join(fixture.cwd, "npr.config.js"),
        semantic ?
          'import { SemanticReleaseWorkflow } from "npm-package-release"; export default new SemanticReleaseWorkflow();\n' :
          'import { ReleaseWorkflow, IntrideaChangelog } from "npm-package-release"; export default new ReleaseWorkflow({ changelog: new IntrideaChangelog() });\n');
      await fixture.git("add", ".");
      await fixture.git("commit", "-m", "feat: install release tooling");
      await fixture.git("push", "origin", "master");
    }
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
      ...fixture.env,
      PATH: bin + delimiter + process.env.PATH,
      npm_config_script_shell: shell,
      NPR_CONFIG: "npr.config.js", NPR_VERSION: semantic ? "" : releasedVersion, NPR_TIMEZONE: "America/New_York",
      NPR_ARTIFACTS: artifacts, RUNNER_TEMP: fixture.directory, NPR_DEFAULT_BRANCH: "master",
      GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/master",
      GITHUB_STEP_SUMMARY: join(fixture.directory, "summary.md"), GH_TOKEN: "isolated-test-only",
    };
    if (selfRelease) {
      await assert.rejects(readFile(join(fixture.cwd, "dist/index.js")), { code: "ENOENT" });
      const build = steps.find((step) => step.name === "Build Release Tooling");
      assert.equal(build.if, "${{ inputs.build }}");
      const setup = [steps.find((step) => step.name === "Install Project Dependencies")];
      if (definition.jobs.release.with.build) setup.push(build);
      for (const step of setup) {
        await command("bash", ["-euo", "pipefail", "-c", step.run], {
          cwd: fixture.cwd, env,
        });
      }
    }
    await command("bash", ["-euo", "pipefail", "-c", steps[preparation].run], { cwd: fixture.cwd, env });
    await assert.rejects(readFile(publication), { code: "ENOENT" });
    const durable = join(fixture.directory, "uploaded-artifacts");
    await cp(artifacts, durable, { recursive: true });
    const prepared = JSON.parse(await readFile(join(durable, "release.json"), "utf8"));
    const bytes = await readFile(join(durable, prepared.artifact.filename));
    await assert.rejects(readFile(join(durable, "checkpoint.json")), { code: "ENOENT" });
    for (const line of (await readFile(env.GITHUB_ENV, "utf8")).trim().split("\n")) {
      const equals = line.indexOf("=");
      env[line.slice(0, equals)] = line.slice(equals + 1);
    }
    assert.equal(env.NPR_SOURCE_COMMIT, prepared.initialCommit);
    assert.equal(env.NPR_MANIFEST_VERSION, prepared.previousVersion);
    assert.equal(env.NPR_RELEASE_DATE, prepared.date);
    assert.match(env.SOURCE_DATE_EPOCH, /^\d+$/u);
    if (semantic) {
      assert.equal(prepared.semantic.decision.version, releasedVersion);
      assert.equal(prepared.semantic.nextDevelopment, false);
      assert.equal(JSON.parse(await readFile(env.NPR_STATE_FILE, "utf8")).analysis.version, releasedVersion);
    }
    const output = await command("bash", ["-euo", "pipefail", "-c", steps[publicationStep].run], { cwd: fixture.cwd, env });
    const packageName = selfRelease ? "npm-package-release" : "@npr-test/example";
    assert.ok(output.includes(`[npr] verified: ${packageName}@${releasedVersion}`));
    assert.equal(JSON.parse(await readFile(hosted, "utf8")).tag_name, `v${releasedVersion}`);
    assert.equal(JSON.parse(await readFile(join(fixture.cwd, "package.json"), "utf8")).version, semantic ? releasedVersion : "0.2.1");
    const before = await readFile(publication, "utf8");
    await command("bash", ["-euo", "pipefail", "-c",
      `${executable} verify --artifacts "$NPR_ARTIFACTS"`,
    ], { cwd: fixture.cwd, env });
    assert.equal(await readFile(publication, "utf8"), before);
    assert.equal(JSON.parse(await readFile(join(artifacts, "release.json"), "utf8")).verification, "verified");
    assert.deepEqual(await readFile(join(artifacts, prepared.artifact.filename)), bytes);
    assert.deepEqual(await readFile(join(durable, prepared.artifact.filename)), bytes);
  }
}
