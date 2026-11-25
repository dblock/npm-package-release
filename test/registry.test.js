import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  release, prepare, verify, InitializeRelease, LifecycleHooks, ReleaseWorkflow, SemanticReleaseWorkflow,
} from "../dist/index.js";
import { verifyRetained } from "../dist/steps.js";
import { releaseFixture } from "./helpers/release-fixture.js";

function withoutRegistry(config, settings = {}) {
  return { ...config, verifier: undefined, publisher: null, ...settings };
}

test("a release without a registry hosts the exact archive on GitHub and never contacts npm", async (t) => {
  const fixture = await releaseFixture(t);
  Object.assign(fixture.env, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/master" });
  const hooks = [];
  const record = (id) => ({ id, async run() { hooks.push(id); } });
  const workflow = new ReleaseWorkflow(withoutRegistry(fixture.config, {
    hooks: new LifecycleHooks().before("publish", record("before-publish")).after("publish", record("after-publish"))
      .before("host", record("before-host")),
  }));
  const built = await prepare(workflow, fixture);
  assert.equal(built.state.registry, false);
  assert.equal(built.runtime.services.publisher, null);
  assert.equal(built.runtime.services.verifier, null);
  const result = await release(workflow, { ...fixture, env: built.runtime.env });
  assert.equal(result.verification, "verified");
  assert.equal(result.registry, false);
  assert.equal(result.phase, "next");
  assert.equal(fixture.published.length, 0);
  assert.equal(fixture.lookups.length, 0);
  assert.equal(fixture.events.some((event) => event.startsWith("npm view") || event.startsWith("npm publish")), false);
  assert.equal(fixture.events.some((event) => /publishing|published/u.test(event)), false);
  assert.ok(fixture.events.includes("gh release"));
  assert.ok(fixture.events.includes("[npr] verified: @npr-test/example@0.1.0"));
  assert.deepEqual(hooks, ["before-host"]);
  assert.equal(await fixture.git("ls-remote", "--tags", "origin", "v0.1.0") !== "", true);
  assert.equal(JSON.parse(await readFile(join(fixture.cwd, "package.json"), "utf8")).version, "0.1.1");
  assert.match(await readFile(fixture.env.GITHUB_STEP_SUMMARY, "utf8"),
    /## Release Verification\n\n@npr-test\/example@0\.1\.0: verified without a package registry\./u);
  const verified = await verify(fixture);
  assert.equal(verified.verification, "verified");
  assert.equal(fixture.lookups.length, 0);
  const again = await verify({ ...fixture, services: { publisher: { view() { assert.fail("No registry lookup"); } } } });
  assert.equal(again.registry, false);
});

test("a release without a registry requires a host and no registry verifier", async (t) => {
  for (const Workflow of [ReleaseWorkflow, SemanticReleaseWorkflow]) {
    assert.throws(() => new Workflow({ publisher: null, host: null }), /without a registry \(publisher: null\) requires a release host/u);
    assert.throws(() => new Workflow({ publisher: null, verifier: { async verify() { return "verified"; } } }),
      /registry verifier requires a publisher/u);
    assert.throws(() => new Workflow({ verifier: null }), /verifier: null requires publisher: null/u);
    assert.doesNotThrow(() => new Workflow({ publisher: null }));
    assert.doesNotThrow(() => new Workflow({ publisher: null, verifier: null }));
  }
  const fixture = await releaseFixture(t);
  await assert.rejects(new InitializeRelease({ publisher: null, host: null }).run(fixture), /requires a release host/u);
  assert.equal(fixture.events.length, 0);
});

test("registry verification fails closed without a verifier", async () => {
  const saved = [];
  const state = {
    name: "example", version: "1.0.0", releaseCommit: "a".repeat(40), artifact: { filename: "example.tgz" },
    verificationOptions: { attempts: 1, delay: 0 },
  };
  await assert.rejects(verifyRetained(() => {}, { async summary() {} }, {
    project: { async intact() {} }, repository: { async verifyTag() {} }, verifier: null,
    store: { directory: "unused", async read() { return state; }, async save(value) { saved.push(value); } },
  }), /Registry verification requires a verifier/u);
  assert.equal(saved.at(-1).verification, "failed");
});
