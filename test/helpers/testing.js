import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

async function fixture(t, ReleaseTestProject) {
  const project = await ReleaseTestProject.create();
  t.after(() => project.dispose());
  const root = join(project.directory, "source");
  await mkdir(root);
  return { project, root };
}

export async function checkRecursiveCopying(t, { ReleaseTestProject }) {
  const { project, root } = await fixture(t, ReleaseTestProject);
  for (const path of ["bin", ".config", ".git", "nested/deep/.git"]) {
    await mkdir(join(root, path), { recursive: true });
  }
  const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a]);
  await writeFile(join(root, "README.md"), "Project.\r\n");
  await writeFile(join(root, "bin/tool"), bytes);
  await chmod(join(root, "bin/tool"), 0o751);
  await writeFile(join(root, ".hidden"), "Hidden file.");
  await writeFile(join(root, ".config/settings"), "Hidden directory.");
  await writeFile(join(root, ".git/config"), "Do not copy repository metadata.");
  await writeFile(join(root, "nested/.git"), "Do not copy worktree metadata.");
  await writeFile(join(root, "nested/deep/.git/config"), "Do not copy nested metadata.");
  await writeFile(join(root, "nested/.gitignore"), "Keep this file.\n");
  const configuration = await readFile(join(project.cwd, ".git/config"));
  await project.copyFiles(root, []);
  assert.deepEqual(await readdir(project.cwd), [".git"]);
  await assert.rejects(project.copyFiles(root, null), /array/u);
  await project.copyFiles(root);
  await project.copyFiles(root);
  assert.equal(await readFile(join(project.cwd, "README.md"), "utf8"), "Project.\r\n");
  assert.deepEqual(await readFile(join(project.cwd, "bin/tool")), bytes);
  if (process.platform !== "win32") assert.equal((await stat(join(project.cwd, "bin/tool"))).mode & 0o777, 0o751);
  assert.equal(await readFile(join(project.cwd, ".hidden"), "utf8"), "Hidden file.");
  assert.equal(await readFile(join(project.cwd, ".config/settings"), "utf8"), "Hidden directory.");
  assert.equal(await readFile(join(project.cwd, "nested/.gitignore"), "utf8"), "Keep this file.\n");
  await assert.rejects(stat(join(project.cwd, "nested/.git")), { code: "ENOENT" });
  await assert.rejects(stat(join(project.cwd, "nested/deep/.git")), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(project.cwd, ".git/config")), configuration);
  assert.equal((await project.git("remote", "get-url", "origin")).trim(), project.remote);
}

export async function checkGitMetadataCopying(t, { ReleaseTestProject }) {
  const { project, root } = await fixture(t, ReleaseTestProject);
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, ".git/config"), "Do not copy.");
  await writeFile(join(root, "nested/.git"), "Worktree metadata.");
  await writeFile(join(root, "valid.txt"), "Do not partially copy.");
  const configuration = await readFile(join(project.cwd, ".git/config"));
  for (const path of [".git/config", "nested/.git", "nested/.git/config", ".GIT/config"]) {
    await assert.rejects(project.copyFiles(root, ["valid.txt", path]), /Git metadata/u);
    await assert.rejects(stat(join(project.cwd, "valid.txt")), { code: "ENOENT" });
  }
  if (process.platform !== "win32") {
    await symlink(join(root, ".git/config"), join(root, "source-alias"));
    await symlink(join(root, ".git"), join(root, "source-directory"));
    for (const path of ["source-alias", "source-directory/config"]) {
      await assert.rejects(project.copyFiles(root, ["valid.txt", path]), /Git metadata/u);
    }
    await assert.rejects(project.copyFiles(root), /Git metadata/u);
    await assert.rejects(project.copyFiles(root, "source-*"), /Git metadata/u);
    await writeFile(join(root, "config"), "Do not replace.");
    await symlink(join(project.cwd, ".git/config"), join(project.cwd, "config"));
    await assert.rejects(project.copyFiles(root, ["valid.txt", "config"]), /Git metadata/u);
    await assert.rejects(project.copyFiles(root, "config"), /Git metadata/u);
    await mkdir(join(root, "metadata/new-directory"), { recursive: true });
    await writeFile(join(root, "metadata/new-directory/file.txt"), "Do not create.");
    await symlink(join(project.cwd, ".git"), join(project.cwd, "metadata"));
    await assert.rejects(project.copyFiles(root, ["valid.txt", "metadata/new-directory/file.txt"]), /Git metadata/u);
    await assert.rejects(project.copyFiles(root, "metadata/**/*.txt"), /Git metadata/u);
    await assert.rejects(stat(join(project.cwd, ".git/new-directory")), { code: "ENOENT" });
    await assert.rejects(stat(join(project.cwd, "valid.txt")), { code: "ENOENT" });
  }
  assert.deepEqual(await readFile(join(project.cwd, ".git/config")), configuration);
  assert.equal(await readFile(join(root, ".git/config"), "utf8"), "Do not copy.");
}

export async function checkGlobCopying(t, { ReleaseTestProject }) {
  const { project, root } = await fixture(t, ReleaseTestProject);
  const sources = {
    "README.md": "Project.\n",
    "top.js": "Root script.",
    "src/deep/module.js": "Nested script.",
    "src/deep/notes.md": "Nested notes.",
    ".config/hidden.js": "Hidden directory.",
    ".hidden.js": "Hidden file.",
    "src/ignored.txt": "Not selected.",
    "[literal].js": "Exact array entry.",
    "l.js": "Do not expand array entries.",
    ".git/config": "Do not copy.",
    "src/.git/config": "Do not copy nested metadata.",
  };
  for (const [path, content] of Object.entries(sources)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const configuration = await readFile(join(project.cwd, ".git/config"));
  for (const pattern of ["", "../**", "/**", "C:\\**", "\0"]) {
    await assert.rejects(project.copyFiles(root, pattern), /relative files/u);
  }
  await project.copyFiles(root, "missing/**/*.js");
  await project.copyFiles(root, "**/.git/**");
  assert.deepEqual(await readdir(project.cwd), [".git"]);
  await project.copyFiles(root, ["[literal].js"]);
  assert.equal(await readFile(join(project.cwd, "[literal].js"), "utf8"), sources["[literal].js"]);
  await assert.rejects(stat(join(project.cwd, "l.js")), { code: "ENOENT" });
  await project.copyFiles(root, "./**/*.{js,md}");
  for (const [path, content] of Object.entries(sources)) {
    if (path === "src/ignored.txt" || path.includes(".git/")) continue;
    assert.equal(await readFile(join(project.cwd, path), "utf8"), content);
  }
  await assert.rejects(stat(join(project.cwd, "src/ignored.txt")), { code: "ENOENT" });
  await assert.rejects(stat(join(project.cwd, "src/.git")), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(project.cwd, ".git/config")), configuration);
  if (process.platform !== "win32") {
    const outside = join(project.directory, "outside.js");
    await writeFile(outside, "Keep outside.");
    await symlink(outside, join(root, "escape.js"));
    await writeFile(join(root, "README.md"), "Updated.\n");
    await assert.rejects(project.copyFiles(root, "**/*.{js,md}"), /escapes/u);
    assert.equal(await readFile(join(project.cwd, "README.md"), "utf8"), sources["README.md"]);
    await project.copyFiles(root, "*.md");
    assert.equal(await readFile(join(project.cwd, "README.md"), "utf8"), "Updated.\n");
    assert.equal(await readFile(outside, "utf8"), "Keep outside.");
    await assert.rejects(stat(join(project.cwd, "escape.js")), { code: "ENOENT" });
  }
}
