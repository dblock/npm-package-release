import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { prepare, release, InitializeRelease, ReleaseWorkflow, SemanticReleaseWorkflow } from "../dist/index.js";
import { releaseFixture } from "./helpers/release-fixture.js";

const manifestVersion = /"version": "(?<version>\d+\.\d+\.\d+)"/u;
const installPin = /@npr-test\/example@(?<version>\d+\.\d+\.\d+)/u;

async function referencesFixture(t) {
  const fixture = await releaseFixture(t);
  await mkdir(join(fixture.cwd, "public"));
  await mkdir(join(fixture.cwd, "docs", "guides"), { recursive: true });
  await writeFile(join(fixture.cwd, "public", "manifest.json"),
    '{\r\n  "manifest_version": 3,\r\n  "version": "0.1.0",\r\n  "name": "Ünïcode"\r\n}\r\n');
  await writeFile(join(fixture.cwd, "README.md"),
    "# Example\n\nnpm install @npr-test/example@0.0.9\n\nKeep 1.2.3 and @npr-test/other@0.0.1.\n");
  await writeFile(join(fixture.cwd, "docs", "guides", "install.md"),
    "Install @npr-test/example@0.0.9 or @npr-test/example@0.0.8.\n");
  await writeFile(join(fixture.cwd, "docs", ".hidden.md"), "Hidden @npr-test/example@0.0.7.\n");
  await fixture.git("add", ".");
  await fixture.git("commit", "-m", "Add version references");
  await fixture.git("push", "origin", "master");
  return fixture;
}

const references = {
  versionReferences: { "public/manifest.json": [manifestVersion] },
  releaseReferences: { "./README.md": [installPin], "docs/**/*.md": [installPin], "missing/**/*.md": [installPin] },
};

test("version references follow both commits and release references pin the released version", async (t) => {
  const fixture = await referencesFixture(t);
  const workflow = new ReleaseWorkflow({ ...fixture.config, ...references });
  const built = await prepare(workflow, { ...fixture, version: "0.2.0" });
  const result = await release(workflow, { ...fixture, version: "0.2.0", env: built.runtime.env });
  assert.equal(result.verification, "verified");
  assert.equal(fixture.published.length, 1);
  assert.equal(await fixture.git("show", "v0.2.0:public/manifest.json"),
    '{\r\n  "manifest_version": 3,\r\n  "version": "0.2.0",\r\n  "name": "Ünïcode"\r\n}\r\n');
  assert.equal(await fixture.git("show", "v0.2.0:README.md"),
    "# Example\n\nnpm install @npr-test/example@0.2.0\n\nKeep 1.2.3 and @npr-test/other@0.0.1.\n");
  assert.equal(await fixture.git("show", "v0.2.0:docs/guides/install.md"),
    "Install @npr-test/example@0.2.0 or @npr-test/example@0.2.0.\n");
  assert.equal(await fixture.git("show", "v0.2.0:docs/.hidden.md"), "Hidden @npr-test/example@0.2.0.\n");
  assert.equal(await readFile(join(fixture.cwd, "public", "manifest.json"), "utf8"),
    '{\r\n  "manifest_version": 3,\r\n  "version": "0.2.1",\r\n  "name": "Ünïcode"\r\n}\r\n');
  assert.equal(await readFile(join(fixture.cwd, "README.md"), "utf8"),
    "# Example\n\nnpm install @npr-test/example@0.2.0\n\nKeep 1.2.3 and @npr-test/other@0.0.1.\n");
  assert.equal(await fixture.git("show", "HEAD~1:public/manifest.json"), await fixture.git("show", "v0.2.0:public/manifest.json"));
  assert.equal((await fixture.git("rev-list", "--count", "v0.2.0..HEAD")).trim(), "1");
  assert.equal(await fixture.git("status", "--porcelain"), "");
});

test("semantic workflows update version references in release and next-development commits", async (t) => {
  const fixture = await referencesFixture(t);
  const result = await new SemanticReleaseWorkflow({
    nextDevelopment: true, verifier: fixture.config.verifier, validator: fixture.config.validator, ...references,
  }).run({ ...fixture, version: "1.0.0" });
  assert.equal(result.verification, "verified");
  assert.match(await fixture.git("show", "v1.0.0:public/manifest.json"), /"version": "1\.0\.0"/u);
  assert.match(await fixture.git("show", "v1.0.0:README.md"), /example@1\.0\.0/u);
  assert.match(await readFile(join(fixture.cwd, "public", "manifest.json"), "utf8"), /"version": "1\.0\.1"/u);
  assert.match(await readFile(join(fixture.cwd, "README.md"), "utf8"), /example@1\.0\.0/u);
});

test("missing, unmatched, uncaptured, non-text, and escaping references fail before any reference write", async (t) => {
  const fixture = await referencesFixture(t);
  const readme = await readFile(join(fixture.cwd, "README.md"), "utf8");
  const manifest = await readFile(join(fixture.cwd, "public", "manifest.json"), "utf8");
  const outside = await mkdtemp(join(tmpdir(), "npr-reference-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "version.txt"), "1.0.0\n");
  const reset = async () => {
    await fixture.git("reset", "--hard", "-q", "origin/master");
    await fixture.git("clean", "-fdq");
  };
  const cases = [
    [{ releaseReferences: { "missing.md": [installPin] } }, /Version reference file is missing: missing\.md/u],
    [{ releaseReferences: { "README.md": [/@npr-test\/absent@(?<version>\S+)/u] } }, /does not match README\.md/u],
    [{ releaseReferences: { "docs/**/*.md": [/Install @npr-test\/example@(?<version>\S+) or/u] } }, /does not match docs\/\.hidden\.md/u],
    [{ releaseReferences: { "README.md": [/npm install (?<version>\d+\.\d+\.\d+)?/u] } }, /did not capture a version in README\.md/u],
    [{ releaseReferences: { "docs": [installPin] } }, /regular file inside the repository: docs/u],
    [{ releaseReferences: { "README.md/child.md": [installPin] } }, /ENOTDIR|file is missing/u],
    [{ releaseReferences: { "binary.dat": [/(?<version>x)/u] } }, /must be UTF-8 text: binary\.dat/u, async () => {
      await writeFile(join(fixture.cwd, "binary.dat"), Buffer.from([0xff, 0x78]));
    }],
  ];
  if (process.platform !== "win32") {
    cases.push([{ releaseReferences: { "outside.txt": [/(?<version>1\.0\.0)/u] } }, /regular file inside the repository: outside\.txt/u, async () => {
      await symlink(join(outside, "version.txt"), join(fixture.cwd, "outside.txt"));
    }]);
  }
  for (const [settings, error, setup] of cases) {
    await reset();
    if (setup) {
      await setup();
      await fixture.git("add", ".");
      await fixture.git("commit", "-qm", "Add reference fixture");
      await fixture.git("push", "-q", "origin", "master");
    }
    await assert.rejects(prepare(new ReleaseWorkflow({
      ...fixture.config, versionReferences: { "public/manifest.json": [manifestVersion] }, ...settings,
    }), fixture), error);
    assert.equal(await readFile(join(fixture.cwd, "README.md"), "utf8"), readme);
    assert.equal(await readFile(join(fixture.cwd, "public", "manifest.json"), "utf8"), manifest);
    assert.equal(fixture.published.length, 0);
  }
  await reset();
  await assert.rejects(new InitializeRelease({ ...fixture.config, versionReferences: { "/etc/passwd": [manifestVersion] } })
    .run(fixture), /paths must be relative/u);
});

test("reference options are validated and copied when workflows are constructed", () => {
  for (const Workflow of [ReleaseWorkflow, SemanticReleaseWorkflow]) {
    for (const [option, error] of [
      [null, /must map file paths or globs/u], [[installPin], /must map file paths or globs/u],
      [{ "README.md": installPin }, /nonempty array of regular expressions/u], [{ "README.md": [] }, /nonempty array/u],
      [{ "README.md": ["@(?<version>.+)"] }, /nonempty array of regular expressions/u],
      [{ "README.md": [/@(\d+\.\d+\.\d+)/u] }, /must capture a named group "version"/u],
      [{ "../README.md": [installPin] }, /paths must be relative/u], [{ "C:/README.md": [installPin] }, /paths must be relative/u],
      [{ "docs\\README.md": [installPin] }, /using \/ separators/u], [{ ".git/config": [installPin] }, /inside the repository/u],
      [{ "": [installPin] }, /paths must be relative/u],
    ]) {
      assert.throws(() => new Workflow({ versionReferences: option }), error);
      assert.throws(() => new Workflow({ releaseReferences: option }), error);
    }
  }
  const pattern = /version (?<version>\S+)/giu;
  const input = { "README.md": [pattern] };
  const workflow = new SemanticReleaseWorkflow({ versionReferences: input });
  const copied = workflow.config.versionReferences;
  assert.notEqual(copied, input);
  assert.ok(Object.isFrozen(copied));
  assert.ok(Object.isFrozen(copied["README.md"]));
  assert.notEqual(copied["README.md"][0], pattern);
  assert.equal(copied["README.md"][0].flags, "iu");
  input["README.md"].push(/other (?<version>\S+)/u);
  assert.equal(copied["README.md"].length, 1);
  assert.equal(new ReleaseWorkflow({ releaseReferences: input }).config.releaseReferences["README.md"].length, 2);
});
