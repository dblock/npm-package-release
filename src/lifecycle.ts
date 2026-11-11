import type { HookContext, ReleaseConfig, ReleaseOptions, ReleaseState } from "./contracts.js";
import type { ExecutionContext } from "./execution.js";
import type {
  InitializedRelease, PreparedRelease, ValidatedRelease, CommittedRelease, BuiltRelease,
  PublishedRelease, PushedRelease, HostedRelease, NextRelease, ReleaseContext,
} from "./steps.js";
import type { AnalyzedReleaseOptions } from "./semantic-workflow.js";
import type { StepEvent, WorkflowObserver } from "./workflow.js";

export interface LifecycleFailure extends StepEvent {
  readonly error: unknown;
  readonly hook?: LifecycleHookFailure;
  readonly output?: unknown;
}
export interface LifecycleStages {
  readonly analyze: { before: ReleaseOptions; after: AnalyzedReleaseOptions };
  readonly initialize: { before: ReleaseOptions; after: InitializedRelease };
  readonly prepare: { before: HookContext; after: HookContext };
  readonly "semantic-decision": { before: PreparedRelease; after: PreparedRelease };
  readonly validate: { before: PreparedRelease; after: ValidatedRelease };
  readonly commit: { before: ValidatedRelease; after: CommittedRelease };
  readonly build: { before: CommittedRelease; after: BuiltRelease };
  readonly checkpoint: { before: BuiltRelease; after: BuiltRelease };
  readonly restore: { before: ReleaseOptions; after: BuiltRelease };
  readonly publish: { before: BuiltRelease; after: PublishedRelease };
  readonly push: { before: PublishedRelease; after: PushedRelease };
  readonly host: { before: PushedRelease; after: HostedRelease };
  readonly next: { before: HookContext; after: HookContext };
  readonly verify: { before: NextRelease | HostedRelease | PushedRelease; after: ReleaseState };
  readonly success: { before: ReleaseState; after: ReleaseState };
  readonly failure: { before: LifecycleFailure; after: LifecycleFailure };
}
export type LifecycleStage = keyof LifecycleStages;
export type HookTiming = "before" | "after";
export interface LifecycleHookFailure {
  readonly stage: LifecycleStage;
  readonly timing: HookTiming;
  readonly hook: string;
  readonly index: number;
}
export type LifecycleContext<S extends LifecycleStage, T extends HookTiming> =
  S extends LifecycleStage ? T extends HookTiming ? LifecycleHookFailure & {
    readonly stage: S;
    readonly timing: T;
    readonly execution: ExecutionContext;
  } & (S extends "prepare" | "next" ? { readonly context: LifecycleStages[S][T] } :
    T extends "before" ? { readonly input: LifecycleStages[S][T] } : { readonly output: LifecycleStages[S][T] }) : never : never;
export interface LifecycleHook<S extends LifecycleStage, T extends HookTiming> {
  readonly id: string;
  readonly run: (context: LifecycleContext<S, T>) => Promise<void>;
}

const stages: readonly LifecycleStage[] = [
  "analyze", "initialize", "prepare", "semantic-decision", "validate", "commit", "build", "checkpoint",
  "restore", "publish", "push", "host", "next", "verify", "success", "failure",
];
function isStage(stageId: string): stageId is LifecycleStage {
  return stages.some((stage) => stage === stageId);
}
interface Registration {
  readonly stage: LifecycleStage;
  readonly timing: HookTiming;
  readonly id: string;
  readonly run: (context: LifecycleContext<LifecycleStage, HookTiming>) => Promise<void>;
}

export class LifecycleHooks {
  #registrations: readonly Registration[];

  constructor() {
    this.#registrations = [];
  }

  before<S extends LifecycleStage>(stage: S, hook: LifecycleHook<NoInfer<S>, "before">): LifecycleHooks {
    return this.register(stage, "before", hook);
  }

  after<S extends LifecycleStage>(stage: S, hook: LifecycleHook<NoInfer<S>, "after">): LifecycleHooks {
    return this.register(stage, "after", hook);
  }

  private register<S extends LifecycleStage, T extends HookTiming>(stage: S, timing: T, hook: LifecycleHook<S, T>): LifecycleHooks {
    if (!isStage(stage)) throw new Error(`Unknown lifecycle stage: ${stage}`);
    if (!hook || typeof hook.id !== "string" || !hook.id.trim() || typeof hook.run !== "function") {
      throw new Error("A lifecycle hook requires an id and run method.");
    }
    const registration: Registration = Object.freeze({
      stage, timing, id: hook.id,
      run: (context: LifecycleContext<LifecycleStage, HookTiming>) => hook.run(context as LifecycleContext<S, T>),
    });
    const registeredHooks = new LifecycleHooks();
    registeredHooks.#registrations = Object.freeze([...this.#registrations, registration]);
    return registeredHooks;
  }

  async invoke<S extends LifecycleStage, T extends HookTiming>(
    stage: S, timing: T, stageData: LifecycleStages[S][T], execution: ExecutionContext,
    recordFailure: (error: unknown, details: LifecycleHookFailure) => void, releaseRecord?: unknown,
  ): Promise<void> {
    const registrations = this.#registrations.filter((registration) => registration.stage === stage && registration.timing === timing);
    for (const [index, registration] of registrations.entries()) {
      const details = Object.freeze({ stage, timing, hook: registration.id, index: index + 1 });
      const stageFields = stage === "prepare" || stage === "next" ? { context: stageData } :
        timing === "before" ? { input: stageData } : { output: stageData };
      const hookContext = Object.freeze({ ...details, ...stageFields, execution }) as LifecycleContext<LifecycleStage, HookTiming>;
      try {
        await registration.run(hookContext);
        if (stage !== "prepare" && stage !== "next" && stage !== "failure" && isReleaseContext(releaseRecord)) {
          const { runtime, state } = releaseRecord;
          if (state.preparedTree && !state.releaseCommit) await runtime.services.repository.unchanged(state.preparedTree);
          else await runtime.services.repository.clean();
        }
      } catch (error) {
        recordFailure(error, details);
        throw error;
      }
    }
  }
}

function isReleaseContext(record: unknown): record is ReleaseContext<string> {
  return typeof record === "object" && record !== null && "runtime" in record && "state" in record;
}

export const lifecycleInvocation = Symbol("lifecycleInvocation");
type LifecycleOptions = ReleaseOptions & { readonly [lifecycleInvocation]?: LifecycleInvocation };

export function lifecycleFor(options: ReleaseOptions): LifecycleInvocation | undefined {
  return (options as LifecycleOptions)[lifecycleInvocation];
}

export function lifecycleOptions(config: ReleaseConfig, options: ReleaseOptions, notifySuccess = true): ReleaseOptions {
  const observer = options.observer || config.observer;
  const invocation = new LifecycleInvocation(config.hooks || new LifecycleHooks(), observer, notifySuccess);
  return { ...options, [lifecycleInvocation]: invocation, observer: invocation } as LifecycleOptions;
}

export class LifecycleInvocation implements WorkflowObserver {
  private hookFailure?: { readonly error: unknown; readonly details: LifecycleHookFailure };
  private lastStepInput: unknown;
  constructor(private readonly hooks: LifecycleHooks, private readonly observer?: WorkflowObserver,
    private readonly notifySuccess = true) {}

  details(error: unknown): LifecycleHookFailure | undefined {
    return this.hookFailure?.error === error ? this.hookFailure?.details : undefined;
  }

  async invoke<S extends LifecycleStage, T extends HookTiming>(
    stage: S, timing: T, stageData: LifecycleStages[S][T], execution: ExecutionContext, releaseRecord?: unknown,
  ): Promise<void> {
    await this.hooks.invoke(stage, timing, stageData, execution, (error, details) => {
      this.hookFailure ||= { error, details };
    }, releaseRecord);
  }

  private enabled(event: StepEvent): event is StepEvent & { id: Exclude<LifecycleStage, "prepare" | "next"> } {
    return isStage(event.id) && event.id !== "prepare" && event.id !== "next" &&
      !(event.id === "host" && isReleaseContext(event.input) && event.input.runtime.services.host === null);
  }

  async started(event: StepEvent): Promise<void> {
    this.lastStepInput = event.input;
    if (this.enabled(event)) {
      await this.invoke(event.id, "before", event.input as LifecycleStages[typeof event.id]["before"], event.execution, event.input);
    }
    await this.observer?.started?.(event);
  }

  async completed(event: StepEvent & { readonly output: unknown }): Promise<void> {
    if (this.enabled(event)) {
      await this.invoke(event.id, "after", event.output as LifecycleStages[typeof event.id]["after"], event.execution,
        isReleaseContext(event.output) ? event.output : event.input);
    }
    await this.observer?.completed?.(event);
  }

  async succeeded(event: { readonly output: unknown; readonly execution: ExecutionContext }): Promise<void> {
    if (!this.notifySuccess) return;
    const state = event.output as ReleaseState;
    await this.invoke("success", "before", state, event.execution, this.lastStepInput);
    await this.observer?.succeeded?.(event);
    await this.invoke("success", "after", state, event.execution, this.lastStepInput);
  }

  async failed(event: LifecycleFailure): Promise<void> {
    const details = this.details(event.error);
    const failure = Object.freeze({ ...event, ...(details ? { hook: details } : {}) });
    // Every failure reporter gets a chance; none may replace the original exception.
    for (const report of [
      () => this.invoke("failure", "before", failure, event.execution),
      () => this.observer?.failed?.(failure),
      () => this.invoke("failure", "after", failure, event.execution),
    ]) {
      try { await report(); } catch { /* Preserve the original workflow failure. */ }
    }
  }
}
