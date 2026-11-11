import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { releaseFixture } from "./release-fixture.js";

export async function checkSemanticRelease(t, api) {
  const fixture = await releaseFixture(t);
  Object.assign(fixture.env, {
    GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/master",
  });
  const initial = await fixture.commit();
  await fixture.git("tag", "-a", "v0.4.0", "-m", "Published baseline", initial);
  const tree = (await fixture.git("rev-parse", `${initial}^{tree}`)).trim();
  const unrelated = (await fixture.git("commit-tree", tree, "-m", "Unreachable release")).trim();
  await fixture.git("tag", "v9.0.0", unrelated);
  await writeFile(join(fixture.cwd, "index.js"), (await readFile(join(fixture.cwd, "index.js"), "utf8")) + "export const feature = true;\n");
  await fixture.git("add", "index.js");
  await fixture.git("commit", "-m", "feat(api): ship *typed* releases");
  await fixture.git("tag", "v0.3.0");
  await fixture.git("tag", "v8.0.0-beta.1");
  await fixture.git("push", "origin", "master", "--tags");
  await fixture.git("tag", "-d", "v0.4.0");
  const source = await fixture.commit();
  const originalChangelog = await readFile(join(fixture.cwd, "CHANGELOG.md"), "utf8");
  const hookEvents = [];
  class SemanticHook {
    id = "semantic-hook";
    async run({ stage, timing, output, execution }) {
      hookEvents.push(`${stage}:${timing}`);
      if (stage === "analyze" && timing === "after") {
        assert.ok(output.analysis instanceof api.SemanticDecision);
        assert.equal(output.analysis.version, "0.5.0");
        assert.equal(execution.release, null);
      }
      if (stage === "host" || stage === "next") assert.fail("Disabled stages must skip hooks");
    }
  }
  let hooks = new api.LifecycleHooks();
  for (const stage of ["analyze", "initialize", "semantic-decision", "host", "next", "success"]) {
    hooks = hooks.before(stage, new SemanticHook()).after(stage, new SemanticHook());
  }
  const config = {
    verifier: fixture.config.verifier, prepare: fixture.config.prepare,
    next: fixture.config.next, validator: fixture.config.validator,
    hooks, host: null,
  };
  const workflow = new api.SemanticReleaseWorkflow(config);
  const built = await api.prepare(workflow, fixture);
  assert.deepEqual(hookEvents, [
    "analyze:before", "analyze:after", "initialize:before", "initialize:after",
    "semantic-decision:before", "semantic-decision:after",
  ]);
  assert.equal(fixture.published.length, 0);
  assert.equal(built.release.version, "0.5.0");
  assert.equal(built.release.manifestVersion, "0.1.0");
  const { decision } = built.state.semantic;
  assert.equal(decision.head, source);
  assert.equal(decision.lastRelease.tag, "v0.4.0");
  assert.equal(decision.lastRelease.commit, initial);
  assert.equal(built.state.semantic.nextDevelopment, false);
  assert.equal(decision.commits.length, 1);
  assert.match(decision.notes, /### Features/u);
  assert.match(decision.notes, /\\\*typed\\\*/u);
  assert.ok(decision instanceof api.SemanticDecision);
  assert.throws(() => { decision.commits[0].message = "Changed"; }, TypeError);
  const invocation = { ...fixture, env: built.runtime.env };
  const statePath = built.runtime.env.NPR_STATE_FILE;
  const original = await readFile(statePath, "utf8");
  await writeFile(statePath, JSON.stringify({ analysis: { ...decision, head: initial } }));
  await assert.rejects(workflow.run(invocation), /another commit/u);
  assert.equal(fixture.published.length, 0);
  await writeFile(statePath, original);
  const publication = new api.SemanticReleaseWorkflow({ ...config,
    analyzer: { analyze() { assert.fail("Later phases in the same invocation must not reanalyze history"); } },
  });
  const result = await api.release(publication, invocation);
  assert.equal(result.verification, "verified");
  assert.equal(result.phase, "hosted");
  assert.equal(result.nextCommit, undefined);
  assert.equal(JSON.parse(await readFile(join(fixture.cwd, "package.json"), "utf8")).version, "0.5.0");
  assert.equal(await readFile(join(fixture.cwd, "CHANGELOG.md"), "utf8"), originalChangelog);
  assert.equal(fixture.events.includes("next"), false);
  await api.release(publication, invocation);
  assert.equal(hookEvents.filter((event) => event === "analyze:after").length, 3);
  assert.equal(hookEvents.filter((event) => event === "success:after").length, 2);
  assert.equal(fixture.published.length, 1);
  assert.equal(fixture.events.filter((event) => event === "npm pack").length, 3);
  await assert.rejects(workflow.prepare(fixture), /Nothing to release/u);
}
