import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import {
  prepare, release, verify, actionEntryPoints, buildCommitMessage, GitHubAction, SemanticReleaseWorkflow, Git, ZipArchive,
} from "../dist/index.js";
import { command } from "../dist/command.js";
import { readZip } from "../dist/zip.js";
import { actionProject, actionWorkflow, build, metadata, remoteRef } from "./helpers/action.js";

const unix = { skip: process.platform === "win32" };

test("a GitHub Action releases a reproducible build commit tagged on top of the release commit on main", async (t) => {
  const project = await actionProject(t);
  const { workflow, hosted, checked } = actionWorkflow(project);
  const built = await prepare(workflow, project.options);
  const { commit } = built.state.artifact;
  assert.match(commit, /^[a-f0-9]{40}$/u);
  assert.equal(built.state.branch, "main");
  assert.equal(built.state.registry, false);
  assert.equal((await project.git("rev-parse", "v1.0.0")).trim(), commit);
  assert.equal(await remoteRef(project, "refs/tags/v1.0.0"), null);

  const result = await release(workflow, { ...project.options, env: built.runtime.env });
  assert.equal(result.verification, "verified");
  assert.equal(result.artifact.commit, commit, "prepare and release create the same build commit");
  assert.deepEqual(checked, ["example output", "example output"]);

  const releaseCommit = result.releaseCommit;
  assert.equal(await remoteRef(project, "refs/tags/v1.0.0"), commit);
  assert.equal((await project.git("rev-list", "--parents", "-n", "1", commit)).trim(), `${commit} ${releaseCommit}`);
  assert.equal((await project.git("show", "-s", "--format=%s", commit)).trim(), buildCommitMessage("1.0.0"));
  assert.equal((await project.git("show", "-s", "--format=%an <%ae> %at|%cn <%ce> %ct", commit)).trim(),
    (await project.git("show", "-s", "--format=%an <%ae> %ct|%cn <%ce> %ct", releaseCommit)).trim());
  const remoteMain = await remoteRef(project, "refs/heads/main");
  assert.equal(remoteMain, result.nextCommit);
  assert.equal((await project.git("rev-parse", `${remoteMain}~1`)).trim(), releaseCommit);
  await assert.rejects(project.git("merge-base", "--is-ancestor", commit, remoteMain), "the branch never contains the build commit");

  const added = (await project.git("diff", "--name-status", releaseCommit, commit)).trim().split("\n");
  assert.deepEqual(added, ["A\tdist/chunks/1.js", "A\tdist/cleanup.js", "A\tdist/index.js"]);
  assert.equal(await project.remoteFile("v1.0.0", "action.yml"), metadata);
  assert.match(await project.remoteFile("v1.0.0", "dist/index.js"), /example output/u);
  assert.match(await project.remoteFile("v1.0.0", "CHANGELOG.md"), /^### 1\.0\.0 \(\d{4}\/\d{2}\/\d{2}\)$/mu);
  assert.doesNotMatch(await project.remoteFile("v1.0.0", "CHANGELOG.md"), /Your contribution here/u);
  assert.equal(JSON.parse(await project.remoteFile("v1.0.0", "package.json")).version, "1.0.0");
  assert.equal(JSON.parse(await project.remoteFile("main", "package.json")).version, "1.0.1");
  assert.match(await project.remoteFile("main", "CHANGELOG.md"), /^### 1\.0\.1 \(Next\)\n\n\* Your contribution here\.\n\n### 1\.0\.0 \(/u);
  await assert.rejects(project.remoteFile("main", "dist/index.js"));

  assert.equal(hosted.release.tag_name, "v1.0.0");
  assert.match(hosted.release.body, /Add an output/u);
  const asset = hosted.assets.get("example-action-v1.0.0.zip");
  assert.deepEqual(readZip(asset).map(({ path }) => path), ["action.yml", "dist/chunks/1.js", "dist/cleanup.js", "dist/index.js"]);
  assert.deepEqual(asset, await readFile(join(project.artifacts, "example-action-v1.0.0.zip")));
  assert.equal(await project.git("status", "--porcelain", "--untracked-files=all"), "");

  // A fresh clone with another Git identity rebuilds the same build commit.
  const clone = join(project.directory, "clone");
  await project.git("clone", "--quiet", "--branch", "main", project.remote, clone);
  await project.run("git", ["-C", clone, "checkout", "--quiet", releaseCommit]);
  await project.run("git", ["-C", clone, "config", "user.name", "Someone Else"]);
  await project.run("npm", ["run", "build"], { cwd: clone });
  const rebuilt = await new GitHubAction().bind({ cwd: clone, run: project.run, env: project.environment }).commit("1.0.0");
  assert.equal(rebuilt.commit, commit);

  const verified = await verify(project.options);
  assert.equal(verified.verification, "verified");
  const state = JSON.parse(await readFile(join(project.artifacts, "release.json"), "utf8"));
  await writeFile(join(project.artifacts, "release.json"), JSON.stringify({ ...state, artifact: { ...state.artifact, commit: releaseCommit } }));
  await assert.rejects(verify(project.options), /Remote ref mismatch: refs\/tags\/v1\.0\.0/u);
  await writeFile(join(project.artifacts, "release.json"), JSON.stringify({ ...state, artifact: { ...state.artifact, commit: "main" } }));
  await assert.rejects(verify(project.options), /Invalid retained build commit identity/u);
  const zip = new ZipArchive({ cwd: project.cwd, run: project.run, env: project.environment });
  await assert.rejects(verify({ ...project.options, services: { project: zip } }), /Invalid retained build commit identity/u);
  await writeFile(join(project.cwd, "package.json"), JSON.stringify({ name: "example-action", version: "1.0.1", workspaces: ["a"] }));
  await assert.rejects(new GitHubAction({ cwd: project.cwd }).read(), /without workspaces/u);
});

test("GitHub Action reruns reuse matching outputs and refuse conflicting builds", async (t) => {
  const project = await actionProject(t, { branch: "master" });
  const hosted = { release: null, assets: new Map(), failure: "GitHub is unavailable" };
  const { workflow } = actionWorkflow(project, { hosted });
  const built = await prepare(workflow, project.options);
  const options = { ...project.options, env: built.runtime.env };
  await assert.rejects(release(workflow, options), /GitHub is unavailable/u);
  const tag = await remoteRef(project, "refs/tags/v1.0.0");
  assert.equal(tag, built.state.artifact.commit);
  assert.equal(await remoteRef(project, "refs/heads/master"), built.state.releaseCommit);

  delete hosted.failure;
  const completed = await release(workflow, options);
  assert.equal(completed.artifact.commit, tag);
  assert.equal(hosted.creates, 1);
  assert.equal(await remoteRef(project, "refs/tags/v1.0.0"), tag);

  // A different build of the same release commit conflicts with the existing tag and archive.
  await project.git("reset", "--hard", "--quiet", built.state.releaseCommit);
  const conflicting = { ...options, env: { ...options.env, ACTION_BUILD_VARIANT: " changed" } };
  await assert.rejects(release(workflow, conflicting), /Existing archive differs from the reproducible build/u);
  await assert.rejects(release(workflow, { ...conflicting, artifacts: join(project.directory, "fresh") }),
    /Release tag points at another commit/u);
  assert.equal(await remoteRef(project, "refs/tags/v1.0.0"), tag);
  assert.equal((await project.git("rev-parse", "v1.0.0")).trim(), tag);
});

test("a build commit tag does not satisfy a release of another project type", async (t) => {
  const project = await actionProject(t);
  const { workflow } = actionWorkflow(project);
  const built = await prepare(workflow, project.options);
  const repository = new Git(project.run, { branch: "main" });
  await repository.initialize();
  // The build commit tag identifies its parent as the release commit.
  assert.equal(await repository.commitRelease("1.0.0", (await project.git("rev-parse", "HEAD^{tree}")).trim()),
    built.state.releaseCommit);
  await assert.rejects(repository.tag("1.0.0"), /Release tag points at another commit/u);
  await assert.rejects(repository.push(built.state.releaseCommit, "1.0.0"), /Release tag points at another commit/u);
  assert.equal(await remoteRef(project, "refs/tags/v1.0.0"), null);
});

test("action metadata declares JavaScript entry points", () => {
  assert.deepEqual(actionEntryPoints(metadata), ["dist/index.js", "dist/cleanup.js"]);
  assert.deepEqual(actionEntryPoints("runs:\n  using: node20\n  pre: dist/setup.js\n  main: dist/main.js\n"),
    ["dist/setup.js", "dist/main.js"]);
  for (const [source, error] of [
    ["runs: [", /Invalid action metadata/u],
    ["name: x\n", /must declare runs/u],
    ["", /must declare runs/u],
    ["runs: [node24]\n", /must declare runs/u],
    ["runs:\n  using: composite\n  steps: []\n", /runs\.using must be a nodeNN runtime/u],
    ["runs:\n  using: node24\n", /must declare runs\.main/u],
    ["runs:\n  using: node24\n  main: 1\n", /runs\.main must be a file path/u],
    ["runs:\n  using: node24\n  main: ' '\n", /runs\.main must be a file path/u],
    ["runs:\n  using: node24\n  main: ../index.js\n", /relative path/u],
    ["runs:\n  using: node24\n  main: dist/index.js\n  post: /cleanup.js\n", /relative path/u],
  ]) assert.throws(() => actionEntryPoints(source), error);
});

test("GitHubAction options are validated and bound to each invocation", () => {
  for (const [options, error] of [
    [{ build: [] }, /nonempty array of program/u], [{ build: "npm run build" }, /nonempty array of program/u],
    [{ output: [] }, /nonempty array of paths/u], [{ output: "dist" }, /nonempty array of paths/u],
    [{ output: ["../dist"] }, /relative path/u], [{ output: ["dist", "dist"] }, /repeat or overlap/u],
    [{ output: ["dist", "dist/chunks"] }, /repeat or overlap/u], [{ output: ["action.yml"] }, /action metadata/u],
    [{ name: "../x" }, /filename-safe/u], [{ run: "git" }, /command function/u],
  ]) assert.throws(() => new GitHubAction(options), error);
  const defaults = new GitHubAction();
  assert.deepEqual([defaults.build, defaults.output, defaults.cwd, defaults.run], [["npm", "run", "build"], ["dist"], process.cwd(), command]);
  assert.ok(Object.isFrozen(defaults) && Object.isFrozen(defaults.output) && Object.isFrozen(defaults.build));
  const run = async () => "";
  const bound = new GitHubAction({ build: ["make"], output: ["dist", "lib"], name: "action" }).bind({ cwd: "/project", run, env: { A: "1" } });
  assert.deepEqual([bound.build, bound.output, bound.name, bound.cwd, bound.run, bound.env.A], [["make"], ["dist", "lib"], "action", "/project", run, "1"]);
  assert.equal(defaults.filename({ name: "@owner/example", version: "1.0.0" }), "owner-example-v1.0.0.zip");
  assert.throws(() => defaults.filename({ name: "example", version: "1.0" }), /numeric/u);
  assert.throws(() => new SemanticReleaseWorkflow({ project: defaults, publisher: null }), /does not support GitHubAction/u);
});

async function failure(t, files, error, settings = {}) {
  const project = await actionProject(t, { files });
  for (const path of settings.remove || []) await project.git("rm", "--quiet", path);
  if (settings.remove) await project.commit("Remove files");
  const { workflow } = actionWorkflow(project, settings);
  await assert.rejects(prepare(workflow, project.options), error);
  assert.equal((await project.git("tag", "--list")).trim(), "");
}

test("GitHubAction rejects missing metadata, tracked or missing output, and entry points outside the build", async (t) => {
  await failure(t, {}, /exactly one action\.yml or action\.yaml/u, { remove: ["action.yml"] });
  await failure(t, { "action.yaml": metadata }, /exactly one action\.yml or action\.yaml/u);
  await failure(t, { "action.yml": "runs:\n  using: node24\n  main: src/index.js\n" }, /entry point is not in the build output: src\/index\.js/u);
  await failure(t, { "action.yml": "runs:\n  using: node24\n  main: dist/missing.js\n" }, /entry point is not in the build output: dist\/missing\.js/u);
  await failure(t, { "lib/tracked.js": "x\n" }, /must be ignored and untracked; the release commit contains lib/u, { project: { output: ["dist", "lib"] } });
  await failure(t, {}, /build output is missing: out/u, { project: { output: ["dist", "out"] } });
  await failure(t, { "build.mjs": 'import { mkdirSync } from "node:fs"; mkdirSync("dist", { recursive: true });\n' },
    /build produced no files in dist/u);
  await failure(t, {}, /Command failed|exit/iu, { project: { build: [process.execPath, "-e", "process.exit(4)"] } });
});

test("GitHubAction rejects symbolic links in build output and mismatched archives", unix, async (t) => {
  await failure(t, { "build.mjs": build + 'import { symlinkSync } from "node:fs";\nsymlinkSync("index.js", "dist/alias.js");\n' },
    /only regular files: dist\/alias\.js/u);
  const project = await actionProject(t);
  await project.run("npm", ["run", "build"]);
  const action = new GitHubAction({ name: "example-action" }).bind({ cwd: project.cwd, run: project.run, env: project.environment });
  await mkdir(project.artifacts, { recursive: true });
  const identity = { name: "example-action", version: "1.0.0" };
  const artifact = await action.pack(project.artifacts, identity);
  await action.intact(project.artifacts, { ...identity, artifact });
  await assert.rejects(action.intact(project.artifacts, { ...identity, artifact: { ...artifact, commit: undefined } }),
    /Invalid retained build commit identity/u);
  await assert.rejects(action.intact(project.artifacts, { ...identity, artifact: { ...artifact, shasum: "0" } }),
    /Retained archive integrity mismatch/u);
  await writeFile(join(project.cwd, "dist", "index.js"), "changed();\n");
  await assert.rejects(action.consumer(join(project.artifacts, artifact.filename), async () => assert.fail("Mismatched")),
    /entries differ from the build commit/u);
  await rm(join(project.cwd, "dist"), { recursive: true });
  await symlink(project.cwd, join(project.cwd, "dist"));
  await assert.rejects(action.commit("1.0.0"), /only regular files: dist/u);
});
