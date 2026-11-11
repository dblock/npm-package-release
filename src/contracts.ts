import type { ExecutionContext, ExecutionProvider } from "./execution.js";
import type { WorkflowObserver } from "./workflow.js";
import type { SemanticPlan } from "./semantic.js";

export type Environment = Readonly<Record<string, string | undefined>>;

export interface CommandOptions {
  cwd?: string;
  env?: Environment;
  timeout?: number;
}

export type Command = (program: string, args: string[], options?: CommandOptions) => Promise<string>;
export type Log = (message: string) => void;
export interface ReleaseIdentity { readonly name: string; readonly version: string }
export interface Artifact {
  readonly filename: string;
  readonly integrity: string;
  readonly shasum: string;
}
export interface PackageManifest extends ReleaseIdentity {
  repository?: { url?: string };
  private?: boolean;
  workspaces?: unknown;
  publishConfig?: { directory?: string; registry?: string; tag?: string };
}
export interface Lockfile {
  name: string;
  version: string;
  packages?: Record<string, { name?: string; version: string }>;
}
export interface RegistryMetadata extends ReleaseIdentity {
  readonly dist?: { readonly integrity?: string; readonly shasum?: string };
}
export interface VerificationOptions { readonly attempts: number; readonly delay: number }
export type Verification = "verified" | "unverified";
export interface ReleaseState extends ReleaseIdentity {
  readonly semantic?: SemanticPlan;
  readonly previousVersion: string;
  readonly nextVersion: string;
  readonly date: string;
  readonly timezone: string;
  readonly branch: string;
  readonly remote: string;
  readonly initialCommit: string;
  readonly verificationOptions: VerificationOptions;
  readonly phase: string;
  readonly preparedTree?: string;
  readonly releaseCommit?: string;
  readonly artifact?: Artifact;
  readonly nextCommit?: string;
  readonly verification?: Verification | "failed";
  readonly error?: string;
  readonly failedStep?: string;
}
export interface HookContext {
  readonly execution: ExecutionContext;
  readonly cwd: string;
  readonly version: string;
  readonly releasedVersion: string;
  readonly previousVersion: string;
  readonly date: string;
  readonly phase: string;
  readonly run: Command;
}
export interface ArtifactContext extends HookContext {
  readonly archive: string;
  readonly consumer: string;
}
export type ChangelogFormat = "intridea" | "keep-a-changelog";
export interface ReleaseConfig extends Partial<ReleaseServices> {
  readonly observer?: WorkflowObserver;
  readonly provider?: ExecutionProvider;
  readonly branch?: string;
  readonly remote?: string;
  readonly timezone?: string;
  readonly prepare?: (context: HookContext) => Promise<void>;
  readonly next?: (context: HookContext) => Promise<void>;
}
export interface ValidationHooks {
  readonly validate?: (context: HookContext) => Promise<void>;
  readonly validateArtifact?: (context: ArtifactContext) => Promise<void>;
}
export interface ReleaseOptions {
  readonly provider?: ExecutionProvider;
  readonly observer?: WorkflowObserver;
  readonly cwd?: string;
  readonly version?: string;
  readonly artifacts?: string;
  readonly run?: Command;
  readonly log?: Log;
  readonly env?: Environment;
}

export interface ReleaseRepository {
  readonly branch: string;
  readonly remote: string;
  readonly initialCommit: string;
  initialize(): Promise<void>;
  restore(source: RepositoryCheckpoint, bundle: string, version: string): Promise<void>;
  clean(): Promise<void>;
  current(expected: string): Promise<void>;
  missingTag(version: string): Promise<void>;
  stage(edits: () => Promise<void>): Promise<string>;
  unchanged(tree: string): Promise<void>;
  commit(message: string, tree: string): Promise<string>;
  nextIteration(releaseCommit: string, nextVersion: string): Promise<{ readonly commit: string; readonly tree: string } | null>;
  tag(version: string, commit?: string): Promise<void>;
  bundle(path: string, version: string): Promise<void>;
  push(commit: string, version?: string): Promise<void>;
  verifyTag(version: string, commit: string): Promise<void>;
}
export interface RepositoryCheckpoint {
  readonly branch: string;
  readonly remote: string;
  readonly initialCommit: string;
  readonly releaseCommit: string;
  readonly preparedTree: string;
}
export interface PackageProject {
  read(): Promise<PackageManifest>;
  setVersion(version: string): Promise<void>;
  lockfile(manifest: PackageManifest): Promise<Lockfile | null>;
  pack(directory: string, identity: ReleaseIdentity): Promise<Artifact>;
  consumer(archive: string, check: (consumer: string) => Promise<void>): Promise<void>;
  intact(directory: string, state: ReleaseIdentity & { readonly artifact: Artifact }): Promise<void>;
}
export interface PackagePublisher {
  view(name: string, version: string): Promise<RegistryMetadata | null>;
  available(name: string, version: string): Promise<void>;
  publish(archive: string): Promise<void>;
}
export interface Changelog {
  release(identity: { readonly version: string; readonly date: string; readonly cwd?: string }): Promise<string>;
  next(identity: { readonly version: string; readonly releasedVersion: string; readonly cwd?: string }): Promise<void>;
}
export interface VersionPolicy {
  select(current: string, requested?: string): { readonly version: string; readonly nextVersion: string };
}
export interface ReleaseHost {
  create(release: ReleaseIdentity, artifact: { readonly archive: string; readonly notes: string }): Promise<void>;
}
export interface ReleaseValidator {
  validate(context: HookContext): Promise<void>;
  artifact(context: ArtifactContext): Promise<void>;
}
export interface ReleaseStore {
  readonly directory: string;
  initialize(state: ReleaseState): Promise<void>;
  read(): Promise<ReleaseState>;
  save(state: ReleaseState): Promise<void>;
}
export interface RegistryVerifier {
  readonly options?: VerificationOptions;
  verify(state: ReleaseIdentity & { readonly artifact: Artifact },
    options: VerificationOptions, log: Log): Promise<Verification>;
}
export interface ReleaseServices {
  readonly repository: ReleaseRepository;
  readonly project: PackageProject;
  readonly publisher: PackagePublisher;
  readonly changelog: Changelog | null;
  readonly versions: VersionPolicy;
  readonly host: ReleaseHost | null;
  readonly validator: ReleaseValidator;
  readonly store: ReleaseStore;
  readonly verifier: RegistryVerifier;
}
export interface VerifyOptions extends ReleaseOptions {
  readonly services?: Partial<ReleaseServices>;
}
