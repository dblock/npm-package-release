# Design

## Purpose and Status

Port [ruby-gem-release](https://github.com/dblock/ruby-gem-release) to npm without making consumers maintain custom release scripts. This first PR supplies package entry points, help/version reporting, documentation, and validation infrastructure only. The release API, release commands, reusable workflow, and composite action described below are approved design, not implemented behavior.

## Package Layout

Use ESM with implementation in `src/`, the executable in `bin/`, unit tests in `test/`, installed-package tests in `test/integration/`, and maintenance tools in `scripts/`. The public package currently exports only `version`; the CLI supports no arguments, `--help`, or `--version`. Help and version go to standard output; unknown commands and combined flags go to standard error with exit status 1. There are no diagnostics with source locations, sorting, or deduplication yet.

Consumers require Node.js 22.14 or newer on supported release lines (22, 24, and 26+). Development uses Node.js 26 and npm 12; development tools have higher minimums than consumers. Test CI installs tools on Node.js 26 before switching to the consumer runtime, including the exact floor. Package CI installs real archives with strict engine checks and npm 11/12, without installing development dependencies on the consumer floor.

## Planned Release Interfaces

Provide a JavaScript API and `npm-package-release` CLI with preparation, publication, and next-development phases. A reusable GitHub Actions workflow and root composite action will call the same implementation. Keep the workflow independent of moving composite-action references. The reusable workflow owns environment, permissions, concurrency, and runner setup; composite callers own those settings.

An explicit ESM configuration module will choose the changelog format and trusted preparation/validation hooks. Begin with a single root `package.json` and optional `package-lock.json`; update both when the version changes. Support the checked-in version or a selected numeric release version, UTC or a named timezone, Intridea Next headings or Keep a Changelog, and a next-patch development version. Add SemVer and Markdown-parser runtime dependencies during implementation, selecting current compatible stable releases and preserving unrelated source formatting.

## Planned Release Invariants

Require a clean checkout after dependency installation. Trusted preparation stages only its own resulting edits and records the exact index tree; validation must not introduce unrelated working-tree or index changes. Reject existing release tags, already published versions, and empty release notes before publication. Fail closed on authentication, network, malformed registry metadata, and identity or integrity mismatches.

Validate, build once with `npm pack`, inspect and test the actual archive, retain its checksum and release metadata, and publish that exact archive. Atomically push the matching release commit and tag, verify remote refs, create the GitHub Release with the archive, then validate and push the next development iteration. Preserve recovery artifacts on failure, including hidden files. Failed pushes after accepted publication require inspection and recovery, never automatic republishing or tag movement.

Registry visibility is not publication acceptance. Perform bounded, fresh lookups of the explicit released version after GitHub Release creation and next-development preparation. Retry only missing-version visibility; persist an unverified outcome on timeout without republishing. Final verification uses the retained artifact and released version, not the advanced manifest or HEAD. Make phases and verification outcomes visible in logs and job summaries.

## npm Authentication

Use npm Trusted Publishing on GitHub-hosted runners after manual initial publication. npm checks the calling workflow filename when a reusable workflow publishes; do not copy RubyGems' separate reusable-workflow publisher fields. Callers and reusable workflows both need OIDC permission. Trusted-publisher setup and live publication remain separately authorized operations; simulated tests cannot prove OIDC authentication.

## Tests and Non-Goals

Share CLI behavior checks between source and installed executables. Test the actual packed package in an isolated consumer with strict engines, including archive overrides that are provided, unset, or empty. Release implementation tests will use isolated Git remotes and simulated registry/hosting publication, covering hook ordering, push failure, delayed visibility, timeout, and verification after the manifest advances. Never dispatch a publishing workflow from PR CI.

Defer workspaces, alternate registries or hosts, prerelease channels, and artwork. Do not introduce a generic workflow framework or speculative provider abstractions. Keep this document focused on the current design and relevant rationale, removing superseded proposals rather than maintaining an implementation diary.
