import assert from "node:assert/strict";
import test, { describe } from "node:test";
import * as api from "../dist/index.js";
import { checkComposition, checkDefaultChangelog } from "./helpers/composition.js";
import { releaseFixture } from "./helpers/release-fixture.js";

describe("composable release workflows", { concurrency: 2 }, () => {
  test("class steps compose immutable reusable pipelines and preserve typed outputs", async () => {
    class SelectVersion {
      id = "select";
      async run({ version }) { return { released: version }; }
    }
    class Annotate {
      id = "annotate";
      async run({ released }) { return `released ${released}`; }
    }
    const selected = api.Workflow.start().then(new SelectVersion());
    const annotated = selected.then(new Annotate());
    assert.deepEqual(await selected.run({ version: "1.2.3" }), { released: "1.2.3" });
    assert.equal(await api.release(annotated, { version: "2.0.0" }), "released 2.0.0");
    assert.equal(await annotated.run({ version: "3.0.0" }), "released 3.0.0");
    assert.deepEqual(selected.steps, ["select"]);
    assert.throws(() => annotated.steps.push("surprise"), TypeError);
    assert.throws(() => selected.then(new SelectVersion()), /Duplicate workflow step/u);
    assert.throws(() => selected.then({ id: "", run: async () => {} }), /requires an id/u);
    assert.throws(() => selected.then({ id: "invalid" }), /run method/u);
  });

  test("observers see step order and failures halt without hiding the original error", async () => {
    const events = [];
    const error = new Error("Custom step failed");
    const workflow = api.Workflow.start({
      async started({ id }) { events.push(`start ${id}`); },
      async completed({ id, output }) { events.push(`complete ${id} ${output}`); },
      async failed({ id, error: actual }) {
        assert.equal(actual, error);
        events.push(`fail ${id}`);
        throw new Error("Reporting also failed");
      },
    })
      .then({ id: "first", async run(input) { return input + 1; } })
      .then({ id: "fail", async run() { throw error; } })
      .then({ id: "never", async run() { assert.fail("Must stop"); } });
    await assert.rejects(workflow.run(1), (actual) => actual === error);
    assert.deepEqual(events, ["start first", "complete first 2", "start fail", "fail fail"]);
    await assert.rejects(api.Workflow.start().then({
      id: "unobserved", async run() { throw error; },
    }).run({}), (actual) => actual === error);
  });

  test("custom classes replace services and add a real prepublication artifact step", async (t) => {
    await checkComposition(t, api);
  });

  test("the default changelog supports Keep a Changelog through repeated preparation", async (t) => {
    await checkDefaultChangelog(t, api);
  });

  test("release entry points reject plain configuration and method-bag exports", async () => {
    for (const value of [
      {}, null, { changelog: { format: "intridea" } },
      { id: "plain-object", async run() { assert.fail("Must not execute"); },
        async prepare() { assert.fail("Must not prepare"); } },
    ]) {
      await assert.rejects(api.release(value), /workflow instance/u);
      await assert.rejects(api.prepare(value), /workflow instance/u);
    }
  });

  test("removed service selectors fail before commands or preparation", async () => {
    for (const config of [
      { changelog: { format: "intridea" } }, { github: false },
      { verification: { attempts: 1 } }, { validate: async () => {} }, { validateArtifact: async () => {} },
    ]) {
      await assert.rejects(new api.ReleaseWorkflow(config).prepare({
        run: async () => { assert.fail("Invalid configuration must not execute commands"); },
      }), /Unsupported release option|Changelog must implement/u);
    }
    assert.throws(() => new api.RegistryVisibility({}, { attempts: 0 }), /bounded/u);
  });

  test("a composed workflow can omit hosting and next-development without republishing", async (t) => {
    const fixture = await releaseFixture(t);
    const workflow = api.Workflow.start(new api.ReleaseObserver())
      .then(new api.InitializeRelease(fixture.config))
      .then(new api.PrepareRelease())
      .then(new api.ValidateRelease())
      .then(new api.CommitRelease())
      .then(new api.BuildArtifact())
      .then(new api.PublishArtifact())
      .then(new api.PushRelease())
      .then(new api.VerifyRelease());
    const result = await api.release(workflow, fixture);
    assert.equal(result.verification, "verified");
    assert.equal(result.phase, "pushed");
    assert.equal(result.nextCommit, undefined);
    assert.equal(fixture.published.length, 1);
    assert.equal(fixture.events.includes("gh release"), false);
    assert.equal(fixture.events.includes("next"), false);
    await fixture.git("show", "v0.1.0:package.json");
  });

  test("a custom step failure persists its identity and stops before publication", async (t) => {
    const fixture = await releaseFixture(t);
    const workflow = api.Workflow.start(new api.ReleaseObserver())
      .then(new api.InitializeRelease(fixture.config))
      .then(new api.PrepareRelease())
      .then({ id: "project-policy", async run() { throw new Error("Missing approval"); } })
      .then({ id: "never-publish", async run() { assert.fail("Must stop"); } });
    await assert.rejects(workflow.run(fixture), /Missing approval/u);
    const state = await fixture.state();
    assert.equal(state.failedStep, "project-policy");
    assert.equal(state.phase, "prepared");
    assert.equal(state.error, "Missing approval");
    assert.equal(fixture.published.length, 0);
  });
});
