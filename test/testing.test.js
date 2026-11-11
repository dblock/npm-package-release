import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import process from "node:process";
import test from "node:test";
import { NpmPackage } from "../dist/index.js";
import { ReleaseTestProject, TestPublisher, TestReleaseHost } from "../dist/testing.js";
import { checkRecursiveCopying, checkGitMetadataCopying, checkGlobCopying } from "./helpers/testing.js";
import "../examples/lifecycle-hooks/release.test.js";

test("failed Git initialization removes only its owned temporary project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "npr-init-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const names = ["PATH", "TMPDIR", "TEMP", "TMP"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = root;
    await assert.rejects(ReleaseTestProject.create(), /ENOENT/u);
    assert.deepEqual(await readdir(root), []);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("test projects isolate inherited release/Git credentials and own only their temporary checkout", async (t) => {
  const project = await ReleaseTestProject.create();
  t.after(() => project.dispose());
  const names = ["GH_TOKEN", "NODE_AUTH_TOKEN", "GIT_DIR", "GITHUB_ACTIONS", "GIT_CONFIG_GLOBAL"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const outerConfig = join(project.directory, "caller.gitconfig");
  const outerContents = "[fixture]\nmarker = outer\n";
  await writeFile(outerConfig, outerContents);
  Object.assign(process.env, {
    GH_TOKEN: "isolated-test-only", NODE_AUTH_TOKEN: "isolated-test-only",
    GIT_DIR: "/not-a-fixture", GITHUB_ACTIONS: "true", GIT_CONFIG_GLOBAL: outerConfig,
  });
  const globalConfig = project.environment.GIT_CONFIG_GLOBAL;
  assert.ok(globalConfig.startsWith(project.directory + sep));
  assert.ok((await stat(globalConfig)).isFile());
  await assert.rejects(project.git("config", "--get", "fixture.marker"));
  await project.git("config", "--global", "fixture.marker", "private");
  assert.equal((await project.git("config", "--get", "fixture.marker")).trim(), "private");
  assert.equal(await readFile(outerConfig, "utf8"), outerContents);
  await project.run(process.execPath, ["--input-type=module", "--eval", `
import assert from "node:assert/strict";
import process from "node:process";
assert.equal(process.env.GH_TOKEN, undefined);
assert.equal(process.env.NODE_AUTH_TOKEN, undefined);
assert.equal(process.env.GIT_DIR, undefined);
assert.equal(process.env.GITHUB_ACTIONS, "false");
assert.equal(process.env.HOME, process.argv[1]);
`, join(project.directory, "home")]);
  await project.write("nested/file.txt", "Owned.\n");
  await project.commit();
  assert.equal(await project.remoteFile("master", "nested/file.txt"), "Owned.\n");
  await assert.rejects(project.write("../outside.txt", "No."));
  await assert.rejects(project.write(join(project.directory, "outside.txt"), "No."));
  await assert.rejects(project.remoteFile("--invalid", "nested/file.txt"));
  assert.throws(() => new ReleaseTestProject(project.directory, Symbol()), /create/u);
  const directory = project.directory;
  await project.dispose();
  await assert.rejects(stat(directory), { code: "ENOENT" });
});

test("explicit fixture copying preserves nested paths and modes and preflights every file", async (t) => {
  const project = await ReleaseTestProject.create();
  const root = await mkdtemp(join(tmpdir(), "npr-copy-source-"));
  t.after(async () => { await project.dispose(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "tool"), "Executable.\n");
  await chmod(join(root, "nested", "tool"), 0o751);
  await writeFile(join(root, "valid.txt"), "Copy me.\n");
  await writeFile(join(root, "unlisted.txt"), "Do not copy.");
  for (const invalid of ["missing.txt", "nested", "../escape", "/absolute", "C:\\absolute", "."]) {
    await assert.rejects(project.copyFiles(root, ["valid.txt", invalid]));
    await assert.rejects(readFile(join(project.cwd, "valid.txt")), { code: "ENOENT" });
  }
  await assert.rejects(project.copyFiles(root, 123), /glob string or an array/u);
  await project.copyFiles(root, ["nested/tool", "valid.txt"]);
  await assert.rejects(stat(join(project.cwd, "unlisted.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(project.cwd, "nested", "tool"), "utf8"), "Executable.\n");
  if (process.platform !== "win32") assert.equal((await stat(join(project.cwd, "nested", "tool"))).mode & 0o777, 0o751);
  await project.copyFiles(root, ["valid.txt"]);
  await mkdir(join(project.cwd, "folder"));
  await writeFile(join(root, "folder"), "Not a directory.");
  await writeFile(join(root, "valid.txt"), "Updated.");
  await assert.rejects(project.copyFiles(root, ["valid.txt", "folder"]));
  assert.equal(await readFile(join(project.cwd, "valid.txt"), "utf8"), "Copy me.\n");
});

test("recursive fixture copying includes hidden files and preserves bytes, modes and local Git", async (t) => {
  await checkRecursiveCopying(t, { ReleaseTestProject });
});

test("fixture copying rejects explicit Git metadata and aliases before copying any file", async (t) => {
  await checkGitMetadataCopying(t, { ReleaseTestProject });
});

test("glob fixture copying matches relative hidden and nested files without expanding exact arrays", async (t) => {
  await checkGlobCopying(t, { ReleaseTestProject });
});

test("fixture copying rejects escaping and dangling links in source and destination", {
  skip: process.platform === "win32",
}, async (t) => {
  const project = await ReleaseTestProject.create();
  const root = await mkdtemp(join(tmpdir(), "npr-copy-links-"));
  t.after(async () => { await project.dispose(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "source"));
  await mkdir(join(root, "outside"));
  await symlink(".", join(root, "source", "cycle"));
  await assert.rejects(project.copyFiles(join(root, "source")), /regular file/u);
  await rm(join(root, "source", "cycle"));
  await writeFile(join(root, "outside", "file.txt"), "Outside.");
  await symlink(join(root, "outside"), join(root, "source", "escape"));
  await assert.rejects(project.copyFiles(join(root, "source"), ["escape/file.txt"]), /escapes/u);
  await assert.rejects(project.copyFiles(join(root, "source")), /escapes/u);
  await symlink(join(root, "outside", "missing"), join(root, "source", "dangling"));
  await assert.rejects(project.copyFiles(join(root, "source"), ["dangling"]));
  await writeFile(join(root, "source", "file.txt"), "Inside.");
  await symlink(join(root, "outside", "file.txt"), join(project.cwd, "file.txt"));
  await assert.rejects(project.copyFiles(join(root, "source"), ["file.txt"]), /escapes/u);
  await assert.rejects(project.write("file.txt", "No."), /escapes/u);
  assert.equal(await readFile(join(root, "outside", "file.txt"), "utf8"), "Outside.");
  await symlink(join(root, "source", "file.txt"), join(root, "source", "inside.txt"));
  await project.copyFiles(join(root, "source"), ["inside.txt"]);
  assert.equal(await readFile(join(project.cwd, "inside.txt"), "utf8"), "Inside.");
});

test("local publication adapters retain exact bytes, fail explicitly and reject conflicting archives", async (t) => {
  const project = await ReleaseTestProject.create();
  t.after(() => project.dispose());
  const name = "@npr-test/local";
  await project.write("package.json", JSON.stringify({ name, version: "0.1.0", files: ["index.js"] }));
  await project.write("index.js", "module.exports = 1;\n");
  await mkdir(project.artifacts);
  const npm = new NpmPackage(project.cwd, project.run);
  const first = await npm.pack(project.artifacts, { name, version: "0.1.0" });
  const archive = join(project.artifacts, first.filename);
  const original = join(project.directory, "original.tgz");
  await copyFile(archive, original);
  const notes = join(project.directory, "notes.md");
  await writeFile(notes, "Release notes.");
  await Promise.all([project.publisher.publish(archive), project.publisher.publish(archive)]);
  await project.publisher.publish(archive);
  const metadata = await project.publisher.view(name, "0.1.0");
  assert.equal(metadata.dist.integrity, first.integrity);
  assert.deepEqual(await readdir(join(project.publisher.directory, encodeURIComponent(name))), ["0.1.0.tgz"]);
  await project.host.create({ name, version: "0.1.0" }, { archive, notes });
  await project.host.create({ name, version: "0.1.0" }, { archive, notes });
  await assert.rejects(project.host.create({ name, version: "0.2.0" }, { archive, notes }), /identity/u);
  await assert.rejects(new TestPublisher(join(project.directory, "failure"), { failure: "Rejected" }).publish(archive), /Rejected/u);
  await assert.rejects(new TestReleaseHost(join(project.directory, "failure-host"), { failure: "Rejected" })
    .create({ name, version: "0.1.0" }, { archive, notes }), /Rejected/u);
  await project.write("index.js", "module.exports = 2;\n");
  const conflicting = join(project.directory, "conflicting");
  await mkdir(conflicting);
  const second = await npm.pack(conflicting, { name, version: "0.1.0" });
  const different = join(conflicting, second.filename);
  await assert.rejects(project.publisher.publish(different), /checksum differs/u);
  await assert.rejects(project.host.create({ name, version: "0.1.0" }, { archive: different, notes }), /checksum differs/u);
  assert.deepEqual(await readFile(project.publisher.archive(name, "0.1.0")), await readFile(original));
  await assert.rejects(project.publisher.view("../escape", "0.1.0"), /package name/u);
  const wrongName = "@npr-test/wrong";
  await mkdir(join(project.directory, "registry", encodeURIComponent(wrongName)), { recursive: true });
  await copyFile(original, project.publisher.archive(wrongName, "0.1.0"));
  await assert.rejects(project.publisher.view(wrongName, "0.1.0"), /identity/u);
  await mkdir(project.publisher.archive("@npr-test/directory", "0.1.0"), { recursive: true });
  await assert.rejects(project.publisher.view("@npr-test/directory", "0.1.0"));
});
