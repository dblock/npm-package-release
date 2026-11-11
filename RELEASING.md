# Releasing

The consumer release CLI/API, reusable workflow, and composite action are implemented; see [Detailed Usage](docs/usage.md). This package itself has not had its first npm publication or trusted-publisher setup. The procedure below is prepared but has not been executed; it does not authorize credentials, tags, releases, publisher setup, or publication. The reusable `release.yml` uses `workflow_call`, not a self-publication dispatch.

## Version and Validation

Start at `0.1.0` and keep that version until actually published. Check registry status before changing versions; an authentication/network failure is not proof of availability. Keep `package.json`, `package-lock.json`, and CHANGELOG synchronized using the policy in [AGENTS.md](AGENTS.md).

Run `npm ci`, `npm run test:coverage`, and `npm run lint`. Build an archive with `npm pack --json` (which compiles TypeScript), inspect compiled JavaScript, declarations, the file list, and package metadata, then run `PACKAGE_ARCHIVE=/absolute/path/package.tgz npm run test:package` to install and exercise that exact artifact with strict engines. Retain the archive and checksum through publication and verification; do not rebuild the archive between validation and publication. Packed consumers do not require a TypeScript compiler at runtime.

## Repository Release Configuration

The root [release configuration](https://github.com/dblock/npm-package-release/blob/master/npr.config.js) exports a numeric `ReleaseWorkflow` using the existing Intridea changelog. Default validation runs this repository's tests and lint before publication and for the next development iteration. Its artifact hook executes a class-based workflow through the installed SDK and checks the installed `npr --version`; both must report the selected archive version, not the checkout's original or next version. The built-in consumer installs that exact archive with strict engines and lifecycle scripts disabled.

Build before invoking the checkout's CLI with `node bin/npr.js`. The configuration is repository maintenance code, not a packaged default for consumers. Tests copy it unchanged into isolated SDK projects, simulate publication/hosting, and exercise both compiled source and the actual installed tarball. They do not publish this package or prove live authentication.

This configuration is ready for separately authorized local or future automated releases. Do not invoke `release` or `prepare` as a read-only preview: they edit files and create local commits/tags, and `release` also publishes and pushes. The first publication below deliberately uses a reviewed metadata PR and manual exact-archive publication, not that direct-push workflow.

## First Publication

After explicit release authorization, prepare a release-metadata PR through normal review. Keep both manifest versions at `0.1.0`; date the `0.1.0` changelog heading and remove its contribution placeholder. After that PR merges, use its clean default-branch commit as the release commit. Save the reviewed notes without the changelog heading or placeholder in `release-notes.md` alongside the retained archive.

From that checkout, validate before authentication or publication. These POSIX shell commands retain the archive outside the checkout and handle both npm 11 array and npm 12 object pack metadata:

```sh
npm ci
npm run test:coverage
npm run lint
release_commit=$(git rev-parse HEAD)
release_dir=$(mktemp -d)
npm pack --json --pack-destination "$release_dir" > "$release_dir/pack.json"
archive_name=$(node --input-type=module -e 'import { readFileSync } from "node:fs"; const data = JSON.parse(readFileSync(process.argv[1], "utf8")); const [pack] = Array.isArray(data) ? data : Object.values(data); process.stdout.write(pack.filename);' "$release_dir/pack.json")
export PACKAGE_ARCHIVE="$release_dir/$archive_name"
tar -tzf "$PACKAGE_ARCHIVE"
npm run test:package
node --input-type=module -e 'import { createHash } from "node:crypto"; import { readFileSync } from "node:fs"; import process from "node:process"; console.log(createHash("sha512").update(readFileSync(process.env.PACKAGE_ARCHIVE)).digest("base64"));'
```

Inspect the packed manifest's name/version (`npm-package-release@0.1.0`), compiled exports, declarations, executable, documentation, and file list. The consumer check must pass against this provided archive without repacking. Preserve `release_commit`, `pack.json`, the archive, and its checksums durably, and confirm the checkout still matches that commit and is clean. Do not use a later rebuilt archive or advanced checkout for publication verification.

With explicit publication authorization, use interactive npm authentication on a maintainer machine; never request tokens or two-factor codes in chat. Run `npm publish "$PACKAGE_ARCHIVE" --access public --ignore-scripts`. Then inspect `npm view npm-package-release@0.1.0 --json --fetch-retries=0`: its name, version, SHA-512 integrity, and SHA-1 must match the single record in the retained `pack.json`. Missing-version visibility can be delayed; retry lookup only, never blindly republish after an ambiguous error. Authentication/network failures are not evidence of absence.

Only with tag and hosted-release authorization, create the immutable tag at the recorded release commit and upload that same archive with the reviewed notes:

```sh
git tag v0.1.0 "$release_commit"
git push origin refs/tags/v0.1.0
gh release create v0.1.0 "$PACKAGE_ARCHIVE" --verify-tag --title 0.1.0 --notes-file "$release_dir/release-notes.md"
```

Check the remote tag resolves to the recorded commit, the GitHub Release has the intended notes/asset, and registry checksums still match. If any output already exists, inspect it and complete only missing operations; do not move tags, replace assets, or repeat publication.

After confirming the registry release, use a follow-up PR for the next synchronized development version/changelog, documentation pins to `v0.1.0`, and an npm version badge linking to the actual published package. Do not add a registry badge or claim publication before confirmation.

The package must exist before its npm Trusted Publisher can be configured. Initial publication is manual and separately authorized; do not attempt a live publication from scaffold validation or PR CI.

## Subsequent Trusted Publishing

After verifying the initial registry release, use a focused PR to configure a manually dispatched `release.yml` workflow on a GitHub-hosted runner, a `release` environment restricted to the default branch, and `contents: write` / `id-token: write`. Set up the package's trusted publisher only with explicit authorization, for `dblock/npm-package-release`, calling workflow `release.yml`, environment `release`, and direct `npm publish` permission. Newly configured publishers must complete a successful publication within two days under the [current npm policy](https://docs.npmjs.com/trusted-publishers/); configuration alone does not prove OIDC works.

Use compatible current stable Node.js/npm tooling; npm 12 has a higher runtime floor than consumers. npm validates the calling workflow filename for reusable workflows, and both callers and called workflows need OIDC permission. Do not use `NODE_AUTH_TOKEN` or stored long-lived npm tokens. Trusted Publishing automatically supplies provenance for public packages from public GitHub repositories.

Release automation is planned to publish the retained archive, atomically push the release commit/tag, verify remote refs, create the GitHub Release, validate/push the next development iteration, then verify the explicit published version and retained archive. Authorization to configure this direct-push flow includes removing PR requirements that block release commits while retaining force-push/deletion protections with no bypass actors. This permits fast-forward direct pushes by all writers, not only the workflow; ordinary development still requires PRs. No such setup or protection change is authorized yet.

## Verification and Recovery

Registry visibility can lag accepted publication. Retry only missing-version visibility with bounded waits after GitHub Release creation and next-development preparation. On timeout, retain a visible “release could not be verified” result and job summary without republishing. Authentication, network, malformed metadata, version mismatch, and integrity mismatch remain failures. Never use the now-advanced manifest or HEAD as the released identity.

Before retrying a failed release, inspect registry state, remote commits/tags, GitHub Releases, and retained archives, checksums, and recovery metadata. Complete only missing steps; never duplicate accepted publication or move a tag. Preserve hidden recovery files and record verification limits. Local simulations exercise publication ordering and recovery, not live OIDC or Actions artifact uploading.

The consumer Actions interfaces now require a successful immutable checkpoint upload before publication, then preserve later diagnostics separately. Explicit `npr complete` restores that checkpoint and reconciles actual outputs rather than trusting journal phases; local callers arrange their own durable storage. See [Checkpoints and Reconciliation](docs/checkpoints.md) for the contract and migration of custom run-only workflows. This does not authorize dispatching or publishing this package itself.
