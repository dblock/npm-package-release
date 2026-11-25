import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { Minimatch } from "minimatch";
import type { Command } from "./contracts.js";

export type VersionReferenceMap = Readonly<Record<string, readonly RegExp[]>>;

function selectorPath(path: string, option: string): void {
  if (!path || path.includes("\0") || path.includes("\\") || isAbsolute(path) || win32.isAbsolute(path) ||
    path.split("/").some((part) => part === ".." || part.toLowerCase() === ".git")) {
    throw new Error(`${option} paths must be relative files or globs inside the repository, using / separators.`);
  }
}

function hasVersionGroup(pattern: RegExp): boolean {
  const groups = new RegExp(`(?:${pattern.source})|`, pattern.flags.replace(/[gyd]/gu, "")).exec("")?.groups;
  return !!groups && Object.hasOwn(groups, "version");
}

export function versionReferences(value: unknown, option: string): VersionReferenceMap | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${option} must map file paths or globs to arrays of regular expressions.`);
  }
  const references: Record<string, readonly RegExp[]> = Object.create(null);
  for (const [path, patterns] of Object.entries(value)) {
    selectorPath(path, option);
    if (!Array.isArray(patterns) || !patterns.length || !patterns.every((pattern) => pattern instanceof RegExp)) {
      throw new Error(`${option} for ${path} must be a nonempty array of regular expressions.`);
    }
    references[path] = Object.freeze(patterns.map((pattern: RegExp) => {
      if (!hasVersionGroup(pattern)) throw new Error(`${option} pattern ${pattern} must capture a named group "version".`);
      return new RegExp(pattern.source, pattern.flags.replace(/[gyd]/gu, ""));
    }));
  }
  return Object.freeze(references);
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

interface Selection { readonly selector: string; readonly patterns: readonly RegExp[]; readonly version: string }

export async function updateReferences(
  selections: readonly { readonly references?: VersionReferenceMap; readonly version: string; readonly option: string }[],
  cwd: string, run: Command,
): Promise<void> {
  const plan: Selection[] = [];
  for (const { references, version, option } of selections) {
    for (const [selector, patterns] of Object.entries(versionReferences(references, option) || {})) {
      plan.push({ selector, patterns, version });
    }
  }
  if (!plan.length) return;
  const root = await realpath(cwd);
  const matchers = plan.map(({ selector }) => {
    const matcher = new Minimatch(selector.replace(/^(?:\.\/)+/u, ""), { dot: true, nonegate: true, nocomment: true, platform: "linux" });
    return matcher.hasMagic() ? matcher : null;
  });
  const tracked = matchers.some(Boolean)
    ? (await run("git", ["ls-files", "-z", "--cached"])).split("\0").filter(Boolean)
    : [];
  const files = new Map<string, { path: string; selections: Selection[] }>();
  for (const [index, selection] of plan.entries()) {
    const matcher = matchers[index];
    const paths = matcher ? tracked.filter((path) => matcher.match(path)) : [selection.selector.replace(/^(?:\.\/)+/u, "")];
    for (const path of paths) {
      const file = files.get(path) || { path, selections: [] };
      file.selections.push(selection);
      files.set(path, file);
    }
  }
  const updates: { readonly path: string; readonly source: string; readonly updated: string }[] = [];
  for (const { path, selections: fileSelections } of files.values()) {
    const absolute = resolve(root, path);
    let canonical: string;
    try { canonical = await realpath(absolute); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Version reference file is missing: ${path}`);
      throw error;
    }
    if (!inside(root, canonical) || !(await stat(canonical)).isFile()) {
      throw new Error(`Version reference must be a regular file inside the repository: ${path}`);
    }
    const bytes = await readFile(canonical);
    const source = bytes.toString("utf8");
    if (!Buffer.from(source, "utf8").equals(bytes)) throw new Error(`Version reference file must be UTF-8 text: ${path}`);
    let updated = source;
    for (const { patterns, version } of fileSelections) {
      for (const pattern of patterns) {
        const matches = [...updated.matchAll(new RegExp(pattern.source, pattern.flags + "dg"))];
        if (!matches.length) throw new Error(`Version reference pattern ${pattern} does not match ${path}.`);
        for (const match of matches.reverse()) {
          const span = match.indices?.groups?.version;
          if (!span) throw new Error(`Version reference pattern ${pattern} did not capture a version in ${path}.`);
          updated = updated.slice(0, span[0]) + version + updated.slice(span[1]);
        }
      }
    }
    updates.push({ path: canonical, source, updated });
  }
  for (const { path, source, updated } of updates) if (updated !== source) await writeFile(path, updated);
}
