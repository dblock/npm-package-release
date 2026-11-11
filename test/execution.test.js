import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../dist/index.js";
import { releaseFixture } from "./helpers/release-fixture.js";

const description = {
  name: "example", version: "1.0.0", manifestVersion: "0.9.9", date: "2026-11-10",
};
const attributes = {
  step: { id: "prepare" }, steps: {}, workflow: { id: "release", steps: ["prepare", "publish"] },
};

test("Release is immutable domain data with explicit manifest and release versions", () => {
  const release = new api.Release(description);
  const updated = release.withVersion("2.0.0").withNextVersion("2.0.1").withNotes("New features");
  assert.equal(release.version, "1.0.0");
  assert.equal(updated.manifestVersion, "0.9.9");
  assert.equal(updated.nextVersion, "2.0.1");
  assert.equal(updated.notes, "New features");
  assert.throws(() => { updated.notes = "Changed"; }, TypeError);
  for (const invalid of [{ name: "" }, { version: null }, { date: "yesterday" }, { nextVersion: "" }, { notes: {} }]) {
    assert.throws(() => new api.Release({ ...description, ...invalid }));
  }
});

test("local and GitHub contexts snapshot only allowed metadata and observed statuses", async () => {
  const env = {
    GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2",
    GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "owner/repo",
    GITHUB_WORKFLOW: "Release", GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/master", GITHUB_SHA: "abc123",
    GITHUB_TOKEN: "private-token", GITHUB_EVENT_PATH: "/private/payload.json",
    NPR_DEFAULT_BRANCH: "master", NPR_TIMEZONE: "UTC",
  };
  const observed = { tests: { id: "tests", outcome: "failure", conclusion: "success" } };
  const provider = new api.GitHubExecutionProvider(env, observed);
  observed.tests.outcome = "success";
  env.GITHUB_RUN_ID = "changed";
  const context = provider.context(attributes);
  assert.equal(context.run.id, "123");
  assert.equal(context.run.attempt, "2");
  assert.equal(context.run.url, "https://github.com/owner/repo/actions/runs/123");
  assert.equal(context.steps.tests.outcome, "failure");
  assert.equal(context.steps.tests.conclusion, "success");
  assert.equal(context.steps.neverRun, undefined);
  assert.equal(context.release, null);
  assert.equal(provider.defaultBranch, "master");
  assert.equal(provider.timezone, "UTC");
  assert.equal(context.withRelease(new api.Release(description)).release.version, "1.0.0");
  assert.throws(() => { context.steps.tests.conclusion = "failure"; }, TypeError);
  assert.throws(() => context.workflow.steps.push("surprise"), TypeError);
  assert.throws(() => { context.run.id = "surprise"; }, TypeError);
  assert.doesNotMatch(JSON.stringify(context), /private-token|payload\.json|GITHUB_TOKEN/u);
  assert.doesNotMatch(JSON.stringify(provider), /private-token/u);
  provider.validateReleaseBranch("master");
  await provider.summary("No summary file configured");
  assert.throws(() => provider.validateReleaseBranch("other"), /manual dispatch/u);
  assert.throws(() => provider.validateReleaseBranch(""), /release branch/u);
  assert.throws(() => new api.ExecutionContext("local", { ...attributes, release: {} }), /immutable Release/u);
  assert.throws(() => new api.ExecutionContext("local", attributes, { id: {} }), /run metadata/u);
  assert.throws(() => provider.context({ ...attributes, step: { id: "" } }), /identifier/u);
  assert.throws(() => provider.context({ ...attributes, step: { id: "test", outcome: "unknown" } }), /status/u);
  assert.ok(api.currentExecutionProvider(env) instanceof api.GitHubExecutionProvider);
  assert.ok(api.currentExecutionProvider({}) instanceof api.LocalExecutionProvider);
  const local = new api.LocalExecutionProvider(env).context(attributes);
  assert.equal(local.run, null);
  assert.deepEqual(local.steps, {});
});

test("workflow history is immutable, scoped per invocation, and propagated through nested class steps", async () => {
  const seen = [];
  class Platform extends api.LocalExecutionProvider {
    name = "custom";
    context(input) { return super.context(input); }
  }
  const provider = new Platform({});
  const child = api.Workflow.start().then({
    id: "child",
    async run(value, execution, client) {
      assert.equal(client, provider);
      assert.equal(execution.provider, "custom");
      assert.equal(execution.steps.first.outcome, "success");
      seen.push(execution);
      return value + 1;
    },
  });
  const workflow = api.Workflow.start({
    async succeeded({ output, execution }) {
      assert.equal(output, 3);
      assert.equal(execution.steps.workflow.outcome, "success");
      seen.push(execution);
    },
  }, provider)
    .then({ id: "first", async run(input, execution) { seen.push(execution); return input + 1; } })
    .then(child);
  assert.equal(await workflow.run(1), 3);
  assert.equal(await workflow.run(1), 3);
  assert.deepEqual(seen[0].steps, {});
  assert.deepEqual(seen[3].steps, {});
  assert.equal(seen[0].step.outcome, undefined);
  assert.equal(seen[2].step.id, "workflow:success");
});

test("initialization failures notify observers once even without a captured release", async () => {
  const failures = [];
  await assert.rejects(api.release(new api.ReleaseWorkflow({ changelog: {} }), {
    env: { GITHUB_ACTIONS: "false" },
    observer: {
      async failed(event) { failures.push(event); throw new Error("Notification also failed"); },
      async succeeded() { assert.fail("Initialization failed"); },
    },
  }), /Changelog must implement/u);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].id, "initialize");
  assert.equal(failures[0].execution.release, null);
  assert.equal(failures[0].execution.steps.initialize.outcome, "failure");
  assert.ok(failures[0].error instanceof Error);
  const configured = [];
  await assert.rejects(api.release(new api.ReleaseWorkflow({
    changelog: { format: "invalid" },
    observer: { async failed({ id }) { configured.push(id); } },
  }), { env: {} }), /Changelog must implement/u);
  assert.deepEqual(configured, ["initialize"]);
});

test("notification failures remain structured without hiding the original error", async () => {
  const notifications = [];
  const error = new Error("Success notification failed");
  const workflow = api.Workflow.start({
    async succeeded() { throw error; },
    async failed(event) { notifications.push(event); },
  });
  await assert.rejects(workflow.run({}), (actual) => actual === error);
  assert.equal(notifications[0].id, "workflow:success");
  assert.equal(notifications[0].execution.step.outcome, "failure");
  const original = new Error("Step failed");
  let observed = false;
  await assert.rejects(api.Workflow.start({
    async failed() { throw new Error("First reporter failed"); },
  }).then({ id: "fail", async run() { throw original; } }).run({
    observer: { async failed() { observed = true; } },
  }), (actual) => actual === original);
  assert.equal(observed, true);
  await assert.rejects(api.Workflow.start({
    failed() { throw new Error("Synchronous reporter failed"); },
  }).then({ id: "fail", async run() { throw original; } }).run({}), (actual) => actual === original);
});

test("an injected provider owns release guards and summaries without GitHub ambient coupling", async (t) => {
  const fixture = await releaseFixture(t);
  const events = [];
  class PortableProvider extends api.LocalExecutionProvider {
    name = "portable";
    validateReleaseBranch(branch) { events.push(`guard ${branch}`); super.validateReleaseBranch(branch); }
    summary = async (message) => { events.push(message); };
  }
  const provider = new PortableProvider({});
  const callbacks = [];
  const notificationError = new Error("Project notification failed after publication");
  const workflow = new api.ReleaseWorkflow({
    ...fixture.config, provider,
    async prepare(context) {
      callbacks.push(context.execution);
      assert.equal(context.execution.release.manifestVersion, "0.1.0");
      assert.equal(context.execution.release.version, "0.2.0");
      assert.ok(context.execution.release.notes.includes("Ship release tooling."));
    },
  });
  await assert.rejects(workflow.run({
    ...fixture, version: "0.2.0",
    env: { ...fixture.env, GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request" },
    observer: {
      async completed({ id, execution }) {
        assert.equal(execution.provider, "portable");
        if (id === "initialize") assert.ok(execution.release instanceof api.Release);
      },
      async succeeded({ execution }) {
        callbacks.push(execution);
        assert.equal(execution.release.version, "0.2.0");
        assert.equal(execution.steps.publish.outcome, "success");
        assert.equal(execution.steps.next.outcome, "success");
        throw notificationError;
      },
    },
  }), (error) => error === notificationError);
  const result = await fixture.state();
  assert.equal(result.verification, "verified");
  assert.equal(result.failedStep, "workflow:success");
  assert.equal(result.error, notificationError.message);
  assert.equal(events[0], "guard master");
  assert.ok(events.some((event) => event.includes("verified")));
  assert.deepEqual(callbacks[0].steps.initialize.outcome, "success");
  assert.equal(callbacks.length, 2);
  assert.equal(callbacks[0].steps.publish, undefined);
  assert.equal((await api.verify({ ...fixture, provider })).verification, "verified");
});
