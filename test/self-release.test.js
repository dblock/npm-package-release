import assert from "node:assert/strict";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import workflow from "../npr.config.js";
import { checkSelfRelease } from "./helpers/self-release.js";
import { releaseFixture } from "./helpers/release-fixture.js";

test("the repository configuration releases its compiled SDK and checks installed API and CLI versions", async (t) => {
  await checkSelfRelease(t, fileURLToPath(new URL("../", import.meta.url)), workflow);
});

test("the repository configuration rejects a broken installed SDK before publication or tagging", async (t) => {
  const fixture = await releaseFixture(t, { manifest: { name: "npm-package-release" } });
  await assert.rejects(workflow.prepare(fixture), /does not provide an export named/u);
  assert.equal(fixture.published.length, 0);
  assert.equal((await fixture.state()).failedStep, "build");
  assert.equal(await fixture.git("tag", "--list"), "");
});
