import console from "node:console";
import process from "node:process";
import { command } from "./command.js";
import { Git } from "./git.js";
import { NpmPackage } from "./package.js";
import { Workflow } from "./workflow.js";
import type { Step } from "./workflow.js";
import type { ReleaseConfig, ReleaseOptions, ReleaseServices, ReleaseState, VerifyOptions } from "./contracts.js";
import {
  DirectoryReleaseStore, HookValidator, NumericPatchVersions, RegistryVisibility,
} from "./services.js";
import {
  InitializeRelease, PrepareRelease, ValidateRelease, CommitRelease, BuildArtifact, PublishArtifact,
  PushRelease, CreateHostedRelease, PrepareNextVersion, VerifyRelease, ReleaseObserver,
  artifactDirectory, scopedCommand, verifyRetained,
} from "./steps.js";

export class ReleaseWorkflow implements Step<ReleaseOptions, ReleaseState> {
  readonly id = "npm-release";
  readonly workflow: Workflow<ReleaseOptions, ReleaseState>;

  constructor(config: ReleaseConfig, services: Partial<ReleaseServices> = {}) {
    this.workflow = Workflow.start<ReleaseOptions>(new ReleaseObserver())
      .then(new InitializeRelease(config, services))
      .then(new PrepareRelease())
      .then(new ValidateRelease())
      .then(new CommitRelease())
      .then(new BuildArtifact())
      .then(new PublishArtifact())
      .then(new PushRelease())
      .then(new CreateHostedRelease())
      .then(new PrepareNextVersion())
      .then(new VerifyRelease());
  }

  async run(options: ReleaseOptions = {}): Promise<ReleaseState> {
    return this.workflow.run(options);
  }
}

export function release(config: ReleaseConfig, options?: ReleaseOptions): Promise<ReleaseState>;
export function release<Output>(workflow: Step<ReleaseOptions, Output>, options?: ReleaseOptions): Promise<Output>;
export async function release(config: ReleaseConfig | Step<ReleaseOptions, unknown>, options: ReleaseOptions = {}): Promise<unknown> {
  if (config && "run" in config && typeof config.run === "function" && "id" in config) return config.run(options);
  return new ReleaseWorkflow(config as ReleaseConfig).run(options);
}

export async function verify({
  cwd = process.cwd(), artifacts, run = command, log = console.log, env = process.env, services = {},
}: VerifyOptions = {}): Promise<ReleaseState> {
  const execute = scopedCommand(cwd, run, "UTC", "verify", env);
  const store = services.store || new DirectoryReleaseStore(await artifactDirectory(cwd, execute, artifacts));
  const state = await store.read();
  const npm = new NpmPackage(cwd, execute);
  const publisher = services.publisher || npm;
  return verifyRetained(log, env, {
    repository: services.repository || new Git(execute, { branch: state.branch, remote: state.remote }),
    project: services.project || npm, publisher, store,
    verifier: services.verifier || new RegistryVisibility(publisher),
    changelog: services.changelog || null, host: services.host || null,
    validator: services.validator || new HookValidator(), versions: services.versions || new NumericPatchVersions(),
  });
}
