import { numericVersion } from "./command.js";
import {
  markdownDocument as document, markdownHeadings as headings, markdownSection as section, newline,
} from "./markdown.js";
import type { Nodes } from "mdast";
import type { ChangelogFormat } from "./contracts.js";

export interface ChangelogTemplate {
  readonly placeholder?: string | null;
  readonly sections?: readonly string[];
}

export function changelogTemplate(format: ChangelogFormat, template: ChangelogTemplate = {}): ChangelogTemplate {
  const placeholder = template.placeholder === undefined && format === "intridea"
    ? "- Your contribution here." : template.placeholder;
  const singleLine = (text: unknown): text is string =>
    typeof text === "string" && Boolean(text.trim()) && !/[\r\n]/u.test(text);
  if ((placeholder != null && !singleLine(placeholder)) || (format === "intridea" && placeholder === null)) {
    throw new Error("Contribution placeholder must be a nonempty single line.");
  }
  const sections = template.sections === undefined ? [] : template.sections;
  if (!Array.isArray(sections) || !sections.every(singleLine) || new Set(sections).size !== sections.length) {
    throw new Error("Changelog sections must be unique nonempty single-line names.");
  }
  return Object.freeze({ placeholder, sections: Object.freeze([...sections]) });
}

function hasNotes(node: Nodes): boolean {
  if (["heading", "html", "definition", "thematicBreak"].includes(node.type)) return false;
  if ("value" in node) return Boolean(node.value.trim());
  if (node.type === "image") return Boolean(node.alt);
  return "children" in node ? node.children.some(hasNotes) : false;
}

export function generatedChangelog(source: string, { version, date, notes }:
  { version: string; date: string; notes: string }): string {
  numericVersion(version);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error("Expected a YYYY-MM-DD release date.");
  if (typeof notes !== "string" || !document(notes).children.some(hasNotes)) {
    throw new Error("Generated release notes must not be empty.");
  }
  const separator = newline(source);
  const pattern = new RegExp(`^## ${version.replaceAll(".", "\\.")}(?: |$)`, "u");
  const all = headings(source);
  if (all.some(({ node }) => pattern.test(source.slice(node.position!.start.offset!, node.position!.end.offset!)))) {
    const current = section(source, pattern, true);
    if (source.slice(current.body, current.end).replaceAll("\r\n", "\n").trim() !== notes.replaceAll("\r\n", "\n").trim()) {
      throw new Error("Existing generated release notes differ.");
    }
    return source;
  }
  const position = all.find(({ node }) => node.depth === 2)?.node.position!.start.offset ?? source.length;
  const prefix = source.slice(0, position).replace(/(?:\r?\n)*$/u, separator.repeat(2));
  const entry = `## ${version} (${date.replaceAll("-", "/")})\n\n${notes.trim()}\n\n`.replace(/\r?\n/gu, separator);
  return prefix + entry + source.slice(position);
}

function replace(source: string, edits: [number, number, string][]) {
  for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0])) {
    source = source.slice(0, start) + value + source.slice(end);
  }
  return source;
}

function contributionLines(source: string, placeholder: string) {
  const excluded: [number, number][] = [];
  function visit(node: Nodes) {
    if (["code", "blockquote", "html"].includes(node.type)) {
      excluded.push([node.position!.start.offset!, node.position!.end.offset!]);
    } else if ("children" in node) node.children.forEach(visit);
  }
  visit(document(source));
  return [...source.matchAll(/[^\r\n]+(?:\r?\n|$)/gu)].filter((line) =>
    line[0].replace(/\r?\n$/u, "") === placeholder &&
    !excluded.some(([start, end]) => line.index >= start && line.index < end),
  );
}

function cleanNotes(source: string, depth: number, template: ChangelogTemplate, required: boolean) {
  if (template.placeholder) {
    const prompts = contributionLines(source, template.placeholder);
    if (required && !prompts.length) throw new Error("Expected at least one contribution placeholder.");
    source = replace(source, prompts.map((line) => [line.index, line.index + line[0].length, ""]));
  }
  if (!required && (template.placeholder || template.sections?.length)) {
    const allHeadings = headings(source);
    const categories = allHeadings.filter(({ node }) => node.depth === depth + 1);
    const edits: [number, number, string][] = [];
    for (const { node } of categories) {
      const start = node.position!.start.offset!;
      const body = node.position!.end.offset!;
      const end = allHeadings.find(({ node: other }) =>
        other.position!.start.offset! > start && other.depth <= node.depth,
      )?.node.position!.start.offset ?? source.length;
      if (!document(source.slice(body, end)).children.some(hasNotes)) {
        const newline = source.indexOf("\n", body);
        edits.push([start, newline < 0 ? body : newline + 1, ""]);
      }
    }
    source = replace(source, edits);
  }
  return source;
}

function compareReference(source: string, version: string) {
  const definitions = document(source).children.filter((node) => node.type === "definition");
  const references = definitions.filter((node) => node.identifier.toLowerCase() === "unreleased");
  if (references.length > 1) throw new Error("Duplicate Unreleased comparison references.");
  if (definitions.some((node) => node.identifier === version)) throw new Error("Release reference already exists.");
  if (!references.length) return source;
  const reference = references[0];
  const match = /^(https?:\/\/\S+\/compare\/)([^/\s]*?)(\d+\.\d+\.\d+)\.\.\.([^/\s]+)$/u.exec(reference.url);
  if (!match) throw new Error("Unreleased reference must be a VERSION...BRANCH comparison URL.");
  const [, prefix, tag, previous, branch] = match;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return replace(source, [[reference.position!.start.offset!, reference.position!.end.offset!,
    `[Unreleased]: ${prefix}${tag}${version}...${branch}${newline}[${version}]: ${prefix}${tag}${previous}...${tag}${version}`,
  ]]);
}

export function releaseChangelog(source: string, { format, version, date, ...options }:
  ChangelogTemplate & { format: ChangelogFormat; version: string; date: string }) {
  numericVersion(version);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error("Expected a YYYY-MM-DD release date.");
  if (!["intridea", "keep-a-changelog"].includes(format)) throw new Error("Unknown changelog format.");
  const intridea = format === "intridea";
  const template = changelogTemplate(format, options);
  const released = new RegExp(intridea
    ? `^${version.replaceAll(".", "\\.")} \\(\\d{4}/\\d{2}/\\d{2}\\)$`
    : `^\\[${version.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "u");
  if (headings(source).some(({ text }) => released.test(text))) {
    const existing = section(source, released);
    const notes = source.slice(existing.body, existing.end);
    if (!document(cleanNotes(notes, existing.node.depth, template, false)).children.some(hasNotes)) {
      throw new Error("Release notes must not be empty.");
    }
    return { source, notes: notes.trim() };
  }
  const current = section(source, intridea ? /^\d+\.\d+\.\d+ \(Next\)$/u : /^\[Unreleased\]$/u);
  if (headings(source).some(({ text }) =>
    intridea ? text.startsWith(`${version} (`) && !text.endsWith("(Next)") : text.startsWith(`[${version}] - `),
  )) throw new Error("Release heading already exists.");
  const notes = cleanNotes(source.slice(current.body, current.end), current.node.depth, template, intridea);
  if (!document(notes).children.some(hasNotes)) throw new Error("Release notes must not be empty.");
  const heading = `${"#".repeat(current.node.depth)} ${intridea
    ? `${version} (${date.replaceAll("-", "/")})`
    : `[${version}] - ${date}`}`;
  let updated = replace(source, [[current.start, current.end, heading + notes]]);
  if (!intridea) updated = compareReference(updated, version);
  return { source: updated, notes: notes.trim() };
}

export function nextChangelog(source: string, { format, version, releasedVersion, ...options }:
  ChangelogTemplate & { format: ChangelogFormat; version: string; releasedVersion: string }) {
  numericVersion(version);
  numericVersion(releasedVersion);
  const intridea = format === "intridea";
  if (!["intridea", "keep-a-changelog"].includes(format)) throw new Error("Unknown changelog format.");
  const template = changelogTemplate(format, options);
  const current = section(source, new RegExp(intridea
    ? `^${releasedVersion.replaceAll(".", "\\.")} \\(\\d{4}/\\d{2}/\\d{2}\\)$`
    : `^\\[${releasedVersion.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "u"));
  const pending = headings(source).filter(({ text }) => intridea ? text.endsWith(" (Next)") : text === "[Unreleased]");
  if (pending.length) {
    const expected = intridea ? `${version} (Next)` : "[Unreleased]";
    if (pending.length === 1 && pending[0].text === expected &&
      section(source, intridea ? /^\d+\.\d+\.\d+ \(Next\)$/u : /^\[Unreleased\]$/u).end === current.start) return source;
    throw new Error("Unreleased heading already exists with conflicting version or position.");
  }
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const heading = `${"#".repeat(current.node.depth)} ${intridea ? `${version} (Next)` : "[Unreleased]"}`;
  const categories = intridea ? headings(source).filter(({ node }) =>
    node.depth === current.node.depth + 1 && node.position!.start.offset! >= current.body &&
    node.position!.start.offset! < current.end,
  ).map(({ node }) => source.slice(node.position!.start.offset!, node.position!.end.offset!)) :
    (template.sections ?? []).map((name) => `${"#".repeat(current.node.depth + 1)} ${name}`);
  if (current.node.depth === 6 && categories.length) throw new Error("Category headings cannot exceed level six.");
  const lines = [heading, ""];
  if (categories.length) {
    for (const category of categories) {
      lines.push(category, "");
      if (template.placeholder) lines.push(template.placeholder, "");
    }
  } else if (template.placeholder) lines.push(template.placeholder, "");
  const prefix = lines.join(newline) + newline;
  return replace(source, [[current.start, current.start, prefix]]);
}
