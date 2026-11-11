# Recovery and Reconciliation

## Current Checkout, Not Saved Workflow State

Release operations follow ruby-gem-release: reconcile each output from the current checkout and supplied inputs. There is no checkpoint descriptor, bundle restoration command, or completion journal. `release.json` records diagnostics and supports read-only verification; its phase never grants permission to skip an operation.

`npr prepare` validates release files, commits, builds and tests the actual archive, creates the local tag, and retains notes and a Git bundle without publishing or pushing. `npr release` independently repeats that preparation before publication:

```sh
npm exec --offline -- npr prepare --config npr.config.js --version 1.2.3 --artifacts /path/to/artifacts
# Preserve this directory durably before authorizing publication.
npm exec --offline -- npr release --config npr.config.js --version 1.2.3 --artifacts /path/to/artifacts
```

Use the same intended checkout, configuration, selected version, and release inputs. Matching prepared trees reuse the existing release commit, changelog heading, notes, and tag. Builds must be reproducible; an existing archive is preserved and a different rebuild fails before publication. Commands receive `SOURCE_DATE_EPOCH` from the source commit unless explicitly supplied.

Both Actions interfaces require a successful `npm-release-prepared-RUN-ATTEMPT` upload between preparation and release. It must find files and includes hidden files. A separate failure-aware `npm-release-RUN-ATTEMPT` upload retains later diagnostics. Both retain files for 30 days. Local callers arrange their own durable storage. Neither a local command nor a simulated copy proves a live upload succeeded.

The GitHub execution provider carries the original source commit, manifest version, release date, source timestamp, and a private invocation-state path between steps through `GITHUB_ENV`. Semantic analysis is saved once in that private runner-temporary file and bound to the source and explicit version. It is not uploaded as a recovery descriptor or reused by a fresh dispatch. No discovery, restoration, or automatic rewind occurs.

## Reconcile Actual Outputs

| Operation | Matching Output | Missing or Conflicting Output |
| --- | --- | --- |
| Release preparation | Desired index tree equals the existing tagged tree: reuse the commit. | Commit a new release; a conflicting existing tree fails. |
| Archive build | Rebuilt bytes match the existing archive: preserve it. | Retain a new archive; different existing bytes fail. |
| npm publication | Both registry SHA-512 integrity and SHA-1 match: no upload. | Structured E404 permits one upload; missing/different checksums and other lookup errors fail closed. |
| Git release tag | Local/remote tag resolves to the intended commit: reuse it. | Create a missing matching tag; conflicting targets fail. |
| Git push | Remote branch contains the intended commit: do not rewind it. | Push missing refs with fast-forward/atomic safeguards; divergent work fails. |
| GitHub Release | Title, notes, tag, status, and named asset SHA-256 match: no mutation. | Add a missing asset; conflicting metadata, duplicate assets, or unverifiable/different checksums fail. |
| Next development | Matching immediate development commit/tree: validate and reuse it. | Prepare it from the release commit; unrelated/later local history fails. |

A failed npm upload or hosted mutation may have been accepted. The operation reads the actual output once more and accepts an exact match; it never automatically submits the mutation again. Registry visibility delays remain bounded verification outcomes after hosting and next-development preparation, not permission to republish.

Asset verification uses GitHub's valid `sha256:` digest directly. When that field is missing or malformed, `GitHubReleaseHost` requires a positive safe integer asset ID and downloads through the authenticated repository-local GitHub API, ignoring browser download URLs. It hashes raw bytes in an owned temporary file and removes that file on success or failure. A valid but different digest never triggers a fallback or overwrite. Custom `Command` adapters must honor `options.output`: write binary stdout to that path (relative to `cwd` when needed), return an empty string, and reject unsuccessful commands.

## API Operations

`prepare(workflow, options)` and `workflow.prepare(options)` return a typed `BuiltRelease`. Its runtime carries the invocation inputs; an ordinary numeric workflow can repeat preparation with `await workflow.run({ ...options, env: built.runtime.env })`. Actions handles transport between CLI processes automatically. Semantic split execution also needs its invocation-local analysis; use the Actions provider or compose the typed operations in one process rather than reanalyzing against a newly created tag.

Public steps such as `PublishArtifact`, `PushRelease`, `CreateHostedRelease`, and `PrepareNextVersion` can independently reconcile their corresponding typed input records. There is no saved-record reader or `complete` method. Custom Actions-compatible classes implement `prepare(options)` and `run(options)`, with repeatable preparation and their own observer forwarding.

Hooks and notifications may run again. Make custom preparation and external effects idempotent; services own their own reconciliation guarantees.

## Recovery Limits

Inspect registry state, remote commits/tags, hosted outputs, the retained archive, notes, `release.bundle`, and any `next.bundle` before authorizing another mutation. A matching existing publication is reused, never overwritten. Preserve evidence before retention expires.

Rerun the affected operations only after reviewing the intended checkout and inputs. A whole new dispatch is not a request to resume an old release: it uses a fresh checkout and fresh semantic analysis. An advanced development checkout, dirty tree, changed release input, non-reproducible build, conflicting remote output, or inaccessible registry requires inspection rather than automatic cleanup or rewind. Bundles are evidence for operator-managed Git recovery, not executable saved workflow state.

`npr verify --artifacts PATH` reads the retained archive and explicit release identity without publishing or changing Git history, even after the manifest advances. Never edit checksums or move tags to hide a mismatch.
