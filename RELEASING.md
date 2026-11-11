# Releasing

This guide covers maintaining `npm-package-release`. To configure your own package, follow [README](README.md#usage) and [Detailed Usage](docs/usage.md#new-project-setup). Consumer examples target `0.1.0`; this documentation does not authorize publication, credentials, tags, publisher setup, or protection changes.

## Version and Validation

Check actual registry status before choosing the next version; an authentication/network failure is not proof of availability. Never republish an existing version. Keep `package.json`, `package-lock.json`, and CHANGELOG synchronized using the policy in [AGENTS.md](AGENTS.md).

Run `npm ci`, `npm run test:coverage`, and `npm run lint`. Build an archive with `npm pack --json` (which compiles TypeScript), inspect compiled JavaScript, declarations, the file list, and package metadata, then run `PACKAGE_ARCHIVE=/absolute/path/package.tgz npm run test:package` to install and exercise that exact artifact with strict engines. Retain the archive and checksum through publication and verification; do not rebuild the archive between validation and publication. Packed consumers do not require a TypeScript compiler at runtime.

## Repository Release Configuration

The root [release configuration](https://github.com/dblock/npm-package-release/blob/master/npr.config.js) exports a numeric `ReleaseWorkflow` with an explicit `IntrideaChangelog` for this repository's existing notes. Consumer defaults use `KeepAChangelog`. A `HookValidator` runs this repository's tests and lint before publication and for the next development iteration; its artifact check executes a class-based workflow through the installed SDK and checks the installed `npr --version`. Both must report the selected archive version, not the checkout's original or next version. The built-in consumer installs that exact archive with strict engines and lifecycle scripts disabled.

Build before invoking the checkout's CLI with `node bin/npr.js`. The configuration is repository maintenance code, not a packaged default for consumers. Tests copy it unchanged into isolated SDK projects, simulate publication/hosting, and exercise both compiled source and the actual installed tarball. They do not publish this package or prove live authentication.

Do not invoke `release` or `prepare` as a read-only preview: they edit files and create local commits/tags, and `release` also publishes and pushes. The reusable `release.yml` accepts `workflow_call`; it is not this repository's own manually dispatched publishing workflow. Self-publication automation still requires separate setup authorization.

## Manual Publication

After explicit release authorization, prepare a release-metadata PR through normal review: select an unpublished version, synchronize the manifest/lockfile, date its changelog heading, and remove the placeholder. After merging, record the clean default-branch commit and save the reviewed notes alongside the retained archive.

Validate and inspect the exact archive as above. With publication approval, authenticate interactively on a maintainer machine and run `npm publish /absolute/path/package.tgz --access public --ignore-scripts`. Never request tokens or two-factor codes in chat. Verify the explicit registry name/version, SHA-512 integrity, and SHA-1 against retained pack metadata.

With tag/hosted-release approval, create the matching immutable tag at the recorded commit and a GitHub Release with the same notes/archive. Inspect existing outputs rather than moving tags, replacing assets, or republishing. Preserve the archive, pack metadata, notes, and commit identity durably.

After registry confirmation, use a follow-up PR for the next development version/changelog and updated documentation/example pins. Add an npm version badge linking to the actual package only after confirming publication; documentation pins alone are not verification.

## Trusted Publishing Setup

After verifying the initial registry release, use a focused PR to configure a manually dispatched publishing workflow on a GitHub-hosted runner, a `release` environment restricted to the default branch, and `contents: write` / `id-token: write`. The existing reusable workflow must remain available to consumers. Set up the package's trusted publisher only with explicit authorization, for `dblock/npm-package-release`, the actual calling workflow filename, environment `release`, and direct `npm publish` permission. Newly configured publishers must complete a successful publication within two days under the [current npm policy](https://docs.npmjs.com/trusted-publishers/); configuration alone does not prove OIDC works.

Use compatible current stable Node.js/npm tooling; npm 12 has a higher runtime floor than consumers. npm validates the calling workflow filename for reusable workflows, and both callers and called workflows need OIDC permission. Do not use `NODE_AUTH_TOKEN` or stored long-lived npm tokens. Trusted Publishing automatically supplies provenance for public packages from public GitHub repositories.

Release automation is planned to publish the retained archive, atomically push the release commit/tag, verify remote refs, create the GitHub Release, validate/push the next development iteration, then verify the explicit published version and retained archive. Authorization to configure this direct-push flow includes removing PR requirements that block release commits while retaining force-push/deletion protections with no bypass actors. This permits fast-forward direct pushes by all writers, not only the workflow; ordinary development still requires PRs. No such setup or protection change is authorized yet.

## Verification and Recovery

Registry visibility can lag accepted publication. Retry only missing-version visibility with bounded waits after GitHub Release creation and next-development preparation. On timeout, retain a visible “release could not be verified” result and job summary without republishing. Authentication, network, malformed metadata, version mismatch, and integrity mismatch remain failures. Never use the now-advanced manifest or HEAD as the released identity.

Before retrying a failed release, inspect registry state, remote commits/tags, GitHub Releases, and retained archives, checksums, and recovery metadata. Complete only missing steps; never duplicate accepted publication or move a tag. Preserve hidden recovery files and record verification limits. Local simulations exercise publication ordering and recovery, not live OIDC or Actions artifact uploading.

The consumer Actions interfaces now require a successful immutable checkpoint upload before publication, then preserve later diagnostics separately. Explicit `npr complete` restores that checkpoint and reconciles actual outputs rather than trusting journal phases; local callers arrange their own durable storage. See [Checkpoints and Reconciliation](docs/checkpoints.md) for the contract and migration of custom run-only workflows. This does not authorize dispatching or publishing this package itself.
