import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as api from "../dist/index.js";
import { command } from "../dist/command.js";
import { checkGeneratedChangelog, checkSemanticRelease } from "./helpers/semantic.js";
import { releaseFixture } from "./helpers/release-fixture.js";

const commit = (message, digit = "a") => ({ sha: digit.repeat(40), message });

test("Conventional Commits classify breaking footers, reverts, custom rules, and non-release changes", () => {
  const analyzer = new api.ConventionalCommits();
  for (const [message, expected] of [
    ["feat(api): add a feature", "minor"], ["fix: repair", "patch"], ["perf: faster", "patch"],
    ["docs: clarify", null], ["chore: maintenance", null], ["", null],
    ["feat!: replace API", "major"], ["fix(core): repair\n\nBREAKING CHANGE: remove API\n  details\nRefs: #1", "major"],
    ["refactor: replace\n\nBREAKING-CHANGE:\n  new contract", "major"],
    ["unstructured\n\nBREAKING CHANGE:", "major"],
    ["revert: old release\n\nThis reverts commit bbbbbbb.", "patch"],
  ]) assert.equal(analyzer.analyze([commit(message)]), expected, message);
  const feature = commit("feat: addition");
  const revert = commit(`revert: addition\n\nThis reverts commit ${feature.sha}.`, "b");
  const restore = commit(`revert: restore\n\nThis reverts commit ${revert.sha}.`, "c");
  assert.equal(analyzer.analyze([feature, revert]), null);
  assert.equal(analyzer.analyze([feature, revert, restore]), "minor");
  assert.throws(() => analyzer.analyze([
    commit("feat: one"), { sha: "a".repeat(39) + "b", message: "feat: two" },
    commit("revert: ambiguous\n\nThis reverts commit aaaaaaa.", "c"),
  ]), /Ambiguous/u);
  const rules = [{ type: "docs", scope: "public*", release: "patch" }, { breaking: true, scope: "private", release: false }];
  const custom = new api.ConventionalCommits(rules);
  rules[0].release = false;
  assert.equal(custom.analyze([commit("docs(public-api): document")]), "patch");
  assert.equal(custom.analyze([commit("feat(private)!: internal")]), null);
  assert.equal(new api.ConventionalCommits([{ subject: "rep?ir", release: "minor" }, { type: "fix", release: "patch" }])
    .analyze([commit("fix: repair")]), "minor");
  for (const rule of [{ release: "unknown" }, { type: 1, release: "patch" }, { breaking: "yes", release: false }, { unknown: true, release: "patch" }]) {
    assert.throws(() => new api.ConventionalCommits([rule]), /Invalid/u);
  }
});

test("semantic selection follows reachable release versions, not the manifest, with explicit overrides", () => {
  const selector = new api.SemanticVersionSelector();
  const select = (lastRelease, releaseType, explicitVersion = null) => selector.select({ lastRelease, releaseType, explicitVersion });
  assert.equal(select(null, "patch"), "1.0.0");
  assert.equal(new api.SemanticVersionSelector("0.1.0").select({ lastRelease: null, releaseType: "minor", explicitVersion: null }), "0.1.0");
  assert.equal(select("0.4.3", "major"), "1.0.0");
  assert.equal(select("2.4.3", "minor"), "2.5.0");
  assert.equal(select("2.4.3", "patch"), "2.4.4");
  assert.equal(select("2.4.3", null), null);
  assert.equal(select("2.4.3", null, "3.0.0"), "3.0.0");
  for (const args of [["1.0.0", "patch", "1.0.0"], ["1.0.0", "patch", "0.9.9"], [null, "unknown"], [null, "minor", "01.0.0"]]) {
    assert.throws(() => select(...args));
  }
  assert.throws(() => new api.SemanticVersionSelector("1.0.0-beta.1"));
});

test("semantic decisions freeze validated history and generated notes and reject changed selections", async () => {
  const commits = [commit("feat([api]): use <safe> *text*"), commit("fix!: replace\n\nBREAKING CHANGE: remove old API\n  keep details", "b")];
  const engine = new api.SemanticRelease({ history: { async read() { return { lastRelease: null, commits }; } } });
  const decision = await engine.analyze("f".repeat(40));
  commits[0].message = "Changed after analysis";
  assert.equal(decision.version, "1.0.0");
  assert.match(decision.notes, /### Breaking Changes/u);
  assert.match(decision.notes, /\\<safe\\>/u);
  assert.match(decision.notes, /\\\[api\\\]/u);
  assert.equal(decision.commits[0].message, "feat([api]): use <safe> *text*");
  assert.throws(() => decision.commits.push(commit("fix: injected")), TypeError);
  assert.throws(() => decision.check("0".repeat(40)), /another commit/u);
  assert.throws(() => decision.check(decision.head, "9.0.0"), /version differs/u);
  assert.throws(() => decision.check(decision.head, decision.version, "1.0.0"), /Explicit version changed/u);
  const empty = await new api.SemanticRelease({ history: { async read() { return { lastRelease: null, commits: [] }; } } }).analyze(decision.head);
  assert.equal(empty.releasable, false);
  assert.equal(new api.GeneratedReleaseNotes().generate([]), "Explicit version release.");
  for (const patch of [
    { head: "bad" }, { commits: [commit("one"), commit("two")] }, { releaseType: "unknown" },
    { notes: "" }, { explicitVersion: "2.0.0" },
    { version: null }, { lastRelease: { tag: "bad", version: "0.1.0", commit: "a".repeat(40) } },
  ]) assert.throws(() => new api.SemanticDecision({ ...decision, ...patch }));
});

test("semantic services are replaceable classes rather than fixed selection hooks", async () => {
  class History {
    async read() { return { lastRelease: null, commits: [commit("project change")] }; }
  }
  class Analyzer {
    analyze(commits) { assert.equal(commits.length, 1); return "patch"; }
  }
  class Selector {
    select(input) { assert.equal(input.releaseType, "patch"); return "0.7.0"; }
  }
  class Notes {
    generate(commits) { return `Project notes: ${commits[0].message}`; }
  }
  const decision = await new api.SemanticRelease({
    history: new History(), analyzer: new Analyzer(), selector: new Selector(), notes: new Notes(),
  }).analyze("f".repeat(40));
  assert.equal(decision.version, "0.7.0");
  assert.equal(decision.notes, "Project notes: project change");
});

test("semantic workflow uses actual reachable tags and invocation-scoped decisions without a development bump", async (t) => {
  await checkSemanticRelease(t, api);
});

test("generated changelogs preserve history, resolve paths, and reject conflicting or empty notes without writing", async (t) => {
  await checkGeneratedChangelog(t, api);
});

test("explicit semantic releases can opt into a next-development commit", async (t) => {
  const fixture = await releaseFixture(t);
  const workflow = new api.SemanticReleaseWorkflow({
    nextDevelopment: true, verifier: fixture.config.verifier,
    next: fixture.config.next, validator: fixture.config.validator,
  });
  const result = await workflow.run({ ...fixture, version: "2.3.4" });
  assert.equal(result.verification, "verified");
  assert.equal(result.semantic.decision.explicitVersion, "2.3.4");
  assert.equal(result.semantic.decision.releaseType, null);
  assert.equal(JSON.parse(await readFile(join(fixture.cwd, "package.json"), "utf8")).version, "2.3.5");
  assert.equal(fixture.events.filter((event) => event === "next").length, 1);
});

test("ineligible, shallow, and stale semantic inputs fail before project edits or publication", async (t) => {
  const fixture = await releaseFixture(t);
  const initial = await fixture.commit();
  const failures = [];
  await assert.rejects(new api.SemanticReleaseWorkflow().prepare({
    ...fixture, observer: { async failed(event) { failures.push(event); } },
  }), /Nothing to release/u);
  assert.equal(failures[0].id, "analyze");
  assert.equal(failures[0].execution.release, null);
  assert.equal(await fixture.commit(), initial);
  assert.equal(await fixture.git("status", "--porcelain"), "");
  await assert.rejects(readFile(join(fixture.artifacts, "release.json")), { code: "ENOENT" });
  const shallow = join(fixture.directory, "shallow");
  await command("git", ["clone", "--depth", "1", "--branch", "master", pathToFileURL(fixture.remote).href, shallow]);
  const history = new api.GitHistory((program, args) => command(program, args, { cwd: shallow }));
  await assert.rejects(history.read(initial), /shallow/u);
  await assert.rejects(history.read("invalid"), /captured commit/u);
  const analyzed = await new api.AnalyzeSemanticRelease().run({ ...fixture, version: "1.2.3" });
  await writeFile(join(fixture.cwd, "later.txt"), "Later work\n");
  await fixture.git("add", ".");
  await fixture.git("commit", "-m", "fix: later commit");
  await fixture.git("push", "origin", "master");
  await assert.rejects(new api.InitializeSemanticRelease().run(analyzed), /another commit/u);
  await assert.rejects(new api.AnalyzeSemanticRelease({ nextDevelopment: "yes" }).run(fixture), /boolean/u);
  class AlteredNotes {
    async release() { return "Notes outside the captured decision"; }
    async next() {}
  }
  await assert.rejects(new api.SemanticReleaseWorkflow({ changelog: new AlteredNotes() }).prepare(fixture), /notes differ/u);
  assert.equal(fixture.events.includes("npm pack"), false);
  assert.equal(fixture.published.length, 0);
});
