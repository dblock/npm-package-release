import { readFile, writeFile, mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { inc, valid } from "semver";
import { numericVersion } from "./command.js";
import { releaseChangelog, nextChangelog } from "./changelog.js";
import type {
  Artifact, ArtifactContext, Changelog, ChangelogConfig, Command, HookContext, Log, PackagePublisher,
  RegistryVerifier, ReleaseConfig, ReleaseHost, ReleaseIdentity, ReleaseState, ReleaseStore,
  ReleaseValidator, Verification, VerificationOptions, VersionPolicy,
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

export class MarkdownChangelog implements Changelog {
  constructor(readonly path: string, readonly config: ChangelogConfig) {}

  async release(identity: { version: string; date: string }): Promise<string> {
    const updated = releaseChangelog(await readFile(this.path, "utf8"), { ...this.config, ...identity });
    await writeFile(this.path, updated.source);
    return updated.notes;
  }

  async next(identity: { version: string; releasedVersion: string }): Promise<void> {
    await writeFile(this.path, nextChangelog(await readFile(this.path, "utf8"), { ...this.config, ...identity }));
  }
}

export class GitHubReleaseHost implements ReleaseHost {
  constructor(readonly run: Command, readonly repository: string) {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error("Configure a GitHub owner/repository.");
  }

  async create(release: ReleaseIdentity, { archive, notes }: { archive: string; notes: string }) {
    await this.run("gh", ["release", "create", `v${release.version}`, archive, "--repo", this.repository,
      "--verify-tag", "--title", release.version, "--notes-file", notes]);
  }
}

export class HookValidator implements ReleaseValidator {
  constructor(readonly config: Pick<ReleaseConfig, "validate" | "validateArtifact"> = {}) {}

  async validate(context: HookContext): Promise<void> {
    if (this.config.validate) return this.config.validate(context);
    await context.run("npm", ["test"]);
    await context.run("npm", ["run", "lint"]);
  }

  async artifact(context: ArtifactContext): Promise<void> {
    await this.config.validateArtifact?.(context);
  }
}

export class DirectoryReleaseStore implements ReleaseStore {
  constructor(readonly directory: string) {}

  async initialize(state: ReleaseState): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    if ((await readdir(this.directory)).length) {
      throw new Error("Existing release artifacts: inspect recovery state; never blindly republish.");
    }
    await writeFile(join(this.directory, "release.json"), JSON.stringify(state, null, 2) + "\n", { flag: "wx" });
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
  constructor(readonly publisher: PackagePublisher) {}

  async verify(state: ReleaseIdentity & { readonly artifact: Artifact },
    options: VerificationOptions, log: Log): Promise<Verification> {
    const { attempts, delay } = verificationOptions(options);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const metadata = await this.publisher.view(state.name, state.version);
      if (metadata) {
        if (metadata.dist?.integrity !== state.artifact.integrity || metadata.dist?.shasum !== state.artifact.shasum) {
          throw new Error("Published archive integrity mismatch.");
        }
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
