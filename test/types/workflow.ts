import {
  Workflow, InitializeRelease, PrepareRelease, ValidateRelease, CommitRelease, BuildArtifact,
  PublishArtifact, release, ReleaseWorkflow,
  LocalExecutionProvider, prepare, complete,
} from "../../src/index.js";
import type {
  Step, BuiltRelease, ReleaseOptions, Changelog, PackagePublisher, ReleaseValidator, VersionPolicy,
  ReleaseHost, ReleaseStore, ReleaseRepository, PackageProject, RegistryVerifier, ReleaseServices,
  ExecutionContext, ExecutionProvider,
  ReleaseCheckpoint, CheckpointWorkflow,
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
new ReleaseWorkflow(config, { changelog: new Notes(), versions: new Versions() }, new LocalExecutionProvider({}));
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
// @ts-expect-error Service implementations must satisfy the complete interface.
new ReleaseWorkflow(config, { publisher: { async publish() {} } });

export function serviceContracts(
  repository: ReleaseRepository, project: PackageProject, publisher: PackagePublisher, host: ReleaseHost,
  validator: ReleaseValidator, store: ReleaseStore, verifier: RegistryVerifier,
): ReleaseServices {
  return { repository, project, publisher, host, validator, store, verifier, changelog: new Notes(), versions: new Versions() };
}
