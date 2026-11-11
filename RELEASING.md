# Releasing

This guide covers maintaining `npm-package-release`. To configure your own package, follow [README](README.md#usage) and [Detailed Usage](docs/usage.md#new-project-setup). Consumer examples target `0.1.0`; this documentation does not authorize staging, rejecting staged packages, publication, credentials, tags, publisher setup, or protection changes.

## Version and Validation

Check actual registry status before choosing the next version; an authentication/network failure is not proof of availability. Never republish an existing version. Keep `package.json`, `package-lock.json`, and CHANGELOG synchronized using the policy in [AGENTS.md](AGENTS.md).

Run `npm ci`, `npm run test:coverage`, and `npm run lint`. Build an archive with `npm pack --json` (which compiles TypeScript), inspect compiled JavaScript, declarations, the file list, and package metadata, then run `PACKAGE_ARCHIVE=/absolute/path/package.tgz npm run test:package` to install and exercise that exact artifact with strict engines. Retain the archive and checksum through publication and verification; do not rebuild the archive between validation and publication. Packed consumers do not require a TypeScript compiler at runtime.

## Repository Release Configuration

The root [release configuration](https://github.com/dblock/npm-package-release/blob/master/npr.config.js) exports a numeric `ReleaseWorkflow` with an explicit `IntrideaChangelog` for this repository's existing notes. Consumer defaults use `KeepAChangelog`. A `HookValidator` runs this repository's tests and lint before publication and for the next development iteration; its artifact check executes a class-based workflow through the installed SDK and checks the installed `npr --version`. Both must report the selected archive version, not the checkout's original or next version. The built-in consumer installs that exact archive with strict engines and lifecycle scripts disabled.

Build before invoking the checkout's CLI with `node bin/npr.js`. The configuration is repository maintenance code, not a packaged default for consumers. Tests copy it unchanged into isolated SDK projects, simulate publication/hosting, and exercise both compiled source and the actual installed tarball. They do not publish this package or prove live authentication.

Do not invoke `release` or `prepare` as a read-only preview: they edit files and create local commits/tags, and `release` also publishes and pushes. The reusable `release.yml` accepts `workflow_call` for consumers and this library itself. This repository's manually dispatched `self-release.yml` calls it locally with `build: true`; there is no repository-variable gate. Do not dispatch until the setup below is verified and publication is explicitly authorized.

## First Release by Manual Approval

The first release is complete: [`0.1.0` on npm](https://www.npmjs.com/package/npm-package-release/v/0.1.0) was manually approved on November 11, 2026, and `latest` points to it. The [`v0.1.0` tag/GitHub Release](https://github.com/dblock/npm-package-release/releases/tag/v0.1.0) identifies the archive's actual source commit, `86e51cb4a5f1177caa0e9630a335cbe52b5add9f`. Downloaded registry and GitHub Release archives are byte-identical to the validated archive; both checksums below match. No stage remains, and no rejection or placeholder deletion was needed.

The steps below document that completed one-time process; do not repeat staging or approval of `0.1.0`. Its bundled undated changelog and earlier bootstrap documentation were explicitly accepted unchanged. The repository now prepares `0.1.1`; [Trusted Publishing setup](#trusted-publishing-setup) is still required before an automated release.

The built-in publisher runs direct `npm publish`; it does not stage, approve, or reject packages. A pending stage blocks direct publication of the same version. Do not dispatch Actions for `0.1.0` while its stage exists or after it is published. Do not reject any candidate before the real `0.1.0` publication is verified. Reviewing this path does not authorize publication.

### 1. Check Tools and Authenticate

Activate Node.js 26 and npm 12 using your version manager. Staging and `npm trust` require npm 11.15.0 or later; the repository uses npm 12 for development and release validation. Enable account-level npm 2FA and authenticate in your own terminal:

```sh
node --version
npm --version
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
```

Complete browser authentication and 2FA yourself; never put tokens, passwords, recovery codes, or authentication links in the PR or chat. `npm whoami` confirms the local session only, not future Actions OIDC permissions. Stop here until the expected tooling and account access are confirmed.

### 2. Validate and Retain the Candidate

Use reviewed source from a clean checkout, keep the unpublished version at `0.1.0`, and follow [Version and Validation](#version-and-validation). Retain the archive, pack metadata, and source commit outside the source tree. Normally prepare dated release metadata before packing, as described in [Manual Publication Alternative](#manual-publication-alternative). The existing stage is already packed; its metadata exception is described in step 4. Do not rebuild it or run `npr prepare` as a preview.

For a new candidate only, create a retained directory and test its exact archive after validation:

```sh
bootstrap_dir="$(mktemp -d "${TMPDIR:-/tmp}/npr-bootstrap.XXXXXX")"
npm pack --json --pack-destination "$bootstrap_dir" > "$bootstrap_dir/pack.json"
PACKAGE_ARCHIVE="$bootstrap_dir/npm-package-release-0.1.0.tgz" npm run test:package
```

Inspect `pack.json` and the archive contents, and record the source commit with its SHA-512 integrity and SHA-1 checksum. The archive override prevents the consumer test from repacking a different candidate. Keep the directory through publication and verification; move it to durable storage if necessary. These commands do not stage or publish anything.

### 3. Stage Without Approving

With explicit staging approval, upload the retained candidate, substituting its real absolute path. The current candidate has already been staged; inspect it rather than repeating the upload:

```sh
npm stage publish /absolute/path/npm-package-release-0.1.0.tgz --tag bootstrap --access public --ignore-scripts --registry=https://registry.npmjs.org
npm stage list npm-package-release --json --registry=https://registry.npmjs.org
npm stage view STAGE_ID_FROM_OUTPUT --registry=https://registry.npmjs.org
```

Record the returned stage ID and inspect its package name, version, tag, and checksum. Confirm the registry contains the expected placeholder and that `0.1.0` is staged, not publicly released. The placeholder is public even though the candidate contents are private. Do not approve without separate publication authorization, stage another copy after an ambiguous error, or create another placeholder blindly; inspect actual registry/stage state first.

A successful upload can initially report `status: validating`; let npm finish its checks and inspect the stage again before continuing. Staged metadata exposes `shasum`, which must match the retained pack metadata; also keep the local archive's SHA-512 integrity. The public placeholder may receive the `latest` tag, so verify the explicit `0.1.0` version rather than treating `latest` as a real release.

### 4. Review the Existing Stage

The selected stage is `5f66f54b-f3dd-485b-af59-8dace067b438`, package `npm-package-release@0.1.0`, tag `bootstrap`, from source commit `86e51cb4a5f1177caa0e9630a335cbe52b5add9f`. Its SHA-1 is `02712fde2ef814f7410596cf86d9772176586723`; its SHA-512 integrity is `sha512-2C8QBLeCCAlOPV/6PjbIfFZBXl0K5baxfu0Swuxo1e0MOH0dAqwOAOZXBwcCjVpK4260cALwl+LZR6Vp8tvXWA==`.

Read its current status and download into an owned review directory:

```sh
npm stage view 5f66f54b-f3dd-485b-af59-8dace067b438 --json --registry=https://registry.npmjs.org
review_dir="$(mktemp -d "${TMPDIR:-/tmp}/npr-stage-review.XXXXXX")"
(cd "$review_dir" && npm stage download 5f66f54b-f3dd-485b-af59-8dace067b438 --registry=https://registry.npmjs.org)
```

Use the saved filename printed by `download`, which includes the stage ID, not just the filename in its metadata. The downloaded bytes match the retained, tested archive, including both checksums; all 54 compiled files match the current build. Its source differs from merged `master` only in the initial documentation changes for PR #24. Coverage, strict-engine installed-consumer checks, all 98 tests, and lint passed.

The immutable archive contains `## 0.1.0 (Next)`, its contribution placeholder, and the earlier bootstrap instructions. Those documentation limitations require explicit acceptance before publication. Editing this guide, dating the repository changelog later, or creating a GitHub Release will not alter the staged bytes. Approval will be a manual first release, not evidence of CI/OIDC publication or provenance. If these limitations are unacceptable, stop without approving or rejecting the stage.

### 5. Approve, Verify, and Promote

Only after explicit publication authorization and acceptance of the archive limitations, approve the exact stage in your own terminal and complete browser 2FA. This command publishes the real `0.1.0`:

```sh
npm stage approve 5f66f54b-f3dd-485b-af59-8dace067b438 --registry=https://registry.npmjs.org
npm view npm-package-release@0.1.0 --json --registry=https://registry.npmjs.org
```

Verify explicit name/version, `dist.shasum`, and `dist.integrity` against the retained archive. Missing-version visibility can lag publication; do not approve or publish again after an ambiguous result. Inspect the stage and registry instead.

The stage's tag is immutable: approval publishes under `bootstrap`, so `latest` may still point to `0.0.0-stage`. After checksum verification and separate tag-update authorization, promote the real version:

```sh
npm dist-tag add npm-package-release@0.1.0 latest --registry=https://registry.npmjs.org
npm view npm-package-release dist-tags --json --registry=https://registry.npmjs.org
```

Confirm `latest` resolves to the same verified `0.1.0`. Approval consumes the selected stage; no rejection is needed to complete this release. Do not unpublish the placeholder as cleanup: [removing all published versions](https://docs.npmjs.com/policies/unpublish/) triggers a 24-hour publication block. Any later rejection or removal requires separate approval.

### 6. Finish Release Metadata and Configure Automation

After registry confirmation, separately authorize the matching Git tag/GitHub Release and use a reviewed PR for dated repository notes, the next development version `0.1.1`, and the npm version badge. Preserve the archive's actual source identity when choosing a tag target; do not pretend later documentation edits were included in the published archive. Never overwrite the archive or published version to repair its bundled documentation.

Then obtain separate setup approval and follow [Trusted Publishing Setup](#trusted-publishing-setup) for subsequent releases. Configure the `release` environment restricted to `master`, owner `dblock`, repository `npm-package-release`, caller `self-release.yml`, and direct publication permission. Inspect effective protections before authorizing any removal of blocking PR requirements; retain force-push/deletion protections and no bypass actors. Configure the publisher when a subsequent release can complete within its two-day activation window.

## Manual Publication Alternative

After explicit release authorization, prepare a release-metadata PR through normal review: select an unpublished version, synchronize the manifest/lockfile, date its changelog heading, and remove the placeholder. After merging, record the clean default-branch commit and save the reviewed notes alongside the retained archive.

Validate and inspect the exact archive as above. With publication approval, authenticate interactively on a maintainer machine and run `npm publish /absolute/path/package.tgz --access public --ignore-scripts`. Never request tokens or two-factor codes in chat. Verify the explicit registry name/version, SHA-512 integrity, and SHA-1 against retained pack metadata.

With tag/hosted-release approval, create the matching immutable tag at the recorded commit and a GitHub Release with the same notes/archive. Inspect existing outputs rather than moving tags, replacing assets, or republishing. Preserve the archive, pack metadata, notes, and commit identity durably.

After registry confirmation, use a follow-up PR for the next development version/changelog and updated documentation/example pins. Add an npm version badge linking to the actual package only after confirming publication; documentation pins alone are not verification.

## Trusted Publishing Setup

The [self-release caller](https://github.com/dblock/npm-package-release/blob/master/.github/workflows/self-release.yml) publishes subsequent releases after the verified manual first publication. Before dispatching, select a new unpublished version with no conflicting pending stage and explicitly authorize the publisher/environment/protection setup below. Do not dispatch `0.1.0` after manually approving it. No enablement variable is required.

With setup approval, configure and read back the npm publisher:

```sh
npm trust github npm-package-release --file self-release.yml --repo dblock/npm-package-release --env release --allow-publish --registry=https://registry.npmjs.org
npm trust list npm-package-release --json --registry=https://registry.npmjs.org
```

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
