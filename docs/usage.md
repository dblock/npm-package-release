# Detailed Usage

## Requirements

The default workflow uses one public root npm package on `registry.npmjs.org`, Node.js 22.14+, 24, or 26+, Git, and npm with Trusted Publishing support (11.5.1+; the workflow defaults to Node.js 26/npm 12). GitHub Releases additionally require `gh` and `GH_TOKEN`. A manifest must have a numeric version, no workspaces, and an optional matching `package-lock.json`. Built-in services do not support alternate registries, prerelease versions/channels, or workspace publication; [custom workflows](workflows.md) can supply their own classes and contracts.

Install `npm-package-release@0.2.0` as an exact development dependency and commit the lockfile. The CLI is `npr`, not the unrelated npm package of that name. Upgrade the dependency and pinned workflow/action together.

## New Project Setup

First complete [README steps 1-2](../README.md#usage) in **your package's repository**: install the tool, add `npr.config.js`, and merge `.github/workflows/release.yml`. Use Node.js 26/npm 12 for the commands below. Replace `YOUR_PACKAGE` and `YOUR_OWNER/YOUR_REPO` with your npm name and GitHub repository; examples use default branch `master`.

### 1. Publish Once Manually

Skip this step if your package is already published. Otherwise, prepare version `0.1.0` and dated changelog notes through your normal review process. From the clean merged checkout:

```sh
npm test
npm run lint
npm pack --json
tar -tzf YOUR_PACKAGE-0.1.0.tgz
```

Use the actual tarball filename printed by `npm pack`, especially for scoped packages. Test that exact archive in an isolated consumer before publishing it. With release approval, authenticate and publish that same file:

```sh
npm login --registry=https://registry.npmjs.org
npm publish ./YOUR_PACKAGE-0.1.0.tgz --access public --ignore-scripts --registry=https://registry.npmjs.org
npm view YOUR_PACKAGE@0.1.0 version dist.integrity dist.shasum --json --registry=https://registry.npmjs.org
```

Complete browser 2FA yourself. Compare the registry checksums with `npm pack` output and retain the archive. Create the matching Git tag/GitHub Release only with approval; never overwrite a published version or tag.

### 2. Configure GitHub

In **Settings → Environments**, create `release` and allow deployments only from `master` (or your actual default branch).

Have an authorized administrator allow the workflow to push release/next-version commits and release tags. Remove blocking PR requirements, but keep force-push/deletion protections and no bypass actors. This allows fast-forward direct pushes by **all writers**, not only Actions; ordinary development should still use PRs.

### 3. Configure Trusted Publishing

Authenticate to npm, then add and inspect the publisher:

```sh
npm trust github YOUR_PACKAGE --repo YOUR_OWNER/YOUR_REPO --file release.yml --env release --allow-publish --registry=https://registry.npmjs.org
npm trust list YOUR_PACKAGE --json --registry=https://registry.npmjs.org
```

Use the calling workflow's filename, not the reusable workflow's filename. Check that the saved owner, repository, filename, environment, and direct-publish permission match. Do not add an npm token or `NODE_AUTH_TOKEN` to GitHub secrets. A new publisher must successfully publish within [two days](https://docs.npmjs.com/trusted-publishers/), so configure it when you are ready for the next release.

### 4. Release From Actions

Add your release notes, merge them, and run tests/lint. For the next patch after manual `0.1.0`, dispatch:

```sh
gh workflow run release.yml --repo YOUR_OWNER/YOUR_REPO --ref master -f version=0.1.1
gh run list --repo YOUR_OWNER/YOUR_REPO --workflow release.yml --limit 5
npm view YOUR_PACKAGE@0.1.1 version dist.integrity dist.shasum --json --registry=https://registry.npmjs.org
```

Use your actual next unpublished version. After preparation, verify the run summary, matching GitHub tag/release, and registry checksums against the retained artifact. A dispatch is not confirmation of publication; inspect [recovery evidence](#recovery) before retrying a failed or ambiguous run.

## CLI

```sh
npm exec --offline -- npr --help
npm exec --offline -- npr release
npm exec --offline -- npr release --version 1.2.3 --config npr.config.js
npm exec --offline -- npr prepare --artifacts /path/to/artifacts
npm exec --offline -- npr verify --artifacts /path/to/retained-artifacts
```

`--offline` prevents npm from downloading missing release tooling; install the package first. It does not make the release offline: child commands discard inherited npm-exec lookup flags so validation and consumer installs can access the registry. Explicit child-command flags such as `npm install --offline` still apply.

`release` publishes and pushes: obtain authorization and configure authentication first. It releases the checked-in version unless `--version` selects a numeric version, then prepares the next patch version. `--config` defaults to `npr.config.js`; use an ESM file (`.mjs` when the consumer declares CommonJS). `--artifacts` overrides the default Git-metadata directory. Empty version/artifact values are treated as unset. Put artifacts outside the source tree or in an ignored directory.

Those version/next-development defaults describe `ReleaseWorkflow`. Export `new SemanticReleaseWorkflow()` to opt into Conventional Commits versioning and generated notes instead; it leaves next-development preparation disabled unless configured. See [Semantic Releases](semantic.md) for policies and replacement classes. The same CLI commands and Actions inputs apply.

`verify` reads `release.json` and its archive, checks the remote lightweight release tag and explicit registry version, and never publishes, commits, pushes, or creates hosted releases. Supply the complete retained directory; do not substitute a rebuilt archive.

`prepare` stops after validation, archive construction, local tagging, and bundle creation, without publishing or pushing. Preserve the entire directory durably before invoking `release` with the same intended checkout and inputs. Release independently repeats preparation and reconciles matching outputs; there is no restoration command. Both accept `--config`, `--version`, and `--artifacts`; see [Recovery and Reconciliation](recovery.md).

Help/version and phase reports go to standard output. Errors go to standard error with exit status 1, including captured standard output from failed child commands so test failures remain visible. Success, including visibility timeout with an explicitly unverified result, returns 0. Machine-readable state belongs in `release.json`, not parsed human log lines. Reports follow lifecycle order; there is no sorting, deduplication, or source-location diagnostic format. Unknown options/positionals fail; standalone `--help`/`--version` cannot be combined, and `verify` rejects release-only options.

Representative release output:

```text
[npr] prepared: example@0.1.0
[npr] validating: example@0.1.0
[npr] validated: example@0.1.0
[npr] building: example@0.1.0
[npr] built: example@0.1.0
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
| `branch` | Actions default branch or remote symbolic HEAD | Must match the checked-out branch; remote changes must be compatible with the intended release. |
| `remote` | `origin` | Named Git remote, used for concurrency checks and atomic pushes. |
| `repository` | `Git` | A `ReleaseRepository` instance; default Git uses `branch`/`remote`. |
| `host` | `GitHubReleaseHost` | A `ReleaseHost` instance or `null` to disable hosting. Default GitHub owner/repository comes from the manifest's HTTPS repository URL. |
| `timezone` | `NPR_TIMEZONE` or `UTC` | Named timezone for calendar dates and command/Git timestamps. |
| `prepare` | No additional edits | Trusted release edits after version/changelog preparation. |
| `validator` | `new HookValidator()` | A `ReleaseValidator` instance. `HookValidator({ validate, validateArtifact })` adapts optional checks; default validation runs npm tests/lint for release and next-development files. |
| `next` | No additional edits | Trusted next-development edits after the patch increment. |
| `verifier` | `RegistryVisibility` | A `RegistryVerifier` instance. `new RegistryVisibility(publisher, { attempts: 6, delay: 10000 })` configures bounded lookups; at most 60 attempts and delay up to 60000 milliseconds. |
| `versions` | `NumericPatchVersions` | A `VersionPolicy` instance selecting the release and next-development versions. |
| `project`, `publisher`, `store` | Built-in npm project/publisher and directory store | Instances implementing the [service contracts](workflows.md#replace-services). |
| `provider` | Scoped local/GitHub detection | An `ExecutionProvider` instance; per-run selection takes precedence. |

Hooks receive a frozen context with `cwd`, `version`, `releasedVersion`, `previousVersion`, `date` (`YYYY-MM-DD`), `phase`, and `run(program, argumentArray, options)`. Artifact hooks additionally receive `archive` and `consumer`. Next hooks/validation see the development version as `version` and an empty `PACKAGE_ARCHIVE` in command environments. `run` returns standard output, rejects nonzero exits, defaults to a 120-second timeout, and accepts `cwd`, `env`, and `timeout` overrides. npm lookups use a shorter timeout and disable fetch retries; only explicit missing-version responses are retried.

Hooks also receive `execution`, a provider-neutral immutable snapshot with release data, the logical step, observed history, and allowlisted run metadata. A configuration `observer` class supplies structured success/failure notifications, including failures before initialization. See [Execution Providers and Contexts](execution.md).

For the default `KeepAChangelog`, use `## [Unreleased]` with real notes; releases use `## [0.1.0] - YYYY-MM-DD`. Standard `[Unreleased]: https://github.com/owner/repo/compare/v0.0.1...master` links are updated without rewriting unrelated Markdown. `new IntrideaChangelog()` instead uses `## 0.1.0 (Next)` with real notes and at least one `- Your contribution here.` placeholder; releases use `## 0.1.0 (YYYY/MM/DD)`. See [Changelog Templates](changelogs.md) for optional prompts/category templates and categorized Intridea sections. Empty sections fail before publication. Custom `Changelog.release`/`next` methods receive the invocation's `cwd` alongside version/date data.

## JavaScript API

```js
import { release, verify } from "npm-package-release";
import workflow from "./npr.config.js";

await release(workflow, { version: "1.2.3" });
await verify();
```

The default release and verification return retained state snapshots. A custom workflow returns its final step's output. The release API requires a workflow instance; there is no configuration-object adapter. Options include `cwd`, `artifacts`, `log`, scoped `env`, and an argument-based asynchronous `run` executor (default: public system commands). Alternate executors support isolated integrations; they are trusted code. `releaseChangelog(source, { format, version, date })` returns `{ source, notes }`; `nextChangelog(source, { format, version, releasedVersion })` returns the next source text. These pure Markdown functions retain an explicit format argument; it is not a workflow option. Public TypeScript declarations include step, context, service, and workflow contracts without requiring TypeScript at runtime.

## GitHub Actions

Copy [the caller example](../examples/release.yml) to the consumer's `.github/workflows/release.yml`. It uses `workflow_dispatch`, grants `contents: write` and `id-token: write`, and calls this repository's reusable `release.yml` at the matching release tag. Keep `npm-package-release@0.2.0` installed in the caller's locked development dependencies.

The reusable workflow accepts `node-version` (26), `npm-version` (12), `config` (`npr.config.js`), optional `version`, `timezone` (UTC), and `build` (`false`). Runtime/tooling versions must be compatible with each other and the caller's package. It runs only for manual dispatch on the default branch, uses the `release` environment and repository-level concurrency, installs dependencies without caching, configures Git identity, prepares the release, requires a successful artifact upload, then runs release with the original inputs. It always attempts a separate diagnostic-artifact upload.

Set `build: true` to run `npm run build` after dependency installation and before invoking the CLI. This library's own [self-release caller](../.github/workflows/self-release.yml) uses that option to build and release the checkout through the same reusable workflow. Consumers using the installed package normally leave it `false`.

For step-based integration, adapt the [composite caller example](../examples/action-release.yml), using `dblock/npm-package-release@v0.2.0` after checking out the attached default branch with full history, setting up compatible Node/npm, installing dependencies, and configuring Git identity. Its inputs are `config`, optional `version`, and `timezone`. The caller must supply manual-dispatch/default-branch guards, the `release` environment, contents/OIDC permissions, and non-canceling release concurrency; the composite action uses the same upload gate and failure-aware diagnostic upload. It does not configure repository protections or npm credentials. Both Actions interfaces require a workflow instance implementing prepare/run.

Follow [New Project Setup](#new-project-setup) for staged or manual bootstrap, GitHub environment and branch rules, exact npm Trusted Publisher fields, and dispatch/verification. Existing packages skip only bootstrap. [RELEASING](../RELEASING.md) instead describes maintaining this tool's own package, not setting up your consumer project.

Release commits and tags require direct-push permission on the default branch. Configure that only with explicit authorization, retaining force-push/deletion protections and recognizing that removing a PR requirement permits direct pushes by all writers, not only this workflow. The tool does not change repository protections itself.

## Recovery

Never blindly rerun publication. Inspect `release.json` (phase, identity, refs, integrity, verification, and error), retained archive, notes, and `release.bundle` (plus `next.bundle` when the development commit was prepared); then inspect registry metadata, remote refs, and hosted releases. A `publishing` phase can mean acceptance followed by a transport failure, so an error is not proof that npm rejected the upload. A published archive cannot be replaced.

After inspection and explicit recovery authorization, rerun the affected operations from the intended checkout and inputs. Preparation reuses a matching tagged tree and reproducibly rebuilds the archive; publication compares both registry checksums before deciding whether an upload is missing. Diagnostic phase flags never skip work. Do not move release tags, overwrite evidence, or alter a build to hide a checksum mismatch. `npr verify --artifacts PATH` rechecks without mutation, even after the manifest advances. Existing artifact directories are reusable, but existing archive bytes must match. See [Recovery and Reconciliation](recovery.md) for input transport, advanced-checkout limits, and operator-managed recovery.

Visibility timeout records `verification: "unverified"` and “release could not be verified,” without blocking hosted-release creation or next-development preparation. A later verify command may confirm propagation. Authentication, network, malformed metadata, identity, and integrity failures remain errors. Registry visibility checks do not prove live OIDC configuration. Actions artifact preservation precedes publication, but retention expiry and local-only artifact loss still require operator planning.
