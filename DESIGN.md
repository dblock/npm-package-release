# Design

## Purpose and Scope

Port [ruby-gem-release](https://github.com/dblock/ruby-gem-release) to npm with class-based, strongly typed workflow composition. Provide a safe default for one public root npm package, numeric release versions, Intridea or Keep a Changelog notes, npm publication, Git, and optional GitHub Releases. Consumers can compose their own steps and service classes. Native workspace, alternate-registry/host, and prerelease implementations remain deferred.

Keep `npm-package-release` as the repository/npm package name, `npr` as the executable, and `npr.config.js` as the trusted configuration module. TypeScript implementation lives in `src/`; compile ESM JavaScript, declarations, and source maps to ignored `dist/`. The executable lives in `bin/`, unit/release tests in `test/`, compile-time contracts in `test/types/`, installed-package tests in `test/integration/`, and maintenance tools in `scripts/`. Use public Node.js, npm, Git, and GitHub APIs; use SemVer for incrementing and mdast for source-preserving changelog boundaries.

## Composition Boundaries

`Step<Input, Output>` is the public behavioral contract. `Workflow.start<Input>().then(step)` creates an immutable sequential composition, enforcing adjacent input/output compatibility. Steps are class instances with stable identifiers, not string-named hooks or an untyped context registry. Built-in release records carry frozen state snapshots and discriminate completed lifecycle stages; validation, commitment, and artifact preparation are explicit prerequisites for publication.

`ReleaseWorkflow` assembles exported built-in steps. Each depends on `ReleaseRepository`, `PackageProject`, `PackagePublisher`, `Changelog`, `VersionPolicy`, `ReleaseHost`, `ReleaseValidator`, `ReleaseStore`, and `RegistryVerifier` interfaces rather than concrete providers. Supply service instances directly in workflow options; `InitializeRelease` fills omitted services with defaults. `KeepAChangelog` is the numeric workflow's default; `IntrideaChangelog` preserves Intridea conventions. Changelog paths resolve against the invocation directory. Custom workflows may omit or replace compatible steps; custom implementations own any safety guarantees they bypass. Keep the runner independent of npm/Git side effects, do not add a generic parallel scheduler, and do not claim types verify arbitrary custom behavior.

The generic runner handles ordered execution, observer events, and stopping without retries. `ReleaseObserver` provides logging and failure persistence for release contexts. Built-in steps persist phase transitions and recovery snapshots through the injected store. `release(workflow, options)` and CLI configuration modules require workflow instances; no configuration-object adapter or format/hosting/validation selector options exist. Simple branch/remote/timezone settings and trusted prepare/next callbacks remain workflow options. See [Composable Workflows](docs/workflows.md) for contracts and examples.

Both standard workflows accept immutable `LifecycleHooks` registries of typed hook classes. Hooks expose step `input` before an operation, `output` afterward, or command-capable `context` for preparation. Per-invocation adapters execute ordered before/after hooks and preserve existing observers; preparation hooks run inside trusted Git staging, not around the outer step. Other hooks reject file/index edits once repository context exists. Skipped hosting/development operations skip their hooks; preparation never emits whole-release success. Hook failures retain the original exception and add diagnostic stage/timing/ID/index metadata without serializing callbacks into checkpoints. See [Lifecycle Hooks](docs/hooks.md).

## Execution Boundaries

Separate immutable domain `Release` data from execution snapshots and provider clients. Capture `manifestVersion` explicitly; retain legacy state/hook fields without claiming they identify publication history. Each lifecycle record carries release data; callbacks and step observers receive frozen execution metadata with current step, observed history, workflow description, and optional platform run information. Unknown steps remain absent; outcome and conclusion are distinct.

`LocalExecutionProvider` and `GitHubExecutionProvider` implement a replaceable execution interface. Select GitHub only from the scoped Actions flag, with explicit provider injection taking precedence. Providers own platform metadata, default-branch/timezone inputs, execution-policy checks, and summaries; npm publication and hosted releases remain separate services. Contexts are data, not platform clients, environments, or raw event payloads. Step implementations may receive the provider separately from the snapshot.

Each workflow invocation has independent history. Initialization failures still notify observers with no captured release. The built-in failure reporter and custom reporters coexist; a reporter failure cannot hide the original error or prevent other failure reporters from being attempted. Success notification failures are observable without rewriting registry verification outcomes or automatically retrying publication.

This adopts the context/provider separation in ruby-gem-release 0.5.0, not its Rake process model or RubyGems credential exchange. Output reconciliation, immutable prepublication checkpoints, and opt-in semantic release analysis build on those boundaries. See [Execution Providers and Contexts](docs/execution.md).

## Release Sequence

The reusable GitHub Actions workflow and composite action invoke the same CLI/configuration as local callers, including composed class workflows. The Actions workflow owns the release environment, manual-default-branch guard, permissions, runner, dependency setup, concurrency, Git identity, and artifact upload. Composite callers supply those prerequisites. The reusable workflow does not reference a moving composite-action version.

This repository's manually dispatched `self-release.yml` calls the local reusable `release.yml` with `build: true`, building and running the checkout's CLI with its root configuration rather than depending on a published version of itself. Consumers default to `build: false` and use their installed tool. One shared pipeline owns release guards, concurrency, the prepare/upload/complete boundary, hidden recovery artifacts, and failure-aware diagnostics; no enablement variable is required.

Check the repository root, configured default branch, clean checkout, remote tip, selected numeric version, existing tags, registry availability, and configuration before preparation. Version updates synchronize the manifest and optional lockfile; formatting retains indentation and line endings. Preparation hooks own trusted additional edits. Stage only changes produced inside that clean preparation boundary and retain the exact index tree. Reject any later unstaged, untracked, or index changes from validation rather than staging them.

Commit release metadata, pack once, inspect the archive's embedded manifest and SHA-512/SHA-1 checksums, and install the archive in an isolated strict-engine consumer without lifecycle scripts. An optional artifact hook checks the installed public API. Reject build mutations to tracked/non-ignored source. Create a lightweight release tag and Git recovery bundle, repeat concurrency/duplicate checks, and write an immutable checkpoint. Publish the exact verified tarball with lifecycle scripts disabled.

`ReleaseWorkflow.prepare` runs through `CheckpointRelease` without publication or whole-release success notifications. `ReleaseWorkflow.complete` starts with `RestoreRelease`, validates explicit checkpoint evidence, restores the exact prepared commit from its bundle when needed, and reconstructs trusted services from configuration. Actions requires a successful checkpoint upload between these methods; the final failure-aware upload uses a different artifact name. Local `run` composes both halves in one process without claiming external durability. Custom staged classes explicitly implement `CheckpointWorkflow`.

After publication, verify archive integrity, atomically push the release commit and tag, and read back remote refs. Create the GitHub Release with notes and the archive before preparing the next patch version. Run trusted next edits, synchronize versions/changelog, run validation again, reject unexpected changes, commit, push, and verify the next ref. Next-phase commands receive an empty `PACKAGE_ARCHIVE`, so optional consumer validation builds the development version instead of reusing the release archive.

## Changelog Boundaries

Changelogs and `MarkdownSection` share one mdast parser and top-level section boundary implementation. Section editing requires an exact heading line, preserves surrounding source, rejects ambiguous headings/line endings, and leaves project-specific wording in trusted hooks; see [Updating Markdown Sections](docs/markdown.md).

Parse Markdown to identify top-level ATX headings, contribution prompts, actual release notes, and comparison definitions. Exclude headings, HTML/comments, definitions, and thematic breaks from meaningful notes; do not borrow historical notes. Code and described images count as actual content. Update original source slices rather than rendering an AST; preserve unrelated Markdown, Unicode offsets, and CRLF. Intridea removes every matching prompt and restores one-level category headings for development. Keep a Changelog preserves existing defaults, with optional prompt cleanup and explicit category templates; retain standard Unreleased comparison links and reject unsupported or duplicate definitions. See [Changelog Templates](docs/changelogs.md).

## Semantic Releases

`SemanticReleaseWorkflow` is opt-in; the numeric/manual-changelog workflow is unchanged. Replaceable `SemanticHistory`, `CommitAnalyzer`, `SemanticVersionPolicy`, and `SemanticNotes` interfaces separate Git discovery, Conventional Commits classification, selection, and notes. Capture full history from the highest numeric tag reachable from the source commit, reject shallow checkouts, and bind an immutable decision to that source, version, original override, and notes before committing. No eligible change fails before project edits; an explicit increasing version can override classification.

Default the first semantic release to `1.0.0`, breaking changes to a major increment even in `0.x`, and next-development preparation to disabled. Generated notes replace manual changelog maintenance without modifying a Markdown file. Checkpoints retain the decision and next-development policy; completion must not rediscover history or reanalyze commits, and rejects mismatched workflow policies. `nextVersion` remains planned data even when no next commit is made. See [Semantic Releases](docs/semantic.md).

## Verification and Recovery

Registry acceptance and visibility are separate. After hosting and next-development preparation, verify the retained artifact against metadata for the explicit released name/version, never the advanced manifest or HEAD. Retry only structured npm E404 responses with bounded waits; authentication, network, malformed metadata, identity, and integrity errors fail closed. Visibility timeout persists an unverified outcome without failing the release or republishing.

Persist phases, immutable release identity, commit refs, archive checksums, and errors in `release.json`, using atomic replacement after the initial exclusive reservation. This is diagnostic state, never a completion protocol. A separate `checkpoint.json` captures only immutable release/source/archive identity and note/bundle checksums; completion validates these inputs and ignores journal phases. Log phases/retries and write verification outcomes to the GitHub job summary. Actions uploads hidden checkpoint files before publication and separate diagnostic files afterward; upload failure prevents publication. Local callers must arrange their own durable preservation.

`npr verify` rechecks only retained artifact identity, the remote release tag, and registry metadata; it never republishes or changes Git history. Remote branches may advance normally after a release, so standalone verification does not demand that the branch still equals its historical next-development commit. Explicit `complete` reconciles actual outputs rather than replaying journal flags: matching npm checksums, Git refs/ancestry, hosted metadata/asset checksums, and the immediate next-development commit are reused; missing outputs are completed and conflicts fail without overwriting. Later local history and dirty trees require inspection, not automatic rewinds or cleanup. New release starts still refuse existing artifact directories, versions, and tags. See [Checkpoints and Reconciliation](docs/checkpoints.md).

## Runtime and Tests

Consumers require Node.js 22.14+, 24, or 26+; development uses Node.js 26/npm 12. Tooling requirements are separate from strict packed-consumer engines. npm 11/12 pack/view JSON shapes differ; accept only one unambiguous record and exercise both versions in package CI.

Release tests run the real implementation with isolated Git remotes, npm test/lint, actual tarballs, and installed consumers; intercept only registry lookup/publication and hosted-release creation. The packed consumer invokes the installed library's full release flow and, on Unix, the actual release CLI command read from both YAML interfaces, using isolated npm/GitHub publication shims. Source and installed executables share CLI assertions. These checks do not prove live OIDC authentication, provenance, or Actions artifact uploading, and PR CI never dispatches a publishing workflow.

Keep this document focused on the current design and relevant rationale, removing superseded proposals rather than maintaining an implementation diary.

The optional `npm-package-release/testing` export supplies disposable local Git projects and explicit publisher/host adapters without depending on `node:test`. It scrubs inherited command environments and validates explicit file copies against canonical roots. Test archives are immutable local outputs with real checksums; adapters do not model live authentication or sandbox arbitrary callbacks. The packaged lifecycle example shares the production builder with source/installed consumer tests; see [Testing Custom Workflows](docs/testing.md).

## Artwork

The logo is a single package box with an upward release arrow and a white packing-tape detail. Its simple geometry and red (`#cb3837`)/white palette draw on the [npm](https://www.npmjs.com) visual aesthetic; the illustration is original artwork, not a copy of the npm wordmark or an endorsement by npm. GitHub Copilot created the geometric SVG for this project on behalf of @dblock. No third-party artwork or fonts are embedded; both assets use the project's [MIT license](LICENSE).

Edit [assets/logo.svg](assets/logo.svg), the source of truth, and regenerate the transparent 512-pixel [assets/logo.png](assets/logo.png) with `rsvg-convert --width 512 --height 512 --output assets/logo.png assets/logo.svg`. The SVG contains only paths and has no external resources. Keep both files in the npm archive so the image resolves in the packaged README.

Preserve the logo above the README title at a display width of 160 pixels with descriptive alt text. After edits, inspect the full-size PNG and a 160-pixel rendering on light and dark backgrounds for clipping, contrast, and a recognizable box-and-arrow silhouette. Keep transparent outer padding and the white tape detail rather than adding a background rectangle.
