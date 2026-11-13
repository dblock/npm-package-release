import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export function markdownDocument(source: string) {
  return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

export function markdownHeadings(source: string) {
  return new ParsedMarkdown(source).headings;
}

export function markdownSection(source: string, pattern: RegExp, exactLine = false) {
  return new ParsedMarkdown(source).section(pattern, exactLine);
}

export class ParsedMarkdown {
  readonly root;
  readonly headings;

  constructor(readonly source: string) {
    this.root = markdownDocument(source);
    this.headings = this.root.children.filter((node) => node.type === "heading").map((node) => ({
      node,
      text: source.slice(node.position!.start.offset!, node.position!.end.offset!)
        .replace(/^[ \t]{0,3}#{1,6}[ \t]+/u, "").replace(/[ \t]+#+[ \t]*$/u, ""),
    }));
  }

  section(pattern: RegExp, exactLine = false) {
    const matches = this.headings.filter(({ node, text }) => pattern.test(exactLine
      ? this.source.slice(node.position!.start.offset!, node.position!.end.offset!) : text));
    if (matches.length !== 1) throw new Error("Expected exactly one matching Markdown heading.");
    const { node, text } = matches[0];
    const end = this.headings.find(({ node: other }) =>
      other.position!.start.offset! > node.position!.start.offset! && other.depth <= node.depth,
    )?.node.position!.start.offset ?? this.source.length;
    return { node, text, start: node.position!.start.offset!, body: node.position!.end.offset!, end };
  }
}

export function newline(source: string) {
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

  async replace(body: string, options?: { readonly cwd?: string }): Promise<void>;
  async replace(search: string | RegExp, replacement: string, options?: { readonly cwd?: string }): Promise<void>;
  async replace(
    bodyOrSearch: string | RegExp,
    replacementOrOptions: string | { readonly cwd?: string } = {},
    options: { readonly cwd?: string } = {},
  ): Promise<void> {
    if (typeof replacementOrOptions === "string") {
      if (typeof bodyOrSearch !== "string" && !(bodyOrSearch instanceof RegExp)) {
        throw new Error("Markdown section search must be a string or regular expression.");
      }
      newline(replacementOrOptions);
      const { path, source, current, separator } = await this.read(options.cwd);
      const body = source.slice(current.body, current.end);
      const text = body.replace(bodyOrSearch, replacementOrOptions.replace(/\r?\n/gu, separator));
      newline(text);
      const updated = source.slice(0, current.body) + text.replace(/\r?\n/gu, separator) + source.slice(current.end);
      if (updated !== source) await writeFile(path, updated);
      return;
    }
    if (!replacementOrOptions || typeof replacementOrOptions !== "object") {
      throw new Error("Markdown replacement must be a string or options object.");
    }
    if (typeof bodyOrSearch !== "string") throw new Error("Markdown section body must be a string.");
    newline(bodyOrSearch);
    const { path, source, current, separator } = await this.read(replacementOrOptions.cwd);
    const text = bodyOrSearch.replace(/\r?\n/gu, separator).replace(/^(?:\r?\n)+/u, "").replace(/(?:\r?\n)+$/u, "");
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
