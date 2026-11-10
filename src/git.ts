import type { Command, ReleaseRepository, RepositoryCheckpoint } from "./contracts.js";

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

  async initialize() {
    await this.checkout();
    this.initialCommit = (await this.run("rev-parse", "HEAD")).trim();
    await this.current(this.initialCommit);
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

  async restore(source: RepositoryCheckpoint, bundle: string, version: string): Promise<void> {
    await this.checkout();
    if (source.branch !== this.branch || source.remote !== this.remote) throw new Error("Checkpoint repository differs.");
    this.initialCommit = source.initialCommit;
    await this.run("bundle", "verify", bundle);
    await this.run("fetch", "--no-tags", bundle, "HEAD");
    if ((await this.run("rev-parse", "FETCH_HEAD")).trim() !== source.releaseCommit ||
      (await this.run("rev-parse", `${source.releaseCommit}^{tree}`)).trim() !== source.preparedTree) {
      throw new Error("Checkpoint Git tree/commit mismatch.");
    }
    const parents = (await this.run("rev-list", "--parents", "-n", "1", source.releaseCommit)).trim().split(/\s+/u);
    if (source.releaseCommit !== source.initialCommit &&
      (parents.length !== 2 || parents[1] !== source.initialCommit)) throw new Error("Checkpoint release parent differs.");
    const remote = await this.remoteHead();
    if (remote !== source.initialCommit && !await this.ancestor(source.releaseCommit, remote)) {
      throw new Error("Remote branch advanced; checkpoint cannot overwrite unrelated work.");
    }
    const head = (await this.run("rev-parse", "HEAD")).trim();
    if (head !== source.initialCommit && !await this.ancestor(source.releaseCommit, head)) {
      throw new Error("Checkout differs from checkpoint release.");
    }
    await this.tag(version, source.releaseCommit);
    if (head === source.initialCommit) await this.run("merge", "--ff-only", source.releaseCommit);
  }

  async clean() {
    if ((await this.run("status", "--porcelain=v1", "--untracked-files=all")).trim()) {
      throw new Error("Expected a clean checkout, including the index and untracked files.");
    }
  }

  async current(expected: string) {
    await this.run("fetch", "--no-tags", this.remote, `refs/heads/${this.branch}`);
    if ((await this.run("rev-parse", "FETCH_HEAD")).trim() !== expected) {
      throw new Error("Remote branch advanced; inspect the release state before retrying.");
    }
  }

  async missingTag(version: string) {
    try {
      await this.run("show-ref", "--verify", "--quiet", `refs/tags/v${version}`);
    } catch (error) {
      if ((error as { code?: unknown }).code !== 1) throw error;
      try {
        await this.run("ls-remote", "--exit-code", this.remote, `refs/tags/v${version}`);
      } catch (remoteError) {
        if ((remoteError as { code?: unknown }).code === 2) return;
        throw remoteError;
      }
    }
    throw new Error(`Release tag already exists: v${version}`);
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

  async push(commit: string, version?: string) {
    const remote = await this.remoteHead();
    const alreadyPushed = await this.ancestor(commit, remote);
    if (!alreadyPushed && !await this.ancestor(remote, commit)) throw new Error("Remote branch advanced; refusing to overwrite it.");
    const tag = version ? await this.remoteTag(version) : null;
    if (version && (await this.tagCommit(version) !== commit || (tag && tag !== commit))) {
      throw new Error("Release tag points at another commit.");
    }
    const refs = [
      ...(!alreadyPushed ? [`${commit}:refs/heads/${this.branch}`] : []),
      ...(version && !tag ? [`refs/tags/v${version}`] : []),
    ];
    if (refs.length) await this.run("push", ...(version ? ["--atomic"] : []), this.remote, ...refs);
    await this.verify(commit, version);
  }

  async verify(commit: string | null, version?: string, tagCommit = commit) {
    if (commit && !await this.ancestor(commit, await this.remoteHead())) throw new Error(`Remote ref mismatch: refs/heads/${this.branch}`);
    if (version && await this.remoteTag(version) !== tagCommit) throw new Error(`Remote ref mismatch: refs/tags/v${version}`);
  }
}
