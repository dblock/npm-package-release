import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import * as api from "../dist/index.js";
import { checkLifecycle } from "./helpers/lifecycle.js";
import { releaseFixture } from "./helpers/release-fixture.js";

class Hook {
  constructor(id, run) { this.id = id; this.run = run; }
}

test("ordered lifecycle classes preserve staging, exact consumers and checkpoint reconciliation", async (t) => {
  await checkLifecycle(t, api);
});

test("hook failures retain original errors, stop later hooks and report precise immutable metadata", async (t) => {
  for (const [stage, timing] of [["initialize", "after"], ["publish", "before"], ["publish", "after"], ["success", "after"]]) {
    const fixture = await releaseFixture(t);
    const original = Object.freeze(new RangeError(`Failed ${stage} hook`));
    const failures = [];
    let fail = true;
    let hooks = new api.LifecycleHooks();
    hooks = hooks[timing](stage, new Hook("project-check", async () => { if (fail) throw original; }));
    hooks = hooks[timing](stage, new Hook("later-check", async () => { assert.equal(fail, false); }))
      .before("failure", new Hook("broken-reporter", async () => { throw new Error("Secondary failure"); }))
      .after("failure", new Hook("failure-notification", async ({ output: failure }) => {
        assert.equal(failure.error, original);
        assert.ok(Object.isFrozen(failure.hook));
        failures.push(failure);
      }));
    const workflow = new api.ReleaseWorkflow({
      ...fixture.config, hooks,
      observer: { async failed(event) { failures.push(event); } },
    });
    await assert.rejects(workflow.run(fixture), (error) => error === original);
    assert.equal(failures.length, 2);
    const details = { stage, timing, hook: "project-check", index: 1 };
    assert.deepEqual(failures[0].hook, details);
    assert.deepEqual((await fixture.state()).failedHook, details);
    assert.equal((await fixture.state()).error, original.message);
    if (stage === "initialize") {
      assert.equal(fixture.published.length, 0);
    } else {
      if (timing === "before") assert.equal(fixture.published.length, 0);
      if (stage === "success") assert.equal((await fixture.state()).verification, "verified");
      fail = false;
      const state = await workflow.complete(fixture);
      assert.equal(state.verification, "verified");
      assert.equal(fixture.published.length, 1);
    }
  }
});

test("built-in failures skip after hooks and do not inherit metadata from broken failure reporters", async (t) => {
  const fixture = await releaseFixture(t);
  const original = new Error("Project validation failed");
  let observed;
  const hooks = new api.LifecycleHooks()
    .after("validate", new Hook("must-not-run", async () => { assert.fail("Validation failed"); }))
    .before("failure", new Hook("broken-notification", async () => { throw new Error("Reporter failed"); }));
  const workflow = new api.ReleaseWorkflow({
    ...fixture.config, hooks,
    validator: new api.HookValidator({ async validate() { throw original; } }),
    observer: { async failed(event) { observed = event; } },
  });
  await assert.rejects(workflow.prepare(fixture), (error) => error === original);
  assert.equal(observed.hook, undefined);
  assert.equal((await fixture.state()).failedHook, undefined);
  assert.equal((await fixture.state()).failedStep, "validate");
});

test("failure hooks identify initialization failures before capture without manufacturing release data", async () => {
  const original = new Error("Before capture");
  let observed;
  const hooks = new api.LifecycleHooks()
    .before("initialize", new Hook("early-check", async ({ execution }) => {
      assert.equal(execution.release, null);
      throw original;
    }))
    .before("failure", new Hook("notify", async ({ input: failure }) => { observed = failure; }));
  await assert.rejects(new api.ReleaseWorkflow({ hooks }).run({
    run: async () => { assert.fail("Early hook failure must not execute commands"); },
  }), (error) => error === original);
  assert.equal(observed.error, original);
  assert.equal(observed.execution.release, null);
  assert.equal(observed.hook.hook, "early-check");
});

test("nonpreparation hooks cannot smuggle edits into the validated tree", async (t) => {
  const fixture = await releaseFixture(t);
  const hooks = new api.LifecycleHooks().after("validate", new Hook("unexpected-edit", async ({ output }) => {
    await writeFile(join(output.runtime.cwd, "UNEXPECTED.txt"), "Must not publish\n");
  }));
  await assert.rejects(new api.ReleaseWorkflow({ ...fixture.config, hooks }).run(fixture), /Unexpected working-tree/u);
  assert.equal(fixture.published.length, 0);
  assert.equal((await fixture.state()).failedHook.hook, "unexpected-edit");
});

test("a failed editing hook leaves partial files unstaged and does not run later edits", async (t) => {
  const fixture = await releaseFixture(t);
  const original = new Error("Preparation failed");
  const hooks = new api.LifecycleHooks()
    .after("prepare", new Hook("partial-edit", async ({ context }) => {
      await writeFile(join(context.cwd, "PARTIAL.txt"), "Keep for inspection\n");
      throw original;
    }))
    .after("prepare", new Hook("later", async () => { assert.fail("Must stop"); }));
  await assert.rejects(new api.ReleaseWorkflow({ ...fixture.config, hooks }).prepare(fixture), (error) => error === original);
  assert.equal((await fixture.state()).failedHook.stage, "prepare");
  assert.match(await fixture.git("status", "--porcelain"), /\?\? PARTIAL\.txt/u);
  assert.equal(await fixture.git("diff", "--cached", "--name-only"), "");
  assert.equal(fixture.published.length, 0);
});

test("lifecycle registration rejects unknown stages and incomplete hook classes", () => {
  const hooks = new api.LifecycleHooks();
  assert.throws(() => hooks.before("unknown", new Hook("check", async () => {})), /Unknown lifecycle stage/u);
  for (const invalidHook of [null, {}, { id: "", run: async () => {} }, { id: "missing-run" }]) {
    assert.throws(() => hooks.after("build", invalidHook), /requires an id and run/u);
  }
});

test("reusing a workflow keeps concurrent hook failure identities isolated", async () => {
  const original = Object.freeze(new Error("Shared project failure"));
  const failures = [];
  const hooks = new api.LifecycleHooks()
    .before("initialize", new Hook("first", async ({ input }) => {
      if (input.version === "1.0.0") {
        await Promise.resolve();
        throw original;
      }
    }))
    .before("initialize", new Hook("second", async () => { throw original; }));
  const workflow = new api.ReleaseWorkflow({ hooks });
  await Promise.all(["1.0.0", "2.0.0"].map((version) => assert.rejects(workflow.run({
    version,
    observer: { async failed(event) { failures.push([version, event.hook.hook]); } },
    run: async () => { assert.fail("Hooks must stop before commands"); },
  }), (error) => error === original)));
  assert.deepEqual(failures.sort(), [["1.0.0", "first"], ["2.0.0", "second"]]);
});
