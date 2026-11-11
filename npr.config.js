import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { HookValidator, IntrideaChangelog, LifecycleHooks, ReleaseWorkflow } from "npm-package-release";

class UpdateDocumentationPins {
  id = "update-documentation-pins";
  async run({ context: { cwd, releasedVersion } }) {
    let entries = [];
    try { entries = await readdir(join(cwd, "docs"), { recursive: true, withFileTypes: true }); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const files = [join(cwd, "README.md"), ...entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => join(entry.parentPath, entry.name))];
    const updates = await Promise.all(files.map(async (path) => {
      const source = await readFile(path, "utf8");
      const updated = source.replace(
        /(dblock\/npm-package-release(?:\/\.github\/workflows\/release\.yml)?@v|(?<![@\w/.-])npm-package-release@)\d+\.\d+\.\d+(?![\w.+-])/gu,
        `$1${releasedVersion}`,
      );
      return { path, source, updated };
    }));
    for (const { path, source, updated } of updates) if (updated !== source) await writeFile(path, updated);
  }
}

export default new ReleaseWorkflow({
  changelog: new IntrideaChangelog(),
  hooks: new LifecycleHooks().after("next", new UpdateDocumentationPins()),
  validator: new HookValidator({ async validateArtifact({ consumer, version, run }) {
    await run(process.execPath, ["--input-type=module", "--eval", `
import assert from "node:assert/strict";
import process from "node:process";
import { Workflow, version } from "npm-package-release";
class CheckInstalledVersion {
  id = "check-installed-version";
  async run(expected) {
    assert.equal(version, expected);
    return version;
  }
}
assert.equal(await Workflow.start().then(new CheckInstalledVersion()).run(process.argv[1]), process.argv[1]);
`, version], { cwd: consumer });
    const output = await run(process.execPath, [
      join(consumer, "node_modules/npm-package-release/bin/npr.js"), "--version",
    ], { cwd: consumer });
    assert.equal(output.trim(), version);
  } }),
});
