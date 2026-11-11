import process from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { command } from "./command.js";
import { generatedChangelog } from "./changelog.js";
import { Workflow } from "./workflow.js";
import { prepareRelease, finishRelease } from "./release.js";
import { lifecycleOptions } from "./lifecycle.js";
import { snapshot } from "./services.js";
import { GitHistory, SemanticRelease, SemanticDecision, semanticPlan } from "./semantic.js";
import {
  InitializeRelease, PrepareRelease,
  ReleaseRuntime, ReleaseObserver, scopedCommand,
} from "./steps.js";
import type { Step } from "./workflow.js";
import type { ExecutionContext, ExecutionProvider } from "./execution.js";
import type { SemanticServices } from "./semantic.js";
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
    const head = env.NPR_SOURCE_COMMIT || (await execute("git", ["rev-parse", "HEAD"])).trim();
    const saved = env.NPR_STATE_FILE ? JSON.parse(await readFile(env.NPR_STATE_FILE, "utf8")) : {};
    if (!saved || typeof saved !== "object" || Array.isArray(saved) ||
      Object.keys(saved).some((key) => key !== "analysis")) throw new Error("Invalid invocation analysis state.");
    const analysis = saved.analysis ? new SemanticDecision(saved.analysis) : await new SemanticRelease({
      ...this.config, history: this.config.history || new GitHistory(execute, this.config.remote),
    }).analyze(head, options.version || null);
    analysis.check(head, analysis.version, options.version?.trim() || null);
    if (!analysis.releasable) throw new Error("Nothing to release: no release-eligible commits.");
    return Object.freeze({ ...options, analysis });
  }
}

export class GeneratedChangelog implements Changelog {
  constructor(readonly decision: SemanticDecision, readonly path = "CHANGELOG.md") {}
  async release({ version, date, cwd }: { version: string; date: string; cwd?: string }): Promise<string> {
    this.decision.check(this.decision.head, version);
    if (!this.decision.notes) throw new Error("Semantic release notes are missing.");
    const path = resolve(cwd || ".", this.path);
    let source = "# Changelog\n";
    try { source = await readFile(path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const updated = generatedChangelog(source, { version, date, notes: this.decision.notes });
    if (updated !== source) await writeFile(path, updated);
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
    analysis.check(env.NPR_SOURCE_COMMIT || (await execute("git", ["rev-parse", "HEAD"])).trim(),
      analysis.version, options.version?.trim() || null);
    const config: ReleaseConfig = {
      ...this.config, changelog: this.config.changelog === undefined ? new GeneratedChangelog(analysis) : this.config.changelog,
    };
    const input = await new InitializeRelease(config).run({ ...options, version: analysis.version! }, execution, provider);
    analysis.check(input.state.initialCommit, input.state.version);
    const state = snapshot({
      ...input.state, semantic: semanticPlan({ decision: analysis, nextDevelopment: this.config.nextDevelopment ?? false }),
    });
    const runtime = new ReleaseRuntime(config, input.runtime.cwd, input.runtime.run, input.runtime.log,
      input.runtime.env, input.runtime.services, state, input.runtime.provider, input.runtime.lifecycle);
    await runtime.services.store.save(state);
    if (runtime.env.NPR_STATE_FILE) await writeFile(runtime.env.NPR_STATE_FILE, JSON.stringify({ analysis }), { mode: 0o600 });
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

export class SemanticReleaseWorkflow implements Step<ReleaseOptions, ReleaseState> {
  readonly id = "npm-semantic-release";
  readonly config: SemanticReleaseConfig;
  readonly preparation: Workflow<ReleaseOptions, BuiltRelease>;
  readonly workflow: Workflow<ReleaseOptions, ReleaseState>;

  constructor(config: SemanticReleaseConfig = {}) {
    config = Object.freeze({ ...config });
    this.config = config;
    const nextDevelopment = config.nextDevelopment ?? false;
    this.preparation = prepareRelease(Workflow.start<ReleaseOptions>(new ReleaseObserver(), config.provider)
      .then(new AnalyzeSemanticRelease(config))
      .then(new InitializeSemanticRelease(config))
      .then(new PrepareRelease())
      .then(new ValidateSemanticDecision()));
    this.workflow = finishRelease(this.preparation, nextDevelopment);
  }

  async run(options: ReleaseOptions = {}, execution?: ExecutionContext, provider?: ExecutionProvider): Promise<ReleaseState> {
    return this.workflow.run(lifecycleOptions(this.config, options), execution, provider);
  }
  async prepare(options: ReleaseOptions = {}): Promise<BuiltRelease> {
    return this.preparation.run(lifecycleOptions(this.config, options, false));
  }
}
