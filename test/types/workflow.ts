import {
  Workflow, InitializeRelease, PrepareRelease, ValidateRelease, CommitRelease, BuildArtifact,
  PublishArtifact, release, ReleaseWorkflow,
  LocalExecutionProvider, prepare,
  SemanticReleaseWorkflow, AnalyzeSemanticRelease, InitializeSemanticRelease, KeepAChangelog, IntrideaChangelog, HookValidator,
  LifecycleHooks, MarkdownSection,
} from "../../src/index.js";
import type {
  Step, BuiltRelease, ReleaseOptions, Changelog, PackagePublisher, ReleaseValidator, VersionPolicy,
  ReleaseHost, ReleaseStore, ReleaseRepository, PackageProject, RegistryVerifier, ReleaseServices,
  ExecutionContext, ExecutionProvider,
  SemanticHistory, CommitAnalyzer, SemanticVersionPolicy, SemanticNotes, SemanticDecision,
  LifecycleHook, LifecycleContext,
} from "../../src/index.js";

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
  // @ts-expect-error Semantic selections cannot be changed after analysis.
  decision.version = "9.0.0";
  // @ts-expect-error Captured history is deeply immutable.
  decision.commits[0].message = "Changed";
}
// @ts-expect-error Service implementations must satisfy the complete interface.
new ReleaseWorkflow({ ...config, publisher: { async publish() {} } });

export function serviceContracts(
  repository: ReleaseRepository, project: PackageProject, publisher: PackagePublisher, host: ReleaseHost,
  validator: ReleaseValidator, store: ReleaseStore, verifier: RegistryVerifier,
): ReleaseServices {
  return { repository, project, publisher, host, validator, store, verifier, changelog: new Notes(), versions: new Versions() };
}
