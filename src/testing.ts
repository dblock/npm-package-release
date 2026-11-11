import { createHash } from "node:crypto";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import process from "node:process";
import { Minimatch } from "minimatch";
import { command, numericVersion } from "./command.js";
import { LocalExecutionProvider } from "./execution.js";
import type {
  Command, Environment, PackagePublisher, RegistryMetadata, ReleaseHost, ReleaseIdentity, ReleaseOptions,
} from "./contracts.js";

function isolatedEnvironment(home: string): Environment {
  const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
    "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "npm_execpath"]) env[key] = process.env[key];
  return Object.freeze({
    ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"),
    npm_config_userconfig: join(home, "npmrc"), npm_config_globalconfig: join(home, "global-npmrc"),
    npm_config_cache: join(home, "npm-cache"), GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0", GITHUB_ACTIONS: "false",
  });
}

function packagePath(directory: string, name: string, version: string): string {
  numericVersion(version);
  if (typeof name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)) {
    throw new Error("Invalid test package name.");
  }
  return join(directory, encodeURIComponent(name), `${version}.tgz`);
}

async function archiveMetadata(archive: string, bytes: Buffer): Promise<RegistryMetadata> {
  const metadata: ReleaseIdentity = JSON.parse(await command("tar", ["-xOf", archive, "package/package.json"], {
    env: isolatedEnvironment(dirname(archive)),
  }));
  packagePath(".", metadata.name, metadata.version);
  return Object.freeze({ name: metadata.name, version: metadata.version, dist: Object.freeze({
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    shasum: createHash("sha1").update(bytes).digest("hex"),
  }) });
}

async function existing(path: string): Promise<Buffer | null> {
  try { return await readFile(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function retain(path: string, bytes: Buffer, failure?: string): Promise<void> {
  const previous = await existing(path);
  if (previous) {
    if (!previous.equals(bytes)) throw new Error("Published test archive checksum differs.");
    return;
  }
  if (failure) throw new Error(failure);
  await mkdir(dirname(path), { recursive: true });
  const temporary = await mkdtemp(join(dirname(path), ".npr-"));
  try {
    const archive = join(temporary, "archive.tgz");
    await writeFile(archive, bytes);
    await link(archive, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const accepted = await readFile(path);
    if (!accepted.equals(bytes)) throw new Error("Published test archive checksum differs.");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export class TestPublisher implements PackagePublisher {
  private readonly failure?: string;
  constructor(readonly directory: string, { failure }: { readonly failure?: string } = {}) { this.failure = failure; }

  archive(name: string, version: string): string { return packagePath(this.directory, name, version); }

  async view(name: string, version: string): Promise<RegistryMetadata | null> {
    const archive = this.archive(name, version);
    const bytes = await existing(archive);
    if (!bytes) return null;
    const metadata = await archiveMetadata(archive, bytes);
    if (metadata.name !== name || metadata.version !== version) throw new Error("Test registry identity differs.");
    return metadata;
  }

  async available(name: string, version: string): Promise<void> {
    if (await this.view(name, version)) throw new Error(`Version is already published: ${name}@${version}`);
  }

  async publish(archive: string): Promise<void> {
    const bytes = await readFile(archive);
    const { name, version } = await archiveMetadata(archive, bytes);
    await retain(this.archive(name, version), bytes, this.failure);
  }
}

export class TestReleaseHost implements ReleaseHost {
  private readonly failure?: string;
  constructor(readonly directory: string, { failure }: { readonly failure?: string } = {}) { this.failure = failure; }

  archive(name: string, version: string): string { return packagePath(this.directory, name, version); }

  async create(identity: ReleaseIdentity, { archive, notes }: { archive: string; notes: string }): Promise<void> {
    const bytes = await readFile(archive);
    const metadata = await archiveMetadata(archive, bytes);
    if (metadata.name !== identity.name || metadata.version !== identity.version) throw new Error("Test hosting identity differs.");
    await readFile(notes, "utf8");
    await retain(this.archive(identity.name, identity.version), bytes, this.failure);
  }
}

function relativeFile(path: string): void {
  if (typeof path !== "string" || !path || path.includes("\0") || isAbsolute(path) || win32.isAbsolute(path) ||
    path.split(/[\\/]/u).includes("..")) throw new Error("Fixture paths must be relative files inside their root.");
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function gitMetadata(path: string): boolean {
  return path.split(/[\\/]/u).some((part) => part.toLowerCase() === ".git");
}

async function sourceFiles(root: string): Promise<string[]> {
  const paths: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (gitMetadata(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path); else paths.push(path);
    }
  }
  await visit("");
  return paths;
}

async function fixturePath(root: string, path: string, protectGit = false): Promise<string> {
  relativeFile(path);
  if (protectGit && gitMetadata(path)) throw new Error("Fixture files must not copy or replace Git metadata.");
  const resolvedRoot = await realpath(root);
  const destination = resolve(resolvedRoot, path);
  if (destination === resolvedRoot || !inside(resolvedRoot, destination)) throw new Error("Fixture path must name a file.");
  let ancestor = destination;
  for (;;) {
    try { await lstat(ancestor); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
      continue;
    }
    const resolvedAncestor = await realpath(ancestor);
    if (!inside(resolvedRoot, resolvedAncestor)) throw new Error("Fixture symbolic link escapes its root.");
    if (protectGit && gitMetadata(relative(resolvedRoot, resolvedAncestor))) {
      throw new Error("Fixture files must not copy or replace Git metadata.");
    }
    return destination;
  }
}

const ownership = Symbol("release-test-project");

export class ReleaseTestProject {
  readonly #directory: string;
  readonly environment: Environment;
  readonly publisher: TestPublisher;
  readonly host: TestReleaseHost;
  readonly provider: LocalExecutionProvider;
  readonly options: ReleaseOptions;
  readonly services: Readonly<{ publisher: TestPublisher; host: TestReleaseHost; provider: LocalExecutionProvider }>;

  private constructor(directory: string, token: symbol) {
    if (token !== ownership) throw new Error("Use ReleaseTestProject.create() for an owned temporary project.");
    this.#directory = directory;
    this.environment = isolatedEnvironment(join(directory, "home"));
    this.publisher = new TestPublisher(join(directory, "registry"));
    this.host = new TestReleaseHost(join(directory, "hosting"));
    this.provider = new LocalExecutionProvider(this.environment);
    this.services = Object.freeze({ publisher: this.publisher, host: this.host, provider: this.provider });
    this.options = Object.freeze({
      cwd: this.cwd, artifacts: this.artifacts, env: this.environment, run: this.run, log: () => {},
    });
  }

  get directory(): string { return this.#directory; }
  get cwd(): string { return join(this.#directory, "checkout"); }
  get remote(): string { return join(this.#directory, "remote.git"); }
  get artifacts(): string { return join(this.#directory, "artifacts"); }

  static async create(): Promise<ReleaseTestProject> {
    const project = new ReleaseTestProject(await mkdtemp(join(tmpdir(), "npr-project-")), ownership);
    try {
      await mkdir(project.cwd);
      await mkdir(join(project.directory, "home"));
      await writeFile(join(project.directory, "home", "gitconfig"), "");
      await project.run("git", ["init", "--bare", "--initial-branch=master", project.remote]);
      await project.git("init", "-b", "master");
      await project.git("config", "user.name", "Release Fixture");
      await project.git("config", "user.email", "release-fixture@example.test");
      await project.git("config", "commit.gpgsign", "false");
      await project.git("config", "tag.gpgsign", "false");
      await project.git("config", "core.autocrlf", "false");
      await project.git("remote", "add", "origin", project.remote);
      return project;
    } catch (error) {
      await project.dispose();
      throw error;
    }
  }

  readonly run: Command = async (program, args, options = {}) => command(program, args, {
    ...options, cwd: options.cwd || this.cwd,
    env: { ...isolatedEnvironment(join(this.directory, "home")), ...this.environment, ...options.env },
  });

  async git(...args: string[]): Promise<string> { return this.run("git", args); }

  async write(path: string, content: string): Promise<void> {
    const destination = await fixturePath(this.cwd, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }

  async copyFiles(root: string, selection?: string | readonly string[]): Promise<void> {
    if (selection !== undefined && typeof selection !== "string" && !Array.isArray(selection)) {
      throw new Error("Fixture selection must be a glob string or an array of files.");
    }
    if (typeof selection === "string") relativeFile(selection);
    const matcher = typeof selection === "string"
      ? new Minimatch(selection.replace(/^(?:\.\/)+/u, ""), { dot: true, nonegate: true, nocomment: true, platform: "linux" })
      : undefined;
    const paths = typeof selection === "string" || selection === undefined ? await sourceFiles(root) : selection;
    const files: { source: string; destination: string; mode: number }[] = [];
    for (const path of paths) {
      if (matcher && !matcher.match(path.split(sep).join("/"))) continue;
      const source = await fixturePath(root, path, true);
      const sourceStat = await stat(source);
      if (!sourceStat.isFile()) throw new Error("Fixture source must be a regular file.");
      const destination = await fixturePath(this.cwd, path, true);
      try {
        if (!(await stat(destination)).isFile()) throw new Error("Fixture destination must be a regular file.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      files.push({ source, destination, mode: sourceStat.mode });
    }
    for (const { source, destination, mode } of files) {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      await chmod(destination, mode & 0o777);
    }
  }

  async commit(message = "Prepare release fixture"): Promise<void> {
    await this.git("add", "--all", "--", ".");
    await this.git("commit", "-m", message);
    await this.git("push", "-u", "origin", "master");
    await this.git("remote", "set-head", "origin", "master");
  }

  async remoteFile(ref: string, path: string): Promise<string> {
    relativeFile(path);
    await this.git("check-ref-format", "--branch", ref);
    return this.git("--git-dir", this.remote, "show", `${ref}:${path}`);
  }

  async dispose(): Promise<void> { await rm(this.#directory, { recursive: true, force: true }); }
}
