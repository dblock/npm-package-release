import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { numericVersion } from "./command.js";
import type { Nodes } from "mdast";
import type { ChangelogFormat } from "./contracts.js";

function document(source: string) {
  return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

function headings(source: string) {
  return document(source).children.filter((node) => node.type === "heading").map((node) => ({
    node,
    text: source.slice(node.position!.start.offset!, node.position!.end.offset!)
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/u, "").replace(/[ \t]+#+[ \t]*$/u, ""),
  }));
}

function section(source: string, pattern: RegExp) {
  const all = headings(source);
  const matches = all.filter(({ text }) => pattern.test(text));
  if (matches.length !== 1) throw new Error("Expected exactly one matching changelog heading.");
  const { node, text } = matches[0];
  const end = all.find(({ node: other }) =>
    other.position!.start.offset! > node.position!.start.offset! && other.depth <= node.depth,
  )?.node.position!.start.offset ?? source.length;
  return { node, text, start: node.position!.start.offset!, body: node.position!.end.offset!, end };
}

function hasNotes(node: Nodes): boolean {
  if (["heading", "html", "definition", "thematicBreak"].includes(node.type)) return false;
  if ("value" in node) return Boolean(node.value.trim());
  if (node.type === "image") return Boolean(node.alt);
  return "children" in node ? node.children.some(hasNotes) : false;
}

function replace(source: string, edits: [number, number, string][]) {
  for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0])) {
    source = source.slice(0, start) + value + source.slice(end);
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

export function releaseChangelog(source: string, { format, version, date }: { format: ChangelogFormat; version: string; date: string }) {
  numericVersion(version);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error("Expected a YYYY-MM-DD release date.");
  if (!["intridea", "keep-a-changelog"].includes(format)) throw new Error("Unknown changelog format.");
  const intridea = format === "intridea";
  const current = section(source, intridea ? /^\d+\.\d+\.\d+ \(Next\)$/u : /^\[Unreleased\]$/u);
  if (headings(source).some(({ text }) =>
    intridea ? text.startsWith(`${version} (`) && !text.endsWith("(Next)") : text.startsWith(`[${version}] - `),
  )) throw new Error("Release heading already exists.");
  let notes = source.slice(current.body, current.end);
  if (intridea) {
    const items = document(notes).children.filter((node) => node.type === "list").flatMap((node) => node.children);
    const placeholders = items.filter((node) =>
      notes.slice(node.position!.start.offset!, node.position!.end.offset!).trim() === "- Your contribution here.",
    );
    if (placeholders.length !== 1) throw new Error("Expected exactly one contribution placeholder.");
    const placeholder = placeholders[0];
    notes = replace(notes, [[placeholder.position!.start.offset!, placeholder.position!.end.offset!, ""]]);
  }
  if (!document(notes).children.some(hasNotes)) throw new Error("Release notes must not be empty.");
  const heading = `${"#".repeat(current.node.depth)} ${intridea
    ? `${version} (${date.replaceAll("-", "/")})`
    : `[${version}] - ${date}`}`;
  let updated = replace(source, [[current.start, current.end, heading + notes]]);
  if (!intridea) updated = compareReference(updated, version);
  return { source: updated, notes: notes.trim() };
}

export function nextChangelog(source: string, { format, version, releasedVersion }: { format: ChangelogFormat; version: string; releasedVersion: string }) {
  numericVersion(version);
  numericVersion(releasedVersion);
  const intridea = format === "intridea";
  if (!["intridea", "keep-a-changelog"].includes(format)) throw new Error("Unknown changelog format.");
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
  const prefix = intridea ? `${heading}${newline}${newline}- Your contribution here.${newline}${newline}` : `${heading}${newline}${newline}`;
  return replace(source, [[current.start, current.start, prefix]]);
}
