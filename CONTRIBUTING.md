# Contributing

Read [DESIGN.md](DESIGN.md) for the scope and release invariants, and [Detailed Usage](docs/usage.md) for CLI/API configuration and recovery.

## Setup and Validation

Use Node.js 26 and npm 12 for development. Consumers support Node.js 22.14+, 24, and 26+; the lint tools and latest npm have higher minimums than the package runtime. Verify current stable versions and compatibility when choosing or updating tools. Install dependencies with `npm ci`; commit `package-lock.json`.

Run `npm run build` to compile strict TypeScript from `src/` into ignored `dist/`, including ESM JavaScript, declarations, and source maps. Tests exercise that compiled code; build before invoking individual test files or `node bin/npr.js` directly. `npm test`, `npm pack`, and package validation build automatically. TypeScript 6.0.3 is the newest stable compiler supported by the current typescript-eslint peer range (`<6.1.0`); TypeScript 7 is intentionally deferred until parser support exists. Node type definitions target the consumer's Node.js 22 floor rather than exposing newer APIs.

Run `npm test` and `npm run lint` locally before every development push, including PR updates. Run `npm run test:coverage` for text and LCOV coverage in `coverage/`. Run `npm run test:package` before committing packaging or public-entry changes and before pushing them; it runs `npm pack`, inspects the archive, and installs that exact artifact into an isolated consumer with strict engines. Final checks immediately before committing also cover the push if the tested revision does not change.

To test a retained artifact without repacking, use `PACKAGE_ARCHIVE=/absolute/path/package.tgz npm run test:package`. Unset and empty `PACKAGE_ARCHIVE` both build once in an owned temporary directory; tests remove their own temporary directories, never a caller-provided archive. Check both cases with `npm run test:package` and `PACKAGE_ARCHIVE='' npm run test:package`.

`npm run lint` checks strict runtime types, positive/negative contract fixtures, TypeScript, JavaScript, YAML, Markdown source, embedded JavaScript, spelling, single-line paragraphs, and title-case Markdown headings and workflow/job/step display names. Preserve proper names, acronyms, expressions, and code identifiers. Fix spelling mistakes and keep reviewed vocabulary in `.spellcheck.txt` with the bundled English dictionary. Validate workflow syntax with `actionlint .github/workflows/*.yml examples/*.yml` when changing workflow interfaces; this is separate from the YAML-aware display-name checker.

## Tests

Focused unit/release tests live in `test/`; packed consumers live in `test/integration/` and share CLI assertions and real release fixtures in `test/helpers/`. Source and installed CLI checks verify output channels, unsupported commands, and incompatible flags. Release fixtures run real Git remotes, npm tests/lint, archive construction, and strict-engine consumer installation while intercepting only registry lookup/publication and GitHub Release creation. The packed consumer runs the installed library's release sequence and, on Unix, the actual release CLI command from each YAML interface with isolated npm/GitHub publication shims. This Bash integration is not run on Windows; cross-platform unit/API consumers still run there. Workflow checker tests cover valid and invalid YAML display names without treating arbitrary `name` keys as display names.

`test/types/` checks custom classes, service contracts, readonly records, and rejected step ordering with `@ts-expect-error` assertions. Keep these assertions meaningful: they must fail when an expected type error disappears. Composed release fixtures add real artifact-policy steps and replace changelog/version/validation/hosting services; the installed tarball exercises the same behavior and independently compiles a consumer against published declarations without relying on development-only ambient types. See [Composable Workflows](docs/workflows.md).

Initial release implementation should approach full line and branch coverage of project-owned runtime code with meaningful behavior tests, including subprocesses and error paths; report remaining gaps rather than hiding code or adding trivial assertions. Simulate publication and hosting, but exercise real Git remotes, npm archives, and consumer installation. Consumer checks do not validate live Actions authentication or artifact uploads.

Coverage maps compiled execution back to TypeScript. Exclude only the empty JavaScript generated from `contracts.ts`, which contains interfaces/types and no executable implementation; its guarantees are checked by contract fixtures rather than runtime coverage.

Keep `Test`, `Lint`, and `Package` workflows separate. Use explicit `matrix.entry` lists of compact inline objects, not `include`/`exclude` or Cartesian axes. Maintain Coveralls coverage upload; JavaScript Danger checks are not configured.

## Pull Requests

Ordinary development requires a topic branch and PR, not commits or pushes directly to `master`. Inspect status, branches, and worktrees before switching; preserve unrelated changes. Start with `git switch -c dblock/<topic> master`, using the actual contributor's login in place of `dblock`. Work in the existing checkout by default; create separate worktrees only for parallel tasks, never to overwrite or evade another task's checkout.

Prefer one coherent commit per PR; independently reviewable changes may use multiple commits. Squash and rebase merges are supported; merge commits are disabled. Task-owned PR commits may be amended or squashed without further approval: verify branch ownership, record the remote tip, reconcile remote changes, validate locally, then use `git push --force-with-lease=refs/heads/<branch>:<recorded-sha> origin HEAD:<branch>`. Never rewrite another contributor's work or force-push `master`.

After merging, fetch with pruning and verify the merged PR state through GitHub. Inspect dirty/untracked work and dependent stacked PRs before switching cleanly to `master`, removing clean, no-longer-needed parallel worktrees, and deleting merged local branches. Use forced branch deletion only after verifying the merge and that no unmerged work or dependencies would be lost; never remove active branches or discard work.

Update affected documentation and add changelog entries for features, improvements, and fixes, but not minor typos or the initial scaffold. Under `0.1.0 (Next)`, append entries oldest to newest above the final `- Your contribution here.` placeholder. Use actual PR links and contributor attribution: `- [#123](https://github.com/dblock/npm-package-release/pull/123): Description - [@author](https://github.com/author).` Predict the next shared issue/PR number before opening, then verify and correct it immediately if needed.

Keep Markdown paragraphs on one source line and human-readable Markdown headings and YAML display names in title case. Include `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` in AI-assisted commits; AI-authored PRs/comments must disclose AI authorship on behalf of `@dblock`. Use closing issue references in PRs rather than manually closing issues with implementation PRs. See [AGENTS.md](AGENTS.md) for the version policy and [RELEASING.md](RELEASING.md) for provisional publication instructions. Do not merge, publish, create tags/releases, or set up credentials without explicit authorization.
