# Design

## Purpose and Scope

Port [ruby-gem-release](https://github.com/dblock/ruby-gem-release) to npm with class-based, strongly typed workflow composition. Provide a safe default for one public root npm package, numeric release versions, Intridea or Keep a Changelog notes, npm publication, Git, and optional GitHub Releases. Consumers can compose their own steps and service classes. Native workspace, alternate-registry/host, prerelease, and artwork implementations remain deferred.

Keep `npm-package-release` as the repository/npm package name, `npr` as the executable, and `npr.config.js` as the trusted configuration module. TypeScript implementation lives in `src/`; compile ESM JavaScript, declarations, and source maps to ignored `dist/`. The executable lives in `bin/`, unit/release tests in `test/`, compile-time contracts in `test/types/`, installed-package tests in `test/integration/`, and maintenance tools in `scripts/`. Use public Node.js, npm, Git, and GitHub APIs; use SemVer for incrementing and mdast for source-preserving changelog boundaries.

## Composition Boundaries

`Step<Input, Output>` is the public behavioral contract. `Workflow.start<Input>().then(step)` creates an immutable sequential composition, enforcing adjacent input/output compatibility. Steps are class instances with stable identifiers, not string-named hooks or an untyped context registry. Built-in release records carry frozen state snapshots and discriminate completed lifecycle stages; validation, commitment, and artifact preparation are explicit prerequisites for publication.

`ReleaseWorkflow` assembles exported built-in steps. Each depends on `ReleaseRepository`, `PackageProject`, `PackagePublisher`, `Changelog`, `VersionPolicy`, `ReleaseHost`, `ReleaseValidator`, `ReleaseStore`, and `RegistryVerifier` interfaces rather than concrete providers. `InitializeRelease` supplies defaults or explicitly injected instances. Custom workflows may omit or replace compatible steps; custom implementations own any safety guarantees they bypass. Keep the runner independent of npm/Git side effects, do not add a generic parallel scheduler, and do not claim types verify arbitrary custom behavior.

The generic runner handles ordered execution, observer events, and stopping without retries. `ReleaseObserver` provides logging and failure persistence for release contexts. Built-in steps persist phase transitions and recovery snapshots through the injected store. Existing `release(config, options)` and configuration objects are adapters to the default workflow; the CLI also accepts composed workflows. See [Composable Workflows](docs/workflows.md) for contracts and examples.

## Execution Boundaries

Separate immutable domain `Release` data from execution snapshots and provider clients. Capture `manifestVersion` explicitly; retain legacy state/hook fields without claiming they identify publication history. Each lifecycle record carries release data; callbacks and step observers receive frozen execution metadata with current step, observed history, workflow description, and optional platform run information. Unknown steps remain absent; outcome and conclusion are distinct.

`LocalExecutionProvider` and `GitHubExecutionProvider` implement a replaceable execution interface. Select GitHub only from the scoped Actions flag, with explicit provider injection taking precedence. Providers own platform metadata, default-branch/timezone inputs, execution-policy checks, and summaries; npm publication and hosted releases remain separate services. Contexts are data, not platform clients, environments, or raw event payloads. Step implementations may receive the provider separately from the snapshot.

Each workflow invocation has independent history. Initialization failures still notify observers with no captured release. The built-in failure reporter and custom reporters coexist; a reporter failure cannot hide the original error or prevent other failure reporters from being attempted. Success notification failures are observable without rewriting registry verification outcomes or automatically retrying publication.

This adopts the context/provider separation in ruby-gem-release 0.5.0, not its Rake process model or RubyGems credential exchange. Independently idempotent actions and prepublication artifact-upload checkpoints remain subsequent work; keep the current fail-closed guards until those contracts and their reconciliation tests are implemented. Opt-in semantic release analysis follows those foundations. See [Execution Providers and Contexts](docs/execution.md).

## Release Sequence

The reusable GitHub Actions workflow and composite action invoke the same CLI/configuration as local callers, including composed class workflows. The Actions workflow owns the release environment, manual-default-branch guard, permissions, runner, dependency setup, concurrency, Git identity, and artifact upload. Composite callers supply those prerequisites. The reusable workflow does not reference a moving composite-action version.

Check the repository root, configured default branch, clean checkout, remote tip, selected numeric version, existing tags, registry availability, and configuration before preparation. Version updates synchronize the manifest and optional lockfile; formatting retains indentation and line endings. Preparation hooks own trusted additional edits. Stage only changes produced inside that clean preparation boundary and retain the exact index tree. Reject any later unstaged, untracked, or index changes from validation rather than staging them.

Commit release metadata, pack once, inspect the archive's embedded manifest and SHA-512/SHA-1 checksums, and install the archive in an isolated strict-engine consumer without lifecycle scripts. An optional artifact hook checks the installed public API. Reject build mutations to tracked/non-ignored source. Create a lightweight release tag and Git recovery bundle, repeat concurrency/duplicate checks, and publish the exact verified tarball with lifecycle scripts disabled.

After publication, verify archive integrity, atomically push the release commit and tag, and read back remote refs. Create the GitHub Release with notes and the archive before preparing the next patch version. Run trusted next edits, synchronize versions/changelog, run validation again, reject unexpected changes, commit, push, and verify the next ref. Next-phase commands receive an empty `PACKAGE_ARCHIVE`, so optional consumer validation builds the development version instead of reusing the release archive.

## Changelog Boundaries

Parse Markdown to identify top-level ATX headings, list placeholders, actual release notes, and comparison definitions. Exclude headings, HTML/comments, definitions, and thematic breaks from meaningful notes; do not borrow historical notes. Code and described images count as actual content. Update original source slices rather than rendering an AST; preserve unrelated Markdown, Unicode offsets, and CRLF. Intridea requires exactly one contribution placeholder. Keep a Changelog supports standard Unreleased comparison links; reject unsupported or duplicate definitions.

## Verification and Recovery

Registry acceptance and visibility are separate. After hosting and next-development preparation, verify the retained artifact against metadata for the explicit released name/version, never the advanced manifest or HEAD. Retry only structured npm E404 responses with bounded waits; authentication, network, malformed metadata, identity, and integrity errors fail closed. Visibility timeout persists an unverified outcome without failing the release or republishing.

Persist phases, immutable release identity, commit refs, archive checksums, and errors in `release.json`, using atomic replacement after the initial exclusive reservation. Log phases/retries and write verification outcomes to the GitHub job summary. Retain the archive, notes, metadata, and Git bundle even after partial failure. The default local directory is inside Git metadata; Actions uses runner temporary storage and uploads hidden files on success or failure. Runner loss before upload can still lose local recovery files.

`npr verify` rechecks only retained artifact identity, the remote release tag, and registry metadata; it never republishes or changes Git history. Remote branches may advance normally after a release, so standalone verification does not demand that the branch still equals its historical next-development commit. Recovery of a failed push, hosted release, or next-development commit requires inspecting state and completing only missing operations manually. Existing artifact directories, published versions, and tags are never overwritten.

## Runtime and Tests

Consumers require Node.js 22.14+, 24, or 26+; development uses Node.js 26/npm 12. Tooling requirements are separate from strict packed-consumer engines. npm 11/12 pack/view JSON shapes differ; accept only one unambiguous record and exercise both versions in package CI.

Release tests run the real implementation with isolated Git remotes, npm test/lint, actual tarballs, and installed consumers; intercept only registry lookup/publication and hosted-release creation. The packed consumer invokes the installed library's full release flow and, on Unix, the actual release CLI command read from both YAML interfaces, using isolated npm/GitHub publication shims. Source and installed executables share CLI assertions. These checks do not prove live OIDC authentication, provenance, or Actions artifact uploading, and PR CI never dispatches a publishing workflow.

Keep this document focused on the current design and relevant rationale, removing superseded proposals rather than maintaining an implementation diary.
