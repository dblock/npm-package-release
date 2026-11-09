import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { releaseFixture } from "./release-fixture.js";

export async function checkComposition(t, api) {
  const fixture = await releaseFixture(t);
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
      await fixture.config.validateArtifact(context);
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
    async run(context) {
      assert.equal(context.kind, "built");
      assert.equal(fixture.published.length, 0);
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
    async available(name, version) { await npm.available(name, version); }
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
  const workflow = api.Workflow.start(new api.ReleaseObserver())
    .then(new api.InitializeRelease({
      ...fixture.config, changelog: null, repository: "not-a-github-repository",
      async validate() { assert.fail("The class validator must replace the legacy hook"); },
    }, {
      changelog: new ProjectNotes(), versions: new NextMinor(),
      validator: new ProjectChecks(), host: new ProjectHost(), publisher,
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
  const result = await api.release(workflow, { ...fixture, version: "0.2.0" });
  assert.equal(result.verification, "verified");
  assert.equal(result.nextVersion, "0.3.0");
  assert.equal(fixture.published.length, 1);
  assert.equal(fixture.events.filter((event) => event === "project publication").length, 1);
  assert.ok(fixture.events.indexOf("project registry view") > fixture.events.indexOf("next"));
  assert.equal(JSON.parse(await readFile(join(fixture.cwd, "package.json"), "utf8")).version, "0.3.0");
  assert.equal(await readFile(notesPath, "utf8"), "Next 0.3.0\nCustom release 0.2.0\n");
  assert.ok(fixture.events.indexOf("project artifact check") < fixture.events.indexOf("npm publish"));
  assert.ok(fixture.events.indexOf("npm publish") < fixture.events.indexOf("project hosting"));
  assert.ok(fixture.events.indexOf("project hosting") < fixture.events.indexOf("next"));
  const verified = await api.verify({ ...fixture, services: { publisher } });
  assert.equal(verified.version, "0.2.0");
  assert.equal(verified.verification, "verified");
}
