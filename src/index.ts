import metadata from "../package.json" with { type: "json" };

export const version = metadata.version;
export { release, verify, prepare } from "./release.js";
export { releaseChangelog, nextChangelog } from "./changelog.js";
export type { ChangelogTemplate } from "./changelog.js";
export { MarkdownSection } from "./markdown.js";
export type * from "./contracts.js";
export { Workflow } from "./workflow.js";
export { LifecycleHooks } from "./lifecycle.js";
export type {
  LifecycleHook, LifecycleContext, LifecycleStages, LifecycleStage, HookTiming, LifecycleHookFailure, LifecycleFailure,
} from "./lifecycle.js";
export type { Step, StepEvent, WorkflowObserver, WorkflowRunOptions } from "./workflow.js";
export { Release } from "./release-description.js";
export type { ReleaseDescription } from "./release-description.js";
export { ExecutionContext, LocalExecutionProvider, GitHubExecutionProvider, currentExecutionProvider } from "./execution.js";
export type {
  ExecutionProvider, ExecutionAttributes, ExecutionStep, StepHistory, StepOutcome, ExecutionRun, WorkflowDescription,
} from "./execution.js";
export { Git } from "./git.js";
export { NpmPackage } from "./package.js";
export {
  NumericPatchVersions, MarkdownChangelog, KeepAChangelog, IntrideaChangelog,
  GitHubReleaseHost, HookValidator, DirectoryReleaseStore, RegistryVisibility,
} from "./services.js";
export {
  InitializeRelease, PrepareRelease, ValidateRelease, CommitRelease, BuildArtifact, PublishArtifact,
  PushRelease, CreateHostedRelease, PrepareNextVersion, VerifyRelease, ReleaseRuntime, ReleaseObserver,
} from "./steps.js";
export type {
  ReleaseContext, InitializedRelease, PreparedRelease, ValidatedRelease, CommittedRelease, BuiltRelease,
  PublishedRelease, PushedRelease, HostedRelease, NextRelease,
} from "./steps.js";
export { ReleaseWorkflow } from "./release.js";
export {
  SemanticRelease, SemanticDecision, GitHistory, ConventionalCommits, SemanticVersionSelector, GeneratedReleaseNotes,
} from "./semantic.js";
export type {
  ReleaseType, SemanticCommit, SemanticTag, SemanticHistoryData, SemanticHistory, CommitAnalyzer, SemanticSelection,
  SemanticVersionPolicy, SemanticNotes, SemanticServices, SemanticDecisionData, SemanticPlan, ParsedCommit, ReleaseRule,
} from "./semantic.js";
export {
  SemanticReleaseWorkflow, AnalyzeSemanticRelease, InitializeSemanticRelease, GeneratedChangelog, ValidateSemanticDecision,
} from "./semantic-workflow.js";
export type { SemanticReleaseConfig, AnalyzedReleaseOptions } from "./semantic-workflow.js";
