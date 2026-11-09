import { realpath, writeFile } from "node:fs/promises";
import console from "node:console";
import { join, resolve } from "node:path";
import process from "node:process";
import { command, numericVersion } from "./command.js";
import { Git } from "./git.js";
import { NpmPackage } from "./package.js";
import {
  DirectoryReleaseStore, GitHubReleaseHost, HookValidator, MarkdownChangelog, NumericPatchVersions,
  RegistryVisibility, snapshot, verificationOptions,
} from "./services.js";
import type {
  Artifact, Command, Environment, HookContext, Log, ReleaseConfig, ReleaseOptions, ReleaseServices, ReleaseState,
} from "./contracts.js";
import type { Step, StepEvent, WorkflowObserver } from "./workflow.js";

export function scopedCommand(cwd: string, run: Command, timezone: string, phase: string, env: Environment): Command {
  return (program, args, options = {}) => run(program, args, {
    cwd, ...options,
    env: { ...env, TZ: timezone, ...(phase === "next" ? { PACKAGE_ARCHIVE: "" } : {}), ...options.env },
  });
}

export async function artifactDirectory(cwd: string, run: Command, path?: string): Promise<string> {
  return resolve(cwd, path?.trim() || (await run("git", ["rev-parse", "--git-path", "npr-release"])).trim());
}

export class ReleaseRuntime {
  constructor(
    readonly config: ReleaseConfig,
    readonly cwd: string,
    readonly run: Command,
    readonly log: Log,
    readonly env: Environment,
    readonly services: ReleaseServices,
    readonly identity: ReleaseState,
  ) {}

  hook(phase: string): HookContext {
    return Object.freeze({
      cwd: this.cwd,
      version: phase === "next" ? this.identity.nextVersion : this.identity.version,
      releasedVersion: this.identity.version, previousVersion: this.identity.previousVersion,
      date: this.identity.date, phase,
      run: scopedCommand(this.cwd, this.run, this.identity.timezone, phase, this.env),
    });
  }

  async report<State extends ReleaseState>(state: State, phase: string): Promise<Readonly<State>> {
    const updated = snapshot({ ...state, phase });
    await this.services.store.save(updated);
    this.log(`[npr] ${phase}: ${state.name}@${state.version}`);
    return updated;
  }
}

export interface ReleaseContext<Stage extends string, State extends ReleaseState = ReleaseState> {
  readonly kind: Stage;
  readonly runtime: ReleaseRuntime;
  readonly state: Readonly<State>;
}
export type InitializedRelease = ReleaseContext<"initialized">;
type PreparedState = ReleaseState & { readonly preparedTree: string };
export type PreparedRelease = ReleaseContext<"prepared", PreparedState> & { readonly notes: string };
export type ValidatedRelease = ReleaseContext<"validated", PreparedState> & { readonly notes: string };
type CommittedState = PreparedState & { readonly releaseCommit: string };
export type CommittedRelease = ReleaseContext<"committed", CommittedState> & { readonly notes: string };
type ArtifactState = CommittedState & { readonly artifact: Artifact };
export type BuiltRelease = ReleaseContext<"built", ArtifactState>;
export type PublishedRelease = ReleaseContext<"published", ArtifactState>;
export type PushedRelease = ReleaseContext<"pushed", ArtifactState>;
export type HostedRelease = ReleaseContext<"hosted", ArtifactState>;
export type NextRelease = ReleaseContext<"next", ArtifactState & { readonly nextCommit: string }>;

export class ReleaseObserver implements WorkflowObserver {
  async started({ id, input }: StepEvent): Promise<void> {
    if (isReleaseContext(input)) input.runtime.log(`[npr] step ${id}`);
  }

  async failed({ id, input, error }: StepEvent & { error: unknown }): Promise<void> {
    if (!isReleaseContext(input)) return;
    const { runtime } = input;
    const state = await runtime.services.store.read();
    await runtime.services.store.save({
      ...state, error: error instanceof Error ? error.message : String(error), failedStep: id,
      ...(state.phase === "next" ? { verification: "failed" } : {}),
    });
    runtime.log(`[npr] stopped at ${state.phase}; recovery artifacts: ${runtime.services.store.directory}`);
  }
}

function isReleaseContext(value: unknown): value is ReleaseContext<string> {
  return typeof value === "object" && value !== null && "runtime" in value && value.runtime instanceof ReleaseRuntime;
}

export class InitializeRelease implements Step<ReleaseOptions, InitializedRelease> {
  readonly id = "initialize";
  constructor(readonly config: ReleaseConfig, readonly services: Partial<ReleaseServices> = {}) {}

  async run(options: ReleaseOptions): Promise<InitializedRelease> {
    const config = this.config;
    if (!config || !Object.hasOwn(config, "changelog")) throw new Error("Configure an explicit changelog format, or changelog: null.");
    if (config.changelog !== null && !["intridea", "keep-a-changelog"].includes(config.changelog.format)) {
      throw new Error("Unknown changelog format.");
    }
    for (const hook of ["prepare", "validate", "validateArtifact", "next"] as const) {
      if (config[hook] !== undefined && typeof config[hook] !== "function") throw new Error(`${hook} must be a function.`);
    }
    const { cwd = process.cwd(), run = command, log = console.log } = options;
    const env = Object.freeze({ ...(options.env || process.env) });
    const timezone = config.timezone || env.NPR_TIMEZONE || "UTC";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const date = ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)!.value).join("-");
    const verification = verificationOptions(config.verification);
    const execute = scopedCommand(cwd, run, timezone, "release", env);
    if (await realpath(cwd) !== await realpath((await execute("git", ["rev-parse", "--show-toplevel"])).trim())) {
      throw new Error("Run releases from the repository root.");
    }
    const repository = this.services.repository || new Git(execute, { branch: config.branch || env.NPR_DEFAULT_BRANCH, remote: config.remote });
    await repository.initialize();
    if (env.GITHUB_ACTIONS === "true" &&
      (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_REF !== `refs/heads/${repository.branch}`)) {
      throw new Error("Actions publication requires manual dispatch from the default branch.");
    }
    const npm = new NpmPackage(cwd, execute);
    const project = this.services.project || npm;
    const publisher = this.services.publisher || npm;
    const manifest = await project.read();
    const versions = this.services.versions || new NumericPatchVersions();
    const { version, nextVersion } = versions.select(manifest.version, options.version);
    const hostedRepository = config.repository || manifest.repository?.url?.replace(/^git\+/u, "").match(
      /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/u,
    )?.[1];
    const host = this.services.host !== undefined ? this.services.host :
      config.github === false ? null : new GitHubReleaseHost(execute, hostedRepository || "");
    await repository.missingTag(version);
    await publisher.available(manifest.name, version);
    const store = this.services.store || new DirectoryReleaseStore(await artifactDirectory(cwd, execute, options.artifacts));
    const state = snapshot({
      name: manifest.name, version, previousVersion: manifest.version, nextVersion,
      date, timezone, branch: repository.branch, remote: repository.remote, initialCommit: repository.initialCommit,
      verificationOptions: verification, phase: "started",
    });
    await store.initialize(state);
    const services: ReleaseServices = Object.freeze({
      repository, project, publisher, versions, store, host,
      validator: this.services.validator || new HookValidator(config),
      changelog: this.services.changelog !== undefined ? this.services.changelog :
        config.changelog ? new MarkdownChangelog(resolve(cwd, config.changelog.path || "CHANGELOG.md"), config.changelog) : null,
      verifier: this.services.verifier || new RegistryVisibility(publisher),
    });
    const runtime = new ReleaseRuntime(config, cwd, run, log, env, services, state);
    return Object.freeze({ kind: "initialized", runtime, state });
  }
}

export class PrepareRelease implements Step<InitializedRelease, PreparedRelease> {
  readonly id = "prepare";
  async run({ runtime, state }: InitializedRelease): Promise<PreparedRelease> {
    const { project, repository, changelog } = runtime.services;
    let notes = "";
    const preparedTree = await repository.stage(async () => {
      await project.setVersion(state.version);
      notes = await changelog?.release(state) || "";
      await runtime.config.prepare?.(runtime.hook("prepare"));
      if ((await project.read()).version !== state.version) throw new Error("Preparation changed the selected version.");
      await project.lockfile(await project.read());
    });
    return Object.freeze({
      kind: "prepared", runtime, notes,
      state: await runtime.report({ ...state, preparedTree }, "prepared"),
    });
  }
}

export class ValidateRelease implements Step<PreparedRelease, ValidatedRelease> {
  readonly id = "validate";
  async run(input: PreparedRelease): Promise<ValidatedRelease> {
    const { runtime, state } = input;
    await runtime.report(state, "validating");
    await runtime.services.validator.validate(runtime.hook("validate"));
    await runtime.services.repository.unchanged(state.preparedTree);
    return Object.freeze({ ...input, kind: "validated", state: await runtime.report(state, "validated") });
  }
}

export class CommitRelease implements Step<ValidatedRelease, CommittedRelease> {
  readonly id = "commit";
  async run(input: ValidatedRelease): Promise<CommittedRelease> {
    const { runtime, state } = input;
    const releaseCommit = await runtime.services.repository.commit(`Prepare release ${state.version}`, state.preparedTree);
    const updated = snapshot({ ...state, releaseCommit });
    await runtime.services.store.save(updated);
    return Object.freeze({ ...input, kind: "committed", state: updated });
  }
}

export class BuildArtifact implements Step<CommittedRelease, BuiltRelease> {
  readonly id = "build";
  async run({ runtime, state, notes }: CommittedRelease): Promise<BuiltRelease> {
    const { project, repository, publisher, validator, store } = runtime.services;
    const building = await runtime.report(state, "building");
    const artifact = await project.pack(store.directory, state);
    const updated = snapshot({ ...building, artifact });
    await store.save(updated);
    const archive = join(store.directory, artifact.filename);
    await project.consumer(archive, (consumer) =>
      validator.artifact(Object.freeze({ ...runtime.hook("artifact"), archive, consumer })));
    await project.intact(store.directory, updated);
    await repository.clean();
    await repository.current(state.initialCommit);
    await repository.missingTag(state.version);
    await publisher.available(state.name, state.version);
    await repository.tag(state.version);
    await repository.bundle(join(store.directory, "release.bundle"), state.version);
    await writeFile(join(store.directory, "release-notes.md"), notes + "\n");
    return Object.freeze({ kind: "built", runtime, state: await runtime.report(updated, "built") });
  }
}

export class PublishArtifact implements Step<BuiltRelease, PublishedRelease> {
  readonly id = "publish";
  async run(input: BuiltRelease): Promise<PublishedRelease> {
    const { runtime, state } = input;
    const { project, publisher, store } = runtime.services;
    await project.intact(store.directory, state);
    await runtime.report(state, "publishing");
    await publisher.publish(join(store.directory, state.artifact.filename));
    await runtime.report(state, "published");
    await project.intact(store.directory, state);
    return Object.freeze({ ...input, kind: "published", state: snapshot({ ...state, phase: "published" }) });
  }
}

export class PushRelease implements Step<PublishedRelease, PushedRelease> {
  readonly id = "push";
  async run(input: PublishedRelease): Promise<PushedRelease> {
    const { runtime, state } = input;
    await runtime.services.repository.current(state.initialCommit);
    await runtime.services.repository.push(state.releaseCommit, state.version);
    return Object.freeze({ ...input, kind: "pushed", state: await runtime.report(state, "pushed") });
  }
}

export class CreateHostedRelease implements Step<PushedRelease, HostedRelease> {
  readonly id = "host";
  async run(input: PushedRelease): Promise<HostedRelease> {
    const { runtime, state } = input;
    const { store, host } = runtime.services;
    await host?.create(state, {
      archive: join(store.directory, state.artifact.filename), notes: join(store.directory, "release-notes.md"),
    });
    return Object.freeze({ ...input, kind: "hosted", state: await runtime.report(state, "hosted") });
  }
}

export class PrepareNextVersion implements Step<HostedRelease | PushedRelease, NextRelease> {
  readonly id = "next";
  async run({ runtime, state }: HostedRelease | PushedRelease): Promise<NextRelease> {
    const { project, repository, changelog, validator, store } = runtime.services;
    const nextTree = await repository.stage(async () => {
      await project.setVersion(state.nextVersion);
      await changelog?.next({ version: state.nextVersion, releasedVersion: state.version });
      await runtime.config.next?.(runtime.hook("next"));
      if ((await project.read()).version !== state.nextVersion) throw new Error("Next hook changed the development version.");
      await project.lockfile(await project.read());
    });
    await validator.validate(runtime.hook("next"));
    const nextCommit = await repository.commit(`Prepare next development iteration, ${state.nextVersion}`, nextTree);
    const updated = snapshot({ ...state, nextCommit });
    await store.save(updated);
    await repository.bundle(join(store.directory, "next.bundle"), state.version);
    await repository.current(state.releaseCommit);
    await repository.push(nextCommit);
    const next = await runtime.report(updated, "next");
    await project.intact(store.directory, next);
    return Object.freeze({ kind: "next", runtime, state: next });
  }
}

export class VerifyRelease implements Step<NextRelease | HostedRelease | PushedRelease, ReleaseState> {
  readonly id = "verify";
  async run({ runtime }: NextRelease | HostedRelease | PushedRelease): Promise<ReleaseState> {
    return verifyRetained(runtime.log, runtime.env, runtime.services);
  }
}

export async function verifyRetained(
  log: Log, env: Environment, services: ReleaseServices,
): Promise<ReleaseState> {
  let state = await services.store.read();
  try {
    numericVersion(state.version);
    if (typeof state.name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(state.name)) {
      throw new Error("Invalid retained package name.");
    }
    if (!state.artifact) throw new Error("Missing retained archive.");
    await services.project.intact(services.store.directory, { ...state, artifact: state.artifact });
    if (!state.releaseCommit || !/^[a-f0-9]{40,64}$/u.test(state.releaseCommit)) throw new Error("Missing release commit identity.");
    await services.repository.verifyTag(state.version, state.releaseCommit);
    log(`[npr] verifying: ${state.name}@${state.version}`);
    const verification = await services.verifier.verify({ ...state, artifact: state.artifact }, state.verificationOptions, log);
    state = snapshot({ ...state, verification });
    await services.store.save(state);
    const message = verification === "verified" ? "verified" : "release could not be verified";
    log(`[npr] ${message}: ${state.name}@${state.version}`);
    if (env.GITHUB_STEP_SUMMARY) {
      await writeFile(env.GITHUB_STEP_SUMMARY,
        `\n## npm Release Verification\n\n${state.name}@${state.version}: ${message}.\n`, { flag: "a" });
    }
    return state;
  } catch (error) {
    await services.store.save({ ...state, verification: "failed", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
