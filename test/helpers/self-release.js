import assert from "node:assert/strict";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { command } from "../../dist/command.js";
import { releaseFixture } from "./release-fixture.js";

export async function selfReleaseFixture(t, packageRoot, buildFromSource = false) {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const fixture = await releaseFixture(t, { manifest: {
    name: manifest.name, version: manifest.version, exports: manifest.exports,
    bin: manifest.bin, files: ["dist/", "bin/"], dependencies: manifest.dependencies, engines: manifest.engines,
    scripts: {
      ...(buildFromSource ? { build: "tsc", prepack: "npm run build" } : {}),
      test: "node --test test.js", lint: "node --check dist/index.js",
    },
    ...(buildFromSource ? { devDependencies: Object.fromEntries(
      ["typescript", "@types/node", "@types/semver"].map((name) => [name, manifest.devDependencies[name]]),
    ) } : {}),
  } });
  for (const directory of buildFromSource ? ["src", "bin"] : ["dist", "bin"]) {
    await cp(join(packageRoot, directory), join(fixture.cwd, directory), { recursive: true });
  }
  if (buildFromSource) await cp(join(packageRoot, "tsconfig.json"), join(fixture.cwd, "tsconfig.json"));
  await cp(fileURLToPath(new URL("../../npr.config.js", import.meta.url)), join(fixture.cwd, "npr.config.js"));
  await writeFile(join(fixture.cwd, ".gitignore"), `node_modules/\n${buildFromSource ? "dist/\n" : ""}`);
  await writeFile(join(fixture.cwd, "test.js"), `
import assert from "node:assert/strict";
import { Workflow } from "npm-package-release";
class Inspect {
  id = "inspect";
  async run(value) { return value + 1; }
}
assert.equal(await Workflow.start().then(new Inspect()).run(41), 42);
`);
  await writeFile(join(fixture.cwd, "CHANGELOG.md"),
    `# Changelog\n\n## ${manifest.version} (Next)\n\n- Validate the actual self-release archive.\n- Your contribution here.\n`);
  await command("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: fixture.cwd });
  await fixture.git("add", ".");
  await fixture.git("commit", "-m", "Configure an isolated self release");
  await fixture.git("push", "origin", "master");
  return fixture;
}

export async function checkSelfRelease(t, packageRoot, configuredWorkflow) {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const fixture = await selfReleaseFixture(t, packageRoot);
  const workflow = configuredWorkflow || (await import(pathToFileURL(join(fixture.cwd, "npr.config.js")).href)).default;
  const result = await workflow.run({ ...fixture, version: "3.2.1" });
  assert.equal(result.verification, "verified");
  assert.equal(result.previousVersion, manifest.version);
  assert.equal(result.version, "3.2.1");
  assert.equal(fixture.published.length, 1);
  assert.equal(fixture.published[0].version, "3.2.1");
  assert.equal(fixture.events.filter((event) => event === "npm pack").length, 1);
  assert.equal(await fixture.git("status", "--porcelain"), "");
  assert.equal((await fixture.git("rev-parse", "v3.2.1")).trim(), result.releaseCommit);
  for (const file of ["package.json", "package-lock.json"]) {
    assert.equal(JSON.parse(await readFile(join(fixture.cwd, file), "utf8")).version, "3.2.2");
  }
  await workflow.complete(fixture);
  assert.equal(fixture.published.length, 1);
  await writeFile(join(fixture.cwd, "bin/npr.js"), 'import process from "node:process"; process.stdout.write("wrong-version\\n");\n');
  const changelog = join(fixture.cwd, "CHANGELOG.md");
  await writeFile(changelog, (await readFile(changelog, "utf8"))
    .replace("- Your contribution here.", "- Reject a broken CLI.\n- Your contribution here."));
  await fixture.git("add", ".");
  await fixture.git("commit", "-m", "Exercise a broken installed CLI");
  await fixture.git("push", "origin", "master");
  await assert.rejects(workflow.prepare({
    ...fixture, version: "3.3.0", artifacts: join(fixture.directory, "broken-cli"),
  }), { code: "ERR_ASSERTION" });
  assert.equal(fixture.published.length, 1);
  assert.equal(await fixture.git("tag", "--list", "v3.3.0"), "");
}
