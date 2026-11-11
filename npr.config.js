import assert from "node:assert/strict";
import { join } from "node:path";
import process from "node:process";
import { HookValidator, IntrideaChangelog, ReleaseWorkflow } from "npm-package-release";

export default new ReleaseWorkflow({
  changelog: new IntrideaChangelog(),
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
