import { compare } from "semver";
import { numericVersion } from "./command.js";
import type { Command, FloatingTag, ReleaseRepository } from "./contracts.js";

/** Subject of the commit that adds build output on top of a release commit, such as a GitHub Action's. */
export function buildCommitMessage(version: string): string {
  return `Build release ${numericVersion(version)}`;
}

/** Floating tag names for a numeric release version, in option order: `major` is `vX`, `minor` is `vX.Y`. */
export function floatingTagNames(version: string, kinds: readonly FloatingTag[]): string[] {
  const [major, minor] = numericVersion(version).split(".");
  return kinds.map((kind) => kind === "major" ? `v${major}` : `v${major}.${minor}`);
}

export class Git implements ReleaseRepository {
  readonly run: (...args: string[]) => Promise<string>;
  branch: string;
  readonly remote: string;
  initialCommit = "";

  constructor(run: Command, { branch = "", remote = "origin" }: { branch?: string; remote?: string } = {}) {
    this.run = (...args) => run("git", args);
    this.branch = branch;
    this.remote = remote;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(remote)) throw new Error("Invalid Git remote name.");
  }

  async initialize(sourceCommit?: string) {
    await this.checkout();
    this.initialCommit = sourceCommit || (await this.run("rev-parse", "HEAD")).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(this.initialCommit) ||
      !await this.ancestor(this.initialCommit, "HEAD")) throw new Error("Release source differs from the checkout.");
  }

  private async checkout() {
    this.branch ||= (await this.run("symbolic-ref", `refs/remotes/${this.remote}/HEAD`)).trim()
      .slice(`refs/remotes/${this.remote}/`.length);
    await this.run("check-ref-format", "--branch", this.branch);
    const branch = (await this.run("branch", "--show-current")).trim();
    if (branch !== this.branch) throw new Error("Release checkout must be on the configured default branch.");
    await this.clean();
  }

  private async ancestor(commit: string, descendant: string): Promise<boolean> {
    try { await this.run("merge-base", "--is-ancestor", commit, descendant); return true; } catch (error) {
      if ((error as { code?: unknown }).code === 1) return false;
      throw error;
    }
  }

  private async remoteHead(): Promise<string> {
    await this.run("fetch", "--no-tags", this.remote, `refs/heads/${this.branch}`);
    return (await this.run("rev-parse", "FETCH_HEAD")).trim();
  }

  async clean() {
    if ((await this.run("status", "--porcelain=v1", "--untracked-files=all")).trim()) {
      throw new Error("Expected a clean checkout, including the index and untracked files.");
    }
  }

  async current(expected: string, version?: string) {
    const remote = await this.remoteHead();
    if (remote === expected) return;
    const release = version ? await this.existingRelease(version) : null;
    if (release && (await this.ancestor(release, remote) ||
      (release === (await this.run("rev-parse", "HEAD")).trim() && await this.ancestor(remote, release)))) return;
    throw new Error("Remote branch advanced; inspect the release before retrying.");
  }

  async stage(edits: () => Promise<void>) {
    await this.clean();
    await edits();
    await this.run("add", "--all", "--", ".");
    return (await this.run("write-tree")).trim();
  }

  async unchanged(tree: string) {
    if ((await this.run("write-tree")).trim() !== tree ||
      (await this.run("diff", "--name-only")).trim() ||
      (await this.run("ls-files", "--others", "--exclude-standard")).trim()) {
      throw new Error("Unexpected working-tree or index changes after trusted preparation.");
    }
  }

  async commit(message: string, tree: string) {
    await this.unchanged(tree);
    if ((await this.run("diff", "--cached", "--name-only")).trim()) await this.run("commit", "-m", message);
    await this.clean();
    return (await this.run("rev-parse", "HEAD")).trim();
  }

  async commitRelease(version: string, tree: string) {
    numericVersion(version);
    await this.unchanged(tree);
    const existing = await this.existingRelease(version);
    const head = (await this.run("rev-parse", "HEAD")).trim();
    if (existing) {
      if (head !== existing && !await this.ancestor(head, existing)) {
        throw new Error("Checkout advanced beyond the matching release; refusing to rewind it.");
      }
      return this.reuseCommit(existing, tree, head);
    }
    if (head !== this.initialCommit) throw new Error("Checkout advanced beyond the captured release source.");
    return this.commit(`Prepare release ${version}`, tree);
  }

  async commitNext(version: string, tree: string) {
    numericVersion(version);
    await this.unchanged(tree);
    const message = `Prepare next development iteration, ${version}`;
    const head = (await this.run("rev-parse", "HEAD")).trim();
    const remote = await this.remoteHead();
    const next = (await this.run("rev-list", "--first-parent", "--reverse", `${head}..${remote}`)).trim().split(/\s+/u)[0];
    if (next && (await this.run("rev-list", "--parents", "-n", "1", next)).trim() === `${next} ${head}` &&
      (await this.run("log", "-1", "--format=%s", next)).trim() === message) return this.reuseCommit(next, tree, head);
    return this.commit(message, tree);
  }

  private async reuseCommit(commit: string, tree: string, head: string) {
    if ((await this.run("rev-parse", `${commit}^{tree}`)).trim() !== tree) {
      throw new Error("Existing release or development tree differs from the intended changes.");
    }
    await this.run("update-ref", "HEAD", commit, head);
    await this.clean();
    return commit;
  }

  async nextIteration(releaseCommit: string, nextVersion: string): Promise<{ commit: string; tree: string } | null> {
    const head = (await this.run("rev-parse", "HEAD")).trim();
    if (head === releaseCommit) return null;
    const parents = (await this.run("rev-list", "--parents", "-n", "1", head)).trim().split(/\s+/u);
    if (parents.length !== 2 || parents[1] !== releaseCommit ||
      (await this.run("log", "-1", "--format=%s", head)).trim() !== `Prepare next development iteration, ${nextVersion}`) {
      throw new Error("Checkout advanced beyond the matching development iteration; refusing to rewind it.");
    }
    return Object.freeze({ commit: head, tree: (await this.run("rev-parse", `${head}^{tree}`)).trim() });
  }

  private async tagCommit(version: string): Promise<string | null> {
    try { return (await this.run("rev-parse", "--verify", `refs/tags/v${version}^{commit}`)).trim(); } catch (error) {
      // show-ref distinguishes a missing ref from an unreadable repository.
      try { await this.run("show-ref", "--verify", "--quiet", `refs/tags/v${version}`); } catch (missing) {
        if ((missing as { code?: unknown }).code === 1) return null;
        throw missing;
      }
      throw error;
    }
  }

  private async remoteTag(version: string): Promise<string | null> {
    const entries = (await this.run("ls-remote", "--tags", this.remote,
      `refs/tags/v${version}`, `refs/tags/v${version}^{}`)).trim().split(/\r?\n/u).filter(Boolean).map((line) => line.split(/\s+/u));
    return entries.find(([, ref]) => ref.endsWith("^{}"))?.[0] || entries[0]?.[0] || null;
  }

  private async existingRelease(version: string): Promise<string | null> {
    const local = await this.tagCommit(version);
    const remote = await this.remoteTag(version);
    if (local && remote && local !== remote) throw new Error("Release tag points at another commit.");
    if (!local && remote) {
      await this.run("fetch", "--no-tags", this.remote, `refs/tags/v${version}`);
      return this.releaseOf((await this.run("rev-parse", "FETCH_HEAD^{commit}")).trim(), version);
    }
    return local && this.releaseOf(local, version);
  }

  // A tag on a build commit identifies the release commit it was built from: its only parent.
  private async releaseOf(commit: string, version: string): Promise<string> {
    const [parents, subject] = (await this.run("show", "-s", "--format=%P%n%s", commit)).split("\n");
    const parent = parents.trim().split(/\s+/u);
    return parent.length === 1 && parent[0] && subject === buildCommitMessage(version) ? parent[0] : commit;
  }

  async tag(version: string, commit?: string) {
    commit ||= (await this.run("rev-parse", "HEAD")).trim();
    const local = await this.tagCommit(version);
    const remote = await this.remoteTag(version);
    if ((local && local !== commit) || (remote && remote !== commit)) throw new Error("Release tag points at another commit.");
    if (!local) await this.run("tag", "--no-sign", `v${version}`, commit);
  }

  async bundle(path: string, version: string) {
    await this.run("bundle", "create", path, "HEAD", `refs/tags/v${version}`);
  }

  async verifyTag(version: string, commit: string) {
    await this.verify(null, version, commit);
  }

  async push(commit: string, version?: string, tagCommit = commit) {
    const remote = await this.remoteHead();
    const alreadyPushed = await this.ancestor(commit, remote);
    if (!alreadyPushed && !await this.ancestor(remote, commit)) throw new Error("Remote branch advanced; refusing to overwrite it.");
    const tag = version ? await this.remoteTag(version) : null;
    if (version && (await this.tagCommit(version) !== tagCommit || (tag && tag !== tagCommit))) {
      throw new Error("Release tag points at another commit.");
    }
    const refs = [
      ...(!alreadyPushed ? [`${commit}:refs/heads/${this.branch}`] : []),
      ...(version && !tag ? [`refs/tags/v${version}`] : []),
    ];
    if (refs.length) await this.run("push", ...(version ? ["--atomic"] : []), this.remote, ...refs);
    await this.verify(commit, version, tagCommit);
  }

  // Remote tag refs: the ref value (for leases) and the commit it resolves to.
  private async remoteTags(): Promise<Map<string, { ref: string; commit: string }>> {
    const tags = new Map<string, { ref: string; commit: string }>();
    for (const line of (await this.run("ls-remote", "--tags", this.remote)).split(/\r?\n/u).filter(Boolean)) {
      const [object, ref] = line.split(/\s+/u);
      const peeled = ref.endsWith("^{}");
      const name = ref.slice("refs/tags/".length, peeled ? -3 : undefined);
      const tag = tags.get(name);
      if (peeled && tag) tag.commit = object;
      else if (!peeled) tags.set(name, { ref: object, commit: tags.get(name)?.commit ?? object });
    }
    return tags;
  }

  // The highest release version tagged at a floating tag's commit within the same major (and minor) line.
  private floatingVersion(tags: Map<string, { commit: string }>, name: string, commit: string): string | null {
    const versions = [...tags].filter(([tag, { commit: tagged }]) => tagged === commit &&
      /^v\d+\.\d+\.\d+$/u.test(tag) && `${tag}.`.startsWith(`${name}.`)).map(([tag]) => tag.slice(1));
    return versions.sort(compare).at(-1) ?? null;
  }

  async floatingTags(version: string, commit: string, kinds: readonly FloatingTag[]): Promise<readonly string[]> {
    await this.verify(null, version, commit);
    const tags = await this.remoteTags();
    const names: string[] = [];
    const moves: string[] = [];
    for (const name of floatingTagNames(version, kinds)) {
      const current = tags.get(name);
      if (current && current.commit !== commit) {
        const pointed = this.floatingVersion(tags, name, current.commit);
        if (!pointed) {
          throw new Error(`Floating tag ${name} points at a commit without a ${name} release tag; inspect it before moving it.`);
        }
        // Never move a floating tag backwards: a later release in its line keeps it.
        if (compare(pointed, version) >= 0) continue;
      }
      names.push(name);
      if (current?.commit !== commit) moves.push(name);
    }
    if (moves.length) {
      await this.run("push", "--atomic", ...moves.map((name) => `--force-with-lease=refs/tags/${name}:${tags.get(name)?.ref ?? ""}`),
        this.remote, ...moves.map((name) => `${commit}:refs/tags/${name}`));
    }
    const pushed = await this.remoteTags();
    for (const name of names) {
      if (pushed.get(name)?.commit !== commit) throw new Error(`Remote ref mismatch: refs/tags/${name}`);
    }
    return Object.freeze(names);
  }

  async verifyFloatingTags(version: string, names: readonly string[]): Promise<void> {
    numericVersion(version);
    const tags = await this.remoteTags();
    for (const name of names) {
      if (typeof name !== "string" || !/^v\d+(?:\.\d+)?$/u.test(name) || !`${version}.`.startsWith(`${name.slice(1)}.`)) {
        throw new Error("Invalid retained floating tag.");
      }
      const current = tags.get(name);
      const pointed = current && this.floatingVersion(tags, name, current.commit);
      if (!pointed || compare(pointed, version) < 0) throw new Error(`Remote ref mismatch: refs/tags/${name}`);
    }
  }

  async verify(commit: string | null, version?: string, tagCommit = commit) {
    if (commit && !await this.ancestor(commit, await this.remoteHead())) throw new Error(`Remote ref mismatch: refs/heads/${this.branch}`);
    if (version && await this.remoteTag(version) !== tagCommit) throw new Error(`Remote ref mismatch: refs/tags/v${version}`);
  }
}
