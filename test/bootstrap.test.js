import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { bootstrap, githubRepository, reserve, trust } from "../dist/bootstrap.js";
import { interactive } from "../dist/command.js";

const registry = "--registry=https://registry.npmjs.org/";
const message = "Placeholder reserving this name. Install a later version.";

function missing() {
  return Object.assign(new Error("npm view failed."), { stdout: JSON.stringify({ error: { code: "E404" } }) });
}

async function fixture(t, manifest = { name: "@scope/example", license: "MIT", repository: { url: "git+https://github.com/owner/example.git" } }) {
  const cwd = await mkdtemp(join(tmpdir(), "npr-bootstrap-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  if (manifest) await writeFile(join(cwd, "package.json"), JSON.stringify(manifest));
  const calls = [];
  const logs = [];
  const state = { exists: false, origin: null, placeholders: [], fail: null };
  return {
    cwd, calls, logs, state,
    options: {
      cwd,
      log: (line) => logs.push(line),
      async run(program, args) {
        calls.push(["run", program, ...args]);
        if (program === "git") {
          if (!state.origin) throw new Error("No such remote.");
          return `${state.origin}\n`;
        }
        if (state.exists === "error") throw new Error("Network unavailable.");
        if (!state.exists) throw missing();
        return "\"@scope/example\"\n";
      },
      async interactive(program, args, options) {
        calls.push(["interactive", program, ...args]);
        if (args[0] === "publish") {
          state.placeholders.push(JSON.parse(await readFile(join(options.cwd, "package.json"), "utf8")));
          state.directory = options.cwd;
        }
        if (state.fail === args[0]) throw new Error(`${args[0]} failed.`);
      },
    },
  };
}

test("reserve publishes and deprecates an empty 0.0.0 placeholder from a temporary directory", async (t) => {
  const { options, calls, state, logs } = await fixture(t);
  await reserve(options);
  assert.deepEqual(state.placeholders, [{
    name: "@scope/example", version: "0.0.0", description: message, license: "MIT",
    repository: "git+https://github.com/owner/example.git",
  }]);
  await assert.rejects(access(state.directory), { code: "ENOENT" });
  assert.equal(calls[0][3], "@scope/example");
  assert.deepEqual(calls.slice(1), [
    ["interactive", "npm", "publish", "--access", "public", registry],
    ["interactive", "npm", "deprecate", "@scope/example@0.0.0", message, registry],
  ]);
  assert.deepEqual(logs, ["[npr] published placeholder: @scope/example@0.0.0", "[npr] deprecated placeholder: @scope/example@0.0.0"]);
});

test("reserve refuses existing names and unknown registry errors before publishing", async (t) => {
  const { options, calls, state } = await fixture(t);
  state.exists = true;
  await assert.rejects(reserve(options), /@scope\/example already exists on npm; reserve only unpublished names\./u);
  state.exists = "error";
  await assert.rejects(reserve(options), /Network unavailable/u);
  assert.equal(calls.some(([kind]) => kind === "interactive"), false);
});

test("reserve accepts flag overrides, omits unknown metadata, and removes the directory after failures", async (t) => {
  const { options, state } = await fixture(t, null);
  await assert.rejects(reserve(options), /Pass --name or run in a directory with package.json\./u);
  await writeFile(join(options.cwd, "package.json"), "{");
  await assert.rejects(reserve({ ...options, name: "example" }), SyntaxError);
  await rm(join(options.cwd, "package.json"));
  await assert.rejects(reserve({ ...options, name: "Invalid Name" }), /Expected an npm package name\./u);
  await assert.rejects(reserve({ ...options, name: "example", license: "" }), /Expected a license string\./u);
  state.fail = "deprecate";
  await assert.rejects(reserve({ ...options, name: "example" }), /deprecate failed\./u);
  assert.deepEqual(state.placeholders, [{ name: "example", version: "0.0.0", description: message }]);
  await assert.rejects(access(state.directory), { code: "ENOENT" });
});

test("trust configures the calling workflow and environment, inferring the repository", async (t) => {
  const { options, calls, logs } = await fixture(t);
  await trust(options);
  assert.deepEqual(calls, [
    ["interactive", "npm", "trust", "github", "@scope/example", "--repo", "owner/example", "--file", "release.yml",
      "--env", "release", "--allow-publish", registry],
    ["interactive", "npm", "trust", "list", "@scope/example", "--json", registry],
  ]);
  assert.match(logs[0], /trusted publisher configured for @scope\/example; it expires unless it publishes within two days\./u);
  calls.length = 0;
  await trust({ ...options, repo: "other/repo", file: "publish.yaml", environment: "npm" });
  assert.deepEqual(calls[0].slice(5, 11), ["--repo", "other/repo", "--file", "publish.yaml", "--env", "npm"]);
});

test("trust falls back to the origin remote and validates its inputs", async (t) => {
  const { options, calls, state } = await fixture(t, { name: "example", repository: "https://gitlab.com/owner/example" });
  await assert.rejects(trust(options), /Pass --repo as a GitHub owner\/repository; it could not be inferred\./u);
  state.origin = "git@github.com:owner/example.git";
  await trust(options);
  assert.deepEqual(calls.find(([kind]) => kind === "interactive").slice(5, 7), ["--repo", "owner/example"]);
  await assert.rejects(trust({ ...options, repo: "https://github.com/owner/example" }), /Expected --repo/u);
  await assert.rejects(trust({ ...options, file: ".github/workflows/release.yml" }), /Expected --file/u);
  await assert.rejects(trust({ ...options, environment: "two words" }), /Expected --env/u);
});

test("bootstrap validates trust inputs before publishing, then reserves and trusts", async (t) => {
  const { options, calls, state } = await fixture(t, { name: "example" });
  await assert.rejects(bootstrap(options), /Pass --repo/u);
  assert.equal(calls.some(([kind]) => kind === "interactive"), false);
  await bootstrap({ ...options, repo: "owner/example" });
  assert.deepEqual(calls.filter(([kind]) => kind === "interactive").map((call) => call.slice(2, 4)), [
    ["publish", "--access"], ["deprecate", "example@0.0.0"], ["trust", "github"], ["trust", "list"],
  ]);
  state.fail = "trust";
  await assert.rejects(bootstrap({ ...options, repo: "owner/example" }),
    /^Error: Reserved example@0\.0\.0, but Trusted Publishing setup failed; rerun npr trust\. trust failed\.$/u);
});

test("interactive commands inherit the terminal and report failures", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "npr-interactive-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await interactive(process.execPath, ["-e", "require('fs').writeFileSync('ran', process.env.NPR_VALUE)"],
    { cwd, env: { NPR_VALUE: "yes" } });
  assert.equal(await readFile(join(cwd, "ran"), "utf8"), "yes");
  await assert.rejects(interactive(process.execPath, ["-e", "process.exit(3)"]), /failed with exit code 3\./u);
  await assert.rejects(interactive(join(cwd, "missing-program"), []), { code: "ENOENT" });
});

test("GitHub repository URLs normalize to owner/repository", () => {
  for (const url of [
    "owner/repo", "github:owner/repo", "https://github.com/owner/repo", "https://github.com/owner/repo.git",
    "git+https://github.com/owner/repo.git", "git+ssh://git@github.com/owner/repo.git", "git@github.com:owner/repo.git",
    "git://github.com/owner/repo.git",
  ]) assert.equal(githubRepository(url), "owner/repo", url);
  for (const url of ["https://gitlab.com/owner/repo", "gitlab:owner/repo", "owner", "https://github.com/owner"]) {
    assert.equal(githubRepository(url), null, url);
  }
});

test("the CLI previews setup commands without contacting npm and rejects unsupported flags", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "npr-bootstrap-cli-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "example", license: "MIT", repository: "github:owner/example" }));
  const entry = fileURLToPath(new URL("../bin/npr.js", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [entry, ...args], { cwd, encoding: "utf8" });
  const preview = run("bootstrap", "--dry-run", "--env", "npm");
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.stderr, "");
  assert.deepEqual(preview.stdout.trim().split("\n"), [
    '[npr] placeholder package.json: {"name":"example","version":"0.0.0","description":"Placeholder reserving this name. Install a later version.","license":"MIT","repository":"github:owner/example"}',
    `[npr] would run: npm publish --access public ${registry}`,
    `[npr] would run: npm deprecate example@0.0.0 "${message}" ${registry}`,
    `[npr] would run: npm trust github example --repo owner/example --file release.yml --env npm --allow-publish ${registry}`,
    `[npr] would run: npm trust list example --json ${registry}`,
  ]);
  const reserved = run("reserve", "--dry-run", "--name", "other", "--license", "ISC");
  assert.equal(reserved.status, 0, reserved.stderr);
  assert.match(reserved.stdout, /"name":"other".*"license":"ISC"/u);
  assert.doesNotMatch(reserved.stdout, /trust/u);
  const trusted = run("trust", "--dry-run", "--repo", "other/repo");
  assert.equal(trusted.status, 0, trusted.stderr);
  assert.doesNotMatch(trusted.stdout, /publish --access|placeholder/u);
  assert.match(trusted.stdout, /--repo other\/repo/u);
  for (const args of [["reserve", "--repo", "owner/repo"], ["trust", "--license", "MIT"], ["bootstrap", "extra"], ["toString"]]) {
    const result = run(...args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^\[npr\] /u);
  }
});
