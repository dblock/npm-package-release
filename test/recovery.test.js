import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import process from "node:process";
import test from "node:test";
import * as api from "../dist/index.js";
import { command } from "../dist/command.js";
import { releaseFixture } from "./helpers/release-fixture.js";

test("current-checkout release operations reconcile failed and repeated publication without restoring diagnostics", async (t) => {
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
  const config = new api.ReleaseWorkflow({ ...fixture.config, observer: { async succeeded() { notifications++; } } });
  const built = await api.prepare(config, fixture);
  assert.equal(fixture.published.length, 0);
  assert.equal(notifications, 0);
  assert.equal((await fixture.git("ls-remote", "origin", "refs/heads/master")).split("\t")[0], built.state.initialCommit);
  await writeFile(join(fixture.artifacts, "release.json"), '{"phase":"next","verification":"verified","artifact":{"filename":"wrong"}}');
  const options = { ...fixture, version: built.release.version, env: built.runtime.env };
  failPush = true;
  await assert.rejects(api.release(config, options), /Connection failed/u);
  assert.equal(fixture.published.length, 1);
  assert.equal(notifications, 0);
  const completed = await api.release(config, options);
  assert.equal(completed.verification, "verified");
  assert.equal(notifications, 1);
  const pushes = fixture.events.filter((event) => event === "git push").length;
  const published = await new api.PublishArtifact().run(built);
  const pushed = await new api.PushRelease().run(published);
  const hosted = await new api.CreateHostedRelease().run(pushed);
  const again = await new api.PrepareNextVersion().run(hosted);
  assert.equal(again.state.nextCommit, completed.nextCommit);
  assert.equal(fixture.published.length, 1);
  assert.equal(fixture.events.filter((event) => event === "npm pack").length, 3);
  assert.equal(fixture.events.filter((event) => event === "git push").length, pushes);
  assert.equal(fixture.events.filter((event) => event === "gh release").length, 1);
  assert.equal(fixture.events.filter((event) => event === "next").length, 1);
  await assert.rejects(readFile(join(fixture.artifacts, "checkpoint.json")), { code: "ENOENT" });
  assert.equal(await fixture.git("status", "--porcelain"), "");
  await fixture.git("commit", "--allow-empty", "-m", "Later local development");
  const later = await fixture.commit();
  await assert.rejects(api.release(config, options), /refusing to rewind/u);
  assert.equal(await fixture.commit(), later);
  assert.equal(fixture.published.length, 1);
});

test("a conflicting intended release tree is rejected before publication", async (t) => {
  const fixture = await releaseFixture(t);
  const built = await api.prepare(new api.ReleaseWorkflow(fixture.config), fixture);
  const tag = await fixture.git("rev-parse", "v0.1.0");
  await assert.rejects(api.release(new api.ReleaseWorkflow({
    ...fixture.config, prepare: async () => { await writeFile(join(fixture.cwd, "README.md"), "Different intended release\n"); },
  }), { ...fixture, env: built.runtime.env }), /tree differs/u);
  assert.equal(await fixture.git("rev-parse", "v0.1.0"), tag);
  assert.equal(fixture.published.length, 0);
});

test("a nonreproducible rebuild cannot replace the preserved prepublication archive", async (t) => {
  const fixture = await releaseFixture(t, { manifest: {
    files: ["index.js", "test.js", "generated.js"],
    scripts: { test: "node --test test.js", lint: "node --check index.js", prepack: "node build.js" },
  } });
  await writeFile(join(fixture.cwd, ".gitignore"), "generated.js\n");
  await writeFile(join(fixture.cwd, "build.js"),
    'import { writeFileSync } from "node:fs"; writeFileSync("generated.js", process.env.NPR_TEST_BUILD_VALUE);\n');
  await fixture.git("add", ".gitignore", "build.js");
  await fixture.git("commit", "-m", "Ignore generated build output");
  await fixture.git("push", "origin", "master");
  const workflow = new api.ReleaseWorkflow(fixture.config);
  const built = await workflow.prepare({ ...fixture, env: { ...fixture.env, NPR_TEST_BUILD_VALUE: "first" } });
  const archive = join(fixture.artifacts, built.state.artifact.filename);
  const bytes = await readFile(archive);
  await assert.rejects(workflow.run({
    ...fixture, env: { ...built.runtime.env, NPR_TEST_BUILD_VALUE: "different" },
  }), /Existing archive differs/u);
  assert.deepEqual(await readFile(archive), bytes);
  assert.equal(fixture.published.length, 0);
});

test("a fresh release checkout rebuilds matching outputs and reuses remote development without downloaded state", async (t) => {
  const fixture = await releaseFixture(t);
  const workflow = new api.ReleaseWorkflow(fixture.config);
  const built = await workflow.prepare(fixture);
  const released = await workflow.run({ ...fixture, env: built.runtime.env });
  const cwd = join(fixture.directory, "fresh-release-checkout");
  await command("git", ["-c", "core.autocrlf=false", "clone", "--branch", "v0.1.0", fixture.remote, cwd]);
  await command("git", ["switch", "-c", "master"], { cwd });
  await command("git", ["remote", "set-head", "origin", "master"], { cwd });
  const again = await workflow.run({
    ...fixture, cwd, artifacts: join(fixture.directory, "new-artifacts"), env: built.runtime.env,
  });
  assert.equal(again.releaseCommit, released.releaseCommit);
  assert.equal(again.nextCommit, released.nextCommit);
  assert.equal(again.artifact.integrity, released.artifact.integrity);
  assert.equal(again.verification, "verified");
  assert.equal(fixture.published.length, 1);
  assert.equal(fixture.events.filter((event) => event === "gh release").length, 1);
  assert.equal(await command("git", ["status", "--porcelain"], { cwd }), "");
});

test("published versions are reused only when both archive checksums match", async (t) => {
  const fixture = await releaseFixture(t);
  const built = await api.prepare(new api.ReleaseWorkflow(fixture.config), fixture);
  fixture.published.push({ name: built.release.name, version: built.release.version, dist: { integrity: "different", shasum: "different" } });
  await assert.rejects(api.release(new api.ReleaseWorkflow(fixture.config), { ...fixture, env: built.runtime.env }), /integrity mismatch/u);
  fixture.published[0].dist = {};
  await assert.rejects(api.release(new api.ReleaseWorkflow(fixture.config), fixture), /unavailable/u);
  assert.equal(fixture.events.filter((event) => event === "npm publish").length, 0);
  assert.equal((await fixture.git("ls-remote", "origin", "refs/heads/master")).split("\t")[0], built.state.initialCommit);
});

test("matching Git refs can be reused and missing tags completed without rewinding descendants", async (t) => {
  const fixture = await releaseFixture(t);
  const built = await api.prepare(new api.ReleaseWorkflow(fixture.config), fixture);
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
  const bytes = Buffer.from([0, 255, 128, 13, 10, 192, 254, 42]);
  await writeFile(archive, bytes);
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
  let downloads = 0;
  let output;
  let downloaded = bytes;
  let downloadError;
  const host = new api.GitHubReleaseHost(async (program, args, options) => {
    if (args[0] === "api" && args[1] === "repos/owner/repo/releases/assets/42") {
      assert.equal(program, "gh");
      assert.deepEqual(args.slice(2), ["--header", "Accept: application/octet-stream"]);
      output = options.output;
      downloads++;
      if (downloadError) {
        await writeFile(output, "Partial download");
        throw downloadError;
      }
      return command(process.execPath, ["-e", `process.stdout.write(Buffer.from(${JSON.stringify([...downloaded])}))`], options);
    }
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
  assert.equal(downloads, 0);
  for (const digest of [undefined, null, "", "sha256:invalid", 42]) {
    metadata.assets = [{ name: asset.name, id: 42, digest, browser_download_url: "https://untrusted.invalid/asset" }];
    await host.create(identity, { archive, notes });
    await assert.rejects(readFile(output), { code: "ENOENT" });
  }
  assert.equal(downloads, 5);
  metadata.assets = [{ ...asset, id: 42, digest: "sha256:" + "0".repeat(64) }];
  await assert.rejects(host.create(identity, { archive, notes }), /checksum differs/u);
  assert.equal(downloads, 5);
  for (const id of [undefined, 0, -1, 1.5, "42", Number.MAX_SAFE_INTEGER + 1]) {
    metadata.assets = [{ name: asset.name, id }];
    await assert.rejects(host.create(identity, { archive, notes }), /positive download ID/u);
  }
  metadata.assets = [{ name: asset.name, id: 42 }, { name: asset.name, id: 42 }];
  await assert.rejects(host.create(identity, { archive, notes }), /checksum differs/u);
  assert.equal(downloads, 5);
  metadata.assets = [{ name: asset.name, id: 42 }];
  downloaded = Buffer.from("Different bytes");
  await assert.rejects(host.create(identity, { archive, notes }), /checksum differs/u);
  await assert.rejects(readFile(output), { code: "ENOENT" });
  downloadError = new Error("Asset download failed");
  await assert.rejects(host.create(identity, { archive, notes }), (error) => error === downloadError);
  await assert.rejects(readFile(output), { code: "ENOENT" });
  assert.equal(mutations, 1);
  metadata.assets = [asset];
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
