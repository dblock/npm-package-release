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
import { command } from "../../dist/command.js";
import { checkComposition, checkDefaultChangelog } from "../helpers/composition.js";
import { checkSemanticRelease } from "../helpers/semantic.js";
import { checkSelfRelease } from "../helpers/self-release.js";
import { checkLifecycle } from "../helpers/lifecycle.js";

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
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/lifecycle.js",
    "package/dist/lifecycle.d.ts",
    "package/docs/hooks.md",
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
  const installedApi = await import(pathToFileURL(join(consumer, "node_modules/npm-package-release/dist/index.js")).href);
  await checkComposition(t, installedApi);
  await checkDefaultChangelog(t, installedApi);
  await checkLifecycle(t, installedApi);
  await checkSemanticRelease(t, installedApi);
  await checkSelfRelease(t, join(consumer, "node_modules/npm-package-release"));
  const typed = join(consumer, "consumer.ts");
  await writeFile(typed, `
import { Workflow, InitializeRelease, PrepareRelease, PublishArtifact, LocalExecutionProvider, ReleaseWorkflow, prepare, complete, release, SemanticReleaseWorkflow, AnalyzeSemanticRelease, InitializeSemanticRelease, KeepAChangelog, IntrideaChangelog, HookValidator, LifecycleHooks } from "npm-package-release";
import type { Step, ReleaseOptions, PreparedRelease, ExecutionContext, CheckpointWorkflow, LifecycleHook, LifecycleContext } from "npm-package-release";
class Inspect implements Step<PreparedRelease, PreparedRelease> {
  readonly id = "inspect";
  async run(input: PreparedRelease, execution?: ExecutionContext) {
    execution?.release?.manifestVersion satisfies string | undefined;
    return input;
  }
}
const flow = Workflow.start<ReleaseOptions>({}, new LocalExecutionProvider({}))
  .then(new InitializeRelease({ changelog: null }))
  .then(new PrepareRelease()).then(new Inspect());
export async function run(options: ReleaseOptions) { return flow.run(options); }
export async function staged(options: ReleaseOptions) {
  const workflow = new ReleaseWorkflow({ changelog: null });
  workflow satisfies CheckpointWorkflow;
  const built = await prepare(workflow, options);
  built.state.artifact.integrity satisfies string;
  return complete(workflow, options);
}
export const semantic = new SemanticReleaseWorkflow({ nextDevelopment: false });
semantic satisfies CheckpointWorkflow;
new ReleaseWorkflow({ changelog: new KeepAChangelog("docs/HISTORY.md"), validator: new HookValidator() });
new ReleaseWorkflow({ changelog: new IntrideaChangelog() });
new KeepAChangelog("CHANGELOG.md", { placeholder: "* Contribute.", sections: ["Added", "Fixed"] });
new IntrideaChangelog("CHANGELOG.md", { placeholder: "* Contribute." });
// @ts-expect-error Template sections require an array.
new KeepAChangelog("CHANGELOG.md", { sections: "Added" });
class CheckBuild implements LifecycleHook<"build", "after"> {
  readonly id = "check-build";
  async run({ output }: LifecycleContext<"build", "after">) {
    output.state.artifact.integrity satisfies string;
  }
}
const hooks = new LifecycleHooks().after("build", new CheckBuild());
new ReleaseWorkflow({ hooks });
new SemanticReleaseWorkflow({ hooks });
export function hookPayloads(beforeInitialize: LifecycleContext<"initialize", "before">,
  preparation: LifecycleContext<"prepare" | "next", "before" | "after">,
  afterBuild: LifecycleContext<"build", "after">) {
  beforeInitialize.input.version satisfies string | undefined;
  preparation.context.version satisfies string;
  // @ts-expect-error Hook payloads no longer expose an ambiguous value property.
  String(afterBuild.value);
  // @ts-expect-error Preparation hooks expose context, not step output.
  String(preparation.output);
}
// @ts-expect-error Before-build hooks cannot assume an archive exists.
hooks.before("build", new CheckBuild());
// @ts-expect-error Hook stage types cannot be interchanged.
hooks.after("prepare", new CheckBuild());
// @ts-expect-error Format objects are not changelog implementations.
new ReleaseWorkflow({ changelog: { format: "intridea" } });
// @ts-expect-error Release calls require workflow instances.
release({ changelog: null });
// @ts-expect-error Hosting uses service instances rather than flags.
new ReleaseWorkflow({ github: false });
Workflow.start<ReleaseOptions>().then(new AnalyzeSemanticRelease()).then(new InitializeSemanticRelease());
// @ts-expect-error A semantic initializer needs an immutable analyzed decision.
Workflow.start<ReleaseOptions>().then(new InitializeSemanticRelease());
// @ts-expect-error Prepared releases cannot skip artifact validation.
flow.then(new PublishArtifact());
`);
  await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true, noEmit: true, module: "NodeNext", target: "ES2023", types: [],
    },
    files: ["consumer.ts"],
  }));
  await command(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--project", consumer]);
  const fixture = await releaseFixture(t);
  await fixture.assertReleased(await installedApi.release(new installedApi.ReleaseWorkflow(fixture.config), fixture));
  const { NpmPackage } = installedApi;
  const publicRegistry = new NpmPackage(consumer, (program, args, options) =>
    command(program, args, { cwd: consumer, ...options }));
  assert.equal((await publicRegistry.view("semver", "7.8.6")).version, "7.8.6");
  if (process.platform !== "win32") await checkActions(t, archive);
  assert.equal(await digest(), originalDigest);
});
