# Releasing

This guide covers maintaining `npm-package-release`. To configure your own package, follow [README](README.md#usage) and [Detailed Usage](docs/usage.md#new-project-setup). Consumer examples target `0.1.0`; this documentation does not authorize publication, credentials, tags, publisher setup, or protection changes.

## Version and Validation

Check actual registry status before choosing the next version; an authentication/network failure is not proof of availability. Never republish an existing version. Keep `package.json`, `package-lock.json`, and CHANGELOG synchronized using the policy in [AGENTS.md](AGENTS.md).

Run `npm ci`, `npm run test:coverage`, and `npm run lint`. Build an archive with `npm pack --json` (which compiles TypeScript), inspect compiled JavaScript, declarations, the file list, and package metadata, then run `PACKAGE_ARCHIVE=/absolute/path/package.tgz npm run test:package` to install and exercise that exact artifact with strict engines. Retain the archive and checksum through publication and verification; do not rebuild the archive between validation and publication. Packed consumers do not require a TypeScript compiler at runtime.

## Repository Release Configuration

The root [release configuration](https://github.com/dblock/npm-package-release/blob/master/npr.config.js) exports a numeric `ReleaseWorkflow` with an explicit `IntrideaChangelog` for this repository's existing notes. Consumer defaults use `KeepAChangelog`. A `HookValidator` runs this repository's tests and lint before publication and for the next development iteration; its artifact check executes a class-based workflow through the installed SDK and checks the installed `npr --version`. Both must report the selected archive version, not the checkout's original or next version. The built-in consumer installs that exact archive with strict engines and lifecycle scripts disabled.

Build before invoking the checkout's CLI with `node bin/npr.js`. The configuration is repository maintenance code, not a packaged default for consumers. Tests copy it unchanged into isolated SDK projects, simulate publication/hosting, and exercise both compiled source and the actual installed tarball. They do not publish this package or prove live authentication.

Do not invoke `release` or `prepare` as a read-only preview: they edit files and create local commits/tags, and `release` also publishes and pushes. The reusable `release.yml` accepts `workflow_call` for consumers and this library itself. This repository's manually dispatched `self-release.yml` calls it locally with `build: true`; there is no repository-variable gate. Do not dispatch until the setup below is verified and publication is explicitly authorized.

## Manual Publication

After explicit release authorization, prepare a release-metadata PR through normal review: select an unpublished version, synchronize the manifest/lockfile, date its changelog heading, and remove the placeholder. After merging, record the clean default-branch commit and save the reviewed notes alongside the retained archive.

Validate and inspect the exact archive as above. With publication approval, authenticate interactively on a maintainer machine and run `npm publish /absolute/path/package.tgz --access public --ignore-scripts`. Never request tokens or two-factor codes in chat. Verify the explicit registry name/version, SHA-512 integrity, and SHA-1 against retained pack metadata.

With tag/hosted-release approval, create the matching immutable tag at the recorded commit and a GitHub Release with the same notes/archive. Inspect existing outputs rather than moving tags, replacing assets, or republishing. Preserve the archive, pack metadata, notes, and commit identity durably.

After registry confirmation, use a follow-up PR for the next development version/changelog and updated documentation/example pins. Add an npm version badge linking to the actual package only after confirming publication; documentation pins alone are not verification.

## Trusted Publishing Setup

The [self-release caller](https://github.com/dblock/npm-package-release/blob/master/.github/workflows/self-release.yml) is implemented in advance of the initial publication. Before dispatching, verify the first manual release and explicitly authorize the publisher/environment/protection setup below. No enablement variable is required.

Configure a `release` environment restricted to the default branch and the npm GitHub Actions trusted publisher for owner `dblock`, repository `npm-package-release`, calling workflow filename `self-release.yml`, environment `release`, and direct `npm publish` permission. Both caller and reusable workflow grant `contents: write` and `id-token: write`; the reusable workflow uses a GitHub-hosted runner. npm checks the caller filename, not the called `release.yml`. Newly configured publishers must complete a successful publication within two days under the [current npm policy](https://docs.npmjs.com/trusted-publishers/); configuration alone does not prove OIDC works.

Use compatible current stable Node.js/npm tooling; npm 12 has a higher runtime floor than consumers. npm validates the calling workflow filename for reusable workflows, and both callers and called workflows need OIDC permission. Do not use `NODE_AUTH_TOKEN` or stored long-lived npm tokens. Trusted Publishing automatically supplies provenance for public packages from public GitHub repositories.

Before dispatching, explicitly authorize and remove PR requirements that block the workflow's release and next-development commits, retaining active force-push/deletion protections with no bypass actors. Inspect effective repository and inherited protections, not just one ruleset. This permits fast-forward direct pushes by all writers, not only the workflow; ordinary development still requires PRs. No publisher, environment, or protection change has been performed by implementing this workflow.

## Automated Self-release

After separate release authorization, dispatch **Release This Library** from `master`:

```sh
gh workflow run self-release.yml --ref master --repo dblock/npm-package-release
```

The caller forwards optional `version` and `timezone` (UTC) inputs to `./.github/workflows/release.yml` with `build: true`. That shared workflow owns default-branch/manual-dispatch guards, the release environment, permissions, concurrency, tooling, Git identity, artifact uploads, and publication. It installs Node.js 26/npm 12 and dependencies, builds this checkout, then invokes its own CLI through `npm exec --offline -- npr` with the root `npr.config.js`. It does not install a previously published copy of this library. Consumers leave `build` at its default `false` and use their installed tool.

Preparation validates tests/lint and the actual installed archive, then uploads recovery artifacts including hidden files before publication is allowed. Release independently repeats preparation using captured source/date/version inputs, requires an identical archive, publishes it, atomically pushes the release commit/tag, verifies remote refs, creates the GitHub Release, validates/pushes the next development iteration, and verifies the explicit published version and retained archive. The final artifact upload runs even after failure. Both uploads retain their files for 30 days; preserve them elsewhere before expiry when investigating an incomplete release.

The root configuration updates this package's installation, action, and reusable-workflow pins in README and `docs/**/*.md` during next-development preparation. Pins use the version just released, never the unreleased development version. Other packages/actions, prerelease references, examples, and non-Markdown files are unchanged; original line endings and surrounding content are preserved.

Local tests run the workflow's actual dependency-install, TypeScript-build, prepare, release, and verify commands against an isolated SDK checkout and Git remote. They copy the root release configuration unchanged, simulate only registry/hosting operations, retain artifacts before publication, and verify matching rebuilt bytes. They do not prove live OIDC, provenance, or Actions uploads.

## Verification and Recovery

Registry visibility can lag accepted publication. Retry only missing-version visibility with bounded waits after GitHub Release creation and next-development preparation. On timeout, retain a visible “release could not be verified” result and job summary without republishing. Authentication, network, malformed metadata, version mismatch, and integrity mismatch remain failures. Never use the now-advanced manifest or HEAD as the released identity.

Before retrying a failed release, inspect registry state, remote commits/tags, GitHub Releases, and retained archives, checksums, and recovery metadata. Complete only missing steps; never duplicate accepted publication or move a tag. Preserve hidden recovery files and record verification limits. Local simulations exercise publication ordering and recovery, not live OIDC or Actions artifact uploading.

The consumer Actions interfaces require a successful artifact upload before publication and preserve later diagnostics separately. Each operation reconciles current inputs and actual outputs, never a saved completion journal; local callers arrange their own durable storage. See [Recovery and Reconciliation](docs/recovery.md) for rerun guarantees and limits. This does not authorize dispatching or publishing this package itself.

For self-release recovery, download `npm-release-prepared-<run-id>-<run-attempt>` and preserve the separate `npm-release-<run-id>-<run-attempt>` diagnostics. Do not treat a fresh dispatch as automatic resumption. After inspection and explicit recovery authorization, reconstruct the intended checkout and inputs, build with `npm ci` and `npm run build`, then rerun the affected operations. A matching existing publication is reused; conflicting trees, archives, or refs fail. No command imports a downloaded bundle or rewinds development history. Use `node bin/npr.js verify --artifacts /absolute/path/to/downloaded-artifacts` for verification without publication or Git changes.
