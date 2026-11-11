# Detailed Usage

## Requirements

The default workflow uses one public root npm package on `registry.npmjs.org`, Node.js 22.14+, 24, or 26+, Git, and npm with Trusted Publishing support (11.5.1+; the workflow defaults to Node.js 26/npm 12). GitHub Releases additionally require `gh` and `GH_TOKEN`. A manifest must have a numeric version, no workspaces, and an optional matching `package-lock.json`. Built-in services do not support alternate registries, prerelease versions/channels, or workspace publication; [custom workflows](workflows.md) can supply their own classes and contracts.

Install `npm-package-release@0.1.0` as an exact development dependency and commit the lockfile. The CLI is `npr`, not the unrelated npm package of that name. Upgrade the dependency and pinned workflow/action together.

## New Project Setup

Follow the [four-step README setup](../README.md#usage) in **your package's repository**, not this tool's repository. Install the tool in locked development dependencies, export the configuration, and merge the calling workflow into your default branch.

### First Publication

An unpublished npm package needs a manual first publication before configuring its Trusted Publisher. Existing packages skip this step.

Review the initial release metadata through your normal PR process: synchronize manifest/lockfile versions (for example `0.1.0`), date the changelog heading, and remove its placeholder. From the clean merged commit, run tests/lint, build with `npm pack --json`, inspect the archive/checksums, and test that exact archive in an isolated consumer with strict engines and lifecycle scripts disabled.

With publication approval, authenticate interactively using `npm login` when needed, then publish the tested archive:

```sh
npm publish /absolute/path/to/package.tgz --access public --ignore-scripts
```

Verify `npm view YOUR_PACKAGE@0.1.0 --json` matches the retained archive's name/version, `dist.integrity`, and `dist.shasum`. With tag/hosted-release approval, create the matching immutable tag at the release commit and a GitHub Release with those notes/archive. Never rebuild or overwrite existing outputs. For the next release, update manifest/lockfile/changelog together or pass an unpublished version in the dispatch input.

### Environment and Branch Permissions

Create `release` under your GitHub repository's **Settings → Environments**. Restrict it to your default branch and optionally require maintainer approval where supported. An unprotected environment alone does not restrict who can publish.

The workflow pushes release and next-development commits directly. An authorized administrator must allow fast-forward default-branch pushes and release-tag creation. Removing a blocking PR requirement permits direct pushes by **all writers**, not only Actions; retain force-push/deletion protections with no bypass actors and keep ordinary development on PRs. The tool does not change protections itself.

### Publisher Checks

Use the [exact npm publisher fields in README](../README.md#3-enable-trusted-publishing): your owner/repository, calling filename `release.yml`, environment `release`, and direct `npm publish` permission. Fields are case-sensitive; use the actual filename if renamed. npm checks the caller even when it invokes a reusable workflow. Do not store an npm publish token or set `NODE_AUTH_TOKEN`; `GH_TOKEN` is a separate GitHub job token supplied by the reusable workflow.

New publishers [expire without a successful publication within two days](https://docs.npmjs.com/trusted-publishers/); expired configurations must be recreated by an authorized maintainer. For authentication failures, also check both workflow permissions, GitHub-hosted execution, and supported Node/npm. `npm whoami` is not an OIDC permission test. Inspect [recovery evidence](#recovery) before repeating a failed dispatch.

## CLI

```sh
npm exec --offline -- npr --help
npm exec --offline -- npr release
npm exec --offline -- npr release --version 1.2.3 --config npr.config.js
npm exec --offline -- npr prepare --artifacts /path/to/checkpoint
npm exec --offline -- npr complete --artifacts /path/to/checkpoint
npm exec --offline -- npr verify --artifacts /path/to/retained-artifacts
```

`release` publishes and pushes: obtain authorization and configure authentication first. It releases the checked-in version unless `--version` selects a numeric version, then prepares the next patch version. `--config` defaults to `npr.config.js`; use an ESM file (`.mjs` when the consumer declares CommonJS). `--artifacts` overrides the default Git-metadata directory. Empty version/artifact values are treated as unset. Put artifacts outside the source tree or in an ignored directory.

Those version/next-development defaults describe `ReleaseWorkflow`. Export `new SemanticReleaseWorkflow()` to opt into Conventional Commits versioning and generated notes instead; it leaves next-development preparation disabled unless configured. See [Semantic Releases](semantic.md) for policies and replacement classes. The same CLI commands and Actions inputs apply.

`verify` reads `release.json` and its archive, checks the remote lightweight release tag and explicit registry version, and never publishes, commits, pushes, or creates hosted releases. Supply the complete retained directory; do not substitute a rebuilt archive.

`prepare` stops after validation and immutable checkpoint creation, without publishing or pushing. Preserve the entire directory durably before invoking `complete`, which restores and reconciles that explicit checkpoint. Complete rejects `--version`: the checkpoint already captures the release identity. Both accept `--config` and `--artifacts`; see [Checkpoints and Reconciliation](checkpoints.md).

Help/version and phase reports go to standard output. Errors go to standard error with exit status 1. Success, including visibility timeout with an explicitly unverified result, returns 0. Machine-readable state belongs in `release.json`, not parsed human log lines. Reports follow lifecycle order; there is no sorting, deduplication, or source-location diagnostic format. Unknown options/positionals fail; standalone `--help`/`--version` cannot be combined, and `verify` rejects release-only options.

Representative release output:

```text
[npr] prepared: example@0.1.0
[npr] validating: example@0.1.0
[npr] validated: example@0.1.0
[npr] building: example@0.1.0
[npr] built: example@0.1.0
[npr] checkpoint: example@0.1.0
[npr] publishing: example@0.1.0
[npr] published: example@0.1.0
[npr] pushed: example@0.1.0
[npr] hosted: example@0.1.0
[npr] next: example@0.1.0
[npr] verifying: example@0.1.0
[npr] verified: example@0.1.0
```

## Configuration

Configuration is trusted JavaScript executed with release privileges, not untrusted data. Export a [composed workflow instance](workflows.md) or `new ReleaseWorkflow(options)` as shown below. Plain-object exports and format/hosting/validation selector options are not supported. Supply service instances directly; `KeepAChangelog` is the default, and `changelog: null` delegates notes to your own steps.

```js
import { KeepAChangelog, HookValidator, ReleaseWorkflow } from "npm-package-release";

export default new ReleaseWorkflow({
  changelog: new KeepAChangelog("CHANGELOG.md"),
  timezone: "UTC",
  validator: new HookValidator({
    async validateArtifact({ consumer, run }) {
      await run("node", ["--input-type=module", "--eval", 'import("example")'], {
        cwd: consumer,
      });
    },
  }),
});
```

Replace `example` with the package's public API and check its actual behavior. The built-in consumer always installs the exact archive with strict engines and lifecycle scripts disabled; `validateArtifact` runs inside that consumer before publication, without rebuilding.

| Option | Default | Behavior |
| --- | --- | --- |
| `hooks` | No lifecycle hooks | An immutable `LifecycleHooks` instance registering ordered hook classes; see [Lifecycle Hooks](hooks.md). |
| `changelog` | `new KeepAChangelog()` | `new KeepAChangelog(path)`, `new IntrideaChangelog(path)`, a custom `Changelog`, or `null`. Paths default to `CHANGELOG.md` and resolve relative to the invocation's `cwd`. |
| `branch` | Actions default branch or remote symbolic HEAD | Must match the checked-out branch and current remote tip. |
| `remote` | `origin` | Named Git remote, used for concurrency checks and atomic pushes. |
| `repository` | `Git` | A `ReleaseRepository` instance; default Git uses `branch`/`remote`. |
| `host` | `GitHubReleaseHost` | A `ReleaseHost` instance or `null` to disable hosting. Default GitHub owner/repository comes from the manifest's HTTPS repository URL. |
| `timezone` | `NPR_TIMEZONE` or `UTC` | Named timezone for calendar dates and command/Git timestamps. |
| `prepare` | No additional edits | Trusted release edits after version/changelog preparation. |
| `validator` | `new HookValidator()` | A `ReleaseValidator` instance. `HookValidator({ validate, validateArtifact })` adapts optional checks; default validation runs npm tests/lint for release and next-development files. |
| `next` | No additional edits | Trusted next-development edits after the patch increment. |
| `verifier` | `RegistryVisibility` | A `RegistryVerifier` instance. `new RegistryVisibility(publisher, { attempts: 6, delay: 10000 })` configures bounded lookups; at most 60 attempts and delay up to 60000 milliseconds. Captured settings are retained for completion. |
| `versions` | `NumericPatchVersions` | A `VersionPolicy` instance selecting the release and next-development versions. |
| `project`, `publisher`, `store` | Built-in npm project/publisher and directory store | Instances implementing the [service contracts](workflows.md#replace-services). |
| `provider` | Scoped local/GitHub detection | An `ExecutionProvider` instance; per-run selection takes precedence. |

Hooks receive a frozen context with `cwd`, `version`, `releasedVersion`, `previousVersion`, `date` (`YYYY-MM-DD`), `phase`, and `run(program, argumentArray, options)`. Artifact hooks additionally receive `archive` and `consumer`. Next hooks/validation see the development version as `version` and an empty `PACKAGE_ARCHIVE` in command environments. `run` returns standard output, rejects nonzero exits, defaults to a 120-second timeout, and accepts `cwd`, `env`, and `timeout` overrides. npm lookups use a shorter timeout and disable fetch retries; only explicit missing-version responses are retried.

Hooks also receive `execution`, a provider-neutral immutable snapshot with release data, the logical step, observed history, and allowlisted run metadata. A configuration `observer` class supplies structured success/failure notifications, including failures before initialization. See [Execution Providers and Contexts](execution.md).

For the default `KeepAChangelog`, use `## [Unreleased]` with real notes; releases use `## [0.1.0] - YYYY-MM-DD`. Standard `[Unreleased]: https://github.com/owner/repo/compare/v0.0.1...master` links are updated without rewriting unrelated Markdown. `new IntrideaChangelog()` instead uses `## 0.1.0 (Next)` with real notes and exactly one `- Your contribution here.` placeholder; releases use `## 0.1.0 (YYYY/MM/DD)`. Empty sections fail before publication. Custom `Changelog.release`/`next` methods receive the invocation's `cwd` alongside version/date data.

## JavaScript API

```js
import { release, verify } from "npm-package-release";
import workflow from "./npr.config.js";

await release(workflow, { version: "1.2.3" });
await verify();
```

The default release and verification return retained state snapshots. A custom workflow returns its final step's output. The release API requires a workflow instance; there is no configuration-object adapter. Options include `cwd`, `artifacts`, `log`, scoped `env`, and an argument-based asynchronous `run` executor (default: public system commands). Alternate executors support isolated integrations; they are trusted code. `releaseChangelog(source, { format, version, date })` returns `{ source, notes }`; `nextChangelog(source, { format, version, releasedVersion })` returns the next source text. These pure Markdown functions retain an explicit format argument; it is not a workflow option. Public TypeScript declarations include step, context, service, and workflow contracts without requiring TypeScript at runtime.

## GitHub Actions

Copy [the caller example](../examples/release.yml) to the consumer's `.github/workflows/release.yml`. It uses `workflow_dispatch`, grants `contents: write` and `id-token: write`, and calls this repository's reusable `release.yml` at `v0.1.0`. Keep `npm-package-release@0.1.0` installed in the caller's locked development dependencies.

The reusable workflow accepts `node-version` (26), `npm-version` (12), `config` (`npr.config.js`), optional `version`, and `timezone` (UTC). Runtime/tooling versions must be compatible with each other and the caller's package. It runs only for manual dispatch on the default branch, uses the `release` environment and repository-level concurrency, installs dependencies without caching, configures Git identity, prepares the release, requires a successful checkpoint upload, then completes publication. It always attempts a separate diagnostic-artifact upload.

For step-based integration, adapt the [composite caller example](../examples/action-release.yml), using `dblock/npm-package-release@v0.1.0` after checking out the attached default branch with full history, setting up compatible Node/npm, installing dependencies, and configuring Git identity. Its inputs are `config`, optional `version`, and `timezone`. The caller must supply manual-dispatch/default-branch guards, the `release` environment, contents/OIDC permissions, and non-canceling release concurrency; the composite action uses the same upload-gated handoff and failure-aware diagnostic upload. It does not configure repository protections or npm credentials. Both Actions interfaces require a workflow instance implementing prepare/complete.

Follow [New Project Setup](#new-project-setup) for the manual first-publication bootstrap, GitHub environment and branch rules, exact npm Trusted Publisher fields, and dispatch/verification. Existing packages skip only the bootstrap publication. [RELEASING](../RELEASING.md) instead describes maintaining this tool's own package, not setting up your consumer project.

Release commits and tags require direct-push permission on the default branch. Configure that only with explicit authorization, retaining force-push/deletion protections and recognizing that removing a PR requirement permits direct pushes by all writers, not only this workflow. The tool does not change repository protections itself.

## Recovery

Never blindly rerun publication. Inspect `release.json` (phase, identity, refs, integrity, verification, and error), retained archive, notes, and `release.bundle` (plus `next.bundle` when the development commit was prepared); then inspect registry metadata, remote refs, and hosted releases. A `publishing` phase can mean acceptance followed by a transport failure, so an error is not proof that npm rejected the upload. A published archive cannot be replaced.

After inspecting and downloading a complete trusted checkpoint, explicitly authorized `npr complete --config npr.config.js --artifacts PATH` reconciles actual outputs and completes missing operations using the existing release commit, tag, and exact archive. It ignores diagnostic phase flags, skips matching publications, and rejects conflicting or unverifiable outputs. Do not move release tags or rebuild an archive to match metadata. `npr verify --artifacts PATH` rechecks without mutation, even after the manifest advances. Before a later independent release, archive the previous local artifact directory and choose a new empty directory; the tool intentionally refuses existing artifacts. See [Checkpoints and Reconciliation](checkpoints.md) for restoration and later-history limits.

Visibility timeout records `verification: "unverified"` and “release could not be verified,” without blocking hosted-release creation or next-development preparation. A later verify command may confirm propagation. Authentication, network, malformed metadata, identity, and integrity failures remain errors. Registry visibility checks do not prove live OIDC configuration. Actions checkpoints precede publication, but retention expiry and local-only artifact loss still require operator planning.
