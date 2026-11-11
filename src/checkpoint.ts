import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { numericVersion } from "./command.js";
import { Release } from "./release-description.js";
import { verificationOptions } from "./services.js";
import { semanticPlan } from "./semantic.js";
import type { SemanticPlan } from "./semantic.js";
import type { ReleaseDescription } from "./release-description.js";
import type { Artifact, RepositoryCheckpoint, VerificationOptions } from "./contracts.js";
import type { BuiltRelease } from "./steps.js";

export interface ReleaseCheckpoint {
  readonly semantic?: SemanticPlan;
  readonly schema: 1;
  readonly release: ReleaseDescription;
  readonly source: RepositoryCheckpoint;
  readonly artifact: Artifact;
  readonly timezone: string;
  readonly verificationOptions: VerificationOptions;
  readonly notesDigest: string;
  readonly bundleDigest: string;
}

export async function fileDigest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function writeCheckpoint({ runtime, state, release }: BuiltRelease): Promise<void> {
  const directory = runtime.services.store.directory;
  const checkpoint: ReleaseCheckpoint = {
    schema: 1, release,
    source: {
      branch: state.branch, remote: state.remote, initialCommit: state.initialCommit,
      releaseCommit: state.releaseCommit, preparedTree: state.preparedTree,
    },
    artifact: state.artifact, timezone: state.timezone, verificationOptions: state.verificationOptions,
    notesDigest: await fileDigest(join(directory, "release-notes.md")),
    bundleDigest: await fileDigest(join(directory, "release.bundle")),
    ...(state.semantic ? { semantic: state.semantic } : {}),
  };
  await writeFile(join(directory, "checkpoint.json"), JSON.stringify(checkpoint, null, 2) + "\n", { flag: "wx" });
}

export async function readCheckpoint(directory: string): Promise<ReleaseCheckpoint> {
  const checkpoint: ReleaseCheckpoint = JSON.parse(await readFile(join(directory, "checkpoint.json"), "utf8"));
  if (checkpoint.schema !== 1) throw new Error("Unsupported release checkpoint.");
  const release = new Release(checkpoint.release);
  numericVersion(release.version);
  numericVersion(release.manifestVersion);
  numericVersion(release.nextVersion!);
  const { source, artifact } = checkpoint;
  if (!source || [source.initialCommit, source.releaseCommit, source.preparedTree]
    .some((value) => typeof value !== "string" || !/^[a-f0-9]{40,64}$/u.test(value)) ||
    typeof source.branch !== "string" || !source.branch.trim() ||
    typeof source.remote !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(source.remote) ||
    !artifact || typeof artifact.filename !== "string" || basename(artifact.filename) !== artifact.filename ||
    !artifact.filename.endsWith(".tgz") || typeof artifact.integrity !== "string" || typeof artifact.shasum !== "string") {
    throw new Error("Invalid release checkpoint identity.");
  }
  if (typeof checkpoint.timezone !== "string" || !checkpoint.timezone ||
    !checkpoint.verificationOptions || !Number.isInteger(checkpoint.verificationOptions.attempts) ||
    !Number.isInteger(checkpoint.verificationOptions.delay)) throw new Error("Invalid checkpoint execution settings.");
  new Intl.DateTimeFormat("en", { timeZone: checkpoint.timezone }).format();
  for (const [file, digest] of [["release-notes.md", checkpoint.notesDigest], ["release.bundle", checkpoint.bundleDigest]]) {
    if (typeof digest !== "string" || digest !== await fileDigest(join(directory, file))) {
      throw new Error(`Checkpoint integrity mismatch: ${file}`);
    }
  }
  if (await readFile(join(directory, "release-notes.md"), "utf8") !== (release.notes || "") + "\n") {
    throw new Error("Checkpoint release notes differ.");
  }
  const semantic = checkpoint.semantic === undefined ? undefined : semanticPlan(checkpoint.semantic);
  if (semantic) {
    semantic.decision.check(source.initialCommit, release.version);
    if (semantic.decision.notes !== release.notes) throw new Error("Checkpoint notes differ from semantic decision.");
  }
  return Object.freeze({
    schema: 1, release,
    source: Object.freeze({
      branch: source.branch, remote: source.remote, initialCommit: source.initialCommit,
      releaseCommit: source.releaseCommit, preparedTree: source.preparedTree,
    }),
    artifact: Object.freeze({ filename: artifact.filename, integrity: artifact.integrity, shasum: artifact.shasum }),
    timezone: checkpoint.timezone, verificationOptions: verificationOptions(checkpoint.verificationOptions),
    notesDigest: checkpoint.notesDigest, bundleDigest: checkpoint.bundleDigest,
    ...(semantic ? { semantic } : {}),
  });
}
