# Detailed Usage

## Requirements

The default workflow uses one public root npm package on `registry.npmjs.org`, Node.js 22.14+, 24, or 26+, Git, and npm with Trusted Publishing support (11.5.1+; the workflow defaults to Node.js 26/npm 12). GitHub Releases additionally require `gh` and `GH_TOKEN`. A manifest must have a numeric version, no workspaces, and an optional matching `package-lock.json`. Built-in services do not support alternate registries, prerelease versions/channels, or workspace publication; [custom workflows](workflows.md) can supply their own classes and contracts.

The package has not been published yet. Until its first release, build/install its local tarball using [CONTRIBUTING](../CONTRIBUTING.md#setup-and-validation). After publication, install `npm-package-release` as a development dependency, not the unrelated npm package `npr`. Prefer an exact reviewed version and commit the lockfile.

## CLI

```sh
npm exec --offline -- npr --help
npm exec --offline -- npr release
npm exec --offline -- npr release --version 1.2.3 --config npr.config.js
npm exec --offline -- npr verify --artifacts /path/to/retained-artifacts
```

`release` publishes and pushes: obtain authorization and configure authentication first. It releases the checked-in version unless `--version` selects a numeric version, then prepares the next patch version. `--config` defaults to `npr.config.js`; use an ESM file (`.mjs` when the consumer declares CommonJS). `--artifacts` overrides the default Git-metadata directory. Empty version/artifact values are treated as unset. Put artifacts outside the source tree or in an ignored directory.

`verify` reads `release.json` and its archive, checks the remote lightweight release tag and explicit registry version, and never publishes, commits, pushes, or creates hosted releases. Supply the complete retained directory; do not substitute a rebuilt archive.

Help/version and phase reports go to standard output. Errors go to standard error with exit status 1. Success, including visibility timeout with an explicitly unverified result, returns 0. Machine-readable state belongs in `release.json`, not parsed human log lines. Reports follow lifecycle order; there is no sorting, deduplication, or source-location diagnostic format. Unknown options/positionals fail; standalone `--help`/`--version` cannot be combined, and `verify` rejects release-only options.

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

Configuration is trusted JavaScript executed with release privileges, not untrusted data. Export a [composed workflow](workflows.md), `new ReleaseWorkflow(config, services)`, or a compatible configuration object as shown below. The object form is adapted to the default class-based workflow. All hooks are optional; hook failures stop the sequence. Choose a changelog format explicitly or use `changelog: null` to delegate release-note maintenance to your own steps or changelog service.

```js
export default {
  changelog: { format: "intridea", path: "CHANGELOG.md" },
  timezone: "UTC",
  async validate({ run }) {
    await run("npm", ["test"]);
    await run("npm", ["run", "lint"]);
  },
  async validateArtifact({ consumer, run }) {
    await run("node", ["--input-type=module", "--eval", 'import("example")'], {
      cwd: consumer,
    });
  },
};
```

Replace `example` with the package's public API and check its actual behavior. The built-in consumer always installs the exact archive with strict engines and lifecycle scripts disabled; `validateArtifact` runs inside that consumer before publication, without rebuilding.

| Option | Default | Behavior |
| --- | --- | --- |
| `changelog` | Required | `{ format: "intridea" }`, `{ format: "keep-a-changelog" }`, or explicit `null`; path defaults to `CHANGELOG.md`. |
| `branch` | Actions default branch or remote symbolic HEAD | Must match the checked-out branch and current remote tip. |
| `remote` | `origin` | Named Git remote, used for concurrency checks and atomic pushes. |
| `repository` | GitHub HTTPS URL in manifest metadata | Explicit `owner/repository` for GitHub Release creation. |
| `github` | `true` | Set `false` to disable hosted-release creation, not package publication. |
| `timezone` | `NPR_TIMEZONE` or `UTC` | Named timezone for calendar dates and command/Git timestamps. |
| `prepare` | No additional edits | Trusted release edits after version/changelog preparation. |
| `validate` | `npm test`, then `npm run lint` | Runs for release and next-development files; must not modify tracked/non-ignored files or the index. |
| `validateArtifact` | Strict consumer installation only | Check installed public behavior using `consumer` and the retained `archive`. |
| `next` | No additional edits | Trusted next-development edits after the patch increment. |
| `verification` | `{ attempts: 6, delay: 10000 }` | Fresh registry lookups; at most 60 attempts, with delay between 0 and 60000 milliseconds. |

Hooks receive a frozen context with `cwd`, `version`, `releasedVersion`, `previousVersion`, `date` (`YYYY-MM-DD`), `phase`, and `run(program, argumentArray, options)`. Artifact hooks additionally receive `archive` and `consumer`. Next hooks/validation see the development version as `version` and an empty `PACKAGE_ARCHIVE` in command environments. `run` returns standard output, rejects nonzero exits, defaults to a 120-second timeout, and accepts `cwd`, `env`, and `timeout` overrides. npm lookups use a shorter timeout and disable fetch retries; only explicit missing-version responses are retried.

Hooks also receive `execution`, a provider-neutral immutable snapshot with release data, the logical step, observed history, and allowlisted run metadata. A configuration `observer` class supplies structured success/failure notifications, including failures before initialization. See [Execution Providers and Contexts](execution.md).

For Intridea, use `## 0.1.0 (Next)` with real notes and exactly one `- Your contribution here.` placeholder. Releases use `## 0.1.0 (YYYY/MM/DD)`. For Keep a Changelog, use `## [Unreleased]` with real notes; releases use `## [0.1.0] - YYYY-MM-DD`. Standard `[Unreleased]: https://github.com/owner/repo/compare/v0.0.1...master` links are updated without rewriting unrelated Markdown. Empty sections fail before publication.

## JavaScript API

```js
import { release, verify } from "npm-package-release";
import config from "./npr.config.js";

await release(config, { version: "1.2.3" });
await verify();
```

The default release and verification return retained state snapshots. A custom workflow returns its final step's output. Options include `cwd`, `artifacts`, `log`, scoped `env`, and an argument-based asynchronous `run` executor (default: public system commands). Alternate executors support isolated integrations; they are trusted code. `releaseChangelog(source, { format, version, date })` returns `{ source, notes }`; `nextChangelog(source, { format, version, releasedVersion })` returns the next source text. These pure functions do not write files. Public TypeScript declarations include step, context, service, and workflow contracts without requiring TypeScript at runtime.

## GitHub Actions

Copy [the caller example](../examples/release.yml) to the consumer's `.github/workflows/release.yml`. It uses `workflow_dispatch`, grants `contents: write` and `id-token: write`, and calls this repository's reusable `release.yml`. The example currently references `master` because no release tag exists yet; pin a reviewed commit now and a reviewed immutable release tag when available. Keep `npm-package-release` installed in the caller's locked development dependencies.

The reusable workflow accepts `node-version` (26), `npm-version` (12), `config` (`npr.config.js`), optional `version`, and `timezone` (UTC). Runtime/tooling versions must be compatible with each other and the caller's package. It runs only for manual dispatch on the default branch, uses the `release` environment and repository-level concurrency, installs dependencies without caching, configures Git identity, invokes the CLI, and always attempts recovery-artifact upload.

For step-based integration, adapt the [composite caller example](../examples/action-release.yml), using `dblock/npm-package-release@<reviewed-commit>` after checking out the attached default branch with full history, setting up compatible Node/npm, installing dependencies, and configuring Git identity. Its inputs are `config`, optional `version`, and `timezone`. The caller must supply manual-dispatch/default-branch guards, the `release` environment, contents/OIDC permissions, and non-canceling release concurrency; the composite action runs the same CLI and failure-aware artifact upload. It does not configure repository protections or npm credentials.

Existing packages need an authorized npm Trusted Publisher for the calling repository, caller workflow filename `release.yml`, environment `release`, and direct `npm publish` permission. npm validates the calling workflow filename even when publication happens in a reusable workflow. Initial publication is manual before configuring Trusted Publishing; see [RELEASING](../RELEASING.md#subsequent-trusted-publishing). Do not use `npm whoami` as an OIDC permission check or store long-lived publish tokens.

Release commits and tags require direct-push permission on the default branch. Configure that only with explicit authorization, retaining force-push/deletion protections and recognizing that removing a PR requirement permits direct pushes by all writers, not only this workflow. The tool does not change repository protections itself.

## Recovery

Never blindly rerun publication. Inspect `release.json` (phase, identity, refs, integrity, verification, and error), retained archive, notes, and `release.bundle` (plus `next.bundle` when the development commit was prepared); then inspect registry metadata, remote refs, and hosted releases. A `publishing` phase can mean acceptance followed by a transport failure, so an error is not proof that npm rejected the upload. A published archive cannot be replaced.

Complete only missing push/hosting/next-development steps using the existing release commit, tag, and exact archive. Check the registry before any manual publication retry. Do not move release tags or rebuild an archive to match metadata. After downloading complete recovery artifacts, `npr verify --artifacts PATH` can recheck without republishing, even after the manifest advances. Before a later independent release, archive the previous local artifact directory and choose a new empty directory; the tool intentionally refuses existing artifacts.

Visibility timeout records `verification: "unverified"` and “release could not be verified,” without blocking hosted-release creation or next-development preparation. A later verify command may confirm propagation. Authentication, network, malformed metadata, identity, and integrity failures remain errors. Registry visibility checks do not prove live OIDC configuration, and runner loss before the always-upload step can still lose artifacts.
