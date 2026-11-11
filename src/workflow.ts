import { currentExecutionProvider } from "./execution.js";
import type { ExecutionContext } from "./execution.js";
import type { ExecutionProvider, ExecutionStep, WorkflowDescription } from "./execution.js";
import type { Environment } from "./contracts.js";
import { Release } from "./release-description.js";
import type { LifecycleFailure } from "./lifecycle.js";

export interface Step<Input, Output> {
  readonly id: string;
  readonly run: (input: Input, execution?: ExecutionContext, provider?: ExecutionProvider) => Promise<Output>;
}

export interface StepEvent {
  readonly id: string;
  readonly input: unknown;
  readonly execution: ExecutionContext;
}

export interface WorkflowObserver {
  started?(event: StepEvent): Promise<void>;
  completed?(event: StepEvent & { readonly output: unknown }): Promise<void>;
  failed?(event: LifecycleFailure): Promise<void>;
  succeeded?(event: { readonly output: unknown; readonly execution: ExecutionContext }): Promise<void>;
}

export interface WorkflowRunOptions {
  readonly provider?: ExecutionProvider;
  readonly observer?: WorkflowObserver;
  readonly env?: Environment;
}

function releaseFrom(input: unknown): Release | null {
  return typeof input === "object" && input !== null && "release" in input && input.release instanceof Release ? input.release : null;
}

class Invocation {
  readonly history: Record<string, ExecutionStep> = Object.create(null);
  lastInput: unknown;
  lastRelease: Release | null = null;
  constructor(readonly provider: ExecutionProvider, readonly observer: WorkflowObserver,
    readonly workflow: WorkflowDescription, parent?: ExecutionContext) {
    Object.assign(this.history, parent?.steps);
    this.lastRelease = parent?.release || null;
  }

  context(id: string, input: unknown, outcome?: "success" | "failure"): ExecutionContext {
    const step: ExecutionStep = { id, outcome, conclusion: outcome };
    if (outcome) this.history[id] = step;
    this.lastRelease = releaseFrom(input) || this.lastRelease;
    return this.provider.context({ release: this.lastRelease, step, steps: this.history, workflow: this.workflow });
  }

  async failed(event: LifecycleFailure): Promise<void> {
    try { await this.observer.failed?.(event); } catch { /* Preserve the original workflow failure. */ }
  }
}

function observers(first: WorkflowObserver, second?: WorkflowObserver): WorkflowObserver {
  if (!second) return first;
  return {
    async started(event) { await first.started?.(event); await second.started?.(event); },
    async completed(event) { await first.completed?.(event); await second.completed?.(event); },
    async succeeded(event) { await first.succeeded?.(event); await second.succeeded?.(event); },
    async failed(event) {
      const failures: unknown[] = [];
      for (const observer of [first, second]) {
        try { await observer.failed?.(event); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "Failure observers failed.");
    },
  };
}

export class Workflow<Input, Output = Input> implements Step<Input, Output> {
  readonly id = "workflow";
  readonly steps: readonly string[];

  private constructor(
    private readonly execute: (input: Input, invocation: Invocation) => Promise<Output>,
    steps: readonly string[],
    private readonly observer: WorkflowObserver,
    private readonly provider?: ExecutionProvider,
  ) {
    this.steps = Object.freeze([...steps]);
  }

  static start<Input>(observer: WorkflowObserver = {}, provider?: ExecutionProvider): Workflow<Input> {
    return new Workflow(async (input) => input, [], observer, provider);
  }

  then<Next>(step: Step<Output, Next>): Workflow<Input, Next> {
    if (!step.id?.trim() || typeof step.run !== "function") throw new Error("A workflow step requires an id and run method.");
    if (this.steps.includes(step.id)) throw new Error(`Duplicate workflow step: ${step.id}`);
    return new Workflow(async (input, invocation) => {
      const current = await this.execute(input, invocation);
      invocation.lastInput = current;
      const event = { id: step.id, input: current, execution: invocation.context(step.id, current) };
      let output: unknown;
      try {
        await invocation.observer.started?.(event);
        const result = await step.run(current, event.execution, invocation.provider);
        output = result;
        const execution = invocation.context(step.id, result, "success");
        await invocation.observer.completed?.({ ...event, output: result, execution });
        return result;
      } catch (error) {
        await invocation.failed({ ...event, error, output, execution: invocation.context(step.id, output ?? current, "failure") });
        throw error;
      }
    }, [...this.steps, step.id], this.observer, this.provider);
  }

  async run(input: Input, parent?: ExecutionContext, provider?: ExecutionProvider): Promise<Output> {
    const supplied = typeof input === "object" && input !== null ? input as WorkflowRunOptions : {};
    const invocation = new Invocation(supplied.provider || this.provider || provider || currentExecutionProvider(supplied.env),
      observers(this.observer, supplied.observer), { id: this.id, steps: this.steps }, parent);
    const output = await this.execute(input, invocation);
    try {
      await invocation.observer.succeeded?.({ output, execution: invocation.context("workflow:success", output, "success") });
    } catch (error) {
      await invocation.failed({
        id: "workflow:success", input: invocation.lastInput, error,
        execution: invocation.context("workflow:success", output, "failure"),
      });
      throw error;
    }
    return output;
  }
}
