# Execution Providers and Contexts

## Release Data Versus Execution

`Release` is immutable domain data: `name`, selected `version`, captured `manifestVersion`, `date`, optional `nextVersion`, and optional `notes`. `withVersion`, `withNextVersion`, and `withNotes` return new instances without changing the original. The manifest version is not a claim about the last published release. Existing `ReleaseState.previousVersion` and hook fields remain compatible.

Built-in lifecycle records expose this value as `input.release`. Domain services receive release data, not platform contexts. A step may additionally accept `run(input, execution, provider)`; the runner supplies an immutable `ExecutionContext` and a separate `ExecutionProvider` client. Existing one-argument classes continue working. Legacy hooks receive `context.execution`; `context.run` remains the command executor, while `context.execution.run` is descriptive run metadata.

| Execution Field | Meaning |
| --- | --- |
| `provider` | Provider name, not a platform client. |
| `release` | Immutable `Release`, or `null` before successful initialization. |
| `step` | Current logical step ID and any observed outcome/conclusion. |
| `steps` | Frozen snapshots of observed prior/completed steps, keyed by ID. |
| `workflow` | Frozen workflow ID and configured step identifiers. |
| `run` | Allowlisted platform run metadata, or `null` locally. |

`outcome` and `conclusion` remain separate. A GitHub step can fail before error handling yet conclude successfully. Missing steps are unknown, not fabricated as skipped; a running step has no final status. Each observation is a new snapshot, so later execution cannot change a callback's earlier history. Reusing the same workflow starts a fresh history. Nested workflows inherit provider services and enclosing observations.

Execution snapshots do not contain environment variables, credentials, provider instances, or raw event payloads. GitHub run metadata contains only ID, attempt, URL, repository, workflow name, event name, ref, and commit. Do not serialize entire step events or lifecycle records: their trusted `input`/`runtime` can include command environments and service clients.

## Select or Implement a Provider

The default selects `GitHubExecutionProvider` only when the scoped environment has `GITHUB_ACTIONS=true`; otherwise it selects `LocalExecutionProvider`. Detection uses the supplied `env`, not unconditionally the parent process. Both providers copy their input environment without mutating it.

An explicit provider takes precedence. Pass it as `new ReleaseWorkflow(config, services, provider)`, `Workflow.start(observer, provider)`, or a per-run `provider` option. Per-run selection overrides the configured provider. Standalone `verify({ provider })` uses that provider for summaries too.

`ExecutionProvider` defines `name`, optional `defaultBranch`/`timezone`, `context(attributes)`, `validateReleaseBranch(branch)`, and `summary(message)`. Classes may implement the interface directly or extend `LocalExecutionProvider`. The local implementation supplies neutral snapshots and no summary side effects. GitHub adds metadata, manual-dispatch/ref validation, and scoped job-summary writing. It may also receive already observed step snapshots as its second constructor argument; those preserve outcome/conclusion separately.

Default GitHub publication still requires manual dispatch on the configured branch. Selecting a custom provider explicitly transfers execution-policy responsibility to that implementation; it does not change repository protections, grant permissions, or configure authentication. Registry publication and release hosting remain independent services. npm continues to handle its native authentication; this does not add a RubyGems-style token exchange.

## Class-based Notifications

Configure an observer class in `npr.config.js` without replacing the built-in release steps:

```js
import console from "node:console";
import { ReleaseWorkflow } from "npm-package-release";

class ReleaseNotifications {
  async succeeded({ execution }) {
    console.log(`Released ${execution.release.name}@${execution.release.version}`);
  }

  async failed({ id, execution, error }) {
    console.error(`Release stopped at ${id}: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`Provider: ${execution.provider}`);
  }
}

export default new ReleaseWorkflow({
  changelog: { format: "intridea" },
  observer: new ReleaseNotifications(),
});
```

Observers implement `WorkflowObserver`; all methods are optional. `started` runs before a step; `completed` receives its output and successful observation; `failed` receives the original thrown value and a failed observation. `succeeded` runs once after that workflow completes, including an explicitly unverified registry-visibility timeout. It does not mean every external service is immediately consistent.

Initialization failures reach `failed` with `execution.release === null`, even when no recovery directory exists yet. The default failure reporter remains installed alongside configuration/per-run observers. If one failure reporter throws, the others are still attempted and the original workflow exception wins.

A `succeeded` callback failure is reported as `workflow:success` and fails the invocation without republishing. It does not retroactively invalidate verified registry metadata. Notifications are not exactly-once deliveries; custom receivers need their own stable release key or confirmation. The runner does not retry them.

## Current Limits and Next Work

New release starts still reject existing package versions, tags, and artifact directories. Explicit checkpoint completion now reconciles matching outputs, and Actions preserves the immutable checkpoint before publication. See [Checkpoints and Reconciliation](checkpoints.md) for the prepare/upload/complete contract and its limits.

Opt-in semantic selection remains the next gap relative to [ruby-gem-release 0.5.0](https://github.com/dblock/ruby-gem-release/releases/tag/v0.5.0). Completion reconciles archive checksums, Git trees/refs, and hosted outputs—not permission inferred from a completion journal. No successful-skip protocol, semantic workflow, new registry, or live authentication setup is introduced here.
