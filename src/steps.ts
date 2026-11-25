import { realpath, writeFile } from "node:fs/promises";
import console from "node:console";
import { join, resolve } from "node:path";
import process from "node:process";
import { command, numericVersion } from "./command.js";
import { Git } from "./git.js";
import { NpmPackage } from "./package.js";
import { Release } from "./release-description.js";
import { lifecycleFor } from "./lifecycle.js";
import { updateReferences, versionReferences } from "./references.js";
import type { LifecycleInvocation, LifecycleFailure } from "./lifecycle.js";
import { currentExecutionProvider } from "./execution.js";
import type { ExecutionContext, ExecutionProvider } from "./execution.js";
import {
  DirectoryReleaseStore, GitHubReleaseHost, HookValidator, KeepAChangelog, NumericPatchVersions,
  RegistryVisibility, snapshot, verificationOptions,
} from "./services.js";
import type {
  Artifact, Command, Environment, HookContext, Log, PackageManifest, PackageProject, ProjectContext, ReleaseConfig, ReleaseOptions, ReleaseRepository,
  ReleaseServices, ReleaseState,
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
    readonly provider: ExecutionProvider = currentExecutionProvider(env),
    readonly lifecycle?: LifecycleInvocation,
  ) {}

  description(): Release {
    return new Release({
      name: this.identity.name, version: this.identity.version, manifestVersion: this.identity.previousVersion,
      date: this.identity.date, nextVersion: this.identity.nextVersion,
    });
  }

  hook(phase: string, execution = this.provider.context({
    release: this.description(), step: { id: phase }, steps: {}, workflow: { id: "npm-release", steps: [] },
  })): HookContext {
    return Object.freeze({
      execution,
      cwd: this.cwd,
      version: phase === "next" ? this.identity.nextVersion : this.identity.version,
      releasedVersion: this.identity.version, previousVersion: this.identity.previousVersion,
      date: this.identity.date, phase,
      run: scopedCommand(this.cwd, this.run, this.identity.timezone, phase, this.env),
    });
  }

  async report<State extends ReleaseState>(state: State, phase: string): Promise<Readonly<State>> {
    const { activeStep } = await this.services.store.read();
    const updated = snapshot({ ...state, phase, activeStep });
    await this.services.store.save(updated);
    this.log(`[npr] ${phase}: ${state.name}@${state.version}`);
    return updated;
  }
}

export interface ReleaseContext<Stage extends string, State extends ReleaseState = ReleaseState> {
  readonly kind: Stage;
  readonly runtime: ReleaseRuntime;
  readonly state: Readonly<State>;
  readonly release: Release;
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
    if (!isReleaseContext(input)) return;
    const { runtime } = input;
    await runtime.services.store.save({ ...await runtime.services.store.read(), activeStep: id });
    runtime.log(`[npr] step ${id}`);
  }

  async completed({ input, output }: StepEvent & { readonly output: unknown }): Promise<void> {
    const context = isReleaseContext(output) ? output : input;
    if (!isReleaseContext(context)) return;
    const { store } = context.runtime.services;
    await store.save({ ...await store.read(), activeStep: undefined });
  }

  async failed({ id, input, output, error }: LifecycleFailure): Promise<void> {
    const context = isReleaseContext(input) ? input : output;
    if (!isReleaseContext(context)) return;
    const { runtime } = context;
    const state = await runtime.services.store.read();
    const failedHook = runtime.lifecycle?.details(error);
    await runtime.services.store.save({
      ...state, activeStep: id, error: error instanceof Error ? error.message : String(error), failedStep: id,
      ...(failedHook ? { failedHook } : {}),
      ...(id === "next" && state.verification !== "verified" ? { verification: "failed" } : {}),
    });
    runtime.log(`[npr] failed step ${id}; last phase ${state.phase}; recovery artifacts: ${runtime.services.store.directory}`);
  }
}

function isReleaseContext(value: unknown): value is ReleaseContext<string> {
  return typeof value === "object" && value !== null && "runtime" in value && value.runtime instanceof ReleaseRuntime;
}

function validateConfig(config: ReleaseConfig): void {
  if (!config || typeof config !== "object") throw new Error("Expected a release configuration object.");
  for (const option of ["github", "verification", "validate", "validateArtifact"]) {
    if (Object.hasOwn(config, option)) throw new Error(`Unsupported release option: ${option}; configure a service instance instead.`);
  }
  if (config.changelog !== undefined && config.changelog !== null &&
    (typeof config.changelog.release !== "function" || typeof config.changelog.next !== "function")) {
    throw new Error("Changelog must implement release and next; use a changelog class, not a format object.");
  }
  for (const hook of ["prepare", "next"] as const) {
    if (config[hook] !== undefined && typeof config[hook] !== "function") throw new Error(`${hook} must be a function.`);
  }
  validateDestinations(config);
  referenceOptions(config);
  floatingTagOptions(config);
}

export function floatingTagOptions(config: ReleaseConfig): Pick<ReleaseConfig, "floatingTags"> {
  if (!config || typeof config !== "object" || config.floatingTags === undefined) return {};
  const tags = config.floatingTags;
  if (!Array.isArray(tags) || !tags.length || tags.some((tag) => tag !== "major" && tag !== "minor") ||
    new Set(tags).size !== tags.length) {
    throw new Error('floatingTags must be a nonempty list of distinct "major" and "minor" entries.');
  }
  return { floatingTags: Object.freeze([...tags]) };
}

export function referenceOptions(config: ReleaseConfig): Pick<ReleaseConfig, "versionReferences" | "releaseReferences"> {
  if (!config || typeof config !== "object") return {};
  const options: { versionReferences?: ReleaseConfig["versionReferences"]; releaseReferences?: ReleaseConfig["releaseReferences"] } = {};
  for (const option of ["versionReferences", "releaseReferences"] as const) {
    const references = versionReferences(config[option], option);
    if (references) options[option] = references;
  }
  return options;
}

function updateVersionReferences(runtime: ReleaseRuntime, phase: string, version: string,
  execution?: ExecutionContext): Promise<void> {
  const { versionReferences: references, releaseReferences } = runtime.config;
  return updateReferences([
    { references, version, option: "versionReferences" },
    { references: releaseReferences, version: runtime.identity.version, option: "releaseReferences" },
  ], runtime.cwd, runtime.hook(phase, execution).run);
}

export function validateDestinations(config: ReleaseConfig): void {
  if (!config || typeof config !== "object") return;
  if (config.publisher === null) {
    if (config.host === null) {
      throw new Error("A release without a registry (publisher: null) requires a release host, such as GitHubReleaseHost.");
    }
    if (config.verifier !== undefined && config.verifier !== null) {
      throw new Error("A registry verifier requires a publisher; omit verifier when publisher is null.");
    }
  } else if (config.verifier === null) {
    throw new Error("verifier: null requires publisher: null; registry releases always verify visibility.");
  }
}

function bindProject(config: ReleaseConfig, context: ProjectContext): PackageProject | undefined {
  return config.project?.bind ? config.project.bind(Object.freeze(context)) : config.project;
}

function releaseHost(config: ReleaseConfig, run: Command, manifest: PackageManifest) {
  const repository = manifest.repository?.url?.replace(/^git\+/u, "").match(
    /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/u,
  )?.[1];
  return config.host !== undefined ? config.host : new GitHubReleaseHost(run, repository || "");
}

function releaseServices(config: ReleaseConfig,
  core: Pick<ReleaseServices, "repository" | "project" | "publisher" | "versions" | "store" | "host">): ReleaseServices {
  return Object.freeze({
    ...core,
    validator: config.validator || new HookValidator(),
    changelog: config.changelog === undefined ? new KeepAChangelog() : config.changelog,
    verifier: core.publisher ? config.verifier || new RegistryVisibility(core.publisher) : null,
  });
}

export class InitializeRelease implements Step<ReleaseOptions, InitializedRelease> {
  readonly id = "initialize";
  constructor(readonly config: ReleaseConfig = {}) {}

  private date(timezone: string, env: Environment): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const date = env.NPR_RELEASE_DATE ||
      ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)!.value).join("-");
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error("Invalid release date.");
    return date;
  }

  private async repository(cwd: string, execute: Command, provider: ExecutionProvider, env: Environment): Promise<ReleaseRepository> {
    if (await realpath(cwd) !== await realpath((await execute("git", ["rev-parse", "--show-toplevel"])).trim())) {
      throw new Error("Run releases from the repository root.");
    }
    const repository = this.config.repository ||
      new Git(execute, { branch: this.config.branch || provider.defaultBranch, remote: this.config.remote });
    await repository.initialize(env.NPR_SOURCE_COMMIT);
    provider.validateReleaseBranch(repository.branch);
    return repository;
  }

  private async capture(execute: Command, provider: ExecutionProvider, env: Environment,
    source: string, manifestVersion: string, date: string) {
    const epoch = env.SOURCE_DATE_EPOCH || (await execute("git", ["show", "-s", "--format=%ct", source])).trim();
    if (!/^\d+$/u.test(epoch)) throw new Error("Invalid source timestamp.");
    const previousVersion = numericVersion(env.NPR_MANIFEST_VERSION || manifestVersion);
    const inputs = {
      NPR_SOURCE_COMMIT: source, NPR_MANIFEST_VERSION: previousVersion,
      NPR_RELEASE_DATE: date, SOURCE_DATE_EPOCH: epoch,
    };
    const captured = await provider.capture?.(inputs);
    return { env: Object.freeze({ ...env, ...inputs, ...captured }), previousVersion };
  }

  async run(options: ReleaseOptions, execution?: ExecutionContext, injectedProvider?: ExecutionProvider): Promise<InitializedRelease> {
    const config = this.config;
    validateConfig(config);
    const { cwd = process.cwd(), run = command, log = console.log } = options;
    let env = Object.freeze({ ...(options.env || process.env) });
    const provider = options.provider || injectedProvider || config.provider || currentExecutionProvider(env);
    const timezone = config.timezone || provider.timezone || "UTC";
    const date = this.date(timezone, env);
    const verification = verificationOptions(config.verifier?.options);
    let execute = scopedCommand(cwd, run, timezone, "release", env);
    const repository = await this.repository(cwd, execute, provider, env);
    const project = bindProject(config, { cwd, run: execute, env }) || new NpmPackage(cwd, execute);
    const manifest = await project.read();
    const versions = config.versions || new NumericPatchVersions();
    const { version, nextVersion } = versions.select(manifest.version, options.version);
    await repository.current(repository.initialCommit, version);
    const captured = await this.capture(execute, provider, env, repository.initialCommit, manifest.version, date);
    env = captured.env;
    const { previousVersion } = captured;
    execute = scopedCommand(cwd, run, timezone, "release", env);
    const npm = new NpmPackage(cwd, execute);
    const publisher = config.publisher === undefined ? npm : config.publisher;
    const host = releaseHost(config, execute, manifest);
    const published = await publisher?.view(manifest.name, version);
    if (published && (!published.dist?.integrity || !published.dist.shasum)) {
      throw new Error("Published archive integrity is unavailable.");
    }
    const store = config.store || new DirectoryReleaseStore(await artifactDirectory(cwd, execute, options.artifacts));
    const state = snapshot({
      name: manifest.name, version, previousVersion, nextVersion,
      date, timezone, branch: repository.branch, remote: repository.remote, initialCommit: repository.initialCommit,
      verificationOptions: verification, ...(publisher ? {} : { registry: false as const }), phase: "started",
    });
    await store.initialize(state);
    const services = releaseServices(config, {
      repository, project: bindProject(config, { cwd, run: execute, env }) || npm, publisher, versions, store, host,
    });
    const runtime = new ReleaseRuntime(config, cwd, run, log, env, services, state, provider, lifecycleFor(options));
    return Object.freeze({ kind: "initialized", runtime, state, release: runtime.description() });
  }
}

export class PrepareRelease implements Step<InitializedRelease, PreparedRelease> {
  readonly id = "prepare";
  async run(input: InitializedRelease, execution?: ExecutionContext): Promise<PreparedRelease> {
    const { runtime, state } = input;
    const { project, repository, changelog } = runtime.services;
    let notes = "";
    const preparedTree = await repository.stage(async () => {
      const before = runtime.hook("prepare", execution);
      await runtime.lifecycle?.invoke("prepare", "before", before, before.execution);
      await project.setVersion(state.version);
      await updateVersionReferences(runtime, "prepare", state.version, execution);
      notes = await changelog?.release({ ...input.release, cwd: runtime.cwd }) || "";
      await runtime.config.prepare?.(runtime.hook("prepare", execution?.withRelease(input.release.withNotes(notes))));
      const after = runtime.hook("prepare", execution?.withRelease(input.release.withNotes(notes)));
      await runtime.lifecycle?.invoke("prepare", "after", after, after.execution);
      if ((await project.read()).version !== state.version) throw new Error("Preparation changed the selected version.");
      await project.lockfile(await project.read());
    });
    return Object.freeze({
      kind: "prepared", runtime, notes, release: input.release.withNotes(notes),
      state: await runtime.report({ ...state, preparedTree }, "prepared"),
    });
  }
}

export class ValidateRelease implements Step<PreparedRelease, ValidatedRelease> {
  readonly id = "validate";
  async run(input: PreparedRelease, execution?: ExecutionContext): Promise<ValidatedRelease> {
    const { runtime, state } = input;
    await runtime.report(state, "validating");
    await runtime.services.validator.validate(runtime.hook("validate", execution));
    await runtime.services.repository.unchanged(state.preparedTree);
    return Object.freeze({ ...input, kind: "validated", state: await runtime.report(state, "validated") });
  }
}

export class CommitRelease implements Step<ValidatedRelease, CommittedRelease> {
  readonly id = "commit";
  async run(input: ValidatedRelease): Promise<CommittedRelease> {
    const { runtime, state } = input;
    const releaseCommit = await runtime.services.repository.commitRelease(state.version, state.preparedTree);
    const updated = snapshot({ ...state, releaseCommit, activeStep: this.id });
    await runtime.services.store.save(updated);
    return Object.freeze({ ...input, kind: "committed", state: updated });
  }
}

export class BuildArtifact implements Step<CommittedRelease, BuiltRelease> {
  readonly id = "build";
  async run(input: CommittedRelease, execution?: ExecutionContext): Promise<BuiltRelease> {
    const { runtime, state, notes, release } = input;
    const { project, repository, validator, store } = runtime.services;
    const building = await runtime.report(state, "building");
    const artifact = await project.pack(store.directory, release);
    const updated = snapshot({ ...building, artifact });
    await store.save(updated);
    const archive = join(store.directory, artifact.filename);
    await project.consumer(archive, (consumer) =>
      validator.artifact(Object.freeze({ ...runtime.hook("artifact", execution), archive, consumer })));
    await project.intact(store.directory, updated);
    await repository.clean();
    await repository.current(state.initialCommit, state.version);
    await repository.tag(state.version, artifact.commit);
    await repository.bundle(join(store.directory, "release.bundle"), state.version);
    await writeFile(join(store.directory, "release-notes.md"), notes + "\n");
    return Object.freeze({ kind: "built", runtime, release, state: await runtime.report(updated, "built") });
  }
}

export class PublishArtifact implements Step<BuiltRelease, PublishedRelease> {
  readonly id = "publish";
  async run(input: BuiltRelease): Promise<PublishedRelease> {
    const { runtime, state } = input;
    const { project, publisher, store } = runtime.services;
    await project.intact(store.directory, state);
    if (!publisher) return Object.freeze({ ...input, kind: "published", state });
    await runtime.report(state, "publishing");
    await publisher.publish(join(store.directory, state.artifact.filename));
    const published = await runtime.report(state, "published");
    await project.intact(store.directory, state);
    return Object.freeze({ ...input, kind: "published", state: published });
  }
}

export class PushRelease implements Step<PublishedRelease, PushedRelease> {
  readonly id = "push";
  async run(input: PublishedRelease): Promise<PushedRelease> {
    const { runtime, state } = input;
    await runtime.services.repository.push(state.releaseCommit, state.version, state.artifact.commit);
    return Object.freeze({ ...input, kind: "pushed", state: await runtime.report(state, "pushed") });
  }
}

export class CreateHostedRelease implements Step<PushedRelease, HostedRelease> {
  readonly id = "host";
  async run(input: PushedRelease): Promise<HostedRelease> {
    const { runtime, state } = input;
    const { store, host } = runtime.services;
    await host?.create(input.release, {
      archive: join(store.directory, state.artifact.filename), notes: join(store.directory, "release-notes.md"),
    });
    return Object.freeze({ ...input, kind: "hosted", state: await runtime.report(state, "hosted") });
  }
}

export class MoveFloatingTags implements Step<HostedRelease, HostedRelease> {
  readonly id = "floating-tags";
  async run(input: HostedRelease): Promise<HostedRelease> {
    const { runtime, state } = input;
    const kinds = runtime.config.floatingTags;
    if (!kinds?.length) return input;
    const { repository } = runtime.services;
    if (!repository.floatingTags) throw new Error("Floating tags require a repository that implements floatingTags.");
    const floatingTags = await repository.floatingTags(state.version, state.artifact.commit ?? state.releaseCommit, kinds);
    const updated = snapshot({ ...state, floatingTags });
    await runtime.services.store.save(updated);
    runtime.log(`[npr] floating tags at v${state.version}: ${floatingTags.join(", ") || "none"}`);
    return Object.freeze({ ...input, state: updated });
  }
}

export class PrepareNextVersion implements Step<HostedRelease | PushedRelease, NextRelease> {
  readonly id = "next";
  async run(input: HostedRelease | PushedRelease, execution?: ExecutionContext): Promise<NextRelease> {
    const { runtime, state, release } = input;
    const { project, repository, changelog, validator, store } = runtime.services;
    if (![state.version, state.nextVersion].includes((await project.read()).version)) {
      throw new Error("Refusing to rewind a later development version.");
    }
    const existing = await repository.nextIteration(state.releaseCommit, state.nextVersion);
    let nextCommit: string;
    if (existing) {
      if ((await project.read()).version !== state.nextVersion) throw new Error("Existing development version differs.");
      await project.lockfile(await project.read());
      await validator.validate(runtime.hook("next", execution));
      await repository.unchanged(existing.tree);
      nextCommit = existing.commit;
    } else {
      const nextTree = await repository.stage(async () => {
        const context = runtime.hook("next", execution);
        await runtime.lifecycle?.invoke("next", "before", context, context.execution);
        await project.setVersion(state.nextVersion);
        await updateVersionReferences(runtime, "next", state.nextVersion, execution);
        await changelog?.next({ version: state.nextVersion, releasedVersion: state.version, cwd: runtime.cwd });
        await runtime.config.next?.(runtime.hook("next", execution));
        await runtime.lifecycle?.invoke("next", "after", context, context.execution);
        if ((await project.read()).version !== state.nextVersion) throw new Error("Next hook changed the development version.");
        await project.lockfile(await project.read());
      });
      await validator.validate(runtime.hook("next", execution));
      nextCommit = await repository.commitNext(state.nextVersion, nextTree);
    }
    const updated = snapshot({ ...state, nextCommit, activeStep: this.id });
    await store.save(updated);
    await repository.bundle(join(store.directory, "next.bundle"), state.version);
    await repository.push(nextCommit);
    const next = await runtime.report(updated, "next");
    await project.intact(store.directory, next);
    return Object.freeze({ kind: "next", runtime, release, state: next });
  }
}

export class VerifyRelease implements Step<NextRelease | HostedRelease | PushedRelease, ReleaseState> {
  readonly id = "verify";
  async run({ runtime }: NextRelease | HostedRelease | PushedRelease): Promise<ReleaseState> {
    return verifyRetained(runtime.log, runtime.provider, runtime.services);
  }
}

export async function verifyRetained(
  log: Log, provider: ExecutionProvider, services: ReleaseServices,
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
    const { commit } = state.artifact;
    if (commit !== undefined && (typeof commit !== "string" || !/^[a-f0-9]{40,64}$/u.test(commit))) {
      throw new Error("Invalid retained build commit identity.");
    }
    await services.repository.verifyTag(state.version, commit ?? state.releaseCommit);
    if (state.floatingTags !== undefined) {
      if (!Array.isArray(state.floatingTags) || !services.repository.verifyFloatingTags) {
        throw new Error("Retained floating tags cannot be verified.");
      }
      await services.repository.verifyFloatingTags(state.version, state.floatingTags);
    }
    log(`[npr] verifying: ${state.name}@${state.version}`);
    const registry = state.registry !== false;
    if (registry && !services.verifier) throw new Error("Registry verification requires a verifier.");
    const verification = registry
      ? await services.verifier!.verify({ ...state, artifact: state.artifact }, state.verificationOptions, log)
      : "verified";
    state = snapshot({ ...state, verification, activeStep: undefined });
    await services.store.save(state);
    const message = verification === "verified" ? "verified" : "release could not be verified";
    log(`[npr] ${message}: ${state.name}@${state.version}`);
    await provider.summary(registry
      ? `\n## npm Release Verification\n\n${state.name}@${state.version}: ${message}.\n`
      : `\n## Release Verification\n\n${state.name}@${state.version}: ${message} without a package registry.\n`);
    return state;
  } catch (error) {
    await services.store.save({ ...state, verification: "failed", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
