# Lifecycle Hook Example

This example uses one [workflow builder](workflow.js) for the production [configuration](npr.config.js) and its [release tests](release.test.js). It updates this README during trusted prepare/next staging, manages changelog contribution templates, and checks the actual installed archive's API and README before publication.

## Release Status

Documentation for version 0.1.0.

## Usage

Install `npm-package-release@0.1.0` as a locked development dependency in your own package, copy the configuration/workflow files, and adapt the API checks and README wording to your project. Export a numeric package version, a public entry point and GitHub repository URL; package `index.js` and `README.md`. The fixture [check](check.js) verifies the README against the current manifest; use it in your own tests or replace it with project-specific validation.

Keep the [changelog](CHANGELOG.md) with meaningful notes and the configured prompts. Follow [Trusted Publishing setup](../../docs/usage.md#new-project-setup) before actual publication; copying this example does not configure credentials or authorize a release.

## Tests

Run `node --test examples/lifecycle-hooks/release.test.js` from this repository or the installed package directory. The tests import the same workflow builder, recursively copy the real example files without Git metadata, and supply local publication/hosting services from `npm-package-release/testing`. Their focused fixture test command runs only `check.js`, not the copied release spec.

The fixture's Git remote and archives are temporary and are cleaned up after each test. The tests cover the release-tag README, next-development README/categories, exact installed archive, failed publication, and independently repeated operations. Test adapters are explicit replacements, not a sandbox for arbitrary custom callbacks. See [Testing Custom Workflows](../../docs/testing.md).
