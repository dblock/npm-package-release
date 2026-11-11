# Lifecycle Hooks

Both `ReleaseWorkflow` and `SemanticReleaseWorkflow` accept an immutable `LifecycleHooks` instance. Add ordered behavior without replacing the release sequence or its service classes:

```js
import { LifecycleHooks, ReleaseWorkflow } from "npm-package-release";

class UpdateReadme {
  id = "update-readme";

  async run({ context }) {
    await context.run("node", ["scripts/update-readme.js", context.version]);
  }
}

export default new ReleaseWorkflow({
  hooks: new LifecycleHooks()
    .after("prepare", new UpdateReadme())
    .after("next", new UpdateReadme()),
});
```

Registration returns a new registry; keep the returned value. Before hooks run in registration order, then the built-in operation, then after hooks in registration order if it succeeded. Hooks extend operations; they do not replace validation, version selection, publication, or observers.

## Context and Types

Each hook class supplies a nonempty `id` and an asynchronous `run(hookContext)` method. Hook contexts are frozen and contain `stage`, `timing`, `hook` (the registered ID), one-based `index` within that stage/timing, and `execution`. The stage data is exposed through a strongly typed `input`, `output`, or preparation `context` property, not a generic payload field. `execution` is the immutable [execution context](execution.md); its release is `null` before capture. Semantic analysis is available as `output.analysis` after `analyze`, and as `input.state.semantic` or `output.state.semantic` on subsequent release records.

```ts
import type { LifecycleContext, LifecycleHook } from "npm-package-release";

class InspectArchive implements LifecycleHook<"build", "after"> {
  readonly id = "inspect-archive";

  async run({ output }: LifecycleContext<"build", "after">): Promise<void> {
    output.runtime.log(output.state.artifact.integrity);
  }
}
```

Before hooks normally receive a step's `input` record; after hooks receive its `output`. `prepare` and `next` instead receive the existing command-capable `HookContext` as `context` at both timings, because edits must finish before the Git tree is captured. After `prepare`, release notes are available through `execution.release.notes`. Next hooks see the development version as `context.version`, the published version as `context.releasedVersion`, and an empty `PACKAGE_ARCHIVE` in command environments. Only the property appropriate to the stage and timing exists.

## Stages and Order

| Invocation | Stages |
| --- | --- |
| Numeric preparation | `initialize` → `prepare` → `validate` → `commit` → `build` → `checkpoint`. |
| Semantic preparation | `analyze` → `initialize` → `prepare` → `semantic-decision` → `validate` → `commit` → `build` → `checkpoint`. |
| Completion | `restore` → `publish` → `push` → `host` → `next` → `verify` → `success`. |
| Local `run` | Preparation followed by publication through success, without a separate `restore`. |
| Failure | `failure`, after the built-in diagnostic reporter. |

`build` includes strict installed-consumer checks, tagging, and the recovery bundle. `next` hooks surround only development-file preparation, not its later validation, commit, or push. Host hooks are skipped when `host: null`. Next hooks are skipped when semantic development preparation is disabled or completion reuses an existing development commit. Analysis and preparation hooks never run during checkpoint completion.

Preparation does not emit success hooks or whole-release success notifications. Success hooks surround the selected observer's `succeeded` callback, after registry verification; an unverified visibility timeout retains its existing nonfatal behavior. Failure hooks surround the selected observer's `failed` callback. Failure reporters are all attempted even if another reporter throws, and cannot replace the original release error.

## Edits, Failures, and Recovery

Only `prepare` and `next` hooks may edit project files. Both timings run inside the same trusted `repository.stage` boundary as version/changelog updates and the existing prepare/next callback. Before hooks precede built-in edits; after hooks follow those edits and the callback. Version and lockfile checks run afterward, and all successful edits are captured in the same commit.

Other stage hooks validate or observe. Once a repository context is available, working-tree/index checks reject edits from these hooks rather than staging them. Hooks are trusted project code, not a sandbox; custom services retain responsibility for their contracts.

A failed hook stops later hooks and the release. Partial file edits remain for inspection; no rollback occurs. The original thrown value is preserved, including frozen exceptions. Failure observers receive `event.hook` with the stage, timing, hook ID, and index; the same details are saved as `failedHook` in `release.json` when release state exists. Built-in failures have no hook metadata.

Hooks may run again on retry, including publication hooks around an already-published artifact or success notifications after repeated completion. Make external effects idempotent. Hook registrations are trusted executable configuration, not checkpoint data; each process must load the same configuration. Hooks do not authorize rebuilding, republishing, moving tags, or bypassing [checkpoint reconciliation](checkpoints.md).

Custom composed workflows can still add typed [steps](workflows.md) and their own observers. Lifecycle registration applies to the two standard workflow classes, not arbitrary step identifiers.
