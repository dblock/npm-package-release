import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { checkCli } from "../helpers/cli.js";
import { releaseFixture } from "../helpers/release-fixture.js";
import { checkActions } from "../helpers/actions.js";
import { command } from "../../src/command.js";

test("the actual tarball installs with strict engines and exposes its API and CLI", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npm-package-release-consumer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const env = { ...process.env };
  delete env.npm_config_call;
  delete env.npm_config_package;
  assert.ok(env.npm_execpath, "Run this check through npm run test:package.");

  function npm(args, cwd) {
    return spawnSync(process.execPath, [env.npm_execpath, ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
  }

  let archive = process.env.PACKAGE_ARCHIVE?.trim();
  if (archive) {
    archive = isAbsolute(archive) ? archive : resolve(root, archive);
  } else {
    const packed = npm(["pack", "--json", "--pack-destination", directory], root);
    assert.equal(packed.status, 0, packed.stderr || packed.error?.message);
    const output = JSON.parse(packed.stdout);
    const packages = Array.isArray(output) ? output : Object.values(output);
    assert.equal(packages.length, 1);
    const metadata = packages[0];
    assert.equal(typeof metadata.filename, "string");
    archive = join(directory, metadata.filename);
  }
  const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  const digest = () => readFile(archive).then((bytes) => createHash("sha512").update(bytes).digest("hex"));
  const originalDigest = await digest();
  const files = listing.stdout.trim().split(/\r?\n/u);
  for (const file of [
    "package/src/index.js",
    "package/bin/npr.js",
    "package/README.md",
    "package/LICENSE",
    "package/DESIGN.md",
  ]) {
    assert.ok(files.includes(file), `Missing packed file: ${file}`);
  }
  assert.ok(!files.some((file) => /^package\/(?:node_modules|test|coverage|\.github)\//u.test(file)));

  const consumer = join(directory, "consumer");
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const installed = npm(["install", "--engine-strict", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", archive], consumer);
  assert.equal(installed.status, 0, installed.stderr || installed.error?.message);
  const imported = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    'import { version } from "npm-package-release"; process.stdout.write(version);',
  ], { cwd: consumer, encoding: "utf8" });
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(imported.stdout, /^\d+\.\d+\.\d+$/u);
  checkCli((args) => npm(["exec", "--silent", "--offline", "--", "npr", ...args], consumer));
  const installedApi = await import(pathToFileURL(join(consumer, "node_modules/npm-package-release/src/index.js")).href);
  const fixture = await releaseFixture(t);
  await fixture.assertReleased(await installedApi.release(fixture.config, fixture));
  const { NpmPackage } = await import(pathToFileURL(join(consumer, "node_modules/npm-package-release/src/package.js")).href);
  const publicRegistry = new NpmPackage(consumer, (program, args, options) =>
    command(program, args, { cwd: consumer, ...options }));
  assert.equal((await publicRegistry.view("semver", "7.8.6")).version, "7.8.6");
  if (process.platform !== "win32") await checkActions(t, archive);
  assert.equal(await digest(), originalDigest);
});
