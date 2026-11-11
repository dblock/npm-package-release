# Checkpoints and Reconciliation

## Prepare, Preserve, and Complete

The default release can run in one process with `npr release`, or across an explicit artifact handoff:

```sh
npm exec --offline -- npr prepare --config npr.config.js --version 1.2.3 --artifacts /path/to/checkpoint
# Preserve this directory durably before authorizing publication.
npm exec --offline -- npr complete --config npr.config.js --artifacts /path/to/checkpoint
```

`prepare` checks the checkout and registry, prepares and validates release files, commits, packs once, installs that exact archive in a strict consumer, and writes the local release tag, bundle, notes, and `checkpoint.json`. It does not publish or push. Starting a new release still rejects existing versions, tags, and artifact directories; use `complete` for an existing checkpoint, not another `prepare`.

Both Actions interfaces run prepare, upload `npm-release-checkpoint-RUN-ATTEMPT`, and only then run complete. The checkpoint upload must succeed and must find files; publication never runs after a failed upload. A separate failure-aware `npm-release-RUN-ATTEMPT` upload preserves later diagnostics. Both include hidden files and retain artifacts for 30 days. This is orchestration gating, not proof from local simulations that a live Actions upload succeeded.

Local callers must arrange their own durable storage. `npr release` writes a local checkpoint but cannot protect it against losing the machine. Running `complete` yourself does not prove an external upload happened.

## Immutable Input, Not a Completion Journal

`checkpoint.json` contains a versioned `ReleaseCheckpoint`: immutable domain release data, the source branch/remote and initial/release commits, the prepared Git tree, exact archive checksums, release-note and bundle checksums, timezone, and bounded verification settings. It contains no credentials, provider clients, callbacks, or step-completion flags. Treat checkpoints as trusted release inputs, not arbitrary downloaded instructions; checksums establish consistency, not authenticity.

Completion validates the checkpoint, retained archive, notes, bundle, Git tree/parent, and repository relationship. A fresh checkout of the configured branch can import the bundle and advance to the exact prepared release commit. Existing matching release/next-development checkouts are preserved. The release version comes from the checkpoint, never the advanced manifest.

Opt-in [semantic releases](semantic.md) additionally retain the immutable analysis decision and next-development policy. Completion binds the decision to source/version/notes without rerunning analysis and rejects a different workflow mode or next-development setting. Numeric checkpoints remain compatible. Semantic checkpoints contain full analyzed commit messages; preserve repository access controls.

`release.json` remains replaceable diagnostic state. Completion does not consult its phase to decide which operations to run, and changing a phase to `published` or `next` cannot skip a registry lookup or push verification. The immutable checkpoint is not rewritten when diagnostics advance.

## Reconcile Actual Outputs

| Operation | Matching Output | Missing or Conflicting Output |
| --- | --- | --- |
| npm publication | Both registry SHA-512 integrity and SHA-1 match the retained archive: no upload. | Structured E404 permits one upload; missing/different checksums and other lookup errors fail closed. |
| Git release tag | Local/remote tag resolves to the intended commit: reuse without moving it. | Create a missing matching tag; conflicting targets fail. |
| Git push | Remote branch contains the intended commit: do not rewind it. | Push missing refs with fast-forward/atomic safeguards; divergent work fails. |
| GitHub Release | Title, notes, tag, status, and named asset SHA-256 match: no mutation. | Add a missing asset; conflicting metadata, duplicate assets, or absent/different checksums fail without overwriting. |
| Next development | The checkout is the matching immediate next-development commit: validate and reuse its tree without repeating next edits. | Prepare it from the release commit; unrelated/later local history fails rather than rewinding. |

A failed npm upload or hosted mutation may have been accepted. The operation reads the actual output once more and accepts an exact match; it never automatically submits the mutation again. Registry visibility delays remain bounded verification outcomes after hosting and next-development preparation, not permission to republish.

Repeated explicit completion may revalidate the existing next-development tree and notify observers again. Notifications and arbitrary custom external hooks are not exactly-once deliveries. Custom service implementations own their own reconciliation guarantees.

## API and Custom Classes

```js
import { ReleaseWorkflow } from "npm-package-release";

const workflow = new ReleaseWorkflow({ changelog: { format: "intridea" } });
await workflow.prepare({ artifacts: "/path/to/checkpoint" });
// Copy the entire directory to durable storage here.
await workflow.complete({ artifacts: "/path/to/checkpoint" });
```

`prepare(configOrWorkflow, options)` and `complete(configOrWorkflow, options)` provide the same operations. A `ReleaseWorkflow` implements `CheckpointWorkflow<BuiltRelease, ReleaseState>` and retains `run` for the one-process API. Its preparation forwards step/failure observers but reserves whole-release `succeeded` notifications for run/completion.

Custom staged classes implement `CheckpointWorkflow<Prepared, Output>` explicitly. Compose `CheckpointRelease` after the final artifact-policy step; compose `RestoreRelease(config, services)` before publication in the completion workflow. Both pass `BuiltRelease` through strong step contracts. `readCheckpoint(directory)` returns a frozen descriptor, not executable services. Custom repository implementations now also implement `restore` and `nextIteration`; custom providers, publishers, projects, and hosting services remain independently replaceable.

Existing plain `Workflow` configurations still work with `npr release`. Actions now requires a configuration object, `ReleaseWorkflow`, or custom class with both prepare/complete methods; it rejects a plain run-only workflow rather than bypassing the checkpoint. See [Composable Workflows](workflows.md) for composition.

## Recovery Limits

After explicit authorization, download the complete checkpoint artifact, check out the configured branch with full history, install dependencies, configure Git identity/authentication, inspect the checkpoint and external outputs, then run `npr complete --config npr.config.js --artifacts PATH`. An already published matching archive is reused. Do not rebuild it, edit checksums to hide differences, move tags, or blindly rerun `release`.

A dirty checkout, changed evidence, conflicting hosted output, different release tree, or later local development history requires inspection, not automatic cleanup. Retention expiry, lost checkpoints, inaccessible registries, unsupported registry metadata, and arbitrary non-idempotent custom services remain limitations. `npr verify` is still the read-only verification path.
