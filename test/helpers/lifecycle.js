import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { releaseFixture } from "./release-fixture.js";

export async function checkLifecycle(t, api) {
  const fixture = await releaseFixture(t);
  const events = [];
  class Record {
    constructor(id, check = async () => {}) { this.id = id; this.check = check; }
    async run(hookContext) {
      assert.ok(Object.isFrozen(hookContext));
      assert.ok(Object.isFrozen(hookContext.execution));
      events.push(`${hookContext.stage}:${hookContext.timing}:${hookContext.index}:${this.id}`);
      await this.check(hookContext);
    }
  }
  let hooks = new api.LifecycleHooks();
  for (const stage of ["initialize", "validate", "commit", "build", "checkpoint", "restore", "publish", "push", "host", "verify", "success"]) {
    hooks = hooks.before(stage, new Record(stage)).after(stage, new Record(stage));
  }
  hooks = hooks
    .before("prepare", new Record("first", async ({ context, execution }) => {
      assert.equal(context.version, "0.2.0");
      assert.equal(execution.release.version, "0.2.0");
      assert.match(await readFile(join(context.cwd, "CHANGELOG.md"), "utf8"), /0\.1\.0 \(Next\)/u);
    }))
    .before("prepare", new Record("second"))
    .after("prepare", new Record("release-edit", async ({ context, execution }) => {
      assert.match(execution.release.notes, /Ship release tooling/u);
      assert.equal(JSON.parse(await readFile(join(context.cwd, "package.json"), "utf8")).version, "0.2.0");
      await writeFile(join(context.cwd, "LIFECYCLE.txt"), `Release ${context.version}\n`);
      await writeFile(join(context.cwd, "index.js"),
        await readFile(join(context.cwd, "index.js"), "utf8") + "export const lifecycleFeature = true;\n");
    }))
    .before("next", new Record("before-next"))
    .after("next", new Record("development-edit", async ({ context, execution }) => {
      assert.equal(context.version, "0.2.1");
      assert.equal(context.releasedVersion, "0.2.0");
      assert.equal(execution.release.nextVersion, "0.2.1");
      await writeFile(join(context.cwd, "LIFECYCLE.txt"), `Next ${context.version}\n`);
    }));
  hooks.after("success", new Record("unused", async () => { assert.fail("Registration must not mutate the original"); }));
  class CheckArtifact {
    async validate(context) { await fixture.config.validator.validate(context); }
    async artifact(context) {
      await fixture.config.validator.artifact(context);
      await context.run("node", ["--input-type=module", "--eval",
        'import { lifecycleFeature } from "@npr-test/example"; if (lifecycleFeature !== true) throw new Error("Missing lifecycle edit");',
      ], { cwd: context.consumer });
    }
  }
  const workflow = new api.ReleaseWorkflow({
    ...fixture.config, hooks, validator: new CheckArtifact(),
    observer: { async succeeded() { events.push("observer:success"); } },
  });
  const built = await workflow.prepare({ ...fixture, version: "0.2.0" });
  assert.equal(events.some((event) => event.startsWith("success:")), false);
  assert.equal(await fixture.git("show", `${built.state.releaseCommit}:LIFECYCLE.txt`), "Release 0.2.0\n");
  assert.deepEqual(events, [
    "initialize:before:1:initialize", "initialize:after:1:initialize",
    "prepare:before:1:first", "prepare:before:2:second", "prepare:after:1:release-edit",
    "validate:before:1:validate", "validate:after:1:validate",
    "commit:before:1:commit", "commit:after:1:commit",
    "build:before:1:build", "build:after:1:build",
    "checkpoint:before:1:checkpoint", "checkpoint:after:1:checkpoint",
  ]);
  const state = await workflow.complete(fixture);
  assert.equal(await fixture.git("show", `${state.nextCommit}:LIFECYCLE.txt`), "Next 0.2.1\n");
  assert.deepEqual(events.slice(13), [
    "restore:before:1:restore", "restore:after:1:restore",
    "publish:before:1:publish", "publish:after:1:publish",
    "push:before:1:push", "push:after:1:push", "host:before:1:host", "host:after:1:host",
    "next:before:1:before-next", "next:after:1:development-edit",
    "verify:before:1:verify", "verify:after:1:verify",
    "success:before:1:success", "observer:success", "success:after:1:success",
  ]);
  await workflow.complete(fixture);
  assert.equal(events.filter((event) => event === "next:after:1:development-edit").length, 1);
  assert.equal(events.filter((event) => event === "success:after:1:success").length, 2);
  await fixture.assertReleased(state);
}
