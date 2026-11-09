# Releasing

**Provisional:** Release commands, release Actions interfaces, and this package's publication workflow are not implemented. These instructions describe the approved publication plan; they do not authorize credentials, tags, releases, publisher setup, or publication.

## Version and Validation

Start at `0.1.0` and keep that version until actually published. Check registry status before changing versions; an authentication/network failure is not proof of availability. Keep `package.json`, `package-lock.json`, and CHANGELOG synchronized using the policy in [AGENTS.md](AGENTS.md).

Run `npm ci`, `npm run test:coverage`, and `npm run lint`. Build an archive with `npm pack --json`, inspect the file list and package metadata, then run `PACKAGE_ARCHIVE=/absolute/path/package.tgz npm run test:package` to install and exercise that exact artifact with strict engines. Retain the archive and checksum through publication and verification; do not rebuild between validation and publication.

## First Publication

After explicit release authorization, use interactive npm authentication on a maintainer machine; never request tokens or two-factor codes in chat. Publish the exact validated archive with `npm publish /absolute/path/package.tgz --access public`. Check the explicit registry version and integrity against the retained artifact, then verify the matching immutable `v0.1.0` release tag and GitHub Release. Creating and pushing release tags and creating releases require explicit authorization; do not overwrite existing tags.

The package must exist before its npm Trusted Publisher can be configured. Initial publication is manual and separately authorized; do not attempt a live publication from scaffold validation or PR CI.

## Subsequent Trusted Publishing

After verifying the initial registry release, use a focused PR to configure a manually dispatched `release.yml` workflow on a GitHub-hosted runner, a `release` environment restricted to the default branch, and `contents: write` / `id-token: write`. Set up the package's trusted publisher only with explicit authorization, for `dblock/npm-package-release`, calling workflow `release.yml`, environment `release`, and direct `npm publish` permission. Newly configured publishers must complete a successful publication within two days under the [current npm policy](https://docs.npmjs.com/trusted-publishers/); configuration alone does not prove OIDC works.

Use compatible current stable Node.js/npm tooling; npm 12 has a higher runtime floor than consumers. npm validates the calling workflow filename for reusable workflows, and both callers and called workflows need OIDC permission. Do not use `NODE_AUTH_TOKEN` or stored long-lived npm tokens. Trusted Publishing automatically supplies provenance for public packages from public GitHub repositories.

Release automation is planned to publish the retained archive, atomically push the release commit/tag, verify remote refs, create the GitHub Release, validate/push the next development iteration, then verify the explicit published version and retained archive. Authorization to configure this direct-push flow includes removing PR requirements that block release commits while retaining force-push/deletion protections with no bypass actors. This permits fast-forward direct pushes by all writers, not only the workflow; ordinary development still requires PRs. No such setup or protection change is authorized yet.

## Verification and Recovery

Registry visibility can lag accepted publication. Retry only missing-version visibility with bounded waits after GitHub Release creation and next-development preparation. On timeout, retain a visible “release could not be verified” result and job summary without republishing. Authentication, network, malformed metadata, version mismatch, and integrity mismatch remain failures. Never use the now-advanced manifest or HEAD as the released identity.

Before retrying a failed release, inspect registry state, remote commits/tags, GitHub Releases, and retained archives, checksums, and recovery metadata. Complete only missing steps; never duplicate accepted publication or move a tag. Preserve hidden recovery files and record verification limits. Local simulations exercise publication ordering and recovery, not live OIDC or Actions artifact uploading.
