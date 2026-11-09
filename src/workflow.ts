export interface Step<Input, Output> {
  readonly id: string;
  readonly run: (input: Input) => Promise<Output>;
}

export interface StepEvent {
  readonly id: string;
  readonly input: unknown;
}

export interface WorkflowObserver {
  started?(event: StepEvent): Promise<void>;
  completed?(event: StepEvent & { readonly output: unknown }): Promise<void>;
  failed?(event: StepEvent & { readonly error: unknown }): Promise<void>;
}

export class Workflow<Input, Output = Input> implements Step<Input, Output> {
  readonly id = "workflow";
  readonly steps: readonly string[];

  private constructor(
    private readonly execute: (input: Input, observer: WorkflowObserver) => Promise<Output>,
    steps: readonly string[],
    private readonly observer: WorkflowObserver,
  ) {
    this.steps = Object.freeze([...steps]);
  }

  static start<Input>(observer: WorkflowObserver = {}): Workflow<Input> {
    return new Workflow(async (input) => input, [], observer);
  }

  then<Next>(step: Step<Output, Next>): Workflow<Input, Next> {
    if (!step.id?.trim() || typeof step.run !== "function") throw new Error("A workflow step requires an id and run method.");
    if (this.steps.includes(step.id)) throw new Error(`Duplicate workflow step: ${step.id}`);
    return new Workflow(async (input, observer) => {
      const current = await this.execute(input, observer);
      const event = { id: step.id, input: current };
      try {
        await observer.started?.(event);
        const output = await step.run(current);
        await observer.completed?.({ ...event, output });
        return output;
      } catch (error) {
        // A reporting failure must not hide the original step failure.
        await observer.failed?.({ ...event, error }).catch(() => {});
        throw error;
      }
    }, [...this.steps, step.id], this.observer);
  }

  async run(input: Input): Promise<Output> {
    return this.execute(input, this.observer);
  }
}
