import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export function markdownDocument(source: string) {
  return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

export function markdownHeadings(source: string) {
  return markdownDocument(source).children.filter((node) => node.type === "heading").map((node) => ({
    node,
    text: source.slice(node.position!.start.offset!, node.position!.end.offset!)
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/u, "").replace(/[ \t]+#+[ \t]*$/u, ""),
  }));
}

export function markdownSection(source: string, pattern: RegExp, exactLine = false) {
  const all = markdownHeadings(source);
  const matches = all.filter(({ node, text }) => pattern.test(exactLine
    ? source.slice(node.position!.start.offset!, node.position!.end.offset!) : text));
  if (matches.length !== 1) throw new Error("Expected exactly one matching Markdown heading.");
  const { node, text } = matches[0];
  const end = all.find(({ node: other }) =>
    other.position!.start.offset! > node.position!.start.offset! && other.depth <= node.depth,
  )?.node.position!.start.offset ?? source.length;
  return { node, text, start: node.position!.start.offset!, body: node.position!.end.offset!, end };
}

function newline(source: string) {
  if (/\r(?!\n)/u.test(source) || (source.includes("\r\n") && /(?<!\r)\n/u.test(source))) {
    throw new Error("Mixed or unsupported Markdown line endings.");
  }
  return source.includes("\r\n") ? "\r\n" : "\n";
}

export class MarkdownSection {
  constructor(readonly path: string, readonly heading: string) {
    if (typeof heading !== "string" || !/^#{1,6}[ \t]+\S[^\r\n]*$/u.test(heading)) {
      throw new Error("Expected a complete single-line ATX Markdown heading.");
    }
  }

  async validate({ cwd }: { readonly cwd?: string } = {}): Promise<this> {
    await this.read(cwd);
    return this;
  }

  async replace(body: string, { cwd }: { readonly cwd?: string } = {}): Promise<void> {
    if (typeof body !== "string") throw new Error("Markdown section body must be a string.");
    newline(body);
    const { path, source, current, separator } = await this.read(cwd);
    const text = body.replace(/\r?\n/gu, separator).replace(/^(?:\r?\n)+/u, "").replace(/(?:\r?\n)+$/u, "");
    const tail = current.end < source.length ? separator.repeat(2) : source.endsWith(separator) ? separator : "";
    const replacement = text ? separator.repeat(2) + text + tail : separator.repeat(2);
    await writeFile(path, source.slice(0, current.body) + replacement + source.slice(current.end));
  }

  private async read(cwd?: string) {
    const path = resolve(cwd || ".", this.path);
    const source = await readFile(path, "utf8");
    const separator = newline(source);
    const pattern = new RegExp(`^${this.heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u");
    return { path, source, separator, current: markdownSection(source, pattern, true) };
  }
}
