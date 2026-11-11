import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import type { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { numericVersion } from "./command.js";
import type {
  Artifact, Command, CommandOptions, Lockfile, PackageManifest, PackageProject, PackagePublisher,
  RegistryMetadata, ReleaseIdentity,
} from "./contracts.js";

interface NpmMetadata {
  name?: string;
  version?: string;
  filename?: string;
  integrity?: string;
  shasum?: string;
  dist?: RegistryMetadata["dist"];
}

export function record(output: string): NpmMetadata {
  const value = JSON.parse(output);
  const entries = Array.isArray(value) ? value : value.name ? [value] : Object.values(value);
  if (entries.length !== 1 || typeof entries[0] !== "object" || entries[0] === null) {
    throw new Error("Expected metadata for exactly one npm package.");
  }
  return entries[0];
}

export class NpmPackage implements PackageProject, PackagePublisher {
  readonly npm: (args: string[], options?: CommandOptions) => Promise<string>;

  constructor(readonly cwd: string, readonly run: Command) {
    this.npm = (args, options) => run("npm", args, options);
  }

  async read(): Promise<PackageManifest> {
    const metadata: PackageManifest = JSON.parse(await readFile(join(this.cwd, "package.json"), "utf8"));
    numericVersion(metadata.version);
    if (typeof metadata.name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(metadata.name)) {
      throw new Error("Expected an npm package name.");
    }
    if (metadata.private || metadata.workspaces || metadata.publishConfig?.directory ||
      (metadata.publishConfig?.registry && metadata.publishConfig.registry !== "https://registry.npmjs.org/") ||
      (metadata.publishConfig?.tag && metadata.publishConfig.tag !== "latest")) {
      throw new Error("Only a public root package on registry.npmjs.org with the latest tag is supported.");
    }
    return metadata;
  }

  async setVersion(version: string) {
    numericVersion(version);
    const manifest = await this.read();
    const lock = await this.lockfile(manifest);
    if (manifest.version === version) return;
    const files: [string, { version: string }][] = [[join(this.cwd, "package.json"), { ...manifest }]];
    if (lock) {
      if (lock.packages?.[""]) lock.packages[""].version = version;
      files.push([join(this.cwd, "package-lock.json"), lock]);
    }
    for (const [path, metadata] of files) {
      const source = await readFile(path, "utf8");
      metadata.version = version;
      const indent = /\r?\n([ \t]+)"/u.exec(source)?.[1] || 2;
      const newline = source.includes("\r\n") ? "\r\n" : "\n";
      await writeFile(path, JSON.stringify(metadata, null, indent).replaceAll("\n", newline) + newline);
    }
  }

  async lockfile(manifest: PackageManifest): Promise<Lockfile | null> {
    try {
      const lock: Lockfile = JSON.parse(await readFile(join(this.cwd, "package-lock.json"), "utf8"));
      if (lock.name !== manifest.name || lock.version !== manifest.version ||
        (lock.packages?.[""] && (lock.packages[""].version !== manifest.version ||
          (lock.packages[""].name && lock.packages[""].name !== manifest.name)))) {
        throw new Error("Lockfile and manifest identity/version must agree.");
      }
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return null;
    }
  }

  async view(name: string, version: string): Promise<RegistryMetadata | null> {
    try {
      const metadata = record(await this.npm(["view", `${name}@${version}`, "name", "version", "dist", "--json",
        "--registry=https://registry.npmjs.org/", "--prefer-online", "--offline=false",
        "--fetch-retries=0", "--fetch-timeout=15000"], { timeout: 30_000 }));
      if (metadata.name !== name || metadata.version !== version) throw new Error("Registry identity/version mismatch.");
      return metadata as RegistryMetadata;
    } catch (error) {
      let output;
      try { output = JSON.parse((error as { stdout: string }).stdout); } catch { /* Only structured npm E404 responses mean missing. */ }
      if (output?.error?.code === "E404") return null;
      throw error;
    }
  }

  async inspect(archive: string, identity: ReleaseIdentity): Promise<Artifact> {
    const manifest = JSON.parse(await this.run("tar", ["-xOf", archive, "package/package.json"]));
    if (manifest.name !== identity.name || manifest.version !== identity.version) {
      throw new Error("Packed manifest identity/version mismatch.");
    }
    const bytes = await readFile(archive);
    return Object.freeze({
      filename: basename(archive),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      shasum: createHash("sha1").update(bytes).digest("hex"),
    });
  }

  async pack(directory: string, identity: ReleaseIdentity) {
    const temporary = await mkdtemp(join(directory, ".npr-pack-"));
    try {
      const metadata = record(await this.npm(["pack", "--json", "--pack-destination", temporary]));
      if (metadata.name !== identity.name || metadata.version !== identity.version ||
        typeof metadata.filename !== "string" || basename(metadata.filename) !== metadata.filename) {
        throw new Error("npm pack identity/version/filename mismatch.");
      }
      const packed = join(temporary, metadata.filename);
      const artifact = await this.inspect(packed, identity);
      if (artifact.integrity !== metadata.integrity || artifact.shasum !== metadata.shasum) {
        throw new Error("npm pack archive integrity mismatch.");
      }
      const target = join(directory, metadata.filename);
      let existing: Buffer | undefined;
      try { existing = await readFile(target); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing) {
        if (!existing.equals(await readFile(packed))) throw new Error("Existing archive differs from the reproducible build.");
      } else await copyFile(packed, target, constants.COPYFILE_EXCL);
      return artifact;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  async consumer(archive: string, check: (consumer: string) => Promise<void>) {
    const consumer = await mkdtemp(join(tmpdir(), "npr-consumer-"));
    try {
      await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
      await this.npm(["install", "--engine-strict", "--ignore-scripts", "--no-audit", "--no-fund",
        "--package-lock=false", archive], { cwd: consumer });
      await check(consumer);
    } finally {
      await rm(consumer, { recursive: true, force: true });
    }
  }

  async intact(directory: string, state: ReleaseIdentity & { readonly artifact: Artifact }) {
    const { filename } = state.artifact;
    if (typeof filename !== "string" || basename(filename) !== filename) throw new Error("Invalid retained archive filename.");
    const actual = await this.inspect(join(directory, filename), state);
    if (actual.integrity !== state.artifact.integrity || actual.shasum !== state.artifact.shasum) {
      throw new Error("Retained archive integrity mismatch.");
    }
  }

  async publish(archive: string) {
    const identity: ReleaseIdentity = JSON.parse(await this.run("tar", ["-xOf", archive, "package/package.json"]));
    numericVersion(identity.version);
    if (typeof identity.name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(identity.name)) {
      throw new Error("Invalid packed package name.");
    }
    const artifact = await this.inspect(archive, identity);
    const published = async () => {
      const metadata = await this.view(identity.name, identity.version);
      if (!metadata) return false;
      matchingPublication(metadata, artifact);
      return true;
    };
    if (await published()) return;
    try {
      await this.npm(["publish", archive, "--ignore-scripts", "--access=public", "--tag=latest",
        "--registry=https://registry.npmjs.org/"]);
    } catch (error) {
      if (await published()) return;
      throw error;
    }
  }
}

export function matchingPublication(metadata: RegistryMetadata, artifact: Artifact): void {
  if (metadata.dist?.integrity !== artifact.integrity || metadata.dist?.shasum !== artifact.shasum) {
    throw new Error("Published archive integrity mismatch or unavailable; refusing to republish.");
  }
}
