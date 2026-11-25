# Detailed Usage

## Requirements

The default workflow uses one public root npm package on `registry.npmjs.org`, Node.js 22.14+, 24, or 26+, Git, and npm with Trusted Publishing support (11.5.1+; the workflow defaults to Node.js 26/npm 12). GitHub Releases additionally require `gh` and `GH_TOKEN`. A manifest must have a numeric version, no workspaces, and an optional matching `package-lock.json`. Built-in services do not support alternate registries, prerelease versions/channels, or workspace publication; [custom workflows](workflows.md) can supply their own classes and contracts. A project that is not published to a registry can [release only as a GitHub Release](#releases-without-a-registry), including [JavaScript GitHub Actions](#github-actions-releases).

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

Have an authorized administrator allow the workflow to push release/next-version commits and release tags (and update `vX`/`vX.Y` tags when using [floating tags](#floating-tags)). Remove blocking PR requirements, but keep force-push/deletion protections and no bypass actors. This allows fast-forward direct pushes by **all writers**, not only Actions; ordinary development should still use PRs.

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

`verify` reads `release.json` and its archive, checks the remote lightweight release tag and explicit registry version (skipped for [releases without a registry](#releases-without-a-registry)), and never publishes, commits, pushes, or creates hosted releases. Supply the complete retained directory; do not substitute a rebuilt archive.

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
| `versionReferences` | None | Files or globs mapped to regular expressions whose `version` group follows the package version in the release and next-development commits; see [Version References](#version-references). |
| `releaseReferences` | None | Files or globs mapped to regular expressions whose `version` group is set to the released version in both commits; see [Version References](#version-references). |
| `floatingTags` | None | `["major", "minor"]` or `["major"]` moves `vX` and `vX.Y`, or only `vX`, to each release; see [Floating Tags](#floating-tags). |
| `prepare` | No additional edits | Trusted release edits after version/changelog preparation. |
| `validator` | `new HookValidator()` | A `ReleaseValidator` instance. `HookValidator({ validate, validateArtifact })` adapts optional checks; default validation runs npm tests/lint for release and next-development files. |
| `next` | No additional edits | Trusted next-development edits after the patch increment. |
| `verifier` | `RegistryVisibility` | A `RegistryVerifier` instance. `new RegistryVisibility(publisher, { attempts: 6, delay: 10000 })` configures bounded lookups; at most 60 attempts and delay up to 60000 milliseconds. Omit it, or pass `null`, when `publisher` is `null`. |
| `versions` | `NumericPatchVersions` | A `VersionPolicy` instance selecting the release and next-development versions. |
| `project`, `publisher`, `store` | Built-in npm project/publisher and directory store | Instances implementing the [service contracts](workflows.md#replace-services). `publisher: null` releases [without a registry](#releases-without-a-registry). |
| `provider` | Scoped local/GitHub detection | An `ExecutionProvider` instance; per-run selection takes precedence. |

Hooks receive a frozen context with `cwd`, `version`, `releasedVersion`, `previousVersion`, `date` (`YYYY-MM-DD`), `phase`, and `run(program, argumentArray, options)`. Artifact hooks additionally receive `archive` and `consumer`. Next hooks/validation see the development version as `version` and an empty `PACKAGE_ARCHIVE` in command environments. `run` returns standard output, rejects nonzero exits, defaults to a 120-second timeout, and accepts `cwd`, `env`, and `timeout` overrides. npm lookups use a shorter timeout and disable fetch retries; only explicit missing-version responses are retried.

Hooks also receive `execution`, a provider-neutral immutable snapshot with release data, the logical step, observed history, and allowlisted run metadata. A configuration `observer` class supplies structured success/failure notifications, including failures before initialization. See [Execution Providers and Contexts](execution.md).

For the default `KeepAChangelog`, use `## [Unreleased]` with real notes; releases use `## [0.1.0] - YYYY-MM-DD`. Standard `[Unreleased]: https://github.com/owner/repo/compare/v0.0.1...master` links are updated without rewriting unrelated Markdown. `new IntrideaChangelog()` instead uses `## 0.1.0 (Next)` with real notes and at least one `- Your contribution here.` placeholder; releases use `## 0.1.0 (YYYY/MM/DD)`. See [Changelog Templates](changelogs.md) for optional prompts/category templates and categorized Intridea sections. Empty sections fail before publication. Custom `Changelog.release`/`next` methods receive the invocation's `cwd` alongside version/date data.

## Version References

`versionReferences` and `releaseReferences` keep other files in step with the package version. Each maps a file path or glob to an array of regular expressions, and each expression must capture the version in a named group `version`:

```js
import { ReleaseWorkflow } from "npm-package-release";

export default new ReleaseWorkflow({
  versionReferences: {
    "public/manifest.json": [/"version": "(?<version>\d+\.\d+\.\d+)"/u],
  },
  releaseReferences: {
    "README.md": [/npm install example@(?<version>\d+\.\d+\.\d+)/u],
    "docs/**/*.md": [/example@(?<version>\d+\.\d+\.\d+)(?![\w.+-])/u],
  },
});
```

`versionReferences` follow the package version: the release commit gets the released version and the next-development commit gets the next version, as for a browser extension's `manifest.json`. `releaseReferences` are set to the released version in both commits, as for install snippets that should always name a published version. `SemanticReleaseWorkflow` accepts both options; without next-development preparation only the release commit is updated.

Paths are relative to the repository root and use `/` separators on every platform. A path with glob characters (`*`, `?`, `[...]`, `{a,b}`) matches tracked files, including hidden files, and may match nothing. A literal path must name an existing regular file inside the repository. Absolute paths, `..`, backslashes, and `.git` paths are rejected. A file selected by several entries gets all their patterns in order, `versionReferences` first.

Every pattern replaces each of its matches and must match at least once in every file it selects. Only the `version` captures change; other bytes, including line endings, are preserved. Files must be UTF-8 text. All files are read and every pattern is matched before any file is written, so a missing literal path, unmatched pattern, or missing capture fails without changing reference files. Replacing a capture with the version it already has is a no-op, so repeated preparation yields the same tree.

Options are validated when the workflow is constructed. The workflow keeps frozen copies of the maps and arrays, with new regular expressions that drop `g`, `y`, and `d`; later changes to the original objects have no effect. Updates run inside trusted staging, right after the package version changes and before the changelog, so they land in the release and next-development commits.

## Releases Without a Registry

Set `publisher: null` for a project whose GitHub Release is its only destination:

```js
import { IntrideaChangelog, ReleaseWorkflow } from "npm-package-release";

export default new ReleaseWorkflow({
  changelog: new IntrideaChangelog(),
  publisher: null,
});
```

The release still validates, commits, builds, and checks the archive, tags and pushes the release commit, creates the GitHub Release with that archive attached, and prepares the next development version. It never looks up, publishes to, or waits for npm, and `publish` lifecycle hooks do not run. The output omits the `publishing` and `published` phases.

A release without a registry requires a host: the default `GitHubReleaseHost` or your own `ReleaseHost`. `host: null` and a registry `verifier` fail when the workflow is constructed. `SemanticReleaseWorkflow` accepts the same option.

`release.json` records `registry: false`. `npr verify` then checks the retained archive and the remote release tag, records `verified`, and writes a job summary without a registry lookup. Recovery reconciles Git refs and the hosted asset checksum as usual; there is no registry state to inspect.

npm Trusted Publishing is not needed, so skip [Configure Trusted Publishing](#3-configure-trusted-publishing) and the npm bootstrap. The reusable workflow still declares `contents: write` and `id-token: write`, so keep both permissions in its caller; GitHub rejects a caller that grants less than a reusable workflow requests. No built-in step requests an OIDC token without a registry. The `release` environment and direct-push branch rules still apply.

The built-in `NpmPackage` project still rejects private packages and builds an npm tarball, which becomes the attached asset. Use [`ZipArchive`](#zip-archives) to attach a zip of a build directory instead.

## Zip Archives

`ZipArchive` is a project that releases a zip of a build directory, such as a browser extension, instead of an npm tarball. Combine it with `publisher: null` and a GitHub Release. For example, `npr.config.js` for a private browser extension built into `build/`, with a `public/manifest.json` version and an Intridea changelog using `*` bullets:

```js
import { IntrideaChangelog, ReleaseWorkflow, ZipArchive } from "npm-package-release";

export default new ReleaseWorkflow({
  changelog: new IntrideaChangelog("CHANGELOG.md", { placeholder: "* Your contribution here." }),
  project: new ZipArchive({ build: ["npm", "run", "build"], directory: "build", name: "example-extension" }),
  publisher: null,
  versionReferences: {
    "public/manifest.json": [/"version": "(?<version>\d+\.\d+\.\d+)"/u],
  },
});
```

Its caller `.github/workflows/release.yml`:

```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      version:
        description: Optional numeric release version.
        type: string
        required: false

permissions:
  contents: write
  id-token: write

jobs:
  release:
    name: Release Extension
    uses: dblock/npm-package-release/.github/workflows/release.yml@v0.2.0
    with:
      version: ${{ inputs.version }}
```

Install `npm-package-release@0.2.0` as an exact development dependency, set the HTTPS GitHub `repository` URL in `package.json` (or pass `host: new GitHubReleaseHost(run, "owner/repo")`), ignore the build directory in `.gitignore`, and create the `release` environment and direct-push branch rules from [New Project Setup](#2-configure-github). No npm setup is needed. A release then runs `npm test` and `npm run lint`, sets the version in `package.json`, `package-lock.json`, and `public/manifest.json`, builds, zips, tags, pushes, attaches `example-extension-v1.0.0.zip` to the `v1.0.0` GitHub Release, and prepares `1.0.1` with a new `## 1.0.1 (Next)` section.

| Option | Default | Behavior |
| --- | --- | --- |
| `build` | `["npm", "run", "build"]` | Program and arguments run without a shell from the repository root, with the release environment including `SOURCE_DATE_EPOCH`, each time the archive is built. |
| `directory` | `build` | Relative directory, with `/` separators, whose files are zipped with paths relative to it. It must be inside the project and should be ignored by Git, since a build that changes tracked or unignored files fails. |
| `name` | Package name, with a scope's `@` removed and `/` replaced by `-` | Filename prefix; the archive is `NAME-vVERSION.zip`, matching the `vVERSION` release tag. |

`ZipArchive` reads `package.json` like `NpmPackage`, requiring a valid name and numeric version but allowing `"private": true`, and rejects workspaces. It updates `package.json` and an optional matching `package-lock.json` the same way.

Archives are byte-reproducible: entries are sorted by path, every entry is a deflated file with mode `0644` and the `SOURCE_DATE_EPOCH` timestamp (as a DOS time in UTC, no earlier than 1980), and there are no directory entries, extra fields, or comments. Compression uses the zlib built into Node.js, so rebuild with the same Node.js version to reproduce the same bytes; the reusable workflow does so for prepare and release. The build directory must contain at least one file and no empty directories, Git metadata, sockets, or similar files. Symbolic links to files inside the directory are stored as regular files; links that escape it, dangle, or point to directories fail.

Instead of installing an npm package, the artifact check reads the zip, verifies every entry's checksum, requires its files and contents to match the built directory exactly, extracts it into a temporary directory, and passes that directory to `validateArtifact` as `consumer`. Recovery and `npr verify` compare the retained zip's SHA-512 `integrity` and SHA-1 `shasum` like an npm tarball; `npr verify` recognizes a retained `.zip` and checks it without a build. Projects can implement the optional `bind({ cwd, run, env })` method, as `ZipArchive` does, to receive each invocation's directory, command runner, and environment.

## GitHub Actions Releases

`GitHubAction` is a project that releases a JavaScript GitHub Action whose runnable code is build output, such as an `ncc` bundle in a gitignored `dist/`. Actions run from a Git ref, so the shipped artifact is a commit: each release adds a *build commit* on top of the release commit and tags it, while the default branch keeps only source. Combine it with `publisher: null` and a GitHub Release. For example, `npr.config.js` for a private action with an `action.yml` whose `runs.main` is `dist/index.js`, an Intridea changelog using `### 1.0.0 (Next)` headings and `*` bullets, and a `main` default branch:

```js
import { GitHubAction, IntrideaChangelog, ReleaseWorkflow } from "npm-package-release";

export default new ReleaseWorkflow({
  changelog: new IntrideaChangelog("CHANGELOG.md", { placeholder: "* Your contribution here." }),
  project: new GitHubAction({ build: ["npm", "run", "build"], output: ["dist"], name: "example-action" }),
  publisher: null,
  floatingTags: ["major", "minor"],
});
```

Its caller `.github/workflows/release.yml`:

```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      version:
        description: Optional numeric release version.
        type: string
        required: false

permissions:
  contents: write
  id-token: write

jobs:
  release:
    name: Release Action
    uses: dblock/npm-package-release/.github/workflows/release.yml@v0.2.0
    with:
      version: ${{ inputs.version }}
```

Install `npm-package-release@0.2.0` as an exact development dependency, set the HTTPS GitHub `repository` URL in `package.json` (or pass `host: new GitHubReleaseHost(run, "owner/repo")`), keep the build output in `.gitignore`, and create the `release` environment and direct-push branch rules from [New Project Setup](#2-configure-github) for your actual default branch. No npm setup is needed. Dispatching the workflow from `main` releases `1.0.0`:

1. Run `npm test` and `npm run lint`, set the version in `package.json` and `package-lock.json`, date `### 1.0.0 (Next)`, and commit `Prepare release 1.0.0` on `main`.
2. Run the build, then create the build commit `Build release 1.0.0`: its only parent is the release commit and its tree is the release tree plus every file in `output`, added even though they are ignored. `action.yml` is unchanged.
3. Zip `action.yml` and the build output as `example-action-v1.0.0.zip`, check that zip against the build commit, and pass its extracted files to `validateArtifact` as `consumer`, where the entry point can run.
4. Tag `v1.0.0` at the build commit and atomically push `main` (the release commit) and the tag, without force. The branch never contains the build commit.
5. Create the `v1.0.0` GitHub Release with the zip attached, create or move the [floating tags](#floating-tags) `v1` and `v1.0` to the build commit, then commit `Prepare next development iteration, 1.0.1` on top of the release commit with a new `### 1.0.1 (Next)` section and push `main`.

Workflows reference the action as `owner/example@v1`, `owner/example@v1.0`, or `owner/example@v1.0.0`. The `v1.0.0` release tag is never moved; omit `floatingTags` to publish only exact tags, or use `["major"]` to move only `v1`.

| Option | Default | Behavior |
| --- | --- | --- |
| `build` | `["npm", "run", "build"]` | Program and arguments run without a shell from the repository root, with the release environment including `SOURCE_DATE_EPOCH`, each time the build commit is created. |
| `output` | `["dist"]` | Relative paths that do not overlap, with `/` separators, added to the build commit. They must be ignored and untracked in the release commit, exist after the build, and contain only regular files. |
| `name` | Package name, with a scope's `@` removed and `/` replaced by `-` | Filename prefix; the archive is `NAME-vVERSION.zip`, matching the `vVERSION` release tag. |

The release commit must contain exactly one `action.yml` or `action.yaml` declaring `runs.using: nodeNN` and `runs.main`. `runs.main` and the optional `runs.pre` and `runs.post` must name files in the build output; a missing entry point fails before tagging. Composite and Docker actions are not supported. `GitHubAction` reads `package.json` like `ZipArchive`, allowing `"private": true` and rejecting workspaces.

The build commit is reproducible: its author, committer, and both dates come from the release commit (using its committer date), its message is fixed, and it is not signed, so preparation, release, and any later rebuild of the same release commit with the same output produce the same commit. The zip uses the same deterministic format as [`ZipArchive`](#zip-archives), timestamped with the committer date of the release commit. The build must also be deterministic: install locked dependencies and use the same Node.js version, as the reusable workflow does for prepare and release.

Reruns reconcile outputs like other releases. A release tag at a build commit identifies its parent as the release commit, so a matching rerun reuses the release commit, recreates the same build commit, and reuses the tag, push, and hosted release. A build that produces different output conflicts with the existing archive or tag and fails; tags are never overwritten. `release.json` records the build commit as `artifact.commit`, and `npr verify` checks the retained zip and that the remote `vVERSION` tag points at that commit. `SemanticReleaseWorkflow` rejects `GitHubAction`, since its release tags are not reachable from the default branch history.

To migrate from a workflow that builds and moves tags when a GitHub Release is published, remove that workflow and its scripts: a release created with the Actions token does not trigger other workflows, the tag already points at the build commit, and `floatingTags` moves `vX` and `vX.Y`. This tool does not publish releases to GitHub Marketplace.

## Floating Tags

Set `floatingTags` to move floating version tags to each release, as GitHub Actions commonly publish `owner/example@v1` alongside `owner/example@v1.2.3`. List the tags to move: `["major", "minor"]` moves `vX` and `vX.Y`, and `["major"]` moves only `vX`. The option is off by default, so no floating tags move.

```js
import { GitHubAction, IntrideaChangelog, ReleaseWorkflow } from "npm-package-release";

export default new ReleaseWorkflow({
  changelog: new IntrideaChangelog("CHANGELOG.md", { placeholder: "* Your contribution here." }),
  project: new GitHubAction({ name: "example-action" }),
  publisher: null,
  floatingTags: ["major", "minor"],
});
```

Moving tags is an explicit exception to the rule that release tags never move; it applies only to these two names, derived from the numeric released version. After the GitHub Release is created at the pushed and verified `vX.Y.Z` tag, the `floating-tags` step points each listed tag at the commit of that release tag (the build commit for a `GitHubAction`). Releasing `1.2.3` with `["major", "minor"]` creates or moves `v1` and `v1.2`; `v1.2.3` itself never moves, and the release tag push remains non-forced.

A floating tag never moves backwards. When it already exists, the step reads the highest release tag in its line (`vX.*.*` for `vX`, `vX.Y.*` for `vX.Y`) at the same commit; a tag at a later release stays where it is, and the step fails without changes when no such release tag identifies the commit, so you can inspect it. For example, a maintenance release `1.0.4` after `1.1.0` moves `v1.0` and leaves `v1` at `1.1.0`. Tags already at the release commit are reused without a push. Moves use one atomic push with a lease on each tag's current value, so a concurrent change fails instead of being overwritten.

`release.json` records the tags that point at the release as `floatingTags`, such as `["v1", "v1.2"]`, omitting tags kept at a later release. `npr verify` checks that each one points at this release or a later release in its line, since later releases move them. The option is validated when the workflow is constructed: it must be a nonempty list of distinct `"major"` and `"minor"` entries. Numeric release versions are never prereleases, so prerelease versions never move floating tags. `SemanticReleaseWorkflow` accepts the same option.

Switching from `["major", "minor"]` to `["major"]` leaves existing `vX.Y` tags at their last release; say so in your own release documentation so that users of `vX.Y` know to update. Moving tags requires that no tag ruleset blocks updates to `vX` and `vX.Y`.

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

After inspection and explicit recovery authorization, rerun the affected operations from the intended checkout and inputs. Preparation reuses a matching tagged tree and reproducibly rebuilds the archive; publication compares both registry checksums before deciding whether an upload is missing. Diagnostic phase flags never skip work. Do not move release tags (only configured [floating tags](#floating-tags) move), overwrite evidence, or alter a build to hide a checksum mismatch. `npr verify --artifacts PATH` rechecks without mutation, even after the manifest advances. Existing artifact directories are reusable, but existing archive bytes must match. See [Recovery and Reconciliation](recovery.md) for input transport, advanced-checkout limits, and operator-managed recovery.

Visibility timeout records `verification: "unverified"` and “release could not be verified,” without blocking hosted-release creation or next-development preparation. A later verify command may confirm propagation. Authentication, network, malformed metadata, identity, and integrity failures remain errors. Registry visibility checks do not prove live OIDC configuration. Actions artifact preservation precedes publication, but retention expiry and local-only artifact loss still require operator planning.
