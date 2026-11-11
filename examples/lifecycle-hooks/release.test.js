import assert from "node:assert/strict";
import { cp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { ReleaseTestProject, TestPublisher } from "npm-package-release/testing";
import { createReleaseWorkflow } from "./workflow.js";

async function fixture(t, newline) {
  const project = await ReleaseTestProject.create();
  t.after(() => project.dispose());
  await project.copyFiles(fileURLToPath(new URL(".", import.meta.url)), [
    "README.md", "CHANGELOG.md", "workflow.js", "npr.config.js", "index.js", "check.js",
  ]);
  for (const path of ["README.md", "CHANGELOG.md"]) {
    await project.write(path, (await readFile(join(project.cwd, path), "utf8")).replace(/\r?\n/gu, newline));
  }
  await project.write("package.json", JSON.stringify({
    name: "@npr-test/lifecycle-example", version: "0.1.0", type: "module", exports: "./index.js",
    files: ["index.js", "README.md"],
    repository: { type: "git", url: "git+https://github.com/npr-test/lifecycle-example.git" },
    scripts: { test: "node --test check.js", lint: "node --check index.js" },
  }, null, 2) + "\n");
  await project.commit();
  return project;
}

for (const { label, newline } of [{ label: "LF", newline: "\n" }, { label: "CRLF", newline: "\r\n" }]) {
  test(`the real lifecycle workflow updates ${label} files and reuses its checkpoint`, async (t) => {
    const project = await fixture(t, newline);
    const workflow = createReleaseWorkflow(project.services);
    const built = await workflow.prepare({ ...project.options, version: "0.2.0" });
    assert.equal(await project.publisher.view(built.state.name, "0.2.0"), null);
    const checkpoint = join(project.directory, "checkpoint");
    await cp(project.artifacts, checkpoint, { recursive: true });
    const result = await workflow.complete(project.options);
    assert.equal(result.verification, "verified");
    assert.ok((await project.remoteFile("v0.2.0", "README.md")).includes(
      `## Release Status${newline}${newline}Documentation for version 0.2.0.${newline}`,
    ));
    assert.ok((await project.remoteFile("master", "README.md")).includes(
      `## Release Status${newline}${newline}Documentation for version 0.2.1.${newline}`,
    ));
    assert.doesNotMatch(await project.remoteFile("v0.2.0", "CHANGELOG.md"), /### Fixed/u);
    assert.ok((await project.remoteFile("master", "CHANGELOG.md")).includes(
      `### Fixed${newline}${newline}- Your contribution here.`,
    ));
    const archive = project.publisher.archive(result.name, result.version);
    const bytes = await readFile(archive);
    assert.deepEqual(bytes, await readFile(join(project.artifacts, result.artifact.filename)));
    assert.deepEqual(bytes, await readFile(project.host.archive(result.name, result.version)));
    const before = (await stat(archive)).mtimeMs;
    await workflow.complete({ ...project.options, artifacts: checkpoint });
    assert.deepEqual(await readFile(archive), bytes);
    assert.equal((await stat(archive)).mtimeMs, before);
    assert.equal(await project.git("status", "--porcelain"), "");
  });
}

test("rejected publication preserves recovery evidence and leaves the remote release ref absent", async (t) => {
  const project = await fixture(t, "\r\n");
  const workflow = createReleaseWorkflow({
    ...project.services, publisher: new TestPublisher(join(project.directory, "registry"), { failure: "Publication rejected" }),
  });
  await assert.rejects(workflow.run({ ...project.options, version: "0.2.0" }), /Publication rejected/u);
  await assert.rejects(project.remoteFile("v0.2.0", "README.md"));
  assert.ok((await project.remoteFile("master", "README.md")).includes(
    "## Release Status\r\n\r\nDocumentation for version 0.1.0.\r\n",
  ));
  const state = JSON.parse(await readFile(join(project.artifacts, "release.json"), "utf8"));
  assert.equal(state.failedStep, "publish");
  assert.ok((await readFile(join(project.artifacts, "checkpoint.json"), "utf8")).includes("0.2.0"));
});
