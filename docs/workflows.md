# Composable Workflows

## Classes and Contracts

The workflow is application code, not a fixed sequence with additional callbacks. Implement classes against public TypeScript interfaces, pass service instances to the built-in steps, and compose steps with `Workflow.start<Input>().then(step)`. All runtime exports and types come from `npm-package-release`. The package ships compiled ESM JavaScript and declarations; JavaScript callers do not need TypeScript.

`Step<Input, Output>` requires a stable, nonempty `id` and `run(input): Promise<Output>`. A workflow implements the same interface and can itself be composed as a step. Each `then` returns a new reusable workflow without modifying its parent. Duplicate step identifiers fail at construction. The builder checks adjacent input/output compatibility at compile time without an untyped shared data bag.

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

export default Workflow.start(new ReleaseObserver())
  .then(new InitializeRelease({ changelog: { format: "intridea" } }))
  .then(new PrepareRelease())
  .then(new ValidateRelease())
  .then(new CommitRelease())
  .then(new BuildArtifact())
  .then(new CheckArchiveSize())
  .then(new PublishArtifact())
  .then(new PushRelease())
  .then(new CreateHostedRelease())
  .then(new PrepareNextVersion())
  .then(new VerifyRelease());
```

In TypeScript, declare `class CheckArchiveSize implements Step<BuiltRelease, BuiltRelease>` and annotate its input/return types. The published declarations check the complete chain, including custom classes. An incompatible order is a compile-time error. JavaScript composition has the same runtime behavior but cannot provide compile-time guarantees without a JavaScript type checker.

Export `new ReleaseWorkflow(config, services)` to use the standard sequence without listing every step. `await release(workflow, options)` and `await workflow.run(options)` execute a composed workflow; the return type is the final step's output. Options include `cwd`, `version`, `artifacts`, `run`, `log`, and scoped `env`.

## Replace Services

`InitializeRelease(config, services)` and `ReleaseWorkflow(config, services)` accept instances implementing these contracts. Omitted services use the defaults; no inheritance or global registration is required.

| Service | Interface | Default |
| --- | --- | --- |
| `repository` | `ReleaseRepository` | `Git`, including trusted staging, concurrency guards, atomic release pushes, and ref verification. |
| `project` | `PackageProject` | `NpmPackage`, including manifest/lockfile updates, packing, strict consumers, and archive checks. |
| `publisher` | `PackagePublisher` | `NpmPackage`, including registry lookup, duplicate checks, and exact-archive publication. |
| `changelog` | `Changelog` | `MarkdownChangelog`, or `null` to skip built-in notes. |
| `versions` | `VersionPolicy` | `NumericPatchVersions`, selecting the requested/current version and the next patch. |
| `host` | `ReleaseHost` | `GitHubReleaseHost`, or `null` to skip hosting. |
| `validator` | `ReleaseValidator` | `HookValidator`, adapting validation hooks or running npm tests/lint. |
| `store` | `ReleaseStore` | `DirectoryReleaseStore`, exclusively reserving a recovery directory and atomically saving JSON. |
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

export default new ReleaseWorkflow(
  { changelog: { format: "intridea" } },
  { versions: new NextMinorVersion() },
);
```

For TypeScript, implement `VersionPolicy`; use `Changelog`, `ReleaseHost`, or another public interface for other services. An explicitly supplied host replaces GitHub-specific construction, including GitHub repository inference. Publisher injection is independent of package building, and the default registry verifier uses that publisher. Existing npm-specific validation remains in `NpmPackage`; alternative behavior requires the corresponding custom classes, not merely a different URL.

## Ordering, Safety, and Recovery

The default workflow preserves clean-checkout, trusted-index, release identity, build-once, strict-consumer, duplicate-version/tag, archive-integrity, atomic-push, and recovery guarantees. It creates hosting and next-development metadata before bounded registry visibility checks. A timeout is unverified, not permission to republish.

Custom workflows may add, replace, omit, or reorder compatible steps. For example, `VerifyRelease` accepts pushed, hosted, or next-development records, so hosting and next-development can be omitted. Publication cannot be composed immediately after preparation. Type contracts describe data dependencies; they do not prove that arbitrary trusted classes validated an archive, preserved identity, or published safely. A custom workflow explicitly owns any guarantees it bypasses. This is sequential composition, not a parallel job scheduler or an automatic recovery engine.

`ReleaseObserver` logs step starts and records the failing step identifier and error against the last persisted release phase. Use it when composing built-in release steps. The generic runner stops on the first failure, never retries a step, and preserves the original error if failure reporting also fails. Custom observers implement `WorkflowObserver` with optional `started`, `completed`, and `failed` callbacks; they receive the step identifier and input, plus output or error as applicable.

Recovery state is read through the selected store. Built-in steps persist new snapshots; custom steps that change recovery data must call `runtime.services.store.save` with a new state, or `runtime.report(state, phase)` to save and log it. Do not serialize service instances or rerun completed publication steps. Standalone `verify({ services })` accepts replacement service instances for retained custom releases; CLI verification uses the default npm/Git services. See [Recovery](usage.md#recovery).

## Compatibility

Existing configuration objects, `release(config, options)`, hooks, and `npr` flags remain supported through the default `ReleaseWorkflow`. No CLI command or configuration filename changed. TypeScript configuration modules must be compiled to ESM before passing their path to `--config`; the CLI does not install a loader or compiler. Consumers may continue writing JavaScript classes and `npr.config.js`.
