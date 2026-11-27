import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { release, verify, ReleaseWorkflow } from "../dist/index.js";
import { releaseFixture } from "./helpers/release-fixture.js";

test("release uses actual Git pushes, npm tests/lint, and exact archive consumers", async (t) => {
  const fixture = await releaseFixture(t, { viewArray: true, missingLookups: 1 });
  fixture.env.GITHUB_ACTIONS = "true";
  fixture.env.GITHUB_EVENT_NAME = "workflow_dispatch";
  fixture.env.GITHUB_REF = "refs/heads/master";
  const result = await release(new ReleaseWorkflow(fixture.config), { ...fixture, version: "0.2.0" });
  await fixture.assertReleased(result);
  assert.equal(result.version, "0.2.0");
  assert.equal(result.nextVersion, "0.2.1");
  assert.ok((await fixture.git("bundle", "list-heads", join(fixture.artifacts, "next.bundle"))).includes(result.nextCommit));
  assert.equal(fixture.lookups.every((lookup) => lookup.endsWith("@0.2.0")), true);
  assert.ok(fixture.events.lastIndexOf("npm view") > fixture.events.indexOf("next"));
  const again = await verify(fixture);
  assert.equal(again.version, "0.2.0");
  assert.equal(fixture.published.length, 1);
  await writeFile(join(fixture.artifacts, "release.json"), JSON.stringify({
    ...again, name: "--registry=invalid",
  }));
  await assert.rejects(verify(fixture), /Invalid retained package name/u);
  await writeFile(join(fixture.artifacts, "release.json"), JSON.stringify({
    ...again, artifact: { ...again.artifact, integrity: "corrupted metadata" },
  }));
  await assert.rejects(verify(fixture), /Retained archive integrity mismatch/u);
});

test("missing registry visibility times out after hosting and next preparation without republishing", async (t) => {
  const fixture = await releaseFixture(t, { missingLookups: 100 });
  const result = await release(new ReleaseWorkflow(fixture.config), fixture);
  assert.equal(result.verification, "unverified");
  assert.equal(fixture.published.length, 1);
  assert.equal(result.phase, "next");
  assert.ok(fixture.events.some((event) => event.includes("release could not be verified")));
  assert.equal(JSON.parse(await readFile(join(fixture.cwd, "package.json"), "utf8")).version, "0.1.1");
});

test("null changelog and disabled GitHub hosting preserve package publication and version increments", async (t) => {
  const fixture = await releaseFixture(t);
  const original = await readFile(join(fixture.cwd, "CHANGELOG.md"), "utf8");
  const result = await release(new ReleaseWorkflow({ ...fixture.config, changelog: null, host: null }), fixture);
  assert.equal(result.verification, "verified");
  assert.equal(fixture.events.includes("gh release"), false);
  assert.equal(await readFile(join(fixture.cwd, "CHANGELOG.md"), "utf8"), original);
});

test("GitHub summaries are isolated from the real environment", async (t) => {
  const fixture = await releaseFixture(t);
  fixture.env.GITHUB_ACTIONS = "true";
  fixture.env.GITHUB_EVENT_NAME = "workflow_dispatch";
  fixture.env.GITHUB_REF = "refs/heads/master";
  await release(new ReleaseWorkflow(fixture.config), fixture);
  assert.match(await readFile(fixture.env.GITHUB_STEP_SUMMARY, "utf8"), /@npr-test\/example@0.1.0: verified/u);
});
