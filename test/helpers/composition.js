import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { releaseFixture } from "./release-fixture.js";

export async function checkDefaultChangelog(t, api) {
  const fixture = await releaseFixture(t);
  const path = join(fixture.cwd, "CHANGELOG.md");
  await writeFile(path, "# Changelog\n\n## [Unreleased]\n\n- Ship a package.\n");
  await fixture.git("add", "CHANGELOG.md");
  await fixture.git("commit", "-m", "Use Keep a Changelog");
  await fixture.git("push", "origin", "master");
  const config = { ...fixture.config };
  delete config.changelog;
  const workflow = new api.ReleaseWorkflow(config);
  const built = await workflow.prepare(fixture);
  assert.ok(built.runtime.services.changelog instanceof api.KeepAChangelog);
  assert.match(await readFile(path, "utf8"), /## \[0\.1\.0\] - \d{4}-\d{2}-\d{2}/u);
  await workflow.run({ ...fixture, env: built.runtime.env });
  assert.equal(fixture.published.length, 1);
  assert.match(await readFile(path, "utf8"), /## \[Unreleased\]\n\n## \[0\.1\.0\]/u);
  const templatePath = join(fixture.cwd, "TEMPLATE.md");
  await writeFile(templatePath, "## [Unreleased]\n\n### Added\n\n- Ship.\n* Contribute.\n\n### Fixed\n\n* Contribute.\n");
  const changelog = new api.KeepAChangelog("TEMPLATE.md", {
    placeholder: "* Contribute.", sections: ["Added", "Fixed"],
  });
  const notes = await changelog.release({ cwd: fixture.cwd, version: "0.1.0", date: "2026-11-11" });
  assert.doesNotMatch(notes, /Contribute|### Fixed/u);
  await changelog.next({ cwd: fixture.cwd, version: "0.1.1", releasedVersion: "0.1.0" });
  assert.match(await readFile(templatePath, "utf8"), /### Fixed\n\n\* Contribute\./u);
}

export async function checkComposition(t, api) {
  const fixture = await releaseFixture(t);
  const snapshots = [];
  class PortableExecution extends api.LocalExecutionProvider {
    name = "portable-consumer";
  }
  const provider = new PortableExecution({});
  const notesPath = join(fixture.cwd, "PROJECT_NOTES.md");
  class ProjectNotes {
    async release({ version }) {
      const notes = `Custom release ${version}`;
      await writeFile(notesPath, notes + "\n");
      return notes;
    }
    async next({ version }) {
      await writeFile(notesPath, `Next ${version}\n` + await readFile(notesPath, "utf8"));
    }
  }
  class NextMinor {
    select(current, requested) {
      const version = requested || current;
      const [major, minor] = version.split(".").map(Number);
      return { version, nextVersion: `${major}.${minor + 1}.0` };
    }
  }
  class ProjectChecks {
    async validate(context) {
      await context.run("npm", ["test"]);
      await context.run("npm", ["run", "lint"]);
    }
    async artifact(context) {
      await fixture.config.validator.artifact(context);
    }
  }
  class ProjectHost {
    async create(identity, { archive, notes }) {
      assert.equal(identity.version, "0.2.0");
      assert.ok((await readFile(archive)).length);
      assert.equal(await readFile(notes, "utf8"), "Custom release 0.2.0\n");
      fixture.events.push("project hosting");
    }
  }
  class ArtifactPolicy {
    id = "project-artifact-policy";
    async run(context, execution, client) {
      assert.equal(context.kind, "built");
      assert.equal(fixture.published.length, 0);
      assert.equal(client, provider);
      assert.equal(execution.provider, "portable-consumer");
      assert.equal(execution.steps.build.outcome, "success");
      assert.equal(execution.release.manifestVersion, "0.1.0");
      assert.equal(execution.release.version, "0.2.0");
      assert.equal(execution.release.notes, "Custom release 0.2.0");
      assert.equal(context.release, execution.release);
      snapshots.push(execution);
      assert.throws(() => { context.state.version = "9.9.9"; }, TypeError);
      assert.throws(() => { context.state.artifact.integrity = "changed"; }, TypeError);
      assert.ok((await readFile(join(fixture.artifacts, context.state.artifact.filename))).length);
      fixture.events.push("project artifact check");
      return context;
    }
  }
  const npm = new api.NpmPackage(fixture.cwd, (program, args, options) =>
    fixture.run(program, args, { cwd: fixture.cwd, env: fixture.env, ...options }));
  class ProjectPublisher {
    async view(name, version) {
      fixture.events.push("project registry view");
      return npm.view(name, version);
    }
    async publish(archive) {
      fixture.events.push("project publication");
      await npm.publish(archive);
    }
  }
  const publisher = new ProjectPublisher();
  class ProjectRepository extends api.Git {
    async commitRelease(version, tree) {
      fixture.events.push(`commit release ${version}`);
      return super.commitRelease(version, tree);
    }
    async commitNext(version, tree) {
      fixture.events.push(`commit next ${version}`);
      return super.commitNext(version, tree);
    }
  }
  const repository = new ProjectRepository((program, args, options) =>
    fixture.run(program, args, { cwd: fixture.cwd, env: fixture.env, ...options }));
  const workflow = api.Workflow.start(new api.ReleaseObserver())
    .then(new api.InitializeRelease({
      ...fixture.config,
      changelog: new ProjectNotes(), versions: new NextMinor(),
      validator: new ProjectChecks(), host: new ProjectHost(), publisher, repository,
      verifier: new api.RegistryVisibility(publisher, { attempts: 3, delay: 0 }),
    }))
    .then(new api.PrepareRelease())
    .then(new api.ValidateRelease())
    .then(new api.CommitRelease())
    .then(new api.BuildArtifact())
    .then(new ArtifactPolicy())
    .then(new api.PublishArtifact())
    .then(new api.PushRelease())
    .then(new api.CreateHostedRelease())
    .then(new api.PrepareNextVersion())
    .then(new api.VerifyRelease());
  const result = await api.release(workflow, {
    ...fixture, version: "0.2.0", provider,
    observer: { async succeeded({ execution }) { snapshots.push(execution); } },
  });
  assert.equal(result.verification, "verified");
  assert.equal(result.nextVersion, "0.3.0");
  assert.ok(fixture.events.includes("commit release 0.2.0"));
  assert.ok(fixture.events.includes("commit next 0.3.0"));
  assert.equal(fixture.published.length, 1);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].steps.publish, undefined);
  assert.equal(snapshots[1].steps.publish.outcome, "success");
  assert.equal(fixture.events.filter((event) => event === "project publication").length, 1);
  assert.ok(fixture.events.lastIndexOf("project registry view") > fixture.events.indexOf("next"));
  assert.equal(JSON.parse(await readFile(join(fixture.cwd, "package.json"), "utf8")).version, "0.3.0");
  assert.equal(await readFile(notesPath, "utf8"), "Next 0.3.0\nCustom release 0.2.0\n");
  assert.ok(fixture.events.indexOf("project artifact check") < fixture.events.indexOf("npm publish"));
  assert.ok(fixture.events.indexOf("npm publish") < fixture.events.indexOf("project hosting"));
  assert.ok(fixture.events.indexOf("project hosting") < fixture.events.indexOf("next"));
  const verified = await api.verify({ ...fixture, services: { publisher }, provider });
  assert.equal(verified.version, "0.2.0");
  assert.equal(verified.verification, "verified");
}
