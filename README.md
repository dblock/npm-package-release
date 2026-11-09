# npm Package Release

[![Test](https://github.com/dblock/npm-package-release/actions/workflows/test.yml/badge.svg)](https://github.com/dblock/npm-package-release/actions/workflows/test.yml) [![Lint](https://github.com/dblock/npm-package-release/actions/workflows/lint.yml/badge.svg)](https://github.com/dblock/npm-package-release/actions/workflows/lint.yml) [![Package](https://github.com/dblock/npm-package-release/actions/workflows/package.yml/badge.svg)](https://github.com/dblock/npm-package-release/actions/workflows/package.yml) [![Coverage Status](https://coveralls.io/repos/github/dblock/npm-package-release/badge.svg?branch=master)](https://coveralls.io/github/dblock/npm-package-release?branch=master)

Reusable GitHub Actions workflows and JavaScript tooling for npm package releases, ported from [ruby-gem-release](https://github.com/dblock/ruby-gem-release).

**Scaffold only:** Release operations and Actions release interfaces are not implemented, and the package has not been published.

## Installation

Requires Node.js 22.14+, 24, or 26 and newer supported releases. Until publication, use the [local setup instructions](CONTRIBUTING.md#setup-and-validation).

## Usage

Only CLI help and version reporting are available from the source checkout:

```sh
node bin/npm-package-release.js --help
```

```text
Usage: npm-package-release [--help | --version]

Release commands are not implemented yet.
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [DESIGN.md](DESIGN.md), [CHANGELOG.md](CHANGELOG.md), [RELEASING.md](RELEASING.md), and [AGENTS.md](AGENTS.md).

## License

Distributed under the [MIT License](LICENSE).
