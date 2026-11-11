import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MarkdownSection } from "../dist/index.js";
import { checkMarkdownSection, checkMarkdownSubstitutions } from "./helpers/markdown.js";

test("Markdown sections preserve surrounding Unicode, examples and CRLF while replacing nested content", async (t) => {
  await checkMarkdownSection(t, { MarkdownSection });
});

test("Markdown replacements accept literal or regex substitutions confined to the selected body", async (t) => {
  await checkMarkdownSubstitutions(t, { MarkdownSection });
});

test("Markdown sections preserve final-newline policy and support empty repeated replacement", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "npr-markdown-eof-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "README.md");
  const section = new MarkdownSection(path, "###### Version [stable]");
  for (const ending of ["", "\n"]) {
    await writeFile(path, "###### Version [stable]\n\nOld." + ending);
    await section.replace("\r\nNew.\r\n");
    assert.equal(await readFile(path, "utf8"), "###### Version [stable]\n\nNew." + ending);
    await section.replace("New.", "Updated.");
    assert.equal(await readFile(path, "utf8"), "###### Version [stable]\n\nUpdated." + ending);
    await section.replace("");
    assert.equal(await readFile(path, "utf8"), "###### Version [stable]\n\n");
  }
});

test("missing, duplicate, inexact headings and invalid bodies fail before writing", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "npr-markdown-invalid-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "README.md");
  const section = new MarkdownSection(path, "## Stable");
  for (const source of ["## Other\n", "## Stable\n\n## Stable\n", "## Stable ##\n", "## Stable\r\nMixed.\n", "## Stable\rOld."]) {
    await writeFile(path, source);
    await assert.rejects(section.validate());
    await assert.rejects(section.replace("New."));
    await assert.rejects(section.replace(/Old/u, "New"));
    assert.equal(await readFile(path, "utf8"), source);
  }
  await writeFile(path, "## Stable\n\nOld.\n");
  for (const body of [null, 123, "Mixed.\r\nAgain.\n", "Bare\rreturn"]) {
    await assert.rejects(section.replace(body));
    assert.equal(await readFile(path, "utf8"), "## Stable\n\nOld.\n");
  }
  for (const heading of ["Stable", "# ", "####### Stable", "## Stable\nOther", null]) {
    assert.throws(() => new MarkdownSection(path, heading), /heading/u);
  }
  for (const search of [null, 123, {}]) {
    await assert.rejects(section.replace(search, "New."));
  }
  for (const replacement of [null, 123, () => "New.", "Mixed.\r\nAgain.\n", "Bare\rreturn"]) {
    await assert.rejects(section.replace("Old.", replacement));
  }
  assert.equal(await readFile(path, "utf8"), "## Stable\n\nOld.\n");
  await writeFile(path, "## Stable\r\n\r\nOld.\r\n");
  await assert.rejects(section.replace(/\n/gu, ""));
  assert.equal(await readFile(path, "utf8"), "## Stable\r\n\r\nOld.\r\n");
});
