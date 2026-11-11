import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function checkMarkdownSection(t, { MarkdownSection }) {
  const cwd = await mkdtemp(join(tmpdir(), "npr-markdown-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const prefix = "# caf\u00e9\n\n```md\n## Stable Release\n```\n\n> ## Stable Release\n\n<div>\n## Stable Release\n</div>\n\n";
  const tail = "## Contributing\n\nKeep this exact text.\n";
  const source = prefix + "## Stable Release\n\nOld.\n\n### Details\n\nOld details.\n\n" + tail;
  const path = join(cwd, "README.md");
  await writeFile(path, source.replaceAll("\n", "\r\n"));
  const section = new MarkdownSection("README.md", "## Stable Release");
  assert.equal(await section.validate({ cwd }), section);
  await section.replace("Version 0.2.0.\n\nNew details.", { cwd });
  const actual = await readFile(path, "utf8");
  assert.equal(actual, (prefix + "## Stable Release\n\nVersion 0.2.0.\n\nNew details.\n\n" + tail).replaceAll("\n", "\r\n"));
  await section.replace("Version 0.2.0.\n\nNew details.", { cwd });
  assert.equal(await readFile(path, "utf8"), actual);
}
