import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { checkCli } from "./helpers/cli.js";

test("the scaffold CLI reports its status and rejects unsupported commands", () => {
  const entry = fileURLToPath(new URL("../bin/npm-package-release.js", import.meta.url));
  checkCli((args) => spawnSync(process.execPath, [entry, ...args], { encoding: "utf8" }));
});
