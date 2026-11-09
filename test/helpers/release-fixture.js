import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { command } from "../../src/command.js";

export async function releaseFixture(t, settings = {}) {
  const directory = await mkdtemp(join(tmpdir(), "npr-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "project");
  const remote = join(directory, "remote.git");
  const artifacts = join(directory, "artifacts");
  await mkdir(cwd);
  const git = (...args) => command("git", args, { cwd, env: { GIT_CONFIG_NOSYSTEM: "1" } });
  await command("git", ["init", "--bare", remote]);
  await git("init", "-b", "master");
  await git("config", "user.name", "Release Test");
  await git("config", "user.email", "release@example.test");
  await git("config", "commit.gpgsign", "false");
  await git("config", "tag.gpgsign", "false");
  await git("config", "core.autocrlf", "false");
  const manifest = {
    name: "@npr-test/example", version: "0.1.0", type: "module", exports: "./index.js",
    files: ["index.js", "test.js"],
    repository: { type: "git", url: "git+https://github.com/npr-test/example.git" },
    scripts: { test: "node --test test.js", lint: "node --check index.js" },
    ...settings.manifest,
  };
  await writeFile(join(cwd, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(cwd, "package-lock.json"), JSON.stringify({
    name: manifest.name, version: manifest.version, lockfileVersion: 3,
    packages: { "": { name: manifest.name, version: manifest.version } },
  }, null, 2) + "\n");
  await writeFile(join(cwd, "index.js"), 'export const message = "A real packed consumer";\n');
  await writeFile(join(cwd, "test.js"), 'import assert from "node:assert/strict"; import { message } from "./index.js"; assert.equal(message, "A real packed consumer");\n');
  await writeFile(join(cwd, "CHANGELOG.md"),
    "# Changelog\n\n## 0.1.0 (Next)\n\n- Ship release tooling.\n- Your contribution here.\n");
  await git("add", ".");
  await git("commit", "-m", "Initial fixture");
  await git("remote", "add", "origin", remote);
  await git("push", "-u", "origin", "master");
  await git("remote", "set-head", "origin", "master");
  const events = [];
  const lookups = [];
  const published = [];
  let visibleLookups = 0;
  const run = async (program, args, options) => {
    const operation = `${program} ${args[0]}`;
    events.push(operation);
    if (settings.intercept) {
      const intercepted = await settings.intercept(program, args, options, { cwd, remote, git, events });
      if (intercepted !== undefined) return intercepted;
    }
    if (program === "npm" && args[0] === "view") {
      lookups.push(args[1]);
      if (settings.registryError) throw settings.registryError;
      if (published.length && ++visibleLookups > (settings.missingLookups ?? 0)) {
        return JSON.stringify(settings.viewArray ? [published[0]] : published[0]);
      }
      if (settings.alreadyPublished) return JSON.stringify({ name: manifest.name, version: "0.1.0" });
      throw Object.assign(new Error("Version not found"), { stdout: '{"error":{"code":"E404"}}', code: 1 });
    }
    if (program === "npm" && args[0] === "publish") {
      const archive = await readFile(args[1]);
      const packed = JSON.parse(await command("tar", ["-xOf", args[1], "package/package.json"]));
      published.push({
        name: packed.name, version: packed.version,
        dist: {
          integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
          shasum: createHash("sha1").update(archive).digest("hex"),
        },
      });
      await settings.onPublish?.({ cwd, remote, git, events, archive: args[1] });
      return "";
    }
    if (program === "gh") return "";
    return await command(program, args, options);
  };
  const config = {
    changelog: { format: "intridea" },
    verification: { attempts: 3, delay: 0 },
    prepare: async ({ phase }) => { events.push(phase); },
    next: async ({ phase, run: exec }) => {
      events.push(phase);
      await exec(process.execPath, ["-e", 'if (process.env.PACKAGE_ARCHIVE !== "") throw new Error("Archive override leaked into next validation");']);
    },
    validateArtifact: async ({ consumer, run: exec }) => {
      events.push("consumer");
      await exec(process.execPath, ["--input-type=module", "--eval",
        'import { message } from "@npr-test/example"; if (message !== "A real packed consumer") throw new Error("Broken artifact");',
      ], { cwd: consumer });
    },
  };
  const env = {
    ...process.env, GITHUB_ACTIONS: "false",
    GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
  };
  const options = { cwd, artifacts, run, log: (message) => events.push(message), env };
  const state = async () => JSON.parse(await readFile(join(artifacts, "release.json"), "utf8"));
  const commit = async () => (await git("rev-parse", "HEAD")).trim();
  const assertReleased = async (result) => {
    assert.equal(result.verification, "verified");
    assert.equal(published.length, 1);
    assert.equal((await git("show", `v${result.version}:package.json`)).includes(`"version": "${result.version}"`), true);
    assert.equal(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).version, result.nextVersion);
    assert.equal(JSON.parse(await readFile(join(cwd, "package-lock.json"), "utf8")).packages[""].version, result.nextVersion);
    assert.ok(events.indexOf("prepare") < events.indexOf("npm pack"));
    assert.ok(events.indexOf("consumer") < events.indexOf("npm publish"));
    assert.ok(events.indexOf("npm publish") < events.indexOf("gh release"));
    assert.ok(events.indexOf("gh release") < events.indexOf("next"));
    assert.equal(events.filter((event) => event === "npm pack").length, 1);
    assert.equal(await git("status", "--porcelain"), "");
  };
  return { ...options, config, git, events, lookups, published, state, commit, assertReleased, remote, directory };
}
