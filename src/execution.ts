import { writeFile } from "node:fs/promises";
import process from "node:process";
import type { Environment } from "./contracts.js";
import { Release } from "./release-description.js";

export type StepOutcome = "success" | "failure" | "cancelled" | "skipped";
export interface ExecutionStep {
  readonly id: string;
  readonly outcome?: StepOutcome;
  readonly conclusion?: StepOutcome;
}
export type StepHistory = Readonly<Record<string, ExecutionStep>>;
export interface ExecutionRun {
  readonly id?: string;
  readonly attempt?: string;
  readonly url?: string;
  readonly repository?: string;
  readonly workflow?: string;
  readonly event?: string;
  readonly ref?: string;
  readonly commit?: string;
}
export interface WorkflowDescription {
  readonly id: string;
  readonly steps: readonly string[];
}
export interface ExecutionAttributes {
  readonly release?: Release | null;
  readonly step: ExecutionStep;
  readonly steps: StepHistory;
  readonly workflow: WorkflowDescription;
}

function stepSnapshot(step: ExecutionStep): ExecutionStep {
  if (typeof step.id !== "string" || !step.id.trim()) throw new Error("Expected an execution step identifier.");
  for (const status of [step.outcome, step.conclusion]) {
    if (status !== undefined && !["success", "failure", "cancelled", "skipped"].includes(status)) {
      throw new Error("Invalid execution step status.");
    }
  }
  return Object.freeze({ id: step.id, outcome: step.outcome, conclusion: step.conclusion });
}

export class ExecutionContext {
  readonly provider: string;
  readonly release: Release | null;
  readonly step: ExecutionStep;
  readonly steps: StepHistory;
  readonly workflow: WorkflowDescription;
  readonly run: ExecutionRun | null;

  constructor(provider: string, attributes: ExecutionAttributes, run: ExecutionRun | null = null) {
    if (attributes.release != null && !(attributes.release instanceof Release)) throw new Error("Expected an immutable Release.");
    if (run !== null && Object.values({
      id: run.id, attempt: run.attempt, url: run.url, repository: run.repository,
      workflow: run.workflow, event: run.event, ref: run.ref, commit: run.commit,
    }).some((value) => value !== undefined && typeof value !== "string")) throw new Error("Invalid execution run metadata.");
    this.provider = provider;
    this.release = attributes.release || null;
    this.step = stepSnapshot(attributes.step);
    this.steps = Object.freeze(Object.fromEntries(Object.entries(attributes.steps)
      .map(([id, step]) => [id, stepSnapshot({ ...step, id })])));
    this.workflow = Object.freeze({ id: attributes.workflow.id, steps: Object.freeze([...attributes.workflow.steps]) });
    this.run = run === null ? null : Object.freeze({
      id: run.id, attempt: run.attempt, url: run.url, repository: run.repository,
      workflow: run.workflow, event: run.event, ref: run.ref, commit: run.commit,
    });
    Object.freeze(this);
  }

  withRelease(release: Release): ExecutionContext {
    return new ExecutionContext(this.provider, { ...this, release }, this.run);
  }
}

export interface ExecutionProvider {
  readonly name: string;
  readonly defaultBranch?: string;
  readonly timezone?: string;
  context(attributes: ExecutionAttributes): ExecutionContext;
  validateReleaseBranch(branch: string): void;
  summary(message: string): Promise<void>;
}

export class LocalExecutionProvider implements ExecutionProvider {
  readonly name: string = "local";
  readonly #environment: Environment;

  constructor(environment: Environment = process.env) {
    this.#environment = Object.freeze({ ...environment });
  }

  protected value(name: string): string | undefined { return this.#environment[name]; }
  protected runMetadata(): ExecutionRun | null { return null; }
  protected observedSteps(): StepHistory { return {}; }
  get defaultBranch(): string | undefined { return this.value("NPR_DEFAULT_BRANCH"); }
  get timezone(): string | undefined { return this.value("NPR_TIMEZONE"); }

  context(attributes: ExecutionAttributes): ExecutionContext {
    return new ExecutionContext(this.name, {
      ...attributes, steps: { ...this.observedSteps(), ...attributes.steps },
    }, this.runMetadata());
  }

  validateReleaseBranch(branch: string): void {
    if (!branch.trim()) throw new Error("Expected a release branch.");
  }

  readonly summary: (message: string) => Promise<void> = async () => {};
}

export class GitHubExecutionProvider extends LocalExecutionProvider {
  override readonly name: string = "github";
  readonly #steps: StepHistory;

  constructor(environment: Environment = process.env, observedSteps: StepHistory = {}) {
    super(environment);
    this.#steps = new ExecutionContext(this.name, {
      step: { id: "capture" }, steps: observedSteps, workflow: { id: "capture", steps: [] },
    }).steps;
  }

  protected override observedSteps(): StepHistory { return this.#steps; }

  protected override runMetadata(): ExecutionRun {
    const repository = this.value("GITHUB_REPOSITORY");
    const id = this.value("GITHUB_RUN_ID");
    const server = this.value("GITHUB_SERVER_URL");
    return {
      id, repository, attempt: this.value("GITHUB_RUN_ATTEMPT"),
      url: server && repository && id ? `${server}/${repository}/actions/runs/${id}` : undefined,
      workflow: this.value("GITHUB_WORKFLOW"), event: this.value("GITHUB_EVENT_NAME"),
      ref: this.value("GITHUB_REF"), commit: this.value("GITHUB_SHA"),
    };
  }

  override validateReleaseBranch(branch: string): void {
    super.validateReleaseBranch(branch);
    if (this.value("GITHUB_EVENT_NAME") !== "workflow_dispatch" || this.value("GITHUB_REF") !== `refs/heads/${branch}`) {
      throw new Error("Actions publication requires manual dispatch from the default branch.");
    }
  }

  override readonly summary = async (message: string): Promise<void> => {
    const path = this.value("GITHUB_STEP_SUMMARY");
    if (path) await writeFile(path, message, { flag: "a" });
  };
}

export function currentExecutionProvider(environment: Environment = process.env): ExecutionProvider {
  return environment.GITHUB_ACTIONS === "true" ? new GitHubExecutionProvider(environment) : new LocalExecutionProvider(environment);
}
