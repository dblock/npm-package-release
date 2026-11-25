import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import {
  prepare, release, verify, GitHubReleaseHost, IntrideaChangelog, ReleaseWorkflow, ZipArchive,
} from "../dist/index.js";
import { ReleaseTestProject } from "../dist/testing.js";
import { command } from "../dist/command.js";
import { createZip, dosTimestamp, readZip } from "../dist/zip.js";

const unix = { skip: process.platform === "win32" };

// An Intridea changelog with `*` bullets and a `(Next)` heading.
const changelog = `# Changelog

## 1.0.0 (Next)

* [#3](https://github.com/example/extension/pull/3): Add a toolbar button - [@contributor](https://github.com/contributor).
* [#4](https://github.com/example/extension/pull/4): Remember the toolbar state on reload - [@contributor](https://github.com/contributor).
* Your contribution here.

## 0.2.0 (2026/01/02)

* Added a tooltip - [@contributor](https://github.com/contributor).

## 0.1.0 (2026/01/01)

* Initial public release - [@contributor](https://github.com/contributor).
`;

const manifest = (version) => `{
  "manifest_version": 3,
  "name": "Example Extension",
  "version": "${version}",
  "content_scripts": [
    {
      "matches": ["https://example.com/*"],
      "js": ["extension.js"]
    }
  ]
}
`;

// A minimal build: copy public/ and bundle src/ into build/.
const build = `import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
rmSync("build", { recursive: true, force: true });
mkdirSync("build/icons", { recursive: true });
cpSync("public", "build", { recursive: true });
writeFileSync("build/extension.js", "/* bundled */\\n" + readFileSync("src/extension.js", "utf8"));
`;

function simulatedGitHub(project, hosted) {
  return async (program, args, options) => {
    if (program !== "gh") return project.run(program, args, options);
    if (args[0] === "api") {
      if (!hosted.release) throw Object.assign(new Error("Not found"), { stdout: "HTTP/2.0 404 Not Found\n\n{}", code: 1 });
      return "HTTP/2.0 200 OK\n\n" + JSON.stringify(hosted.release);
    }
    const archive = args[3];
    const bytes = await readFile(archive);
    hosted.assets.set(archive.split(/[\\/]/u).at(-1), bytes);
    const asset = { name: archive.split(/[\\/]/u).at(-1), digest: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
    if (args[1] === "create") {
      hosted.release = {
        tag_name: args[2], name: args[args.indexOf("--title") + 1],
        body: await readFile(args[args.indexOf("--notes-file") + 1], "utf8"), draft: false, prerelease: false, assets: [asset],
      };
    } else hosted.release.assets.push(asset);
    return "";
  };
}

async function extensionProject(t) {
  const project = await ReleaseTestProject.create();
  t.after(() => project.dispose());
  const lock = { name: "example-extension", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: { "": { name: "example-extension", version: "1.0.0", license: "MIT" } } };
  await project.write("package.json", JSON.stringify({
    name: "example-extension", version: "1.0.0", private: true, license: "MIT",
    repository: { type: "git", url: "git+https://github.com/example/extension.git" },
    scripts: { build: "node build.mjs", test: "node --test test.mjs", lint: "node --check build.mjs" },
  }, null, 2) + "\n");
  await project.write("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
  await project.write(".gitignore", "/build\n/release\n");
  await project.write("CHANGELOG.md", changelog);
  await project.write("public/manifest.json", manifest("1.0.0"));
  await project.write("public/icons/icon_16.png", "PNG");
  await project.write("src/extension.js", 'console.log("extension");\n');
  await project.write("build.mjs", build);
  await project.write("test.mjs", 'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("extension", () => assert.ok(true));\n');
  await project.commit("Extension fixture");
  return project;
}

test("a private extension releases a reproducible zip as its only GitHub Release asset", async (t) => {
  const project = await extensionProject(t);
  const hosted = { release: null, assets: new Map() };
  const checked = [];
  const workflow = new ReleaseWorkflow({
    changelog: new IntrideaChangelog("CHANGELOG.md", { placeholder: "* Your contribution here." }),
    project: new ZipArchive({ build: ["npm", "run", "build"], directory: "build", name: "example-extension" }),
    publisher: null,
    host: new GitHubReleaseHost(simulatedGitHub(project, hosted), "example/extension"),
    versionReferences: { "public/manifest.json": [/"version": "(?<version>\d+\.\d+\.\d+)"/u] },
    validator: {
      async validate({ run }) { await run("npm", ["test"]); await run("npm", ["run", "lint"]); },
      async artifact({ consumer, archive }) {
        checked.push(archive);
        assert.match(await readFile(join(consumer, "manifest.json"), "utf8"), /"version": "1\.0\.0"/u);
      },
    },
  });
  const built = await prepare(workflow, project.options);
  const archive = join(project.artifacts, "example-extension-v1.0.0.zip");
  const prepared = await readFile(archive);
  assert.equal(built.state.artifact.filename, "example-extension-v1.0.0.zip");
  assert.equal(built.state.registry, false);
  const result = await release(workflow, { ...project.options, env: built.runtime.env });
  assert.equal(result.verification, "verified");
  assert.deepEqual(await readFile(archive), prepared);
  assert.equal(checked.length, 2);
  assert.equal(result.artifact.integrity, `sha512-${createHash("sha512").update(prepared).digest("base64")}`);
  assert.equal(result.artifact.shasum, createHash("sha1").update(prepared).digest("hex"));

  const entries = readZip(prepared);
  assert.deepEqual(entries.map(({ path }) => path), ["extension.js", "icons/icon_16.png", "manifest.json"]);
  assert.equal(entries[2].content.toString(), manifest("1.0.0"));
  const epoch = Number((await project.git("show", "-s", "--format=%ct", built.state.initialCommit)).trim());
  const { time, date } = dosTimestamp(epoch);
  assert.equal(prepared.readUInt16LE(10), time);
  assert.equal(prepared.readUInt16LE(12), date);
  assert.deepEqual(createZip(entries, epoch), prepared);

  assert.equal(hosted.release.tag_name, "v1.0.0");
  assert.deepEqual([...hosted.assets.keys()], ["example-extension-v1.0.0.zip"]);
  assert.deepEqual(hosted.assets.get("example-extension-v1.0.0.zip"), prepared);
  assert.match(hosted.release.body, /Remember the toolbar state on reload/u);
  assert.doesNotMatch(hosted.release.body, /Your contribution here/u);

  const tagged = (path) => project.remoteFile("v1.0.0", path);
  assert.equal(JSON.parse(await tagged("package.json")).version, "1.0.0");
  assert.equal(JSON.parse(await tagged("package.json")).private, true);
  assert.equal(await tagged("public/manifest.json"), manifest("1.0.0"));
  assert.match(await tagged("CHANGELOG.md"), /^## 1\.0\.0 \(\d{4}\/\d{2}\/\d{2}\)$/mu);
  assert.doesNotMatch(await tagged("CHANGELOG.md"), /Your contribution here/u);
  const next = (path) => project.remoteFile("master", path);
  assert.equal(JSON.parse(await next("package.json")).version, "1.0.1");
  assert.equal(JSON.parse(await next("package-lock.json")).version, "1.0.1");
  assert.equal(JSON.parse(await next("package-lock.json")).packages[""].version, "1.0.1");
  assert.equal(await next("public/manifest.json"), manifest("1.0.1"));
  assert.match(await next("CHANGELOG.md"), /## 1\.0\.1 \(Next\)\n\n\* Your contribution here\.\n\n## 1\.0\.0 \(/u);
  assert.equal((await project.git("ls-remote", "--tags", "origin", "v1.0.0")).trim().split(/\s/u)[0],
    (await project.git("rev-parse", "HEAD~1")).trim());
  assert.equal(await project.git("status", "--porcelain"), "");

  const verified = await verify({ ...project.options, provider: project.provider });
  assert.equal(verified.verification, "verified");
  await writeFile(join(project.artifacts, "release.json"), JSON.stringify({ ...verified, artifact: { ...verified.artifact, shasum: "0" } }));
  await assert.rejects(verify(project.options), /Retained archive integrity mismatch/u);
});

async function zipProject(t, files = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "npr-zip-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const artifacts = join(cwd, "artifacts");
  await mkdir(artifacts);
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "@scope/extension", version: "1.2.3", private: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(cwd, path, ".."), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  const archive = (options = {}) => new ZipArchive({
    build: [process.execPath, "-e", ""], cwd, env: { SOURCE_DATE_EPOCH: "1700000000" }, ...options,
  });
  return { cwd, artifacts, archive, identity: { name: "@scope/extension", version: "1.2.3" } };
}

test("ZIP archives are deterministic, validated, and reject malformed bytes", () => {
  const entries = [{ path: "b/c.txt", content: Buffer.from("c") }, { path: "a.txt", content: Buffer.from("a".repeat(100)) }];
  const bytes = createZip(entries, 1700000000);
  assert.deepEqual(createZip([...entries].reverse(), 1700000000), bytes);
  assert.deepEqual(readZip(bytes).map(({ path, content }) => [path, content.toString()]),
    [["a.txt", "a".repeat(100)], ["b/c.txt", "c"]]);
  assert.deepEqual(dosTimestamp(0), { time: 0, date: (0 << 9) | (1 << 5) | 1 });
  assert.deepEqual(dosTimestamp(315532801), { time: 0, date: 33 });
  assert.throws(() => dosTimestamp(4354819200), /beyond the ZIP date range/u);
  assert.throws(() => dosTimestamp(-1), /Invalid source timestamp/u);
  assert.throws(() => createZip([entries[0], entries[0]], 0), /Duplicate ZIP entry/u);
  assert.throws(() => createZip([{ path: "../escape", content: Buffer.alloc(0) }], 0), /relative path/u);
  assert.throws(() => readZip(Buffer.alloc(10)), /missing end of central directory/u);
  const comment = Buffer.from(bytes);
  comment.writeUInt16LE(1, comment.length - 2);
  assert.throws(() => readZip(comment), /unsupported end of central directory/u);
  assert.throws(() => readZip(Buffer.concat([Buffer.from("x"), bytes])), /inconsistent central directory/u);
  const corrupt = Buffer.from(bytes);
  corrupt[35] ^= 0xff;
  assert.throws(() => readZip(corrupt));
  const local = Buffer.from(bytes);
  local.writeUInt16LE(0, 6);
  assert.throws(() => readZip(local), /local header differs for a\.txt/u);
  const central = bytes.length - 22 - (46 + 5) - (46 + 7);
  const stored = Buffer.from(bytes);
  stored.writeUInt16LE(0, central + 10);
  assert.throws(() => readZip(stored), /unsupported entry/u);
  const truncated = Buffer.from(bytes);
  truncated.writeUInt32LE(0, central);
  assert.throws(() => readZip(truncated), /truncated central directory/u);
  const checksum = Buffer.from(bytes);
  checksum.writeUInt32LE(0, 14);
  checksum.writeUInt32LE(0, central + 16);
  assert.throws(() => readZip(checksum), /checksum differs for a\.txt/u);
  const extra = Buffer.concat([bytes.subarray(0, bytes.readUInt32LE(bytes.length - 6)), Buffer.from("x"),
    bytes.subarray(bytes.readUInt32LE(bytes.length - 6))]);
  extra.writeUInt32LE(extra.readUInt32LE(extra.length - 6) + 1, extra.length - 6);
  assert.throws(() => readZip(extra), /unexpected data before the central directory/u);
});

test("ZipArchive options are validated and bound to each invocation", async (t) => {
  for (const [options, error] of [
    [{ build: [] }, /nonempty array/u], [{ build: "npm run build" }, /nonempty array/u], [{ build: ["", "run"] }, /nonempty array/u], [{ build: ["npm", 1] }, /nonempty array/u],
    [{ directory: "../build" }, /relative path/u], [{ directory: "/build" }, /relative path/u], [{ directory: "." }, /relative path/u],
    [{ directory: "out\\build" }, /relative path/u], [{ directory: ".git" }, /relative path/u],
    [{ name: "../example" }, /filename-safe/u], [{ name: "" }, /filename-safe/u], [{ run: "npm" }, /command function/u],
  ]) assert.throws(() => new ZipArchive(options), error);
  const defaults = new ZipArchive();
  assert.deepEqual(defaults.build, ["npm", "run", "build"]);
  assert.equal(defaults.directory, "build");
  assert.equal(defaults.cwd, process.cwd());
  assert.equal(defaults.run, command);
  assert.ok(Object.isFrozen(defaults) && Object.isFrozen(defaults.build) && Object.isFrozen(defaults.env));
  const run = async () => "";
  const bound = new ZipArchive({ build: ["make"], directory: "dist/extension", name: "extension" })
    .bind({ cwd: "/project", run, env: { SOURCE_DATE_EPOCH: "1" } });
  assert.deepEqual([bound.build, bound.directory, bound.name, bound.cwd, bound.run, bound.env.SOURCE_DATE_EPOCH],
    [["make"], "dist/extension", "extension", "/project", run, "1"]);
  assert.equal(defaults.filename({ name: "@scope/extension", version: "1.2.3" }), "scope-extension-v1.2.3.zip");
  assert.equal(bound.filename({ name: "@scope/extension", version: "1.2.3" }), "extension-v1.2.3.zip");
  assert.throws(() => bound.filename({ name: "extension", version: "1.2" }), /numeric/u);

  const { cwd, archive } = await zipProject(t);
  assert.equal((await archive().read()).private, true);
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", workspaces: ["a"] }));
  await assert.rejects(archive().read(), /without workspaces/u);
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "Invalid Name", version: "1.0.0" }));
  await assert.rejects(archive().read(), /npm package name/u);
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "x", version: "1.0" }));
  await assert.rejects(archive().read(), /numeric/u);
});

test("ZipArchive packs the built directory, reconciles existing bytes, and checks consumers", async (t) => {
  const { cwd, artifacts, archive, identity } = await zipProject(t, {
    "build/manifest.json": '{ "version": "1.2.3" }\n', "build/js/app.js": "app();\n", "src/app.js": "app();\n",
  });
  await writeFile(join(cwd, "package-lock.json"), JSON.stringify({ name: "@scope/extension", version: "1.2.3",
    packages: { "": { name: "@scope/extension", version: "1.2.3" } } }, null, 2) + "\n");
  const project = archive();
  await project.setVersion("1.2.4");
  assert.equal(JSON.parse(await readFile(join(cwd, "package-lock.json"), "utf8")).packages[""].version, "1.2.4");
  await project.setVersion("1.2.3");
  const built = await project.pack(artifacts, identity);
  assert.equal(built.filename, "scope-extension-v1.2.3.zip");
  const bytes = await readFile(join(artifacts, built.filename));
  assert.deepEqual(readZip(bytes).map(({ path }) => path), ["js/app.js", "manifest.json"]);
  assert.deepEqual(await project.pack(artifacts, identity), built);
  await project.intact(artifacts, { ...identity, artifact: built });
  const seen = [];
  await project.consumer(join(artifacts, built.filename), async (consumer) => {
    seen.push(await readFile(join(consumer, "js", "app.js"), "utf8"));
  });
  assert.deepEqual(seen, ["app();\n"]);

  await writeFile(join(cwd, "build", "js", "app.js"), "changed();\n");
  await assert.rejects(project.consumer(join(artifacts, built.filename), async () => assert.fail("Mismatched")),
    /entries differ from the built directory/u);
  await assert.rejects(project.pack(artifacts, identity), /Existing archive differs/u);
  await mkdir(join(cwd, "other"));
  await assert.rejects(archive({ env: {} }).pack(join(cwd, "other"), identity), /numeric SOURCE_DATE_EPOCH/u);
  await assert.rejects(archive({ build: [process.execPath, "-e", "process.exit(3)"] }).pack(join(cwd, "other"), identity));
  for (const artifact of [{ ...built, filename: "../escape.zip" }, { ...built, filename: "archive.tgz" }]) {
    await assert.rejects(project.intact(artifacts, { ...identity, artifact }), /Invalid retained archive filename/u);
  }
  await assert.rejects(project.intact(artifacts, { ...identity, artifact: { ...built, integrity: "sha512-x" } }),
    /Retained archive integrity mismatch/u);
  await writeFile(join(artifacts, "corrupt-v1.2.3.zip"), "not a zip");
  await assert.rejects(project.intact(artifacts, { ...identity, artifact: { ...built, filename: "corrupt-v1.2.3.zip" } }),
    /Invalid ZIP archive/u);
});

test("ZipArchive rejects missing, empty, Git, and unsupported build directories", async (t) => {
  const { cwd, artifacts, archive, identity } = await zipProject(t, { "notes.txt": "x" });
  await assert.rejects(archive().pack(artifacts, identity), /Archive directory is missing: build/u);
  await assert.rejects(archive({ directory: "notes.txt" }).pack(artifacts, identity), /must be a directory/u);
  await assert.rejects(archive({ directory: "notes.txt/child" }).pack(artifacts, identity), /ENOTDIR|is missing/u);
  await mkdir(join(cwd, "build"));
  await assert.rejects(archive().pack(artifacts, identity), /contains no files/u);
  await mkdir(join(cwd, "build", "empty"));
  await writeFile(join(cwd, "build", "file.txt"), "x");
  await assert.rejects(archive().pack(artifacts, identity), /empty directory: empty/u);
  await rm(join(cwd, "build", "empty"), { recursive: true });
  await mkdir(join(cwd, "build", "nested", ".git"), { recursive: true });
  await writeFile(join(cwd, "build", "nested", ".git", "HEAD"), "ref");
  await assert.rejects(archive().pack(artifacts, identity), /Git metadata: nested\/\.git/u);
});

test("ZipArchive follows contained file links and rejects escaping or directory links", unix, async (t) => {
  const { cwd, artifacts, archive, identity } = await zipProject(t, { "build/file.txt": "inside\n", "outside.txt": "secret\n" });
  await symlink("file.txt", join(cwd, "build", "alias.txt"));
  const built = await archive().pack(artifacts, identity);
  const entries = readZip(await readFile(join(artifacts, built.filename)));
  assert.deepEqual(entries.map(({ path, content }) => [path, content.toString()]), [["alias.txt", "inside\n"], ["file.txt", "inside\n"]]);
  const other = join(cwd, "other");
  await mkdir(other);
  await symlink(join(cwd, "outside.txt"), join(cwd, "build", "escape.txt"));
  await assert.rejects(archive().pack(other, identity), /symbolic link escapes its directory: escape\.txt/u);
  await rm(join(cwd, "build", "escape.txt"));
  await symlink("missing.txt", join(cwd, "build", "dangling.txt"));
  await assert.rejects(archive().pack(other, identity), /symbolic link escapes its directory: dangling\.txt/u);
  await rm(join(cwd, "build", "dangling.txt"));
  await mkdir(join(cwd, "build", "real"));
  await writeFile(join(cwd, "build", "real", "x.txt"), "x");
  await symlink("real", join(cwd, "build", "linked"));
  await assert.rejects(archive().pack(other, identity), /directory links: linked/u);
  await rm(join(cwd, "build", "linked"));
  await symlink(cwd, join(cwd, "linked-build"));
  await assert.rejects(archive({ directory: "linked-build" }).pack(other, identity), /inside the project/u);
  await rm(join(cwd, "build"), { recursive: true });
  const elsewhere = await mkdtemp(join(tmpdir(), "npr-zip-outside-"));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  await writeFile(join(elsewhere, "file.txt"), "outside\n");
  await symlink(elsewhere, join(cwd, "build"));
  await assert.rejects(archive().pack(other, identity), /inside the project/u);
  await rm(join(cwd, "build"));
  await mkdir(join(cwd, "build"));
  await command("mkfifo", [join(cwd, "build", "pipe")]);
  await assert.rejects(archive().pack(other, identity), /unsupported file: pipe/u);
});
