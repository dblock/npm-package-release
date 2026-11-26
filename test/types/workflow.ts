import {
  Workflow, InitializeRelease, PrepareRelease, ValidateRelease, CommitRelease, BuildArtifact,
  PublishArtifact, release, ReleaseWorkflow,
  LocalExecutionProvider, prepare,
  SemanticReleaseWorkflow, AnalyzeSemanticRelease, InitializeSemanticRelease, KeepAChangelog, IntrideaChangelog, HookValidator,
  LifecycleHooks, MarkdownSection, GeneratedChangelog, ZipArchive, GitHubAction, actionEntryPoints, buildCommitMessage,
  ChromeWebStore, EnvironmentAccessToken, ServiceAccountKey, registryVerifier,
} from "../../src/index.js";
import type {
  Step, BuiltRelease, ReleaseOptions, Changelog, PackagePublisher, ReleaseValidator, VersionPolicy,
  ReleaseHost, ReleaseStore, ReleaseRepository, PackageProject, RegistryVerifier, ReleaseServices,
  ExecutionContext, ExecutionProvider,
  SemanticHistory, CommitAnalyzer, SemanticVersionPolicy, SemanticNotes, SemanticDecision,
  LifecycleHook, LifecycleContext,
} from "../../src/index.js";

export async function commitContract(repository: ReleaseRepository, tree: string) {
  await repository.commitRelease("0.1.2", tree);
  await repository.commitNext("0.1.3", tree);
  await repository.commit("Project change", tree);
  // @ts-expect-error Release commits require a prepared tree.
  await repository.commitRelease("0.1.2");
  // @ts-expect-error Next-development versions must be strings.
  await repository.commitNext(123, tree);
  // @ts-expect-error Ordinary commits do not accept an intent argument.
  await repository.commit("Project change", tree, { kind: "release", version: "0.1.2" });
}

class InspectArtifact implements Step<BuiltRelease, BuiltRelease> {
  readonly id = "inspect";
  async run(input: BuiltRelease, execution?: ExecutionContext, provider?: ExecutionProvider): Promise<BuiltRelease> {
    input.runtime.log(input.state.artifact.integrity);
    execution?.release?.manifestVersion satisfies string | undefined;
    provider?.context satisfies ExecutionProvider["context"] | undefined;
    if (execution) {
      // @ts-expect-error Execution history snapshots are immutable.
      execution.steps.publish = { id: "publish", outcome: "success" };
      // @ts-expect-error The current step is immutable.
      execution.step.id = "changed";
      // @ts-expect-error Execution snapshots do not expose credentials.
      String(execution.env.GITHUB_TOKEN);
    }
    // @ts-expect-error Release identity cannot be mutated by a step.
    input.state.version = "9.9.9";
    // @ts-expect-error Artifact checksums cannot be mutated by a step.
    input.state.artifact.integrity = "changed";
    return input;
  }
}

const config = { changelog: null };
const workflow = Workflow.start<ReleaseOptions>()
  .then(new InitializeRelease(config))
  .then(new PrepareRelease())
  .then(new ValidateRelease())
  .then(new CommitRelease())
  .then(new BuildArtifact())
  .then(new InspectArtifact())
  .then(new PublishArtifact());
export async function resultContract() {
  const published = await release(workflow);
  published.state.artifact.integrity satisfies string;
}

// @ts-expect-error Publishing requires a built artifact, not release options.
Workflow.start<ReleaseOptions>().then(new PublishArtifact());
// @ts-expect-error Prepared files have not been validated/committed/built.
Workflow.start<ReleaseOptions>().then(new InitializeRelease(config)).then(new PrepareRelease()).then(new PublishArtifact());
// @ts-expect-error Class steps must return the next step's required record.
workflow.then({ id: "broken", async run(input: BuiltRelease) { return input; } });

class Notes implements Changelog {
  async release({ version }: { version: string; date: string }): Promise<string> { return version; }
  async next(): Promise<void> {}
}
class Versions implements VersionPolicy {
  select(version: string) { return { version, nextVersion: "1.0.0" }; }
}
new ReleaseWorkflow({ changelog: new Notes(), versions: new Versions(), provider: new LocalExecutionProvider({}) });
new ReleaseWorkflow();
new ReleaseWorkflow({ changelog: new KeepAChangelog("docs/CHANGES.md"), validator: new HookValidator() });
new ReleaseWorkflow({ changelog: new IntrideaChangelog() });
new KeepAChangelog("CHANGELOG.md", { placeholder: "* Contribute.", sections: ["Added", "Fixed"] });
new IntrideaChangelog("CHANGELOG.md", { placeholder: "* Contribute." });
new MarkdownSection("README.md", "## Stable").replace("New.", { cwd: "." });
new MarkdownSection("README.md", "## Stable").replace("Old.", "New.");
new MarkdownSection("README.md", "## Stable").replace(/version (\S+)/gu, "release $1", { cwd: "." });
// @ts-expect-error Markdown section bodies must be strings.
new MarkdownSection("README.md", "## Stable").replace(123);
// @ts-expect-error A regular expression requires replacement text.
new MarkdownSection("README.md", "## Stable").replace(/Old/u);
// @ts-expect-error Substitution text must be a string.
new MarkdownSection("README.md", "## Stable").replace(/Old/u, () => "New.");
// @ts-expect-error Template sections are an array of names.
new KeepAChangelog("CHANGELOG.md", { sections: "Added" });
// @ts-expect-error Intridea always requires a contribution placeholder.
new IntrideaChangelog("CHANGELOG.md", { placeholder: null });
class CheckBuiltArchive implements LifecycleHook<"build", "after"> {
  readonly id = "check-built-archive";
  async run(hookContext: LifecycleContext<"build", "after">): Promise<void> {
    hookContext.output.state.artifact.integrity satisfies string;
    hookContext.execution.release?.version satisfies string | undefined;
    // @ts-expect-error Hook metadata is immutable.
    hookContext.index = 2;
    // @ts-expect-error Release artifact records are immutable.
    hookContext.output.state.artifact.integrity = "changed";
    // @ts-expect-error Post-step hooks expose output, not an ambiguous value.
    String(hookContext.value);
    // @ts-expect-error Step input belongs to before hooks.
    String(hookContext.input);
  }
}
const hooks = new LifecycleHooks().after("build", new CheckBuiltArchive());
new ReleaseWorkflow({ hooks });
new SemanticReleaseWorkflow({ hooks });
// @ts-expect-error A post-build hook cannot run before the artifact exists.
hooks.before("build", new CheckBuiltArchive());
// @ts-expect-error Hooks retain their exact stage contracts.
hooks.after("prepare", new CheckBuiltArchive());
// @ts-expect-error Lifecycle stages are explicit.
hooks.before("anything", new CheckBuiltArchive());
// @ts-expect-error Hooks are class-based registries, not selector objects.
new ReleaseWorkflow({ hooks: { build: async () => {} } });
export function lifecyclePayloads(
  beforeInitialize: LifecycleContext<"initialize", "before">,
  preparation: LifecycleContext<"prepare" | "next", "before" | "after">,
) {
  beforeInitialize.input.version satisfies string | undefined;
  preparation.context.version satisfies string;
  preparation.context.run satisfies ReleaseOptions["run"];
  // @ts-expect-error Before-step hooks expose input, not output.
  String(beforeInitialize.output);
  // @ts-expect-error Preparation hooks expose a command context, not a step input.
  String(preparation.input);
  // @ts-expect-error Preparation hooks expose a command context, not a step output.
  String(preparation.output);
}
// @ts-expect-error Format objects are not changelog implementations.
new ReleaseWorkflow({ changelog: { format: "intridea" } });
// @ts-expect-error Hosting is selected with a host instance or null.
new ReleaseWorkflow({ github: false });
// @ts-expect-error Validation is supplied as a validator instance.
new ReleaseWorkflow({ validate: async () => {} });
// @ts-expect-error Release API accepts workflows, not configuration objects.
release(config);
// @ts-expect-error Staged API accepts workflows, not configuration objects.
prepare(config);
export async function preparationContracts() {
  const workflow = new ReleaseWorkflow(config);
  const built = await prepare(workflow);
  built.state.artifact.integrity satisfies string;
  const completed = await release(workflow, { env: built.runtime.env });
  completed.verification satisfies string | undefined;
}
export function semanticContracts(history: SemanticHistory, analyzer: CommitAnalyzer, selector: SemanticVersionPolicy, notes: SemanticNotes) {
  const workflow = new SemanticReleaseWorkflow({ history, analyzer, selector, notes });
  Workflow.start<ReleaseOptions>().then(new AnalyzeSemanticRelease()).then(new InitializeSemanticRelease());
  // @ts-expect-error Semantic initialization requires an analyzed decision.
  Workflow.start<ReleaseOptions>().then(new InitializeSemanticRelease());
  // @ts-expect-error An analyzer must return a supported release type.
  new SemanticReleaseWorkflow({ analyzer: { analyze() { return "anything"; } } });
  return workflow;
}
export function immutableDecision(decision: SemanticDecision) {
  const changelog: Changelog = new GeneratedChangelog(decision, "docs/HISTORY.md");
  // @ts-expect-error Generated changelog paths must be strings.
  new GeneratedChangelog(decision, 123);
  // @ts-expect-error Semantic selections cannot be changed after analysis.
  decision.version = "9.0.0";
  // @ts-expect-error Captured history is deeply immutable.
  decision.commits[0].message = "Changed";
  return changelog;
}
// @ts-expect-error Service implementations must satisfy the complete interface.
new ReleaseWorkflow({ ...config, publisher: { async publish() {} } });

export function serviceContracts(
  repository: ReleaseRepository, project: PackageProject, publisher: PackagePublisher, host: ReleaseHost,
  validator: ReleaseValidator, store: ReleaseStore, verifier: RegistryVerifier,
): ReleaseServices {
  return { repository, project, publisher, host, validator, store, verifier, changelog: new Notes(), versions: new Versions() };
}
new ReleaseWorkflow({ publisher: null });
new SemanticReleaseWorkflow({ publisher: null });
export function optionalRegistryContract(input: BuiltRelease, services: ReleaseServices) {
  input.state.registry satisfies false | import("../../src/index.js").RegistryDescription | undefined;
  // @ts-expect-error A release without a registry has no publisher to call.
  void services.publisher.publish("archive.tgz");
  // @ts-expect-error A release without a registry has no visibility verifier.
  void services.verifier.verify(input.state, input.state.verificationOptions, input.runtime.log);
  return services.publisher?.view(input.state.name, input.state.version);
}
new ReleaseWorkflow({
  versionReferences: { "public/manifest.json": [/"version": "(?<version>\d+\.\d+\.\d+)"/u] },
  releaseReferences: { "README.md": [/example@(?<version>\d+\.\d+\.\d+)/u], "docs/**/*.md": [/@v(?<version>\S+)/u] },
});
new SemanticReleaseWorkflow({ versionReferences: { "public/manifest.json": [/"version": "(?<version>[^"]+)"/u] } });
// @ts-expect-error References map paths to arrays of regular expressions, not replacement text.
new ReleaseWorkflow({ versionReferences: { "README.md": "1.0.0" } });
// @ts-expect-error Reference patterns are regular expressions, not strings.
new ReleaseWorkflow({ releaseReferences: { "README.md": ["@(?<version>.+)"] } });
new ReleaseWorkflow({
  project: new ZipArchive({ build: ["npm", "run", "build"], directory: "build", name: "example-extension" }),
  publisher: null,
});
new ZipArchive().bind({ cwd: ".", run: async () => "", env: {} }) satisfies PackageProject;
// @ts-expect-error Builds run an argument array without a shell.
new ZipArchive({ build: "npm run build" });
new ReleaseWorkflow({ project: new GitHubAction({ build: ["npm", "run", "build"], output: ["dist"], name: "example-action" }), publisher: null });
new GitHubAction().bind({ cwd: ".", run: async () => "", env: {} }) satisfies PackageProject;
export async function actionContracts(action: GitHubAction, artifact: BuiltRelease["state"]["artifact"]) {
  const build = await action.commit("1.0.0");
  build.commit satisfies string;
  artifact.commit satisfies string | undefined;
  actionEntryPoints("runs:\n  using: node24\n  main: dist/index.js\n") satisfies string[];
  buildCommitMessage("1.0.0") satisfies string;
  // @ts-expect-error Build output is a list of paths.
  new GitHubAction({ output: "dist" });
}
new ReleaseWorkflow({ floatingTags: ["major", "minor"] });
new SemanticReleaseWorkflow({ floatingTags: ["major"] });
// @ts-expect-error Floating tags are major or minor version tags only.
new ReleaseWorkflow({ floatingTags: ["patch"] });
// @ts-expect-error Floating tags are a list.
new ReleaseWorkflow({ floatingTags: "major" });
export async function floatingContracts(repository: ReleaseRepository, input: BuiltRelease) {
  input.state.floatingTags satisfies readonly string[] | undefined;
  // @ts-expect-error Custom repositories may not implement floating tags.
  await repository.floatingTags("1.0.0", "a".repeat(40), ["major"]);
  return repository.floatingTags?.("1.0.0", "a".repeat(40), ["major", "minor"]);
}

const chrome = new ChromeWebStore({
  publisherId: "example-publisher", itemId: "abcdefghijklmnopabcdefghijklmnop", token: new EnvironmentAccessToken("GOOGLE_ACCESS_TOKEN"),
  publishType: "STAGED_PUBLISH", deployPercentage: 50, polling: { attempts: 3, delay: 1000 },
});
new ReleaseWorkflow({ project: new ZipArchive({ name: "example-extension" }), publisher: chrome });
chrome satisfies PackagePublisher;
chrome satisfies RegistryVerifier;
registryVerifier(chrome) satisfies RegistryVerifier;
new ChromeWebStore({ publisherId: "p", itemId: "abcdefghijklmnopabcdefghijklmnop", token: new ServiceAccountKey("KEY") });
new ChromeWebStore({ publisherId: "p", itemId: "abcdefghijklmnopabcdefghijklmnop", token: { async token({ env }) { return env.TOKEN ?? ""; } } });
export async function chromeContracts(input: BuiltRelease) {
  const outcome = await chrome.verify(input.state, input.state.verificationOptions, () => {});
  outcome.status satisfies string;
  input.state.registryStatus satisfies string | undefined;
  const registry = input.state.registry;
  if (registry) registry.kind satisfies string;
  (await chrome.status()).submittedItemRevisionStatus?.state satisfies string | undefined;
}
// @ts-expect-error The store item ID is required.
new ChromeWebStore({ publisherId: "p" });
// @ts-expect-error Access tokens come from a token source, not a configured string.
new ChromeWebStore({ publisherId: "p", itemId: "abcdefghijklmnopabcdefghijklmnop", token: "secret" });
// @ts-expect-error Publish types are the store's DEFAULT_PUBLISH or STAGED_PUBLISH.
new ChromeWebStore({ publisherId: "p", itemId: "abcdefghijklmnopabcdefghijklmnop", publishType: "NOW" });
