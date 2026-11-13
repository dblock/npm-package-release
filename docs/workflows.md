# Composable Workflows

## Classes and Contracts

The workflow is application code, not a fixed sequence with additional callbacks. Implement classes against public TypeScript interfaces, pass service instances to the built-in steps, and compose steps with `Workflow.start<Input>().then(step)`. All runtime exports and types come from `npm-package-release`. The package ships compiled ESM JavaScript and declarations; JavaScript callers do not need TypeScript.

`Step<Input, Output>` requires a stable, nonempty `id` and `run(input, execution?, provider?): Promise<Output>`. Existing one-argument methods remain valid. The optional second argument is an immutable execution snapshot; the third is the execution-provider client, kept separate from snapshot data. A workflow implements the same interface and can itself be composed as a step. Each `then` returns a new reusable workflow without modifying its parent. Duplicate step identifiers fail at construction. The builder checks adjacent input/output compatibility at compile time without an untyped shared data bag.

Built-in records distinguish initialized, prepared, validated, committed, built, published, pushed, hosted, and next-development releases. Publishing requires `BuiltRelease`, not an initialized or merely prepared record. Built-in records, state snapshots, checksums, and verification options are frozen; each transition returns a new record. Injected services are behavioral objects, not serialized state.

## Compose a Release

This JavaScript configuration adds a project-specific class between archive validation and publication. Put it in `npr.config.js`; the same file is used by the local CLI, composite action, and reusable GitHub Actions workflow.

```js
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  Workflow, ReleaseObserver, InitializeRelease, PrepareRelease, ValidateRelease,
  CommitRelease, BuildArtifact, PublishArtifact, PushRelease, CreateHostedRelease,
  PrepareNextVersion, VerifyRelease,
} from "npm-package-release";

class CheckArchiveSize {
  id = "check-archive-size";

  async run(input) {
    const path = join(input.runtime.services.store.directory, input.state.artifact.filename);
    if ((await stat(path)).size > 10_000_000) throw new Error("Archive exceeds the project size limit.");
    return input;
  }
}

const config = {};
const preparation = Workflow.start(new ReleaseObserver())
  .then(new InitializeRelease(config))
  .then(new PrepareRelease())
  .then(new ValidateRelease())
  .then(new CommitRelease())
  .then(new BuildArtifact())
  .then(new CheckArchiveSize());

const publication = preparation
  .then(new PublishArtifact())
  .then(new PushRelease())
  .then(new CreateHostedRelease())
  .then(new PrepareNextVersion())
  .then(new VerifyRelease());

class ProjectRelease {
  id = "project-release";
  async prepare(options) { return preparation.run(options); }
  async run(options) { return publication.run(options); }
}

export default new ProjectRelease();
```

In TypeScript, declare `class CheckArchiveSize implements Step<BuiltRelease, BuiltRelease>` and annotate its input/return types. The published declarations check the complete chain, including custom classes. An incompatible order is a compile-time error. JavaScript composition has the same runtime behavior but cannot provide compile-time guarantees without a JavaScript type checker.

The outer class implements `Step<ReleaseOptions, ReleaseState>` with an additional `prepare` method so Actions can preserve artifacts before publication. Its run independently repeats preparation. Custom classes own observer forwarding and repeatable edits; reserve release-success notifications for the whole release, not preparation. `ReleaseWorkflow` supplies that behavior by default. Local run-only compositions remain supported with `npr release`.

Export `new ReleaseWorkflow(options)` to use the standard sequence without listing every step. Supply service instances and an optional provider alongside runtime settings in that options object. `await release(workflow, options)` and `await workflow.run(options)` execute a composed workflow; the return type is the final step's output. Run options include `cwd`, `version`, `artifacts`, `run`, `log`, scoped `env`, `provider`, and `observer`. See [Execution Providers and Contexts](execution.md) for platform selection, run metadata, and lifecycle reporting.

`SemanticReleaseWorkflow` adds replaceable history, analyzer, selector, and generated-note classes ahead of preparation, while keeping the same staged contract. Its defaults do not require a manual changelog or create a next-development commit. See [Semantic Releases](semantic.md) for typed analysis steps, service interfaces, rules, and immutable decisions.

Use [Lifecycle Hooks](hooks.md) to add ordered before/after behavior to either standard workflow without rebuilding its sequence. Hook classes receive typed step `input`/`output` or preparation `context`; preparation edits remain inside trusted staging boundaries. Use custom steps when changing the pipeline itself.

## Replace Services

`InitializeRelease(options)` and `ReleaseWorkflow(options)` accept service instances directly in their options object. Omitted services use the defaults; no inheritance or global registration is required.

| Service | Interface | Default |
| --- | --- | --- |
| `repository` | `ReleaseRepository` | `Git`, including trusted staging, concurrency guards, atomic release pushes, and ref verification. |
| `project` | `PackageProject` | `NpmPackage`, including manifest/lockfile updates, packing, strict consumers, and archive checks. |
| `publisher` | `PackagePublisher` | `NpmPackage`, including registry lookup, checksum reconciliation, and exact-archive publication. |
| `changelog` | `Changelog` | `KeepAChangelog`; choose `IntrideaChangelog` or a custom class, or `null` to skip built-in notes. |
| `versions` | `VersionPolicy` | `NumericPatchVersions`, selecting the requested/current version and the next patch. |
| `host` | `ReleaseHost` | `GitHubReleaseHost`, or `null` to skip hosting. |
| `validator` | `ReleaseValidator` | `HookValidator`, adapting validation hooks or running npm tests/lint. |
| `store` | `ReleaseStore` | `DirectoryReleaseStore`, creating a recovery directory and atomically replacing diagnostic JSON. |
| `verifier` | `RegistryVerifier` | `RegistryVisibility`, bounded fresh lookups against the selected publisher. |

For example, replace next-version selection with a class instead of changing the runner:

```js
import { ReleaseWorkflow } from "npm-package-release";

class NextMinorVersion {
  select(current, requested) {
    const version = requested?.trim() || current;
    const [major, minor] = version.split(".").map(Number);
    return { version, nextVersion: `${major}.${minor + 1}.0` };
  }
}

export default new ReleaseWorkflow({ versions: new NextMinorVersion() });
```

For TypeScript, implement `VersionPolicy`; use `Changelog`, `ReleaseHost`, or another public interface for other services. An explicitly supplied host replaces GitHub-specific construction, including GitHub repository inference. Publisher injection is independent of package building, and the default registry verifier uses that publisher. Existing npm-specific validation remains in `NpmPackage`; alternative behavior requires the corresponding custom classes, not merely a different URL.

Repository adapters implement `commitRelease(version, tree)` and `commitNext(version, tree)` for release-specific reconciliation, alongside ordinary `commit(message, tree)`. `Git` generates standard messages inside the named operations; message text never selects the reconciliation path. All three operations reject files or index entries that differ from the prepared tree. See [Upgrading](../UPGRADING.md) for adapter migration and existing-output safeguards.

## Ordering, Safety, and Recovery

The default workflow preserves clean-checkout, trusted-index, release identity, reproducible-build, strict-consumer, conflicting-output, archive-integrity, atomic-push, and recovery guarantees. It creates hosting and next-development metadata before bounded registry visibility checks. A timeout is unverified, not permission to republish.

Custom workflows may add, replace, omit, or reorder compatible steps. For example, `VerifyRelease` accepts pushed, hosted, or next-development records, so hosting and next-development can be omitted. Publication cannot be composed immediately after preparation. Type contracts describe data dependencies; they do not prove that arbitrary trusted classes validated an archive, preserved identity, or published safely. A custom workflow explicitly owns any guarantees it bypasses. This is sequential composition, not a parallel job scheduler or an automatic recovery engine.

`ReleaseObserver` logs step starts, persists `activeStep` while a step runs, clears it on successful completion, and records the failing step identifier and error against the last persisted release phase. Next-development failures mark verification failed even when the last phase is still `hosted`. Use it when composing built-in release steps. The generic runner stops on the first failure, never retries a step, and preserves the original error if failure reporting also fails. Custom observers implement `WorkflowObserver` with optional `started`, `completed`, `failed`, and whole-workflow `succeeded` callbacks. Events include frozen execution metadata; step events also include input and output/error as applicable. Per-run observers supplement the workflow observer rather than disabling failure persistence.

Diagnostic state is read through the selected store. Built-in steps persist new snapshots; custom steps that change diagnostics must call `runtime.services.store.save` with a new state, or `runtime.report(state, phase)` to save and log it. Never interpret phase flags as a resume protocol or serialize service instances. Each operation reconciles actual outputs from the current checkout and inputs. Standalone `verify({ services })` accepts replacement service instances for retained custom releases; CLI verification uses the default npm/Git services. See [Recovery and Reconciliation](recovery.md).

Both standard workflows capture a shallow-frozen configuration copy at construction; configure services and hooks before creating the workflow. Service instances remain mutable.

## Compatibility

Configuration modules export workflow instances, not plain objects or service-selector descriptors. `release(workflow, options)` executes a class implementing `Step`; Actions additionally requires a `prepare` method. Custom repositories implement repeatable preparation and `nextIteration`, not bundle restoration. Missing/different hosted asset checksums fail rather than overwriting old assets. TypeScript configuration modules must be compiled to ESM before passing their path to `--config`; the CLI does not install a loader or compiler. Consumers can write JavaScript classes in `npr.config.js`.
