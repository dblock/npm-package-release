import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import * as api from "../dist/index.js";
import { command } from "../dist/command.js";
import { releaseFixture } from "./helpers/release-fixture.js";

test("a downloaded checkpoint completes in a fresh checkout and reconciles failed and repeated publication", async (t) => {
  let failPush = false;
  const fixture = await releaseFixture(t, {
    onPublish: async () => { throw new Error("Transport failed after npm accepted the archive"); },
    intercept: async (program, args) => {
      if (failPush && program === "git" && args[0] === "push") {
        failPush = false;
        throw new Error("Connection failed before Git push");
      }
    },
  });
  let notifications = 0;
  const config = { ...fixture.config, observer: { async succeeded() { notifications++; } } };
  const built = await api.prepare(config, fixture);
  assert.equal(fixture.published.length, 0);
  assert.equal(notifications, 0);
  assert.equal((await fixture.git("ls-remote", "origin", "refs/heads/master")).split("\t")[0], built.state.initialCommit);
  const artifacts = join(fixture.directory, "downloaded-checkpoint");
  await cp(fixture.artifacts, artifacts, { recursive: true });
  const immutable = await readFile(join(artifacts, "checkpoint.json"), "utf8");
  await writeFile(join(artifacts, "release.json"), '{"phase":"next","verification":"verified","artifact":{"filename":"wrong"}}');
  const cwd = join(fixture.directory, "replacement-runner");
  await command("git", ["-c", "core.autocrlf=false", "clone", "--branch", "master", fixture.remote, cwd]);
  await command("git", ["config", "user.name", "Checkpoint Test"], { cwd });
  await command("git", ["config", "user.email", "checkpoint@example.test"], { cwd });
  await command("git", ["config", "commit.gpgsign", "false"], { cwd });
  await command("git", ["config", "core.autocrlf", "false"], { cwd });
  const options = { ...fixture, cwd, artifacts };
  failPush = true;
  await assert.rejects(api.complete(config, options), /Connection failed/u);
  assert.equal(fixture.published.length, 1);
  assert.equal(notifications, 0);
  const completed = await api.complete(config, options);
  assert.equal(completed.verification, "verified");
  assert.equal(notifications, 1);
  const pushes = fixture.events.filter((event) => event === "git push").length;
  const again = await api.complete(config, options);
  assert.equal(again.nextCommit, completed.nextCommit);
  assert.equal(fixture.published.length, 1);
  assert.equal(fixture.events.filter((event) => event === "npm pack").length, 1);
  assert.equal(fixture.events.filter((event) => event === "git push").length, pushes);
  assert.equal(fixture.events.filter((event) => event === "gh release").length, 1);
  assert.equal(fixture.events.filter((event) => event === "next").length, 1);
  assert.equal(await readFile(join(artifacts, "checkpoint.json"), "utf8"), immutable);
  assert.equal(await command("git", ["status", "--porcelain"], { cwd }), "");
  await command("git", ["commit", "--allow-empty", "-m", "Later local development"], { cwd });
  const later = await command("git", ["rev-parse", "HEAD"], { cwd });
  await assert.rejects(api.complete(config, options), /refusing to rewind/u);
  assert.equal(await command("git", ["rev-parse", "HEAD"], { cwd }), later);
  assert.equal(fixture.published.length, 1);
});

test("checkpoint validation rejects changed evidence and strips unrelated metadata before any publication", async (t) => {
  const fixture = await releaseFixture(t);
  await api.prepare(fixture.config, fixture);
  const path = join(fixture.artifacts, "checkpoint.json");
  const original = JSON.parse(await readFile(path, "utf8"));
  for (const patch of [
    { schema: 99 }, { source: { ...original.source, releaseCommit: "invalid" } },
    { artifact: { ...original.artifact, filename: "../escape.tgz" } },
    { source: { ...original.source, releaseCommit: original.source.initialCommit } },
    { source: { ...original.source, preparedTree: "0".repeat(40) } },
    { source: { ...original.source, initialCommit: "0".repeat(40) } },
    { timezone: null }, { verificationOptions: { attempts: 0, delay: 0 } },
    { notesDigest: "changed" }, { bundleDigest: "changed" },
    { release: { ...original.release, notes: "Different notes" } },
  ]) {
    await writeFile(path, JSON.stringify({ ...original, ...patch }));
    await assert.rejects(api.complete(fixture.config, fixture));
    assert.equal(fixture.published.length, 0);
  }
  await writeFile(path, JSON.stringify({
    ...original, source: { ...original.source, name: "untrusted", environment: "private" },
  }));
  const checkpoint = await api.readCheckpoint(fixture.artifacts);
  assert.equal(checkpoint.source.name, undefined);
  assert.equal(checkpoint.source.environment, undefined);
  assert.throws(() => { checkpoint.source.releaseCommit = "changed"; }, TypeError);
  await assert.rejects(api.complete({ ...fixture.config, branch: "different" }, fixture), /Configuration differs/u);
  await writeFile(join(fixture.artifacts, original.artifact.filename), "Changed archive");
  await assert.rejects(api.complete(fixture.config, fixture));
  assert.equal(fixture.published.length, 0);
});

test("published versions are reused only when both archive checksums match", async (t) => {
  const fixture = await releaseFixture(t);
  const built = await api.prepare(fixture.config, fixture);
  fixture.published.push({ name: built.release.name, version: built.release.version, dist: { integrity: "different", shasum: "different" } });
  await assert.rejects(api.complete(fixture.config, fixture), /integrity mismatch/u);
  fixture.published[0].dist = {};
  await assert.rejects(api.complete(fixture.config, fixture), /unavailable/u);
  assert.equal(fixture.events.filter((event) => event === "npm publish").length, 0);
  assert.equal((await fixture.git("ls-remote", "origin", "refs/heads/master")).split("\t")[0], built.state.initialCommit);
});

test("matching Git refs can be reused and missing tags completed without rewinding descendants", async (t) => {
  const fixture = await releaseFixture(t);
  const built = await api.prepare(fixture.config, fixture);
  const { repository } = built.runtime.services;
  await repository.tag(built.release.version, built.state.releaseCommit);
  await assert.rejects(repository.tag(built.release.version, built.state.initialCommit), /another commit/u);
  await repository.push(built.state.releaseCommit, built.release.version);
  await fixture.git("push", "origin", `:refs/tags/v${built.release.version}`);
  await fixture.git("commit", "--allow-empty", "-m", "Newer development");
  const newer = await fixture.commit();
  await fixture.git("push", "origin", "master");
  await repository.push(built.state.releaseCommit, built.release.version);
  assert.equal((await fixture.git("ls-remote", "origin", "refs/heads/master")).split("\t")[0], newer);
  await repository.verifyTag(built.release.version, built.state.releaseCommit);
  await fixture.git("tag", "-d", `v${built.release.version}`);
  await assert.rejects(repository.push(built.state.releaseCommit, built.release.version), /another commit/u);
});

test("hosted releases reconcile missing assets, reject conflicts, and resolve ambiguous accepted mutations", async (t) => {
  const fixture = await releaseFixture(t);
  const archive = join(fixture.directory, "example.tgz");
  const notes = join(fixture.directory, "notes.md");
  await writeFile(archive, "Exact archive bytes");
  await writeFile(notes, "Release notes\n");
  const asset = {
    name: basename(archive), digest: "sha256:" + createHash("sha256").update(await readFile(archive)).digest("hex"),
  };
  const expected = { tag_name: "v1.0.0", name: "1.0.0", body: "Release notes", draft: false, prerelease: false };
  let metadata = { ...expected, assets: [] };
  let error;
  let response;
  let accept = true;
  let failMutation = false;
  let mutations = 0;
  const host = new api.GitHubReleaseHost(async (program, args) => {
    if (args[0] === "api") {
      if (error) throw error;
      if (response !== undefined) return response;
      if (!metadata) throw Object.assign(new Error("Missing"), { stdout: "HTTP/2.0 404 Not Found\n\n{}", code: 1 });
      return "HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n" + JSON.stringify(metadata);
    }
    mutations++;
    if (!accept) {
      if (failMutation) throw new Error("Mutation rejected");
      return "";
    }
    metadata = { ...expected, assets: [asset] };
    if (args[1] === "create") throw new Error("Transport failed after acceptance");
    return "";
  }, "owner/repo");
  const identity = { name: "example", version: "1.0.0" };
  await host.create(identity, { archive, notes });
  await host.create(identity, { archive, notes });
  assert.equal(mutations, 1);
  metadata.body = "Changed by another actor";
  await assert.rejects(host.create(identity, { archive, notes }), /metadata differs/u);
  metadata = { ...expected, assets: [{ name: asset.name }] };
  await assert.rejects(host.create(identity, { archive, notes }), /checksum differs or is unavailable/u);
  metadata = null;
  await host.create(identity, { archive, notes });
  assert.equal(mutations, 2);
  error = Object.assign(new Error("Service unavailable"), { stdout: "HTTP/2.0 503 Unavailable\n\n{}", code: 1 });
  await assert.rejects(host.create(identity, { archive, notes }), /Service unavailable/u);
  assert.equal(mutations, 2);
  error = undefined;
  for (response of ["not HTTP", "HTTP/2.0 200 OK\n\nnull", "HTTP/2.0 200 OK\n\n{"]) {
    await assert.rejects(host.create(identity, { archive, notes }));
  }
  response = undefined;
  metadata = null;
  accept = false;
  await assert.rejects(host.create(identity, { archive, notes }), /could not be verified/u);
  failMutation = true;
  await assert.rejects(host.create(identity, { archive, notes }), /Mutation rejected/u);
});
