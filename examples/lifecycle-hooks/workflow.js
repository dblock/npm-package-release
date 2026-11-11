import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { HookValidator, KeepAChangelog, LifecycleHooks, MarkdownSection, ReleaseWorkflow } from "npm-package-release";

class UpdateReadme {
  id = "update-readme";
  async run({ context }) {
    await new MarkdownSection("README.md", "## Release Status").replace(
      `Documentation for version ${context.version}.`, { cwd: context.cwd },
    );
  }
}

export function createReleaseWorkflow(services = {}) {
  return new ReleaseWorkflow({
    changelog: new KeepAChangelog("CHANGELOG.md", {
      placeholder: "- Your contribution here.", sections: ["Added", "Fixed"],
    }),
    hooks: new LifecycleHooks().after("prepare", new UpdateReadme()).after("next", new UpdateReadme()),
    validator: new HookValidator({
      async validateArtifact({ cwd, consumer, version, run }) {
        const { name } = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
        await run(process.execPath, ["--input-type=module", "--eval", `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
const [name, version] = process.argv.slice(1);
assert.equal((await import(name)).message, "A lifecycle example");
const readme = await readFile(join("node_modules", name, "README.md"), "utf8");
assert.ok(readme.replaceAll("\\r\\n", "\\n").includes("## Release Status\\n\\nDocumentation for version " + version + ".\\n"));
`, name, version], { cwd: consumer });
      },
    }),
    ...services,
  });
}
