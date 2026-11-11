import console from "node:console";
import process from "node:process";
import { command } from "./command.js";
import { Git } from "./git.js";
import { NpmPackage } from "./package.js";
import { Workflow } from "./workflow.js";
import { lifecycleOptions } from "./lifecycle.js";
import { currentExecutionProvider } from "./execution.js";
import type { ExecutionContext, ExecutionProvider } from "./execution.js";
import type { Step } from "./workflow.js";
import type { ReleaseConfig, ReleaseOptions, ReleaseState, VerifyOptions } from "./contracts.js";
import {
  DirectoryReleaseStore, HookValidator, NumericPatchVersions, RegistryVisibility,
} from "./services.js";
import {
  InitializeRelease, PrepareRelease, ValidateRelease, CommitRelease, BuildArtifact, PublishArtifact,
  PushRelease, CreateHostedRelease, PrepareNextVersion, VerifyRelease, ReleaseObserver,
  artifactDirectory, scopedCommand, verifyRetained,
} from "./steps.js";
import type { BuiltRelease, PreparedRelease } from "./steps.js";

export function prepareRelease(workflow: Workflow<ReleaseOptions, PreparedRelease>): Workflow<ReleaseOptions, BuiltRelease> {
  return workflow.then(new ValidateRelease()).then(new CommitRelease()).then(new BuildArtifact());
}

export function finishRelease(workflow: Workflow<ReleaseOptions, BuiltRelease>, nextDevelopment = true): Workflow<ReleaseOptions, ReleaseState> {
  const hosted = workflow.then(new PublishArtifact()).then(new PushRelease()).then(new CreateHostedRelease());
  return nextDevelopment ? hosted.then(new PrepareNextVersion()).then(new VerifyRelease()) : hosted.then(new VerifyRelease());
}

export class ReleaseWorkflow implements Step<ReleaseOptions, ReleaseState> {
  readonly id = "npm-release";
  readonly workflow: Workflow<ReleaseOptions, ReleaseState>;
  readonly preparation: Workflow<ReleaseOptions, BuiltRelease>;

  constructor(private readonly config: ReleaseConfig = {}) {
    this.preparation = prepareRelease(Workflow.start<ReleaseOptions>(new ReleaseObserver(), config.provider)
      .then(new InitializeRelease(config))
      .then(new PrepareRelease()));
    this.workflow = finishRelease(this.preparation);
  }

  async run(options: ReleaseOptions = {}, execution?: ExecutionContext, provider?: ExecutionProvider): Promise<ReleaseState> {
    return this.workflow.run(lifecycleOptions(this.config, options), execution, provider);
  }

  async prepare(options: ReleaseOptions = {}): Promise<BuiltRelease> {
    return this.preparation.run(lifecycleOptions(this.config, options, false));
  }
}

function workflowInstance(workflow: unknown): boolean {
  return typeof workflow === "object" && workflow !== null &&
    Object.getPrototypeOf(workflow) !== Object.prototype && Object.getPrototypeOf(workflow) !== null;
}

export async function prepare<Prepared>(
  workflow: Step<ReleaseOptions, unknown> & { prepare(options: ReleaseOptions): Promise<Prepared> },
  options: ReleaseOptions = {},
): Promise<Prepared> {
  if (!workflowInstance(workflow) || typeof workflow.prepare !== "function" || typeof workflow.run !== "function") {
    throw new Error("Export a workflow instance implementing prepare and run.");
  }
  return workflow.prepare(options);
}

export async function release<Output>(workflow: Step<ReleaseOptions, Output>, options: ReleaseOptions = {}): Promise<Output> {
  if (!workflowInstance(workflow) || !workflow.id?.trim() || typeof workflow.run !== "function") {
    throw new Error("Export a workflow instance with an id and run method.");
  }
  return workflow.run(options);
}

export async function verify({
  cwd = process.cwd(), artifacts, run = command, log = console.log, env = process.env, services = {}, provider = currentExecutionProvider(env),
}: VerifyOptions = {}): Promise<ReleaseState> {
  const execute = scopedCommand(cwd, run, "UTC", "verify", env);
  const store = services.store || new DirectoryReleaseStore(await artifactDirectory(cwd, execute, artifacts));
  const state = await store.read();
  const npm = new NpmPackage(cwd, execute);
  const publisher = services.publisher || npm;
  return verifyRetained(log, provider, {
    repository: services.repository || new Git(execute, { branch: state.branch, remote: state.remote }),
    project: services.project || npm, publisher, store,
    verifier: services.verifier || new RegistryVisibility(publisher),
    changelog: services.changelog || null, host: services.host || null,
    validator: services.validator || new HookValidator(), versions: services.versions || new NumericPatchVersions(),
  });
}
