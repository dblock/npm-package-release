import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { checkWorkflowNames } from "../scripts/check-workflow-names.js";

test("workflow display names preserve acronyms, npm, code, and expressions", () => {
  assert.deepEqual(checkWorkflowNames(`
name: Test and Package
jobs:
  arbitrary-lowercase-id:
    name: Test Node \${{ matrix.entry.node }}
    env:
      name: not a display name
    steps:
      - name: Run npm Tests
        run: npm test
      - name: Run \`node --test\` and ESLint
        run: npm run lint
      - uses: actions/checkout@v7
  call:
    uses: dblock/example/.github/workflows/test.yml@v1
`), []);
});

test("workflow, job, and step display names must use title case", () => {
  const errors = checkWorkflowNames(`
name: run tests
jobs:
  test:
    name: test package
    steps:
      - name: run tests
        run: npm test
`);
  assert.deepEqual(errors.map(({ path }) => path), [
    "name",
    "jobs.test.name",
    "jobs.test.steps[0].name",
  ]);
});

test("optional display names may be absent, but not empty or non-string", () => {
  assert.deepEqual(checkWorkflowNames("on: push\njobs: {}\n"), []);
  assert.deepEqual(checkWorkflowNames(""), []);
  for (const name of ["''", "' '", "false", "null", "42"]) {
    assert.match(checkWorkflowNames(`name: ${name}\n`)[0].message, /nonempty strings/u);
  }
});

test("invalid YAML is rejected instead of silently skipped", () => {
  assert.throws(() => checkWorkflowNames("name: [\n"));
});

test("composite-action step names use title case without checking input names", () => {
  const source = "name: npm Package Release\ninputs:\n  name:\n    description: arbitrary value\nruns:\n  using: composite\n  steps:\n    - name: release package\n      shell: bash\n      run: npm test\n";
  assert.deepEqual(checkWorkflowNames(source).map(({ path }) => path), ["runs.steps[0].name"]);
  assert.deepEqual(checkWorkflowNames(source.replace("release package", "Release Package")), []);
});

test("the workflow checker reports YAML and capitalization errors through its exit status", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npm-package-release-workflows-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workflows = join(directory, ".github/workflows");
  await mkdir(workflows, { recursive: true });
  const checker = fileURLToPath(new URL("../scripts/check-workflow-names.js", import.meta.url));
  const run = () => spawnSync(process.execPath, [checker], { cwd: directory, encoding: "utf8" });

  await writeFile(join(workflows, "test.yml"), "name: Test\n");
  await writeFile(join(workflows, "README.txt"), "not YAML");
  assert.equal(run().status, 0);

  await writeFile(join(workflows, "test.yml"), "name: run tests\n");
  const invalidCase = run();
  assert.equal(invalidCase.status, 1);
  assert.match(invalidCase.stderr, /test\.yml: name: Use title case/u);

  await writeFile(join(workflows, "test.yml"), "name: [\n");
  const invalidYaml = run();
  assert.equal(invalidYaml.status, 1);
  assert.match(invalidYaml.stderr, /test\.yml:/u);
});
