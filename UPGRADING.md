# Upgrading

## 0.4.0 to 0.5.0

### Workflow Files in Version References

`versionReferences` and `releaseReferences` no longer accept files under `.github/workflows/`. GitHub never lets a workflow's `GITHUB_TOKEN` create or update workflow files, so a release that edits one fails when it pushes, after publication; for example, a next-development commit that bumps a version in a reusable workflow is rejected with `refusing to allow a GitHub App to create or update workflow ... without workflows permission`. Construction now rejects such literal paths and globs that match a workflow file, such as `.github/**` or `**/*.yml`, and preparation rejects any tracked workflow file a glob selects.

Remove workflow files from these options and narrow broad globs, for example `docs/**/*.md` instead of `**/*.md` when a Markdown file lives under `.github/workflows/`. If a workflow needs the package version, read it at run time, such as from the caller's installed package, instead of pinning it in the workflow file. Composite actions outside `.github/workflows/`, such as `action.yml`, can stay in the options.

## 0.1.1 to 0.2.0

### Named Git Commit Operations

`ReleaseRepository` now requires `commitRelease(version, tree)` and `commitNext(version, tree)` alongside ordinary `commit(message, tree)`. Standard workflows call the named methods automatically; ordinary `npr.config.js` configurations do not need changes.

Previously, `Git.commit` selected release-specific reconciliation by parsing messages such as `Prepare release 1.2.3` or `Prepare next development iteration, 1.2.4`. It now treats every message as presentation text for an ordinary guarded commit. Direct callers must use the named methods when they need release-specific behavior.

Replace message-selected operations:

```js
export async function commitVersions(repository, version, nextVersion, releaseTree, nextTree) {
  await repository.commit(`Prepare release ${version}`, releaseTree);
  await repository.commit(`Prepare next development iteration, ${nextVersion}`, nextTree);
}
```

With named operations:

```js
export async function commitVersions(repository, version, nextVersion, releaseTree, nextTree) {
  await repository.commitRelease(version, releaseTree);
  await repository.commitNext(nextVersion, nextTree);
}
export async function commitCustom(repository, tree) {
  await repository.commit("Update project metadata", tree);
}
```

`commitRelease` checks local and remote tags for the selected numeric version. It reuses a matching commit only when its tree matches, rejects conflicting tag targets and later-history rewinds, and creates a new commit only from the captured release source. `commitNext` checks for an immediate remote development commit with the standard next-version message and identical tree before creating a missing commit. All three commit methods reject changes outside the prepared tree.

Both named methods generate the same standard messages as earlier releases. Matching messages still help identify a remote next-development commit, but no longer select which operation runs. The methods do not publish, push, or create tags; those remain separate operations.

Custom adapters implementing `ReleaseRepository` must add both named methods. A TypeScript adapter implements `commitRelease(version: string, tree: string): Promise<string>` and `commitNext(version: string, tree: string): Promise<string>`. Preserve version/tag identity, exact-tree guards, direct-parent checks, and no-rewind protections instead of merely aliasing both methods to an ordinary commit.

`Git` subclasses inherit the implementations. Override the named methods to observe their entire operation, including reuse of an existing commit:

```js
import { Git } from "npm-package-release";

export class ProjectRepository extends Git {
  async commitRelease(version, tree) {
    return super.commitRelease(version, tree);
  }
  async commitNext(version, tree) {
    return super.commitNext(version, tree);
  }
}
```

Existing overrides of `commit(message, tree)` still observe creation of missing commits through `Git`, but not reuse of an existing release or development commit.
