import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

export async function checkMarkdownSubstitutions(t, { MarkdownSection }) {
  const cwd = await mkdtemp(join(tmpdir(), "npr-markdown-substitutions-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "README.md");
  const section = new MarkdownSection("README.md", "## Stable");
  const prefix = "# caf\u00e9\n\nUse version 0.1.0.\n\n## Stable\n\n";
  const tail = "\n\n## Other\n\nUse version 0.1.0.\n";
  for (const separator of ["\n", "\r\n"]) {
    const document = (body) => (prefix + body + tail).replaceAll("\n", separator);
    await writeFile(path, document("Use version 0.1.0; version 0.1.0.\n\n### Details\n\nKeep **this** for version 0.1.0."));
    await section.replace("version 0.1.0", "version 0.2.0", { cwd });
    assert.equal(await readFile(path, "utf8"),
      document("Use version 0.2.0; version 0.1.0.\n\n### Details\n\nKeep **this** for version 0.1.0."));
    await section.replace(/version (\d+\.\d+\.\d+)/gu, "release v$1", { cwd });
    assert.equal(await readFile(path, "utf8"),
      document("Use release v0.2.0; release v0.1.0.\n\n### Details\n\nKeep **this** for release v0.1.0."));
    await section.replace("Keep **this**", "Keep\n**this**", { cwd });
    await section.replace("; release v0.1.0", "", { cwd });
    const expected = document("Use release v0.2.0.\n\n### Details\n\nKeep\n**this** for release v0.1.0.");
    assert.equal(await readFile(path, "utf8"), expected);
    const modified = (await stat(path)).mtimeMs;
    await section.replace(/not present/gu, "", { cwd });
    assert.equal(await readFile(path, "utf8"), expected);
    assert.equal((await stat(path)).mtimeMs, modified);
  }
}
