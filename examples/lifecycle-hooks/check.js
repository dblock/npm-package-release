import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { message } from "./index.js";

assert.equal(message, "A lifecycle example");
const { version } = JSON.parse(await readFile("package.json", "utf8"));
assert.ok((await readFile("README.md", "utf8")).replaceAll("\r\n", "\n").includes(
  `## Release Status\n\nDocumentation for version ${version}.\n`,
));
