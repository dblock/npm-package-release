import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { checkCli } from "./helpers/cli.js";

test("the CLI documents release/verification and rejects unsupported commands", () => {
  const entry = fileURLToPath(new URL("../bin/npr.js", import.meta.url));
  checkCli((args) => spawnSync(process.execPath, [entry, ...args], { encoding: "utf8" }));
});

test("CLI flags and configuration errors fail without publishing", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "npr-cli-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL("../bin/npr.js", import.meta.url));
  await writeFile(join(cwd, "npr.config.js"), "export default {};\n");
  await writeFile(join(cwd, "package.json"), '{"type":"module"}\n');
  for (const args of [
    ["release"], ["release", "--config", "missing.js"],
    ["release", "--unknown"], ["release", "--version"],
    ["release", "extra"], ["verify", "--config", "npr.config.js"],
    ["verify", "--artifacts", cwd],
  ]) {
    const result = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: "utf8" });
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^\[npr\] /u);
  }
});
