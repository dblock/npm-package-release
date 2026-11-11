<img src="assets/logo.png" alt="A package box with an upward release arrow" width="160">

# npm Package Release

[![Test](https://github.com/dblock/npm-package-release/actions/workflows/test.yml/badge.svg)](https://github.com/dblock/npm-package-release/actions/workflows/test.yml) [![Lint](https://github.com/dblock/npm-package-release/actions/workflows/lint.yml/badge.svg)](https://github.com/dblock/npm-package-release/actions/workflows/lint.yml) [![Package](https://github.com/dblock/npm-package-release/actions/workflows/package.yml/badge.svg)](https://github.com/dblock/npm-package-release/actions/workflows/package.yml) [![Coverage Status](https://coveralls.io/repos/github/dblock/npm-package-release/badge.svg?branch=master)](https://coveralls.io/github/dblock/npm-package-release?branch=master)

**Release your npm package from GitHub Actions without maintaining custom release scripts or storing an npm publish token.**

One dispatch updates the changelog, tests and publishes the package, creates its GitHub Release, and prepares the next development iteration. Inspired by [ruby-gem-release](https://github.com/dblock/ruby-gem-release), with class-based, strongly typed workflow composition.

## Installation

Requires Node.js 22.14+ and npm 11.5.1+; the release workflow defaults to Node.js 26/npm 12.

```sh
npm install --save-dev --save-exact npm-package-release@0.1.0
```

The CLI is `npr`, but do not install the unrelated npm package `npr`.

## Usage

### 1. Configure Your Package

Create `npr.config.js`:

```js
import { KeepAChangelog, ReleaseWorkflow } from "npm-package-release";

export default new ReleaseWorkflow({
  changelog: new KeepAChangelog(),
});
```

Use a numeric package version, a GitHub `repository` URL, and a `CHANGELOG.md` with `## [Unreleased]` and real notes. `KeepAChangelog` is also the default when omitted. Default validation runs `npm test` and `npm run lint`. For CommonJS projects, use `npr.config.mjs` and set the workflow's `config` input accordingly.

### 2. Add the Release Workflow

Add `.github/workflows/release.yml` using the [caller example](examples/release.yml):

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
    uses: dblock/npm-package-release/.github/workflows/release.yml@v0.1.0
    with:
      version: ${{ inputs.version }}
```

Merge the caller and locked development dependency into your default branch. Upgrade the package and pinned workflow together.

### 3. Enable Trusted Publishing

In **your GitHub repository → Settings → Environments**, create `release`, restrict it to your default branch, and optionally require maintainer approval. Branch rules must allow release commits/tags to be pushed; see [setup and branch permissions](docs/usage.md#new-project-setup).

**New npm package:** First [bootstrap the package](docs/usage.md#first-publication) through npm staged publishing or publish a tested archive manually. Staging creates a public placeholder, not a name-only reservation; clear the pending candidate before direct publication. Then open your package on the [npm website](https://www.npmjs.com), select **Settings → Trusted publishing**, add a **GitHub Actions** publisher, and set:

| Field | Value |
| --- | --- |
| Organization or user | Your GitHub owner. |
| Repository | Your package's repository, not this tool's repository. |
| Workflow filename | `release.yml`, the caller filename only. |
| Environment name | `release`. |
| Allowed actions | Enable direct `npm publish`, not stage-only. |

No npm publish token or `NODE_AUTH_TOKEN` is needed. A new publisher must successfully publish within [two days](https://docs.npmjs.com/trusted-publishers/) or expire; configure it when you are ready to release.

### 4. Make a Release

Review your changes, run tests, and dispatch from your default branch:

```sh
gh workflow run release.yml
```

This publishes the checked-in version and prepares the next patch version. After a manual first publication, select a new unpublished version; pass `-f version=0.1.1` to override the checked-in version. Verify the run summary, registry version/checksums, and GitHub Release. Inspect [recovery artifacts](docs/recovery.md) before retrying a failed run.

## Configuration

See [Detailed Usage](docs/usage.md) for CLI/API commands and defaults; [Changelog Templates](docs/changelogs.md) for contribution prompts and categories; [Lifecycle Hooks](docs/hooks.md) for ordered stage extensions; [Composable Workflows](docs/workflows.md) for custom classes and services; and [Semantic Releases](docs/semantic.md) for opt-in Conventional Commits versioning and generated notes.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [DESIGN.md](DESIGN.md), [CHANGELOG.md](CHANGELOG.md), [RELEASING.md](RELEASING.md), [AGENTS.md](AGENTS.md), [Detailed Usage](docs/usage.md), [Changelog Templates](docs/changelogs.md), [Updating Markdown Sections](docs/markdown.md), [Testing Custom Workflows](docs/testing.md), the [Lifecycle Hook Example](examples/lifecycle-hooks/README.md), [Lifecycle Hooks](docs/hooks.md), [Composable Workflows](docs/workflows.md), [Execution Providers and Contexts](docs/execution.md), [Recovery and Reconciliation](docs/recovery.md), and [Semantic Releases](docs/semantic.md).

## License

Distributed under the [MIT License](LICENSE).
