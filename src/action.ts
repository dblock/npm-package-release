import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { parse } from "yaml";
import { command, numericVersion } from "./command.js";
import { buildCommitMessage } from "./git.js";
import { manifestLockfile, readManifest, setManifestVersion } from "./package.js";
import {
  createZip, extractZip, readZip, relativePath, retainedZip, writeArchive, zipArtifact,
} from "./zip.js";
import type { ZipEntry } from "./zip.js";
import type {
  Artifact, Command, CommandOptions, Environment, Lockfile, PackageManifest, PackageProject, ProjectContext, ReleaseIdentity,
} from "./contracts.js";

export interface GitHubActionOptions {
  readonly build?: readonly string[];
  readonly output?: readonly string[];
  readonly name?: string;
  readonly cwd?: string;
  readonly run?: Command;
  readonly env?: Environment;
}

/** The build commit of a GitHub Action release and the action files it ships. */
export interface ActionBuild {
  readonly commit: string;
  readonly metadata: string;
  readonly entries: readonly ZipEntry[];
  readonly epoch: number;
}

const METADATA = ["action.yml", "action.yaml"];
const ENTRY_POINTS = ["pre", "main", "post"] as const;

function entryPoint(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`Action runs.${key} must be a file path.`);
  return relativePath(value.trim().replace(/^(?:\.\/)+/u, ""), `Action runs.${key}`);
}

/** Return the JavaScript entry points (`runs.pre`, `runs.main`, `runs.post`) declared by action metadata. */
export function actionEntryPoints(source: string): string[] {
  let metadata: unknown;
  try { metadata = parse(source); } catch (error) {
    throw new Error(`Invalid action metadata: ${(error as Error).message}`, { cause: error });
  }
  const runs = (metadata as { runs?: unknown } | null)?.runs as Record<string, unknown> | undefined;
  if (!runs || typeof runs !== "object" || Array.isArray(runs)) throw new Error("Action metadata must declare runs.");
  if (typeof runs.using !== "string" || !/^node\d+$/u.test(runs.using)) {
    throw new Error("GitHubAction releases JavaScript actions; runs.using must be a nodeNN runtime.");
  }
  if (runs.main === undefined) throw new Error("Action metadata must declare runs.main.");
  return ENTRY_POINTS.map((key) => entryPoint(runs[key], key)).filter((path): path is string => path !== undefined);
}

function within(path: string, output: readonly string[]): boolean {
  return output.some((directory) => path === directory || path.startsWith(`${directory}/`));
}

export class GitHubAction implements PackageProject {
  readonly build: readonly string[];
  readonly output: readonly string[];
  readonly name?: string;
  readonly cwd: string;
  readonly run: Command;
  readonly env: Environment;

  constructor({
    build = ["npm", "run", "build"], output = ["dist"], name, cwd, run = command, env = process.env,
  }: GitHubActionOptions = {}) {
    if (!Array.isArray(build) || !build[0] || !build.every((part) => typeof part === "string")) {
      throw new Error("GitHubAction build must be a nonempty array of program and argument strings.");
    }
    if (!Array.isArray(output) || !output.length) throw new Error("GitHubAction output must be a nonempty array of paths.");
    const paths = output.map((path) => relativePath(path, "GitHubAction output"));
    if (new Set(paths).size !== paths.length || paths.some((path) => within(path, paths.filter((other) => other !== path)))) {
      throw new Error("GitHubAction output paths must not repeat or overlap.");
    }
    if (paths.some((path) => METADATA.includes(path))) throw new Error("GitHubAction output must not include action metadata.");
    if (name !== undefined && (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name))) {
      throw new Error("GitHubAction name must be a filename-safe string.");
    }
    if (typeof run !== "function") throw new Error("GitHubAction run must be a command function.");
    this.build = Object.freeze([...build]);
    this.output = Object.freeze(paths);
    this.name = name;
    this.cwd = cwd ?? process.cwd();
    this.run = run;
    this.env = Object.freeze({ ...env });
    Object.freeze(this);
  }

  bind({ cwd, run, env }: ProjectContext): GitHubAction {
    return new GitHubAction({ build: this.build, output: this.output, name: this.name, cwd, run, env });
  }

  filename(identity: ReleaseIdentity): string {
    numericVersion(identity.version);
    const name = this.name ?? identity.name.replace(/^@/u, "").replace("/", "-");
    return `${name}-v${identity.version}.zip`;
  }

  async read(): Promise<PackageManifest> {
    const manifest = await readManifest(this.cwd);
    if (manifest.workspaces) throw new Error("GitHubAction supports a root package without workspaces.");
    return manifest;
  }

  async setVersion(version: string): Promise<void> {
    await setManifestVersion(this.cwd, version, this);
  }

  async lockfile(manifest: PackageManifest): Promise<Lockfile | null> {
    return manifestLockfile(this.cwd, manifest);
  }

  private git(args: string[], options: CommandOptions = {}): Promise<string> {
    return this.run("git", args, { cwd: this.cwd, ...options });
  }

  private async metadata(head: string): Promise<string> {
    const found = (await this.git(["ls-tree", "--name-only", head, "--", ...METADATA])).trim().split(/\r?\n/u).filter(Boolean);
    if (found.length !== 1) throw new Error("A GitHub Action release commit must contain exactly one action.yml or action.yaml.");
    return found[0];
  }

  /**
   * Create (or recreate) the build commit for the checked-out release commit: its tree is the release tree plus the
   * force-added build output, its only parent is the release commit, and its identity and dates are the release
   * commit's committer, so preparation and release produce the same commit.
   */
  async commit(version: string): Promise<ActionBuild> {
    const head = (await this.git(["rev-parse", "HEAD"])).trim();
    const metadata = await this.metadata(head);
    const entryPoints = actionEntryPoints(await this.git(["show", `${head}:${metadata}`]));
    for (const path of this.output) {
      if ((await this.git(["ls-tree", "-r", "--name-only", head, "--", path])).trim()) {
        throw new Error(`GitHubAction output must be ignored and untracked; the release commit contains ${path}.`);
      }
    }
    const temporary = await mkdtemp(join(tmpdir(), "npr-action-"));
    try {
      const index = { env: { GIT_INDEX_FILE: join(temporary, "index") } };
      await this.git(["read-tree", head], index);
      for (const path of this.output) {
        try { await this.git(["add", "--force", "--", path], index); } catch (error) {
          throw new Error(`GitHubAction build output is missing: ${path}`, { cause: error });
        }
      }
      const tree = (await this.git(["write-tree"], index)).trim();
      const listed = (await this.git(["ls-tree", "-r", "-z", "--full-tree", tree, "--", metadata, ...this.output]))
        .split("\0").filter(Boolean).map((line) => {
          const [mode, type, object] = line.slice(0, line.indexOf("\t")).split(" ");
          return { mode, type, object, path: line.slice(line.indexOf("\t") + 1) };
        });
      const files = listed.filter(({ path }) => path !== metadata);
      if (!files.length) throw new Error(`GitHubAction build produced no files in ${this.output.join(", ")}.`);
      for (const { mode, type, path } of listed) {
        if (type !== "blob" || !["100644", "100755"].includes(mode)) {
          throw new Error(`GitHubAction build output must contain only regular files: ${path}`);
        }
      }
      for (const path of entryPoints) {
        if (!files.some((file) => file.path === path)) throw new Error(`Action entry point is not in the build output: ${path}`);
      }
      const [authorName, authorEmail, committerName, committerEmail, time] =
        (await this.git(["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce%x00%ct", head])).trim().split("\0");
      const date = `${time} +0000`;
      const commit = (await this.git(["commit-tree", "--no-gpg-sign", "-p", head, "-m", buildCommitMessage(version), tree], {
        env: {
          GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_NAME: committerName, GIT_COMMITTER_EMAIL: committerEmail, GIT_COMMITTER_DATE: date,
        },
      })).trim();
      const entries: ZipEntry[] = [];
      for (const { object, path } of listed) {
        const blob = join(temporary, "blob");
        await this.git(["cat-file", "blob", object], { output: blob });
        entries.push(Object.freeze({ path, content: await readFile(blob) }));
      }
      entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
      return Object.freeze({ commit, metadata, entries: Object.freeze(entries), epoch: Number(time) });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async pack(directory: string, identity: ReleaseIdentity): Promise<Artifact> {
    const [program, ...args] = this.build;
    await this.run(program, args, { cwd: this.cwd });
    const { commit, entries, epoch } = await this.commit(identity.version);
    const bytes = createZip(entries, epoch);
    const filename = this.filename(identity);
    await writeArchive(directory, filename, bytes);
    return Object.freeze({ ...zipArtifact(filename, bytes), commit });
  }

  async consumer(archive: string, check: (consumer: string) => Promise<void>): Promise<void> {
    const entries = readZip(await readFile(archive));
    const built = await this.commit((await this.read()).version);
    if (entries.length !== built.entries.length || entries.some(({ path, content }, index) =>
      path !== built.entries[index].path || Buffer.compare(content, built.entries[index].content) !== 0)) {
      throw new Error("ZIP archive entries differ from the build commit.");
    }
    await extractZip(entries, check);
  }

  async intact(directory: string, state: ReleaseIdentity & { readonly artifact: Artifact }): Promise<void> {
    if (typeof state.artifact.commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(state.artifact.commit)) {
      throw new Error("Invalid retained build commit identity.");
    }
    await retainedZip(directory, state.artifact);
  }
}
