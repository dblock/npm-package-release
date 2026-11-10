# npm Package Release

[![Test](https://github.com/dblock/npm-package-release/actions/workflows/test.yml/badge.svg)](https://github.com/dblock/npm-package-release/actions/workflows/test.yml) [![Lint](https://github.com/dblock/npm-package-release/actions/workflows/lint.yml/badge.svg)](https://github.com/dblock/npm-package-release/actions/workflows/lint.yml) [![Package](https://github.com/dblock/npm-package-release/actions/workflows/package.yml/badge.svg)](https://github.com/dblock/npm-package-release/actions/workflows/package.yml) [![Coverage Status](https://coveralls.io/repos/github/dblock/npm-package-release/badge.svg?branch=master)](https://coveralls.io/github/dblock/npm-package-release?branch=master)

Composable, strongly typed release workflows for npm, with a JavaScript API, CLI, and GitHub Actions interfaces, ported from [ruby-gem-release](https://github.com/dblock/ruby-gem-release).

Use the default workflow to validate and publish one archive, create its GitHub Release, and prepare the next development iteration, or compose your own workflow from class-based steps and replaceable service interfaces. This package has not had its first npm publication yet.

## Installation

Requires Node.js 22.14+, 24, or 26 and newer supported releases. Until publication, use the [local setup instructions](CONTRIBUTING.md#setup-and-validation).

## Usage

The CLI is named `npr`; the npm package remains `npm-package-release`. From this checkout:

```sh
npm run build
node bin/npr.js --help
```

```text
Usage: npr [--help | --version]

       npr release [--config npr.config.js] [--version X.Y.Z] [--artifacts PATH]
       npr verify [--artifacts PATH]
```

For consumers, configure the [release workflow](docs/usage.md#github-actions) and manually dispatch it after authorized Trusted Publishing setup. See [Detailed Usage](docs/usage.md) for CLI/API commands and recovery. Do not use bare `npx npr` to install this tool: that npm package belongs to an unrelated project.

## Configuration

Export a workflow from `npr.config.js`:

```js
import { ReleaseWorkflow } from "npm-package-release";

export default new ReleaseWorkflow({
  changelog: { format: "intridea" },
});
```

The default validation runs `npm test` and `npm run lint` before publication and for the next development iteration. [Composable Workflows](docs/workflows.md) explains custom classes and service injection; [Execution Providers and Contexts](docs/execution.md) covers platform metadata and notifications; [Detailed Usage](docs/usage.md#configuration) documents compatible configuration objects, hooks, and defaults.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [DESIGN.md](DESIGN.md), [CHANGELOG.md](CHANGELOG.md), [RELEASING.md](RELEASING.md), [AGENTS.md](AGENTS.md), [Detailed Usage](docs/usage.md), [Composable Workflows](docs/workflows.md), and [Execution Providers and Contexts](docs/execution.md).

## License

Distributed under the [MIT License](LICENSE).
