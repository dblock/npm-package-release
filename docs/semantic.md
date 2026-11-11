# Semantic Releases

## Opt In

Export a `SemanticReleaseWorkflow` from the same trusted `npr.config.js` used by the CLI and Actions interfaces:

```js
import { SemanticReleaseWorkflow } from "npm-package-release";

export default new SemanticReleaseWorkflow();
```

`npr prepare` and `npr release` use this workflow without new commands or flags. The ordinary `ReleaseWorkflow` uses numeric versions and defaults to `KeepAChangelog`; both require workflow-instance exports. Publication and authentication still require authorization; choosing a semantic workflow does not configure either.

The semantic workflow analyzes commits before preparing project files, generates release notes, and uses the existing validation, exact-archive, publication, Git, hosting, and bounded verification steps. By default, `GeneratedChangelog` creates or updates `CHANGELOG.md` with the captured notes before validation and commitment. Existing preparation, validation, artifact, observer, provider, and Git settings remain available; custom changelog services must preserve the captured notes.

## Version and History Policy

`GitHistory` fetches tags from the configured remote without forcing replacements, requires a full non-shallow checkout, and checks that HEAD still matches the captured source commit. The baseline is the highest valid numeric `vX.Y.Z` tag reachable from that commit, including annotated tags, not the nearest tag or manifest version. Unreachable tags and prerelease tags are ignored. Commits after the baseline are read with their full messages in history order. Reachable tags establish versioning history, not proof of registry publication.

| Policy | Default |
| --- | --- |
| No prior release tag | First eligible release is `1.0.0`; replace the selector to configure it. |
| `feat` | Minor release. |
| `fix`, `perf`, or an uncancelled revert | Patch release. |
| Header `!`, `BREAKING CHANGE:`, or `BREAKING-CHANGE:` | Major release, including a breaking change from `0.x` to `1.0.0`. |
| Other commits | No release on their own. |
| Explicit `--version X.Y.Z` | Overrides selection, including otherwise ineligible history, but must exceed the baseline. |
| No eligible commits and no override | Fail before project edits or publication, not a successful skip. |
| Next-development commit | Disabled; opt in with `nextDevelopment: true`. |

Recognized headers use `type(scope): subject` or `type(scope)!: subject`; scope is optional. Multiline breaking footers contribute notes. A revert with `This reverts commit SHA.` cancels its original when both occur in the analyzed range; a revert of that revert restores the original effect. Ambiguous abbreviated SHAs fail. A revert whose original predates the baseline remains a patch change.

Generated notes group changes into Breaking Changes, Features, Bug Fixes, Performance Improvements, and Other Changes, escaping Markdown text and including short commit SHAs. Cancelled pairs are omitted. An explicit release with no remaining changes gets a short fallback note. A replaced analyzer does not automatically replace the notes generator's grouping.

## Generated Changelog Files

The default missing file begins with `# Changelog`. Preparation inserts a dated `## X.Y.Z (YYYY/MM/DD)` section before the first real level-two heading, preserving the title, preamble, historical Markdown bytes, and LF/CRLF style. Fenced or quoted example headings are not release sections. Generated notes must contain meaningful content, not only headings, comments, definitions, or separators; invalid notes never create or modify a file.

A matching existing version section is reused without rewriting or changing its date. Its notes must equal the captured notes after trimming and normalizing CRLF; differing notes or duplicate matching headings fail before writing. No Next placeholder is created, even when next-development preparation is enabled. Existing historical sections are not migrated or removed.

`new GeneratedChangelog(decision, path = "CHANGELOG.md")` supports direct/custom composition with an immutable `SemanticDecision`. Relative paths resolve against the invocation directory; absolute paths are accepted. To keep generated notes only in release artifacts, supply a custom `Changelog` class that returns the captured decision's notes without writing Markdown; `changelog: null` does not supply notes and fails semantic validation.

## Replace Classes and Interfaces

```js
import {
  SemanticReleaseWorkflow, ConventionalCommits, SemanticVersionSelector,
} from "npm-package-release";

class ProjectAnalyzer extends ConventionalCommits {
  constructor() {
    super([
      { type: "docs", scope: "public*", release: "patch" },
      { scope: "internal", breaking: true, release: false },
    ]);
  }
}

export default new SemanticReleaseWorkflow({
  nextDevelopment: true,
  analyzer: new ProjectAnalyzer(),
  selector: new SemanticVersionSelector("0.1.0"),
});
```

Rules match optional `type`, `scope`, and `subject` string patterns and `breaking`/`revert` booleans. Patterns support only `*` and `?`, with other characters treated literally. All selectors in a rule must match. Matching rules replace default classification for that commit; the highest matching release wins, with `false` contributing no release. Defaults apply when no rule matches. Rules cannot restore changes removed by revert cancellation.

| Service | Strong Interface | Default Class |
| --- | --- | --- |
| `history` | `SemanticHistory` | `GitHistory` |
| `analyzer` | `CommitAnalyzer` | `ConventionalCommits` |
| `selector` | `SemanticVersionPolicy` | `SemanticVersionSelector` |
| `notes` | `SemanticNotes` | `GeneratedReleaseNotes` |

Implement these interfaces directly in TypeScript or supply structurally compatible JavaScript classes; inheritance is optional. History returns `SemanticHistoryData` with an optional baseline and readonly `SemanticCommit` records. The analyzer selects a `ReleaseType` or `null`; the selector receives `SemanticSelection`; the notes generator receives commits. `SemanticRelease(services).analyze(head, explicitVersion?)` exposes analysis without running the release workflow and returns an immutable `SemanticDecision`, including non-releasable decisions.

`SemanticReleaseWorkflow(options)` accepts release and semantic service instances directly alongside runtime settings. The default history is scoped to each invocation's command, environment, directory, and remote; an injected history owns its own scoping. A custom `Changelog` must return the captured generated notes, or preparation fails before validation/commit. The ordinary `VersionPolicy` still selects the planned next version, but cannot change the captured release version.

For custom step composition, order `AnalyzeSemanticRelease` before `InitializeSemanticRelease`, then `PrepareRelease`, `ValidateSemanticDecision`, and the ordinary validation/commit/build steps. `AnalyzedReleaseOptions` carries the decision into initialization; the public declarations reject initialization without that record. Custom steps and services own any guarantees they bypass.

## Invocation-local Analysis

The decision captures the source SHA, baseline, full commit messages, release type, selected version, generated notes, and original explicit override. Preparation binds it to the captured source, release version, and prepared notes. Snapshots freeze copied decision data rather than keeping mutable history-service results.

Actions saves the decision in a private runner-temporary file for this invocation and transports its path and original source inputs through the execution provider. The publication phase consumes the same bound decision without rerunning the analyzer, selector, or notes generator against its newly created tag. A new dispatch performs fresh analysis from its current checkout; downloaded artifacts never restore analysis or workflow policy. Keep invocation files private because they contain full commit messages.

With the default disabled next-development policy, hosting is followed directly by verification, the manifest stays at the released version, `nextCommit` is absent, and the final diagnostic phase is `hosted`. The required `nextVersion` field still describes a planned version, not an executed step. With `nextDevelopment: true`, the normal next edits, validation, commit, push, and reconciliation apply; the generated changelog remains unchanged during that development step.

See [Recovery and Reconciliation](recovery.md) for artifact preservation and recovery limits, [Composable Workflows](workflows.md) for base steps, and [Execution Providers and Contexts](execution.md) for lifecycle reporting. Native workspaces, prerelease channels, and alternate registries/hosts remain outside the built-in scope.
