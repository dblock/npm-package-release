import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { NpmPackage, record } from "../dist/package.js";
import { command } from "../dist/command.js";
import { releaseFixture } from "./helpers/release-fixture.js";

test("npm metadata accepts actual npm 11/12 shapes and rejects ambiguous or malformed records", () => {
  for (const value of [
    { name: "example", version: "1.0.0" },
    [{ name: "example", version: "1.0.0" }],
    { example: { name: "example", version: "1.0.0" } },
  ]) assert.equal(record(JSON.stringify(value)).version, "1.0.0");
  for (const value of [[], [null], [{}, {}], {}, null]) {
    assert.throws(() => record(JSON.stringify(value)));
  }
});

test("version updates preserve CRLF/indentation and support projects without lockfiles", async (t) => {
  const fixture = await releaseFixture(t);
  const path = join(fixture.cwd, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify(manifest, null, "\t").replaceAll("\n", "\r\n") + "\r\n");
  const pkg = new NpmPackage(fixture.cwd, fixture.run);
  await pkg.setVersion("0.2.0");
  assert.match(await readFile(path, "utf8"), /\r\n\t"version": "0.2.0"/u);
  await rm(join(fixture.cwd, "package-lock.json"));
  await pkg.setVersion("0.3.0");
  assert.equal((await pkg.read()).version, "0.3.0");
});

test("registry identity and packed-file identity/integrity are verified", async (t) => {
  const fixture = await releaseFixture(t);
  const pkg = new NpmPackage(fixture.cwd, async (program, args, options) => {
    if (program === "npm" && args[0] === "view") return '{"name":"different","version":"0.1.0"}';
    return await fixture.run(program, args, options);
  });

  await assert.rejects(pkg.view("@npr-test/example", "0.1.0"), /identity/u);
  const invalidPack = new NpmPackage(fixture.cwd, async () => '{"name":"different","version":"0.1.0","filename":"bad.tgz"}');
  await assert.rejects(invalidPack.pack(fixture.directory, { name: "@npr-test/example", version: "0.1.0" }), /identity/u);
  await assert.rejects(pkg.intact(fixture.directory, {
    artifact: { filename: "../escape.tgz" },
  }), /filename/u);
});

test("the embedded packed manifest and npm-reported archive checksum must agree", async (t) => {
  const fixture = await releaseFixture(t);
  const metadata = record(await command("npm", ["pack", "--json", "--pack-destination", fixture.directory], {
    cwd: fixture.cwd,
  }));
  const pkg = new NpmPackage(fixture.cwd, async (program, args, options) => {
    if (program === "npm" && args[0] === "pack") return JSON.stringify({ ...metadata, integrity: "incorrect" });
    return await command(program, args, { cwd: fixture.cwd, ...options });
  });
  await assert.rejects(pkg.inspect(join(fixture.directory, metadata.filename), {
    name: "different", version: "0.1.0",
  }), /Packed manifest identity/u);
  await assert.rejects(pkg.pack(fixture.directory, {
    name: "@npr-test/example", version: "0.1.0",
  }), /archive integrity mismatch/u);
});
