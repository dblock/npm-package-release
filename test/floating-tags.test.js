import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  prepare, release, verify, floatingTagNames, Git, MoveFloatingTags, ReleaseWorkflow, SemanticReleaseWorkflow,
} from "../dist/index.js";
import { verifyRetained } from "../dist/steps.js";
import { ReleaseTestProject } from "../dist/testing.js";
import { actionProject, actionWorkflow, remoteRef } from "./helpers/action.js";

async function addNote(project, note) {
  const path = join(project.cwd, "CHANGELOG.md");
  await writeFile(path, (await readFile(path, "utf8")).replace("* Your contribution here.", `* ${note}\n* Your contribution here.`));
  await project.git("commit", "--quiet", "-am", note);
  await project.git("push", "--quiet", "origin", project.branch);
}

test("a GitHub Action release moves its major and minor floating tags to the build commit", async (t) => {
  const project = await actionProject(t);
  const { workflow } = actionWorkflow(project, { config: { floatingTags: ["major", "minor"] } });
  assert.ok(workflow.workflow.steps.includes("floating-tags"));
  assert.ok(Object.isFrozen(workflow.config.floatingTags));
  const built = await prepare(workflow, project.options);
  assert.equal(await remoteRef(project, "refs/tags/v1"), null, "preparation never moves floating tags");
  const first = await release(workflow, { ...project.options, env: built.runtime.env });
  assert.deepEqual(first.floatingTags, ["v1", "v1.0"]);
  for (const tag of ["refs/tags/v1", "refs/tags/v1.0", "refs/tags/v1.0.0"]) assert.equal(await remoteRef(project, tag), first.artifact.commit);
  assert.equal((await verify(project.options)).verification, "verified");

  await addNote(project, "Fix an output");
  const second = await release(workflow, { ...project.options, artifacts: join(project.directory, "second") });
  assert.equal(second.version, "1.0.1");
  assert.notEqual(second.artifact.commit, first.artifact.commit);
  for (const tag of ["refs/tags/v1", "refs/tags/v1.0", "refs/tags/v1.0.1"]) assert.equal(await remoteRef(project, tag), second.artifact.commit);
  assert.equal(await remoteRef(project, "refs/tags/v1.0.0"), first.artifact.commit, "release tags never move");
  assert.equal((await verify(project.options)).verification, "verified", "a later release still satisfies earlier floating tags");

  // Switching to major-only moves vX and leaves vX.Y frozen.
  await addNote(project, "Add an input");
  const major = actionWorkflow(project, { config: { floatingTags: ["major"] } }).workflow;
  const third = await release(major, { ...project.options, version: "1.1.0", artifacts: join(project.directory, "third") });
  assert.deepEqual(third.floatingTags, ["v1"]);
  assert.equal(await remoteRef(project, "refs/tags/v1"), third.artifact.commit);
  assert.equal(await remoteRef(project, "refs/tags/v1.0"), second.artifact.commit);
  assert.equal(await remoteRef(project, "refs/tags/v1.1"), null);

  // Without the option, no floating tags move.
  await addNote(project, "Document the action");
  const plain = actionWorkflow(project).workflow;
  assert.equal(plain.workflow.steps.includes("floating-tags"), false);
  const fourth = await release(plain, { ...project.options, artifacts: join(project.directory, "fourth") });
  assert.equal(fourth.floatingTags, undefined);
  assert.equal(await remoteRef(project, "refs/tags/v1"), third.artifact.commit);
});

async function tagged(project, version, file = version) {
  await project.write(`${file}.txt`, `${version}\n`);
  await project.commit(`Release ${version}`);
  await project.git("tag", `v${version}`);
  await project.git("push", "--quiet", "origin", `v${version}`);
  return (await project.git("rev-parse", "HEAD")).trim();
}

test("floating tags are created, reconciled, moved forward, and never moved backwards", async (t) => {
  const project = await ReleaseTestProject.create({ branch: "main" });
  t.after(() => project.dispose());
  let pushes = 0;
  let race = null;
  const repository = new Git(async (program, args, options) => {
    if (args[0] === "push") {
      pushes++;
      if (race) {
        await project.git("--git-dir", project.remote, "update-ref", "refs/tags/v1", race);
        race = null;
      }
    }
    return project.run(program, args, options);
  }, { branch: "main" });
  const first = await tagged(project, "1.0.0");
  assert.deepEqual(await repository.floatingTags("1.0.0", first, ["major", "minor"]), ["v1", "v1.0"]);
  assert.equal(await remoteRef(project, "refs/tags/v1"), first);
  assert.equal(await remoteRef(project, "refs/tags/v1.0"), first);
  assert.equal(pushes, 1);
  assert.deepEqual(await repository.floatingTags("1.0.0", first, ["minor", "major"]), ["v1.0", "v1"]);
  assert.equal(pushes, 1, "matching floating tags are reused without a push");

  const second = await tagged(project, "1.1.0");
  assert.deepEqual(await repository.floatingTags("1.1.0", second, ["major", "minor"]), ["v1", "v1.1"]);
  assert.equal(await remoteRef(project, "refs/tags/v1"), second);
  assert.equal(await remoteRef(project, "refs/tags/v1.0"), first);
  await repository.verifyFloatingTags("1.0.0", ["v1", "v1.0"]);

  const patch = await tagged(project, "1.0.1");
  // A maintenance release moves its minor tag but leaves the major tag at the later release.
  assert.deepEqual(await repository.floatingTags("1.0.1", patch, ["major", "minor"]), ["v1.0"]);
  assert.equal(await remoteRef(project, "refs/tags/v1"), second);
  assert.equal(await remoteRef(project, "refs/tags/v1.0"), patch);
  const pushed = pushes;
  assert.deepEqual(await repository.floatingTags("1.0.1", patch, ["major"]), []);
  assert.equal(pushes, pushed);
  await assert.rejects(repository.floatingTags("1.1.0", patch, ["major"]), /Remote ref mismatch: refs\/tags\/v1\.1\.0/u);
  await assert.rejects(repository.floatingTags("1.2.0", patch, ["major"]), /Remote ref mismatch: refs\/tags\/v1\.2\.0/u);

  // A floating tag on a commit without a release tag in its line needs inspection.
  const unknown = await tagged(project, "2.0.0");
  await project.git("push", "--quiet", "origin", `${first}:refs/tags/v2`);
  await assert.rejects(repository.floatingTags("2.0.0", unknown, ["major"]), /v2 points at a commit without a v2 release tag/u);
  assert.equal(await remoteRef(project, "refs/tags/v2"), first);

  // Annotated floating tags resolve to their commit and move with a lease on the tag object.
  const annotated = await tagged(project, "3.0.0");
  await project.git("tag", "-a", "-m", "Major 3", "v3", annotated);
  await project.git("push", "--quiet", "origin", "v3");
  const next = await tagged(project, "3.0.1");
  assert.deepEqual(await repository.floatingTags("3.0.1", next, ["major"]), ["v3"]);
  assert.equal(await remoteRef(project, "refs/tags/v3"), next);

  // A concurrent move between inspection and push fails the lease without overwriting it.
  const later = await tagged(project, "1.2.0");
  race = patch;
  await assert.rejects(repository.floatingTags("1.2.0", later, ["major"]), /stale info|rejected/u);
  assert.equal(await remoteRef(project, "refs/tags/v1"), patch);

  await assert.rejects(repository.verifyFloatingTags("1.2.0", ["v1"]), /Remote ref mismatch: refs\/tags\/v1$/u);
  await assert.rejects(repository.verifyFloatingTags("4.0.0", ["v4"]), /Remote ref mismatch: refs\/tags\/v4$/u);
  for (const tags of [["v2"], ["1"], ["v1.2.3"], [1]]) {
    await assert.rejects(repository.verifyFloatingTags("1.2.0", tags), /Invalid retained floating tag/u);
  }
});

test("floating tag options are validated and never apply to prerelease versions", async () => {
  for (const Workflow of [ReleaseWorkflow, SemanticReleaseWorkflow]) {
    for (const floatingTags of [[], "major", ["patch"], ["major", "major"], [null], {}]) {
      assert.throws(() => new Workflow({ floatingTags }), /floatingTags must be a nonempty list of distinct "major" and "minor"/u);
    }
    assert.deepEqual(new Workflow({ floatingTags: ["minor"] }).config.floatingTags, ["minor"]);
    assert.ok(new Workflow({ floatingTags: ["minor"] }).workflow.steps.includes("floating-tags"));
    assert.equal(new Workflow().workflow.steps.includes("floating-tags"), false);
  }
  assert.deepEqual(floatingTagNames("12.3.4", ["major", "minor"]), ["v12", "v12.3"]);
  assert.deepEqual(floatingTagNames("0.1.0", ["minor"]), ["v0.1"]);
  assert.throws(() => floatingTagNames("1.0.0-beta.1", ["major"]), /numeric/u);

  const input = (repository, floatingTags) => ({
    kind: "hosted", state: { version: "1.0.0", releaseCommit: "a".repeat(40), artifact: {} },
    runtime: { config: { floatingTags }, services: { repository }, log() {} },
  });
  const skipped = input({}, undefined);
  assert.equal(await new MoveFloatingTags().run(skipped), skipped);
  await assert.rejects(new MoveFloatingTags().run(input({}, ["major"])), /repository that implements floatingTags/u);

  const state = {
    name: "example", version: "1.0.0", releaseCommit: "a".repeat(40), artifact: { filename: "example.zip" },
    registry: false, floatingTags: ["v1"], verificationOptions: { attempts: 1, delay: 0 },
  };
  const saved = [];
  const services = (repository) => ({
    project: { async intact() {} }, repository: { async verifyTag() {}, ...repository }, verifier: null,
    store: { directory: "unused", async read() { return state; }, async save(value) { saved.push(value); } },
  });
  await assert.rejects(verifyRetained(() => {}, { async summary() {} }, services({})), /floating tags cannot be verified/u);
  assert.equal(saved.at(-1).verification, "failed");
  const checked = [];
  await verifyRetained(() => {}, { async summary() {} }, services({ async verifyFloatingTags(...args) { checked.push(args); } }));
  assert.deepEqual(checked, [["1.0.0", ["v1"]]]);
});
