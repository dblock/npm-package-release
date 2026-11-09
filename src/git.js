export class Git {
  constructor(run, { branch, remote = "origin" } = {}) {
    this.run = (...args) => run("git", args);
    this.branch = branch;
    this.remote = remote;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(remote)) throw new Error("Invalid Git remote name.");
  }

  async initialize() {
    this.branch ||= (await this.run("symbolic-ref", `refs/remotes/${this.remote}/HEAD`)).trim()
      .slice(`refs/remotes/${this.remote}/`.length);
    await this.run("check-ref-format", "--branch", this.branch);
    const branch = (await this.run("branch", "--show-current")).trim();
    if (branch !== this.branch) throw new Error("Release checkout must be on the configured default branch.");
    this.initialCommit = (await this.run("rev-parse", "HEAD")).trim();
    await this.clean();
    await this.current(this.initialCommit);
  }

  async clean() {
    if ((await this.run("status", "--porcelain=v1", "--untracked-files=all")).trim()) {
      throw new Error("Expected a clean checkout, including the index and untracked files.");
    }
  }

  async current(expected) {
    await this.run("fetch", "--no-tags", this.remote, `refs/heads/${this.branch}`);
    if ((await this.run("rev-parse", "FETCH_HEAD")).trim() !== expected) {
      throw new Error("Remote branch advanced; inspect the release state before retrying.");
    }
  }

  async missingTag(version) {
    try {
      await this.run("show-ref", "--verify", "--quiet", `refs/tags/v${version}`);
    } catch (error) {
      if (error.code !== 1) throw error;
      try {
        await this.run("ls-remote", "--exit-code", this.remote, `refs/tags/v${version}`);
      } catch (remoteError) {
        if (remoteError.code === 2) return;
        throw remoteError;
      }
    }
    throw new Error(`Release tag already exists: v${version}`);
  }

  async stage(edits) {
    await this.clean();
    await edits();
    await this.run("add", "--all", "--", ".");
    return (await this.run("write-tree")).trim();
  }

  async unchanged(tree) {
    if ((await this.run("write-tree")).trim() !== tree ||
      (await this.run("diff", "--name-only")).trim() ||
      (await this.run("ls-files", "--others", "--exclude-standard")).trim()) {
      throw new Error("Unexpected working-tree or index changes after trusted preparation.");
    }
  }

  async commit(message, tree) {
    await this.unchanged(tree);
    if ((await this.run("diff", "--cached", "--name-only")).trim()) await this.run("commit", "-m", message);
    await this.clean();
    return (await this.run("rev-parse", "HEAD")).trim();
  }

  async push(commit, version) {
    await this.run("push", ...(version ? ["--atomic"] : []), this.remote,
      `${commit}:refs/heads/${this.branch}`, ...(version ? [`refs/tags/v${version}`] : []));
    await this.verify(commit, version);
  }

  async verify(commit, version) {
    const refs = (await this.run("ls-remote", this.remote,
      ...(commit ? [`refs/heads/${this.branch}`] : []),
      ...(version ? [`refs/tags/v${version}`] : []))).trim().split(/\r?\n/u);
    for (const ref of [commit && `refs/heads/${this.branch}`, version && `refs/tags/v${version}`].filter(Boolean)) {
      if (!refs.includes(`${commit || this.releaseCommit}\t${ref}`)) throw new Error(`Remote ref mismatch: ${ref}`);
    }
  }
}
