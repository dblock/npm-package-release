import { readFile, writeFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { inc, valid } from "semver";
import { numericVersion } from "./command.js";
import { releaseChangelog, nextChangelog, changelogTemplate } from "./changelog.js";
import type { ChangelogTemplate } from "./changelog.js";
import { matchingPublication } from "./package.js";
import { semanticPlan } from "./semantic.js";
import type {
  Artifact, ArtifactContext, Changelog, ChangelogFormat, Command, HookContext, Log, PackagePublisher,
  RegistryVerifier, ReleaseHost, ReleaseIdentity, ReleaseState, ReleaseStore,
  ReleaseValidator, ValidationHooks, Verification, VerificationOptions, VersionPolicy,
} from "./contracts.js";

export function verificationOptions(options: Partial<VerificationOptions> = {}): VerificationOptions {
  const { attempts = 6, delay = 10_000 } = options;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 60 ||
    !Number.isInteger(delay) || delay < 0 || delay > 60_000) throw new Error("Invalid bounded verification options.");
  return Object.freeze({ attempts, delay });
}

export function snapshot<State extends ReleaseState>(state: State): Readonly<State> {
  return Object.freeze({
    ...state,
    verificationOptions: Object.freeze({ ...state.verificationOptions }),
    ...(state.artifact ? { artifact: Object.freeze({ ...state.artifact }) } : {}),
    ...(state.semantic ? { semantic: semanticPlan(state.semantic) } : {}),
  });
}

export class NumericPatchVersions implements VersionPolicy {
  select(current: string, requested?: string) {
    const version = numericVersion(requested?.trim() || current);
    if (!valid(version)) throw new Error("Invalid semantic version.");
    const nextVersion = inc(version, "patch");
    if (!nextVersion) throw new Error("Cannot increment the selected version.");
    return Object.freeze({ version, nextVersion });
  }
}

export abstract class MarkdownChangelog implements Changelog {
  abstract readonly format: ChangelogFormat;
  constructor(readonly path = "CHANGELOG.md", protected readonly template: ChangelogTemplate = {}) {}

  async release(identity: { version: string; date: string; cwd?: string }): Promise<string> {
    const path = resolve(identity.cwd || ".", this.path);
    const updated = releaseChangelog(await readFile(path, "utf8"), { ...identity, ...this.template, format: this.format });
    await writeFile(path, updated.source);
    return updated.notes;
  }

  async next(identity: { version: string; releasedVersion: string; cwd?: string }): Promise<void> {
    const path = resolve(identity.cwd || ".", this.path);
    await writeFile(path, nextChangelog(await readFile(path, "utf8"), { ...identity, ...this.template, format: this.format }));
  }
}

export class KeepAChangelog extends MarkdownChangelog {
  readonly format = "keep-a-changelog";
  constructor(path = "CHANGELOG.md", template: ChangelogTemplate = {}) {
    super(path, changelogTemplate("keep-a-changelog", template));
  }
}

export class IntrideaChangelog extends MarkdownChangelog {
  readonly format = "intridea";
  constructor(path = "CHANGELOG.md", template: { readonly placeholder?: string } = {}) {
    super(path, changelogTemplate("intridea", template));
  }
}

export class GitHubReleaseHost implements ReleaseHost {
  constructor(readonly run: Command, readonly repository: string) {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error("Configure a GitHub owner/repository.");
  }

  async create(release: ReleaseIdentity, { archive, notes }: { archive: string; notes: string }) {
    numericVersion(release.version);
    const body = (await readFile(notes, "utf8")).replaceAll("\r\n", "\n").trimEnd();
    const digest = "sha256:" + createHash("sha256").update(await readFile(archive)).digest("hex");
    const name = basename(archive);
    const inspect = async () => {
      const metadata = await this.metadata(release.version);
      if (!metadata) return null;
      if (metadata.tag_name !== `v${release.version}` || metadata.name !== release.version ||
        typeof metadata.body !== "string" || metadata.body.replaceAll("\r\n", "\n").trimEnd() !== body ||
        metadata.draft !== false || metadata.prerelease !== false || !Array.isArray(metadata.assets)) {
        throw new Error("Hosted release metadata differs; refusing to overwrite it.");
      }
      const assets = metadata.assets.filter((asset) => asset.name === name);
      if (assets.length > 1 || (assets.length === 1 && await this.assetDigest(assets[0]) !== digest)) {
        throw new Error("Hosted release asset checksum differs or is unavailable.");
      }
      return assets.length === 1;
    };
    const existing = await inspect();
    if (existing === true) return;
    try {
      await this.run("gh", existing === null
        ? ["release", "create", `v${release.version}`, archive, "--repo", this.repository,
          "--verify-tag", "--title", release.version, "--notes-file", notes]
        : ["release", "upload", `v${release.version}`, archive, "--repo", this.repository]);
    } catch (error) {
      if (await inspect() === true) return;
      throw error;
    }
    if (await inspect() !== true) throw new Error("Hosted release output could not be verified.");
  }

  private async assetDigest(asset: HostedMetadata["assets"][number]): Promise<string> {
    if (typeof asset.digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(asset.digest)) return asset.digest;
    if (!Number.isSafeInteger(asset.id) || asset.id! <= 0) {
      throw new Error("Hosted release asset checksum differs or is unavailable: expected a positive download ID.");
    }
    const directory = await mkdtemp(join(tmpdir(), "npr-github-asset-"));
    try {
      const output = join(directory, "asset");
      await this.run("gh", ["api", `repos/${this.repository}/releases/assets/${asset.id}`,
        "--header", "Accept: application/octet-stream"], { output });
      return "sha256:" + createHash("sha256").update(await readFile(output)).digest("hex");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async metadata(version: string): Promise<HostedMetadata | null> {
    let output: string;
    try {
      output = await this.run("gh", ["api", "--include", `repos/${this.repository}/releases/tags/v${version}`]);
    } catch (error) {
      if (/^HTTP\/[\d.]+ 404\b/u.test((error as { stdout?: string }).stdout || "")) return null;
      throw error;
    }
    const response = /^HTTP\/[\d.]+ 200[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*)$/u.exec(output);
    if (!response) throw new Error("Invalid hosted release response.");
    const metadata = JSON.parse(response[1]);
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) throw new Error("Invalid hosted release metadata.");
    return metadata;
  }
}

interface HostedMetadata {
  tag_name: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; digest?: string; id?: number }[];
}

export class HookValidator implements ReleaseValidator {
  constructor(readonly hooks: ValidationHooks = {}) {}

  async validate(context: HookContext): Promise<void> {
    if (this.hooks.validate) return this.hooks.validate(context);
    await context.run("npm", ["test"]);
    await context.run("npm", ["run", "lint"]);
  }

  async artifact(context: ArtifactContext): Promise<void> {
    await this.hooks.validateArtifact?.(context);
  }
}

export class DirectoryReleaseStore implements ReleaseStore {
  constructor(readonly directory: string) {}

  async initialize(state: ReleaseState): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.save(state);
  }

  async read(): Promise<ReleaseState> {
    const state: ReleaseState = JSON.parse(await readFile(join(this.directory, "release.json"), "utf8"));
    return snapshot(state);
  }

  async save(state: ReleaseState): Promise<void> {
    await writeFile(join(this.directory, "release.json.tmp"), JSON.stringify(state, null, 2) + "\n");
    await rename(join(this.directory, "release.json.tmp"), join(this.directory, "release.json"));
  }
}

export class RegistryVisibility implements RegistryVerifier {
  readonly options: VerificationOptions;
  constructor(readonly publisher: PackagePublisher, options: Partial<VerificationOptions> = {}) {
    this.options = verificationOptions(options);
  }

  async verify(state: ReleaseIdentity & { readonly artifact: Artifact },
    options: VerificationOptions, log: Log): Promise<Verification> {
    const { attempts, delay } = verificationOptions(options);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const metadata = await this.publisher.view(state.name, state.version);
      if (metadata) {
        matchingPublication(metadata, state.artifact);
        return "verified";
      }
      if (attempt + 1 < attempts) {
        log(`[npr] waiting for registry visibility (${attempt + 1}/${attempts})`);
        await setTimeout(delay);
      }
    }
    return "unverified";
  }
}
