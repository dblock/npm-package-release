import assert from "node:assert/strict";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { release, verify } from "../src/index.js";
import { releaseFixture } from "./helpers/release-fixture.js";

test("release uses actual Git pushes, npm tests/lint, and exact archive consumers", async (t) => {
  const fixture = await releaseFixture(t, { viewArray: true, missingLookups: 1 });
  fixture.env.GITHUB_ACTIONS = "true";
  fixture.env.GITHUB_EVENT_NAME = "workflow_dispatch";
  fixture.env.GITHUB_REF = "refs/heads/master";
  const result = await release(fixture.config, { ...fixture, version: "0.2.0" });
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
  const result = await release(fixture.config, fixture);
  assert.equal(result.verification, "unverified");
  assert.equal(fixture.published.length, 1);
  assert.equal(result.phase, "next");
  assert.ok(fixture.events.some((event) => event.includes("release could not be verified")));
  assert.equal(JSON.parse(await readFile(join(fixture.cwd, "package.json"), "utf8")).version, "0.1.1");
});

test("null changelog and disabled GitHub hosting preserve package publication and version increments", async (t) => {
  const fixture = await releaseFixture(t);
  const original = await readFile(join(fixture.cwd, "CHANGELOG.md"), "utf8");
  const result = await release({ ...fixture.config, changelog: null, github: false }, fixture);
  assert.equal(result.verification, "verified");
  assert.equal(fixture.events.includes("gh release"), false);
  assert.equal(await readFile(join(fixture.cwd, "CHANGELOG.md"), "utf8"), original);
});

test("dirty checkouts and unexpected validation/index changes cannot enter a release commit", async (t) => {
  const fixture = await releaseFixture(t);
  const initial = await fixture.commit();
  await writeFile(join(fixture.cwd, "unrelated.txt"), "Keep this work.\n");
  await assert.rejects(release(fixture.config, fixture), /clean checkout/u);
  assert.equal(await readFile(join(fixture.cwd, "unrelated.txt"), "utf8"), "Keep this work.\n");
  await rm(join(fixture.cwd, "unrelated.txt"));
  await assert.rejects(release({
    ...fixture.config,
    validate: async () => {
      await writeFile(join(fixture.cwd, "injected.txt"), "Not preparation.\n");
      await fixture.git("add", "injected.txt");
    },
  }, fixture), /Unexpected/u);
  assert.equal(await fixture.commit(), initial);
  assert.equal(fixture.published.length, 0);
});

test("local and remote duplicate tags are rejected without touching project files", async (t) => {
  const fixture = await releaseFixture(t);
  await fixture.git("tag", "v0.1.0");
  await assert.rejects(release(fixture.config, fixture), /tag already exists/u);
  await fixture.git("push", "origin", "refs/tags/v0.1.0");
  await fixture.git("tag", "-d", "v0.1.0");
  await assert.rejects(release(fixture.config, fixture), /tag already exists/u);
  assert.equal(await fixture.git("status", "--porcelain"), "");
});

test("duplicate versions and non-404 registry errors fail closed", async (t) => {
  for (const settings of [
    { alreadyPublished: true },
    { registryError: Object.assign(new Error("Registry unavailable"), { stdout: '{"error":{"code":"E503"}}' }) },
    { registryError: Object.assign(new Error("Malformed response"), { stdout: "<html>" }) },
  ]) {
    const fixture = await releaseFixture(t, settings);
    await assert.rejects(release(fixture.config, fixture), /already published|Registry unavailable|Malformed response/u);
    assert.equal(fixture.published.length, 0);
    assert.equal(await fixture.git("status", "--porcelain"), "");
  }
});

test("a failed remote push after publication retains the archive/bundle and never starts next", async (t) => {
  const fixture = await releaseFixture(t, {
    intercept: async (program, args) => {
      if (program === "git" && args[0] === "push") throw new Error("Simulated remote push failure");
    },
  });
  await assert.rejects(release(fixture.config, fixture), /push failure/u);
  const state = await fixture.state();
  assert.equal(state.phase, "published");
  assert.equal(fixture.published.length, 1);
  assert.equal(fixture.events.includes("gh release"), false);
  assert.equal(fixture.events.includes("next"), false);
  assert.ok((await readFile(join(fixture.artifacts, "release.bundle"))).length > 0);
  assert.ok((await readFile(join(fixture.artifacts, state.artifact.filename))).length > 0);
  await assert.rejects(release(fixture.config, fixture), /Remote branch advanced/u);
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
    await assert.rejects(release(fixture.config, fixture), new RegExp(`Failed ${operation}`, "u"));
    assert.equal(fixture.events.includes("next"), false);
    assert.equal((await fixture.state()).phase, operation === "publish" ? "publishing" : "pushed");
  }
});

test("consumer failure stops before publication and removes its isolated consumer", async (t) => {
  const fixture = await releaseFixture(t);
  let consumer;
  await assert.rejects(release({
    ...fixture.config,
    validateArtifact: async (context) => {
      consumer = context.consumer;
      throw new Error("Public API is broken");
    },
  }, fixture), /Public API is broken/u);
  await assert.rejects(readFile(join(consumer, "package.json")), { code: "ENOENT" });
  assert.equal(fixture.published.length, 0);
});

test("failed next-development validation preserves the published release without pushing invalid files", async (t) => {
  const fixture = await releaseFixture(t);
  await assert.rejects(release({
    ...fixture.config,
    validate: async ({ phase, run }) => {
      await run("npm", ["test"]);
      if (phase === "next") throw new Error("Development validation failed");
    },
  }, fixture), /Development validation failed/u);
  const state = await fixture.state();
  assert.equal(state.phase, "hosted");
  assert.equal(fixture.published.length, 1);
  assert.equal((await fixture.git("ls-remote", "origin", "refs/heads/master")).split("\t")[0], state.releaseCommit);
  assert.equal(JSON.parse(await readFile(join(fixture.cwd, "package.json"), "utf8")).version, "0.1.1");
});

test("a concurrent remote branch advance after publication prevents the atomic push", async (t) => {
  const fixture = await releaseFixture(t, {
    onPublish: async ({ git }) => { await git("push", "origin", "HEAD:master"); },
  });
  await assert.rejects(release(fixture.config, fixture), /Remote branch advanced/u);
  assert.equal(fixture.published.length, 1);
  assert.equal(fixture.events.includes("next"), false);
});

test("retained and registry integrity mismatches fail rather than republish", async (t) => {
  for (const tamper of ["artifact", "registry"]) {
    const fixture = await releaseFixture(t, {
      onPublish: tamper === "artifact" ? async ({ archive }) => { await writeFile(archive, "tampered"); } : undefined,
      intercept: tamper === "registry" ? async (program, args) => {
        if (program === "npm" && args[0] === "view" && args[1].endsWith("@0.1.0") && fixture.published.length) {
          return JSON.stringify({ ...fixture.published[0], dist: { integrity: "bad", shasum: "bad" } });
        }
      } : undefined,
    });
    await assert.rejects(release(fixture.config, fixture));
    assert.equal(fixture.published.length, 1);
    if (tamper === "registry") assert.equal((await fixture.state()).verification, "failed");
  }
});

test("invalid configuration, versions, runtime scope, and existing artifacts fail safely", async (t) => {
  const fixture = await releaseFixture(t);
  for (const config of [
    {}, { changelog: { format: "bad" } }, { ...fixture.config, prepare: "npm test" },
    { ...fixture.config, timezone: "Not/A_Zone" },
    { ...fixture.config, verification: { attempts: 0 } },
    { ...fixture.config, repository: "not-a-repository" },
    { ...fixture.config, remote: "--upload-pack=bad" },
  ]) await assert.rejects(release(config, fixture));
  await assert.rejects(release(fixture.config, { ...fixture, version: "1.0.0-beta.1" }), /numeric/u);
  await assert.rejects(release(fixture.config, { ...fixture, version: "9007199254740992.0.0" }), /semantic/u);
  await assert.rejects(release(fixture.config, { ...fixture, env: {
    ...fixture.env, GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request",
  } }), /manual dispatch/u);
  const subdirectory = join(fixture.cwd, "subdirectory");
  await mkdir(subdirectory);
  await assert.rejects(release(fixture.config, { ...fixture, cwd: subdirectory }), /repository root/u);
  await mkdir(fixture.artifacts);
  await writeFile(join(fixture.artifacts, "preserve.txt"), "Do not overwrite.");
  await assert.rejects(release(fixture.config, fixture), /Existing release artifacts/u);
  assert.equal(await readFile(join(fixture.artifacts, "preserve.txt"), "utf8"), "Do not overwrite.");
});

test("remote tag lookup failures are not interpreted as tag absence", async (t) => {
  const fixture = await releaseFixture(t, {
    intercept: async (program, args) => {
      if (program === "git" && args[0] === "ls-remote") {
        throw Object.assign(new Error("Cannot contact remote"), { code: 128 });
      }
    },
  });
  await assert.rejects(release(fixture.config, fixture), /Cannot contact remote/u);
  assert.equal(fixture.published.length, 0);
});

test("private/workspace packages and mismatched lockfiles are rejected", async (t) => {
  for (const manifest of [{ private: true }, { workspaces: ["packages/*"] }, { name: "INVALID" }]) {
    const fixture = await releaseFixture(t, { manifest });
    await assert.rejects(release(fixture.config, fixture), /public root package|package name/u);
  }
  const fixture = await releaseFixture(t);
  const lockPath = join(fixture.cwd, "package-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.version = "0.0.1";
  await writeFile(lockPath, JSON.stringify(lock));
  await fixture.git("add", "package-lock.json");
  await fixture.git("commit", "-m", "Mismatched lock");
  await fixture.git("push", "origin", "master");
  await assert.rejects(release(fixture.config, fixture), /Lockfile/u);
  assert.equal(fixture.published.length, 0);
});

test("GitHub summaries are isolated from the real environment", async (t) => {
  const fixture = await releaseFixture(t);
  await release(fixture.config, fixture);
  assert.match(await readFile(fixture.env.GITHUB_STEP_SUMMARY, "utf8"), /@npr-test\/example@0.1.0: verified/u);
});
