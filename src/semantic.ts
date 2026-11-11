import { compare, inc, valid } from "semver";
import { command, numericVersion } from "./command.js";
import type { Command } from "./contracts.js";

export type ReleaseType = "patch" | "minor" | "major";
export interface SemanticCommit { readonly sha: string; readonly message: string }
export interface SemanticTag { readonly tag: string; readonly version: string; readonly commit: string }
export interface SemanticHistoryData {
  readonly lastRelease: SemanticTag | null;
  readonly commits: readonly SemanticCommit[];
}
export interface SemanticHistory { read(head: string): Promise<SemanticHistoryData> }
export interface CommitAnalyzer { analyze(commits: readonly SemanticCommit[]): ReleaseType | null }
export interface SemanticSelection {
  readonly lastRelease: string | null;
  readonly releaseType: ReleaseType | null;
  readonly explicitVersion: string | null;
}
export interface SemanticVersionPolicy { select(input: SemanticSelection): string | null }
export interface SemanticNotes {
  generate(commits: readonly SemanticCommit[]): string;
}
export interface SemanticServices {
  readonly history: SemanticHistory;
  readonly analyzer: CommitAnalyzer;
  readonly selector: SemanticVersionPolicy;
  readonly notes: SemanticNotes;
}
export interface SemanticDecisionData extends SemanticHistoryData {
  readonly head: string;
  readonly releaseType: ReleaseType | null;
  readonly version: string | null;
  readonly notes: string | null;
  readonly explicitVersion: string | null;
}
const types: readonly ReleaseType[] = ["patch", "minor", "major"];
const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function version(value: string): string {
  numericVersion(value);
  if (!valid(value)) throw new Error("Invalid semantic version.");
  return value;
}

export class SemanticDecision implements SemanticDecisionData {
  readonly head: string;
  readonly lastRelease: SemanticTag | null;
  readonly commits: readonly SemanticCommit[];
  readonly releaseType: ReleaseType | null;
  readonly version: string | null;
  readonly notes: string | null;
  readonly explicitVersion: string | null;

  constructor(data: SemanticDecisionData) {
    if (typeof data.head !== "string" || !sha.test(data.head) ||
      !Array.isArray(data.commits) || data.commits.some((commit) =>
        !commit || typeof commit.sha !== "string" || !sha.test(commit.sha) || typeof commit.message !== "string") ||
      new Set(data.commits.map((commit) => commit.sha)).size !== data.commits.length) {
      throw new Error("Invalid semantic history.");
    }
    if (data.lastRelease !== null) {
      version(data.lastRelease.version);
      if (data.lastRelease.tag !== `v${data.lastRelease.version}` || !sha.test(data.lastRelease.commit)) {
        throw new Error("Invalid semantic release tag.");
      }
    }
    if (data.releaseType !== null && !types.includes(data.releaseType)) throw new Error("Invalid semantic release type.");
    if (data.explicitVersion !== null) version(data.explicitVersion);
    if (data.version === null) {
      if ([data.releaseType, data.notes, data.explicitVersion].some((value) => value !== null)) throw new Error("Invalid non-release decision.");
    } else {
      version(data.version);
      if (typeof data.notes !== "string" || !data.notes.trim() || (!data.releaseType && !data.explicitVersion) ||
        (data.explicitVersion !== null && data.version !== data.explicitVersion) ||
        (data.lastRelease && compare(data.version, data.lastRelease.version) <= 0)) throw new Error("Invalid semantic selection.");
    }
    this.head = data.head;
    this.lastRelease = data.lastRelease === null ? null : Object.freeze({
      tag: data.lastRelease.tag, version: data.lastRelease.version, commit: data.lastRelease.commit,
    });
    this.commits = Object.freeze(data.commits.map(({ sha, message }) => Object.freeze({ sha, message })));
    this.releaseType = data.releaseType;
    this.version = data.version;
    this.notes = data.notes;
    this.explicitVersion = data.explicitVersion;
    Object.freeze(this);
  }

  get releasable(): boolean { return this.version !== null; }

  check(head: string, selected = this.version, explicit = this.explicitVersion): void {
    if (head !== this.head) throw new Error("Semantic decision belongs to another commit.");
    if (selected !== this.version) throw new Error("Release version differs from semantic decision.");
    if (explicit !== this.explicitVersion) throw new Error("Explicit version changed after semantic analysis.");
  }
}

export interface SemanticPlan {
  readonly decision: SemanticDecision;
  readonly nextDevelopment: boolean;
}
export function semanticPlan(data: SemanticPlan): SemanticPlan {
  if (!data || typeof data.nextDevelopment !== "boolean") throw new Error("Invalid semantic workflow policy.");
  return Object.freeze({
    decision: data.decision instanceof SemanticDecision ? data.decision : new SemanticDecision(data.decision),
    nextDevelopment: data.nextDevelopment,
  });
}

export class GitHistory implements SemanticHistory {
  constructor(readonly run: Command = command, readonly remote = "origin") {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(remote)) throw new Error("Invalid semantic Git remote.");
  }
  async read(head: string): Promise<SemanticHistoryData> {
    if (!sha.test(head)) throw new Error("Semantic history requires a captured commit SHA.");
    const git = (...args: string[]) => this.run("git", args);
    if ((await git("rev-parse", "--is-shallow-repository")).trim() === "true") {
      throw new Error("Semantic releases require full history and tags, not a shallow checkout.");
    }
    await git("fetch", "--tags", "--no-recurse-submodules", this.remote);
    if ((await git("rev-parse", "HEAD")).trim() !== head) throw new Error("Checkout changed before semantic analysis.");
    const tags = (await git("tag", "--merged", head)).trim().split(/\r?\n/u)
      .filter((tag) => /^v\d+\.\d+\.\d+$/u.test(tag) && valid(tag.slice(1)))
      .sort((a, b) => compare(a.slice(1), b.slice(1)));
    const tag = tags.at(-1);
    const lastRelease = tag ? {
      tag, version: tag.slice(1), commit: (await git("rev-parse", `refs/tags/${tag}^{commit}`)).trim(),
    } : null;
    const output = await git("log", "--reverse", "-z", "--format=%H%x00%B", lastRelease ? `${lastRelease.commit}..${head}` : head, "--");
    const entries = output ? output.split("\0") : [];
    if (entries.at(-1) === "") entries.pop();
    if (entries.length % 2) throw new Error("Malformed semantic Git history.");
    const commits = [];
    for (let i = 0; i < entries.length; i += 2) commits.push({ sha: entries[i], message: entries[i + 1] });
    return { lastRelease, commits };
  }
}

export interface ParsedCommit extends SemanticCommit {
  readonly type: string | null;
  readonly scope: string | null;
  readonly subject: string;
  readonly breaking: boolean;
  readonly breakingNotes: readonly string[];
  readonly revert: string | null;
}
export interface ReleaseRule {
  readonly type?: string;
  readonly scope?: string;
  readonly subject?: string;
  readonly breaking?: boolean;
  readonly revert?: boolean;
  readonly release: ReleaseType | false;
}

function glob(pattern: string, value: string): boolean {
  const expression = [...pattern].map((character) => character === "*" ? ".*" : character === "?" ? "." :
    character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")).join("");
  return new RegExp(`^${expression}$`, "u").test(value);
}

export class ConventionalCommits implements CommitAnalyzer {
  readonly rules: readonly ReleaseRule[];
  constructor(rules: readonly ReleaseRule[] = []) {
    for (const rule of rules) {
      if (!rule || (rule.release !== false && !types.includes(rule.release)) ||
        Object.entries(rule).some(([key, value]) => key !== "release" &&
          (["breaking", "revert"].includes(key) ? typeof value !== "boolean" :
            !["type", "scope", "subject"].includes(key) || typeof value !== "string"))) throw new Error("Invalid semantic release rule.");
    }
    this.rules = Object.freeze(rules.map((rule) => Object.freeze({ ...rule })));
  }

  parsed(commits: readonly SemanticCommit[]): readonly ParsedCommit[] {
    const parsed = commits.filter(({ message }) => message.trim()).map((commit) => {
      const lines = commit.message.split(/\r?\n/u);
      const header = /^([A-Za-z0-9_-]+)(?:\(([^()\r\n]+)\))?(!)?: (.+)$/u.exec(lines[0]);
      const subject = header?.[4] || lines[0];
      const breakingNotes = [];
      let footer = false;
      for (let i = 1; i < lines.length; i++) {
        const match = /^BREAKING(?: CHANGE|-CHANGE):[ \t]*(.*)$/u.exec(lines[i]);
        if (!match) continue;
        footer = true;
        const notes = [match[1]];
        while (i + 1 < lines.length && !/^(?:BREAKING(?: CHANGE|-CHANGE):|[A-Za-z][A-Za-z-]*(?:: | #))/u.test(lines[i + 1])) {
          notes.push(lines[++i]);
        }
        if (notes.join("\n").trim()) breakingNotes.push(notes.join("\n").trim());
      }
      const breaking = header?.[3] === "!" || footer;
      if (breaking && !breakingNotes.length) breakingNotes.push(subject);
      return Object.freeze({
        ...commit, type: header?.[1] || null, scope: header?.[2] || null, subject, breaking,
        breakingNotes: Object.freeze(breakingNotes),
        revert: /^This reverts commit ([a-f0-9]{7,64})\./imu.exec(commit.message)?.[1]?.toLowerCase() || null,
      });
    });
    const cancelled = new Set<ParsedCommit>();
    for (const commit of [...parsed].reverse()) {
      if (!commit.revert || cancelled.has(commit)) continue;
      const originals = parsed.filter((candidate) => candidate !== commit && !cancelled.has(candidate) && candidate.sha.startsWith(commit.revert!));
      if (originals.length > 1) throw new Error("Ambiguous reverted commit.");
      if (originals.length === 1) { cancelled.add(commit); cancelled.add(originals[0]); }
    }
    return Object.freeze(parsed.filter((commit) => !cancelled.has(commit)));
  }

  analyze(commits: readonly SemanticCommit[]): ReleaseType | null {
    const releases = this.parsed(commits).flatMap((commit) => {
      const matching = this.rules.filter((rule) => Object.entries(rule).every(([key, value]) =>
        key === "release" || (key === "breaking" || key === "revert" ? Boolean(commit[key]) === value :
          typeof commit[key as "type" | "scope" | "subject"] === "string" && glob(value as string, commit[key as "type" | "scope" | "subject"]!))));
      if (matching.length) return matching.flatMap((rule) => rule.release === false ? [] : [rule.release]);
      return commit.breaking ? ["major"] : commit.type === "feat" ? ["minor"] :
        commit.revert || ["fix", "perf"].includes(commit.type || "") ? ["patch"] : [];
    });
    return types.filter((type) => releases.includes(type)).at(-1) || null;
  }
}

export class SemanticVersionSelector implements SemanticVersionPolicy {
  constructor(readonly firstVersion = "1.0.0") { version(firstVersion); }
  select({ lastRelease, releaseType, explicitVersion }: SemanticSelection): string | null {
    if (lastRelease !== null) version(lastRelease);
    if (releaseType !== null && !types.includes(releaseType)) throw new Error("Invalid semantic release type.");
    const selected = explicitVersion !== null ? version(explicitVersion) :
      releaseType === null ? null : lastRelease === null ? this.firstVersion : inc(lastRelease, releaseType);
    if (releaseType !== null && selected === null) throw new Error("Cannot increment semantic version.");
    if (selected !== null && lastRelease !== null && compare(selected, lastRelease) <= 0) {
      throw new Error("Selected semantic version must exceed the last release.");
    }
    return selected;
  }
}

function escapeMarkdown(value: string): string { return value.replace(/([\\`*_[\]<>#!|])/gu, "\\$1"); }

export class GeneratedReleaseNotes implements SemanticNotes {
  generate(commits: readonly SemanticCommit[]): string {
    const parsed = new ConventionalCommits().parsed(commits);
    const sections = [];
    const breaking = parsed.flatMap((commit) => commit.breakingNotes);
    if (breaking.length) sections.push("### Breaking Changes\n\n" + breaking.map((note) =>
      "- " + escapeMarkdown(note).replaceAll("\n", "\n  ")).join("\n"));
    for (const [type, title] of [["feat", "Features"], ["fix", "Bug Fixes"], ["perf", "Performance Improvements"], ["other", "Other Changes"]]) {
      const group = parsed.filter((commit) => type === "other" ? !["feat", "fix", "perf"].includes(commit.type || "") : commit.type === type);
      if (group.length) sections.push(`### ${title}\n\n` + group.map((commit) =>
        `- ${commit.scope ? `**${escapeMarkdown(commit.scope)}:** ` : ""}${escapeMarkdown(commit.subject)} (${commit.sha.slice(0, 7)})`).join("\n"));
    }
    return sections.join("\n\n") || "Explicit version release.";
  }
}

export class SemanticRelease {
  readonly services: SemanticServices;
  constructor(services: Partial<SemanticServices> = {}) {
    this.services = Object.freeze({
      history: services.history || new GitHistory(), analyzer: services.analyzer || new ConventionalCommits(),
      selector: services.selector || new SemanticVersionSelector(), notes: services.notes || new GeneratedReleaseNotes(),
    });
  }
  async analyze(head: string, explicitVersion: string | null = null): Promise<SemanticDecision> {
    explicitVersion = explicitVersion?.trim() || null;
    const history = await this.services.history.read(head);
    const releaseType = this.services.analyzer.analyze(history.commits);
    const version = this.services.selector.select({ lastRelease: history.lastRelease?.version || null, releaseType, explicitVersion });
    return new SemanticDecision({
      head, ...history, releaseType, version, explicitVersion,
      notes: version === null ? null : this.services.notes.generate(history.commits),
    });
  }
}
