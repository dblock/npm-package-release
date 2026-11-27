import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { release, ReleaseWorkflow, HookValidator } from "../dist/index.js";
import { releaseFixture } from "./helpers/release-fixture.js";

test("a failed remote push after publication retains the archive/bundle and never starts next", async (t) => {
  let blocked = true;
  const fixture = await releaseFixture(t, {
    intercept: async (program, args) => {
      if (blocked && program === "git" && args[0] === "push") {
        blocked = false;
        throw new Error("Simulated remote push failure");
      }
    },
  });
  await assert.rejects(release(new ReleaseWorkflow(fixture.config), fixture), /push failure/u);
  const state = await fixture.state();
  assert.equal(state.phase, "published");
  assert.equal(fixture.published.length, 1);
  assert.equal(fixture.events.includes("gh release"), false);
  assert.equal(fixture.events.includes("next"), false);
  assert.ok((await readFile(join(fixture.artifacts, "release.bundle"))).length > 0);
  assert.ok((await readFile(join(fixture.artifacts, state.artifact.filename))).length > 0);
  const recovered = await release(new ReleaseWorkflow(fixture.config), fixture);
  assert.equal(recovered.verification, "verified");
  assert.equal(recovered.artifact.integrity, state.artifact.integrity);
  assert.equal(fixture.published.length, 1);
});

test("failed publication and hosted-release creation do not prepare next development", async (t) => {
  for (const operation of ["publish", "release"]) {
    const fixture = await releaseFixture(t, {
      intercept: async (program, args) => {
        if ((program === "npm" && args[0] === "publish" && operation === "publish") ||
          (program === "gh" && operation === "release")) throw new Error(`Failed ${operation}`);
      },
    });
    await assert.rejects(release(new ReleaseWorkflow(fixture.config), fixture), new RegExp(`Failed ${operation}`, "u"));
    assert.equal(fixture.events.includes("next"), false);
    assert.equal((await fixture.state()).phase, operation === "publish" ? "publishing" : "pushed");
  }
});

test("consumer failure stops before publication and removes its isolated consumer", async (t) => {
  const fixture = await releaseFixture(t);
  let consumer;
  await assert.rejects(release(new ReleaseWorkflow({
    ...fixture.config,
    validator: new HookValidator({ validateArtifact: async (context) => {
      consumer = context.consumer;
      throw new Error("Public API is broken");
    } }),
  }), fixture), /Public API is broken/u);
  await assert.rejects(readFile(join(consumer, "package.json")), { code: "ENOENT" });
  assert.equal(fixture.published.length, 0);
});

test("failed next-development validation preserves the published release without pushing invalid files", async (t) => {
  const fixture = await releaseFixture(t);
  await assert.rejects(release(new ReleaseWorkflow({
    ...fixture.config,
    validator: new HookValidator({ validate: async ({ phase, run }) => {
      await run("npm", ["test"]);
      if (phase === "next") {
        const state = await fixture.state();
        assert.equal(state.phase, "hosted");
        assert.equal(state.activeStep, "next");
        throw new Error("Development validation failed");
      }
    } }),
  }), fixture), /Development validation failed/u);
  const state = await fixture.state();
  assert.equal(state.phase, "hosted");
  assert.equal(state.activeStep, "next");
  assert.equal(state.failedStep, "next");
  assert.equal(state.verification, "failed");
  assert.ok(fixture.events.some((event) => event.includes("failed step next; last phase hosted")));
  assert.equal(fixture.published.length, 1);
  assert.equal((await fixture.git("ls-remote", "origin", "refs/heads/master")).split("\t")[0], state.releaseCommit);
  assert.equal(JSON.parse(await readFile(join(fixture.cwd, "package.json"), "utf8")).version, "0.1.1");
});

test("a concurrent remote branch advance after publication prevents the atomic push", async (t) => {
  const fixture = await releaseFixture(t, {
    onPublish: async ({ git }) => {
      const parent = (await git("rev-parse", "HEAD^")).trim();
      const tree = (await git("rev-parse", `${parent}^{tree}`)).trim();
      const concurrent = (await git("commit-tree", tree, "-p", parent, "-m", "Unrelated concurrent work")).trim();
      await git("push", "origin", `${concurrent}:master`);
    },
  });
  await assert.rejects(release(new ReleaseWorkflow(fixture.config), fixture), /Remote branch advanced/u);
  assert.equal(fixture.published.length, 1);
  assert.equal(fixture.events.includes("next"), false);
});
