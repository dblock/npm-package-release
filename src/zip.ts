import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import process from "node:process";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { command, numericVersion } from "./command.js";
import { manifestLockfile, readManifest, setManifestVersion } from "./package.js";
import type {
  Artifact, Command, Environment, Lockfile, PackageManifest, PackageProject, ProjectContext, ReleaseIdentity,
} from "./contracts.js";

export interface ZipArchiveOptions {
  readonly build?: readonly string[];
  readonly directory?: string;
  readonly name?: string;
  readonly cwd?: string;
  readonly run?: Command;
  readonly env?: Environment;
}

export interface ZipEntry {
  readonly path: string;
  readonly content: Uint8Array;
}

const UTF8 = 0x0800;
const DEFLATE = 8;
const VERSION = 20;
const UNIX = 3 << 8;
const FILE_MODE = 0o100644;
const MAX_UINT32 = 0xffffffff;

function relativePath(path: string, option: string): string {
  if (typeof path !== "string" || !path || path.includes("\0") || path.includes("\\") || isAbsolute(path) ||
    win32.isAbsolute(path) || path.split("/").some((part) => part === ".." || part === "." || part === "" ||
      part.toLowerCase() === ".git")) {
    throw new Error(`${option} must be a relative path inside the project, using / separators.`);
  }
  return path;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export function dosTimestamp(epoch: number): { readonly time: number; readonly date: number } {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Invalid source timestamp.");
  const moment = new Date(Math.max(epoch, 315_532_800) * 1000);
  const year = moment.getUTCFullYear();
  if (year > 2107) throw new Error("Source timestamp is beyond the ZIP date range.");
  return Object.freeze({
    time: (moment.getUTCHours() << 11) | (moment.getUTCMinutes() << 5) | (moment.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((moment.getUTCMonth() + 1) << 5) | moment.getUTCDate(),
  });
}

export function createZip(entries: readonly ZipEntry[], epoch: number): Uint8Array {
  const { time, date } = dosTimestamp(epoch);
  const sorted = [...entries].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  if (sorted.length > 0xffff) throw new Error("ZIP archives support at most 65535 files without ZIP64.");
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [index, { path, content }] of sorted.entries()) {
    relativePath(path, "ZIP entry");
    if (index && sorted[index - 1].path === path) throw new Error(`Duplicate ZIP entry: ${path}`);
    const name = Buffer.from(path, "utf8");
    const compressed = deflateRawSync(content, { level: 9 });
    const checksum = crc32(content);
    if (content.length >= MAX_UINT32 || compressed.length >= MAX_UINT32 || offset >= MAX_UINT32) {
      throw new Error("ZIP archives larger than 4 GiB are not supported.");
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(UNIX | VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(UTF8, 8);
    central.writeUInt16LE(DEFLATE, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((FILE_MODE << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  if (offset + directory.length >= MAX_UINT32) throw new Error("ZIP archives larger than 4 GiB are not supported.");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function readZip(data: Uint8Array): ZipEntry[] {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const invalid = (reason: string) => new Error(`Invalid ZIP archive: ${reason}.`);
  if (bytes.length < 22) throw invalid("missing end of central directory");
  const end = bytes.length - 22;
  if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 20) !== 0 ||
    bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) {
    throw invalid("unsupported end of central directory");
  }
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  let cursor = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 8) !== count || cursor + size !== end) throw invalid("inconsistent central directory");
  const entries: ZipEntry[] = [];
  let expectedOffset = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw invalid("truncated central directory");
    const method = bytes.readUInt16LE(cursor + 10);
    const flags = bytes.readUInt16LE(cursor + 8);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42);
    if (method !== DEFLATE || (flags & ~UTF8) !== 0 || extraLength !== 0 || offset !== expectedOffset) {
      throw invalid("unsupported entry");
    }
    const path = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const local = bytes.subarray(offset, offset + 30 + nameLength);
    if (local.length !== 30 + nameLength || local.readUInt32LE(0) !== 0x04034b50 ||
      !local.subarray(4, 26).equals(bytes.subarray(cursor + 6, cursor + 28)) ||
      local.readUInt16LE(26) !== nameLength || local.readUInt16LE(28) !== 0 || local.subarray(30).toString("utf8") !== path) {
      throw invalid(`local header differs for ${path}`);
    }
    relativePath(path, "ZIP entry");
    const start = offset + 30 + nameLength;
    const content = inflateRawSync(bytes.subarray(start, start + compressedSize));
    if (content.length !== uncompressedSize || crc32(content) !== checksum) throw invalid(`checksum differs for ${path}`);
    entries.push(Object.freeze({ path, content }));
    expectedOffset = start + compressedSize;
    cursor += 46 + nameLength + extraLength;
  }
  if (expectedOffset !== bytes.readUInt32LE(end + 16)) throw invalid("unexpected data before the central directory");
  return entries;
}

export async function directoryEntries(root: string): Promise<ZipEntry[]> {
  const canonicalRoot = await realpath(root);
  if (!(await stat(canonicalRoot)).isDirectory()) throw new Error("Archive directory must be a directory.");
  const entries: ZipEntry[] = [];
  async function visit(directory: string): Promise<void> {
    const children = await readdir(join(canonicalRoot, directory));
    if (!children.length && directory) throw new Error(`Archive directory contains an empty directory: ${directory}`);
    for (const name of children) {
      const path = directory ? `${directory}/${name}` : name;
      if (name.toLowerCase() === ".git") throw new Error(`Archive directory must not contain Git metadata: ${path}`);
      const absolute = join(canonicalRoot, ...path.split("/"));
      const link = await lstat(absolute);
      const target = link.isSymbolicLink() ? await realpath(absolute).catch(() => null) : absolute;
      if (!target || !inside(canonicalRoot, target)) throw new Error(`Archive symbolic link escapes its directory: ${path}`);
      const info = await stat(target);
      if (info.isDirectory()) {
        if (link.isSymbolicLink()) throw new Error(`Archive directory must not contain directory links: ${path}`);
        await visit(path);
      } else if (info.isFile()) {
        entries.push(Object.freeze({ path, content: await readFile(target) }));
      } else throw new Error(`Archive directory contains an unsupported file: ${path}`);
    }
  }
  await visit("");
  if (!entries.length) throw new Error("Archive directory contains no files.");
  return entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}

function artifact(filename: string, bytes: Uint8Array): Artifact {
  return Object.freeze({
    filename,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    shasum: createHash("sha1").update(bytes).digest("hex"),
  });
}

export class ZipArchive implements PackageProject {
  readonly build: readonly string[];
  readonly directory: string;
  readonly name?: string;
  readonly cwd: string;
  readonly run: Command;
  readonly env: Environment;

  constructor({ build = ["npm", "run", "build"], directory = "build", name, cwd, run = command, env = process.env }: ZipArchiveOptions = {}) {
    if (!Array.isArray(build) || !build[0] || !build.every((part) => typeof part === "string")) {
      throw new Error("ZipArchive build must be a nonempty array of program and argument strings.");
    }
    if (name !== undefined && (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name))) {
      throw new Error("ZipArchive name must be a filename-safe string.");
    }
    if (typeof run !== "function") throw new Error("ZipArchive run must be a command function.");
    this.build = Object.freeze([...build]);
    this.directory = relativePath(directory, "ZipArchive directory");
    this.name = name;
    this.cwd = cwd ?? process.cwd();
    this.run = run;
    this.env = Object.freeze({ ...env });
    Object.freeze(this);
  }

  bind({ cwd, run, env }: ProjectContext): ZipArchive {
    return new ZipArchive({ build: this.build, directory: this.directory, name: this.name, cwd, run, env });
  }

  filename(identity: ReleaseIdentity): string {
    numericVersion(identity.version);
    const name = this.name ?? identity.name.replace(/^@/u, "").replace("/", "-");
    return `${name}-v${identity.version}.zip`;
  }

  async read(): Promise<PackageManifest> {
    const manifest = await readManifest(this.cwd);
    if (manifest.workspaces) throw new Error("ZipArchive supports a root package without workspaces.");
    return manifest;
  }

  async setVersion(version: string): Promise<void> {
    await setManifestVersion(this.cwd, version, this);
  }

  async lockfile(manifest: PackageManifest): Promise<Lockfile | null> {
    return manifestLockfile(this.cwd, manifest);
  }

  private epoch(): number {
    const epoch = this.env.SOURCE_DATE_EPOCH;
    if (!epoch || !/^\d+$/u.test(epoch)) throw new Error("ZipArchive requires a numeric SOURCE_DATE_EPOCH.");
    return Number(epoch);
  }

  private async built(): Promise<ZipEntry[]> {
    const root = await realpath(this.cwd);
    const directory = resolve(root, ...this.directory.split("/"));
    let canonical: string;
    try { canonical = await realpath(directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Archive directory is missing: ${this.directory}`);
      throw error;
    }
    if (!inside(root, canonical) || canonical === root) throw new Error("Archive directory must be inside the project.");
    return directoryEntries(canonical);
  }

  async pack(directory: string, identity: ReleaseIdentity): Promise<Artifact> {
    const [program, ...args] = this.build;
    await this.run(program, args, { cwd: this.cwd });
    const bytes = createZip(await this.built(), this.epoch());
    const filename = this.filename(identity);
    const target = join(directory, filename);
    let existing: Buffer | undefined;
    try { existing = await readFile(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) {
      if (Buffer.compare(existing, bytes) !== 0) throw new Error("Existing archive differs from the reproducible build.");
    } else {
      const temporary = await mkdtemp(join(directory, ".npr-zip-"));
      try {
        await writeFile(join(temporary, filename), bytes);
        await copyFile(join(temporary, filename), target, constants.COPYFILE_EXCL);
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    return artifact(filename, bytes);
  }

  async consumer(archive: string, check: (consumer: string) => Promise<void>): Promise<void> {
    const entries = readZip(await readFile(archive));
    const built = await this.built();
    if (entries.length !== built.length || entries.some(({ path, content }, index) =>
      path !== built[index].path || Buffer.compare(content, built[index].content) !== 0)) {
      throw new Error("ZIP archive entries differ from the built directory.");
    }
    const consumer = await mkdtemp(join(tmpdir(), "npr-consumer-"));
    try {
      for (const { path, content } of entries) {
        const destination = join(consumer, ...path.split("/"));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, content);
      }
      await check(consumer);
    } finally {
      await rm(consumer, { recursive: true, force: true });
    }
  }

  async intact(directory: string, state: ReleaseIdentity & { readonly artifact: Artifact }): Promise<void> {
    const { filename } = state.artifact;
    if (typeof filename !== "string" || basename(filename) !== filename || !filename.endsWith(".zip")) {
      throw new Error("Invalid retained archive filename.");
    }
    const bytes = await readFile(join(directory, filename));
    readZip(bytes);
    const actual = artifact(filename, bytes);
    if (actual.integrity !== state.artifact.integrity || actual.shasum !== state.artifact.shasum) {
      throw new Error("Retained archive integrity mismatch.");
    }
  }
}
