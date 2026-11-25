import process from "node:process";
import {
  GitHubAction, GitHubReleaseHost, HookValidator, IntrideaChangelog, ReleaseWorkflow,
} from "../../dist/index.js";
import { ReleaseTestProject } from "../../dist/testing.js";
import { simulatedGitHub } from "./hosting.js";

export const changelog = `### 1.0.0 (Next)

* [#2](https://github.com/owner/example/pull/2): Add an output - [@contributor](https://github.com/contributor).
* Your contribution here.

### 0.9.0 (2026/01/01)

* Initial release - [@contributor](https://github.com/contributor).
`;

export const metadata = `name: Example Action
description: An example JavaScript action.
runs:
  using: node24
  main: dist/index.js
  post: ./dist/cleanup.js
`;

// A minimal bundler: write dist/ from src/, optionally varying output with ACTION_BUILD_VARIANT.
export const build = `import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/chunks", { recursive: true });
const variant = process.env.ACTION_BUILD_VARIANT || "";
writeFileSync("dist/index.js", "/* bundled" + variant + " */\\n" + readFileSync("src/index.js", "utf8"));
writeFileSync("dist/cleanup.js", "console.log('cleanup');\\n");
writeFileSync("dist/chunks/1.js", "export default 1;\\n");
`;

export async function actionProject(t, { branch = "main", files = {} } = {}) {
  const project = await ReleaseTestProject.create({ branch });
  t.after(() => project.dispose());
  const lock = { name: "example-action", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: { "": { name: "example-action", version: "1.0.0", license: "MIT" } } };
  await project.write("package.json", JSON.stringify({
    name: "example-action", version: "1.0.0", private: true, type: "module", license: "MIT",
    repository: { type: "git", url: "git+https://github.com/owner/example.git" },
    scripts: { build: "node build.mjs", test: "node --test test.mjs", lint: "node --check build.mjs" },
  }, null, 2) + "\n");
  await project.write("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
  await project.write(".gitignore", "node_modules\ndist\n");
  await project.write("CHANGELOG.md", changelog);
  await project.write("README.md", "# Example Action\n\nUse `owner/example@v1`.\n");
  await project.write("action.yml", metadata);
  await project.write("src/index.js", 'console.log("example output");\n');
  await project.write("build.mjs", build);
  await project.write("test.mjs", 'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("action", () => assert.ok(true));\n');
  for (const [path, content] of Object.entries(files)) await project.write(path, content);
  await project.commit("Action fixture");
  return project;
}

export function actionWorkflow(project, settings = {}) {
  const run = simulatedGitHub(project.run, settings.hosted);
  const checked = settings.checked || [];
  return {
    hosted: run.hosted,
    checked,
    workflow: new ReleaseWorkflow({
      changelog: new IntrideaChangelog("CHANGELOG.md", { placeholder: "* Your contribution here." }),
      project: new GitHubAction({ name: "example-action", ...settings.project }),
      publisher: null,
      ...settings.config,
      host: new GitHubReleaseHost(run, "owner/example"),
      validator: new HookValidator({
        async validateArtifact({ consumer, run: execute }) {
          checked.push((await execute(process.execPath, ["dist/index.js"], { cwd: consumer })).trim());
        },
      }),
    }),
  };
}

export const remoteRef = async (project, ref) => (await project.git("ls-remote", "origin", ref)).trim().split(/\s/u)[0] || null;
