import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  const generated = await readFile(join(fixture.cwd, "CHANGELOG.md"), "utf8");
  assert.ok(generated.startsWith(`# Changelog\n\n## 0.5.0 (${built.state.date.replaceAll("-", "/")})\n\n${decision.notes}\n\n`));
  assert.ok(generated.endsWith(originalChangelog.slice(originalChangelog.indexOf("## "))));
  assert.equal(await fixture.git("show", "v0.5.0:CHANGELOG.md"), generated);
  assert.equal(fixture.events.includes("next"), false);
  await api.release(publication, invocation);
  assert.equal(await readFile(join(fixture.cwd, "CHANGELOG.md"), "utf8"), generated);
  assert.equal(hookEvents.filter((event) => event === "analyze:after").length, 3);
  assert.equal(hookEvents.filter((event) => event === "success:after").length, 2);
  assert.equal(fixture.published.length, 1);
  assert.equal(fixture.events.filter((event) => event === "npm pack").length, 3);
  await assert.rejects(workflow.prepare(fixture), /Nothing to release/u);
}

export async function checkGeneratedChangelog(t, api) {
  const cwd = await mkdtemp(join(tmpdir(), "npr-generated-changelog-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "docs"));
  const notes = "### Features\n\n- Add an endpoint.";
  const decision = await new api.SemanticRelease({
    history: { async read() { return { lastRelease: null, commits: [{ sha: "a".repeat(40), message: "feat: add an endpoint" }] }; } },
    selector: new api.SemanticVersionSelector("1.2.3"),
    notes: { generate() { return notes; } },
  }).analyze("f".repeat(40));
  const options = { version: "1.2.3", date: "2026-11-09", cwd };
  const entry = `## 1.2.3 (2026/11/09)\n\n${notes}\n\n`;
  const created = new api.GeneratedChangelog(decision);
  assert.equal(await created.release(options), notes);
  const initial = await readFile(join(cwd, "CHANGELOG.md"), "utf8");
  assert.equal(initial, "# Changelog\n\n" + entry);
  await created.next({ version: "1.2.4", releasedVersion: "1.2.3", cwd });
  assert.equal(await readFile(join(cwd, "CHANGELOG.md"), "utf8"), initial);
  const prefix = "# Changelog\r\n\r\nPreamble: caf\u00e9.\r\n\r\n```md\r\n## 1.2.3 (Example)\r\n```\r\n\r\n> ## 1.2.3 (Quoted)\r\n\r\n";
  const history = "## 1.2.30 (2026/11/08)\r\n\r\n* Original   spacing.\r\n";
  for (const [changelog, path] of [
    [created, join(cwd, "CHANGELOG.md")],
    [new api.GeneratedChangelog(decision, "docs/HISTORY.md"), join(cwd, "docs/HISTORY.md")],
    [new api.GeneratedChangelog(decision, join(cwd, "ABSOLUTE.md")), join(cwd, "ABSOLUTE.md")],
  ]) {
    await writeFile(path, prefix + history);
    assert.equal(await changelog.release(options), notes);
    const expected = prefix + entry.replaceAll("\n", "\r\n") + history;
    assert.equal(await readFile(path, "utf8"), expected);
    await utimes(path, new Date("2000-01-01"), new Date("2000-01-01"));
    const modified = (await stat(path)).mtimeMs;
    await changelog.release({ ...options, date: "2026-11-10" });
    assert.equal(await readFile(path, "utf8"), expected);
    assert.equal((await stat(path)).mtimeMs, modified);
    const conflict = new api.SemanticDecision({ ...decision, notes: "Different notes" });
    await assert.rejects(new api.GeneratedChangelog(conflict, path).release(options), /notes differ/u);
    assert.equal(await readFile(path, "utf8"), expected);
    const duplicate = expected + "\r\n" + entry.replaceAll("\n", "\r\n");
    await writeFile(path, duplicate);
    await assert.rejects(changelog.release(options), /exactly one/u);
    assert.equal(await readFile(path, "utf8"), duplicate);
  }
  const path = join(cwd, "INVALID.md");
  for (const notes of [null, "", " \n", "### Features\n\n<!-- comment -->", "---", "[ref]: https://example.com"]) {
    await assert.rejects(async () => {
      const invalid = new api.SemanticDecision({ ...decision, notes });
      await new api.GeneratedChangelog(invalid, path).release(options);
    });
    await assert.rejects(readFile(path), { code: "ENOENT" });
  }
  const invalid = new api.GeneratedChangelog(decision, path);
  await assert.rejects(invalid.release({ ...options, date: "yesterday" }), /date/u);
  await assert.rejects(invalid.release({ ...options, version: "1.2.4" }), /version differs/u);
  await assert.rejects(readFile(path), { code: "ENOENT" });
  await assert.rejects(new api.GeneratedChangelog(decision, "docs").release(options), { code: "EISDIR" });
}
