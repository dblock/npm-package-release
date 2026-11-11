import process from "node:process";
import { command } from "./command.js";
import { Workflow } from "./workflow.js";
import { checkpointRelease, finishRelease, preparationObserver } from "./release.js";
import { snapshot } from "./services.js";
import { GitHistory, SemanticRelease, semanticPlan } from "./semantic.js";
import {
  InitializeRelease, PrepareRelease,
  RestoreRelease, ReleaseRuntime, ReleaseObserver, scopedCommand,
} from "./steps.js";
import type { Step } from "./workflow.js";
import type { CheckpointWorkflow } from "./release.js";
import type { ExecutionContext, ExecutionProvider } from "./execution.js";
import type { SemanticDecision, SemanticServices } from "./semantic.js";
import type { Changelog, ReleaseConfig, ReleaseOptions, ReleaseState } from "./contracts.js";
import type { BuiltRelease, InitializedRelease, PreparedRelease } from "./steps.js";

export interface SemanticReleaseConfig extends Omit<ReleaseConfig, "changelog">, Partial<SemanticServices> {
  readonly changelog?: Changelog | null;
  readonly nextDevelopment?: boolean;
}
export interface AnalyzedReleaseOptions extends ReleaseOptions {
  readonly analysis: SemanticDecision;
}

export class AnalyzeSemanticRelease implements Step<ReleaseOptions, AnalyzedReleaseOptions> {
  readonly id = "analyze";
  constructor(readonly config: SemanticReleaseConfig = {}) {}
  async run(options: ReleaseOptions): Promise<AnalyzedReleaseOptions> {
    if (this.config.nextDevelopment !== undefined && typeof this.config.nextDevelopment !== "boolean") {
      throw new Error("nextDevelopment must be a boolean.");
    }
    const { cwd = process.cwd(), run = command, env = process.env } = options;
    const execute = scopedCommand(cwd, run, this.config.timezone || "UTC", "analyze", env);
    const head = (await execute("git", ["rev-parse", "HEAD"])).trim();
    const analysis = await new SemanticRelease({
      ...this.config, history: this.config.history || new GitHistory(execute, this.config.remote),
    }).analyze(head, options.version || null);
    if (!analysis.releasable) throw new Error("Nothing to release: no release-eligible commits.");
    return Object.freeze({ ...options, analysis });
  }
}

export class GeneratedChangelog implements Changelog {
  constructor(readonly decision: SemanticDecision) {}
  async release({ version }: { version: string; date: string }): Promise<string> {
    this.decision.check(this.decision.head, version);
    if (!this.decision.notes) throw new Error("Semantic release notes are missing.");
    return this.decision.notes;
  }
  async next(): Promise<void> {}
}

export class InitializeSemanticRelease implements Step<AnalyzedReleaseOptions, InitializedRelease> {
  readonly id = "initialize";
  constructor(readonly config: SemanticReleaseConfig = {}) {}
  async run(options: AnalyzedReleaseOptions, execution?: ExecutionContext, provider?: ExecutionProvider): Promise<InitializedRelease> {
    const { analysis } = options;
    if (!analysis.releasable) throw new Error("Nothing to release: no release-eligible commits.");
    const { cwd = process.cwd(), run = command, env = process.env } = options;
    const execute = scopedCommand(cwd, run, this.config.timezone || "UTC", "analyze", env);
    analysis.check((await execute("git", ["rev-parse", "HEAD"])).trim(), analysis.version, options.version?.trim() || null);
    const config: ReleaseConfig = {
      ...this.config, changelog: this.config.changelog === undefined ? new GeneratedChangelog(analysis) : this.config.changelog,
    };
    const input = await new InitializeRelease(config).run({ ...options, version: analysis.version! }, execution, provider);
    analysis.check(input.state.initialCommit, input.state.version);
    const state = snapshot({
      ...input.state, semantic: semanticPlan({ decision: analysis, nextDevelopment: this.config.nextDevelopment ?? false }),
    });
    const runtime = new ReleaseRuntime(config, input.runtime.cwd, input.runtime.run, input.runtime.log,
      input.runtime.env, input.runtime.services, state, input.runtime.provider);
    await runtime.services.store.save(state);
    return Object.freeze({ ...input, state, runtime });
  }
}

export class ValidateSemanticDecision implements Step<PreparedRelease, PreparedRelease> {
  readonly id = "semantic-decision";
  async run(input: PreparedRelease): Promise<PreparedRelease> {
    const decision = input.state.semantic?.decision;
    if (!decision) throw new Error("Semantic decision is missing.");
    decision.check(input.state.initialCommit, input.release.version);
    if (input.notes !== decision.notes) throw new Error("Prepared notes differ from semantic decision.");
    return input;
  }
}

export class SemanticReleaseWorkflow implements Step<ReleaseOptions, ReleaseState>, CheckpointWorkflow<BuiltRelease, ReleaseState> {
  readonly id = "npm-semantic-release";
  readonly config: SemanticReleaseConfig;
  readonly preparation: Workflow<ReleaseOptions, BuiltRelease>;
  readonly completion: Workflow<ReleaseOptions, ReleaseState>;
  readonly workflow: Workflow<ReleaseOptions, ReleaseState>;

  constructor(config: SemanticReleaseConfig = {}) {
    config = Object.freeze({ ...config });
    this.config = config;
    const nextDevelopment = config.nextDevelopment ?? false;
    this.preparation = checkpointRelease(Workflow.start<ReleaseOptions>(new ReleaseObserver(), config.provider)
      .then(new AnalyzeSemanticRelease(config))
      .then(new InitializeSemanticRelease(config))
      .then(new PrepareRelease())
      .then(new ValidateSemanticDecision()));
    this.workflow = finishRelease(this.preparation, nextDevelopment);
    this.completion = finishRelease(Workflow.start<ReleaseOptions>(new ReleaseObserver(), config.provider)
      .then(new RestoreRelease({ ...config, changelog: null }, { nextDevelopment })), nextDevelopment);
  }

  async run(options: ReleaseOptions = {}, execution?: ExecutionContext, provider?: ExecutionProvider): Promise<ReleaseState> {
    return this.workflow.run({ ...options, observer: options.observer || this.config.observer }, execution, provider);
  }
  async prepare(options: ReleaseOptions = {}): Promise<BuiltRelease> {
    return this.preparation.run({ ...options, observer: preparationObserver(options.observer || this.config.observer) });
  }
  async complete(options: ReleaseOptions = {}): Promise<ReleaseState> {
    return this.completion.run({ ...options, observer: options.observer || this.config.observer });
  }
}
