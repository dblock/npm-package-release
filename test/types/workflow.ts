import {
  Workflow, InitializeRelease, PrepareRelease, ValidateRelease, CommitRelease, BuildArtifact,
  PublishArtifact, release, ReleaseWorkflow,
  LocalExecutionProvider, prepare, complete,
  SemanticReleaseWorkflow, AnalyzeSemanticRelease, InitializeSemanticRelease, KeepAChangelog, IntrideaChangelog, HookValidator,
} from "../../src/index.js";
import type {
  Step, BuiltRelease, ReleaseOptions, Changelog, PackagePublisher, ReleaseValidator, VersionPolicy,
  ReleaseHost, ReleaseStore, ReleaseRepository, PackageProject, RegistryVerifier, ReleaseServices,
  ExecutionContext, ExecutionProvider,
  ReleaseCheckpoint, CheckpointWorkflow,
  SemanticHistory, CommitAnalyzer, SemanticVersionPolicy, SemanticNotes, SemanticDecision,
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
export async function checkpointContracts() {
  const workflow = new ReleaseWorkflow(config);
  workflow satisfies CheckpointWorkflow<BuiltRelease, Awaited<ReturnType<typeof workflow.complete>>>;
  const built = await prepare(workflow);
  built.state.artifact.integrity satisfies string;
  const completed = await complete(workflow);
  completed.verification satisfies string | undefined;
}
export function immutableCheckpoint(checkpoint: ReleaseCheckpoint) {
  // @ts-expect-error Checkpoint source identity is immutable.
  checkpoint.source.releaseCommit = "changed";
  // @ts-expect-error A checkpoint is data, not a workflow with publication capabilities.
  complete(checkpoint);
}
export function semanticContracts(history: SemanticHistory, analyzer: CommitAnalyzer, selector: SemanticVersionPolicy, notes: SemanticNotes) {
  const workflow = new SemanticReleaseWorkflow({ history, analyzer, selector, notes });
  workflow satisfies CheckpointWorkflow<BuiltRelease, Awaited<ReturnType<typeof workflow.complete>>>;
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
