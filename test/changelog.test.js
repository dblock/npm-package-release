import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { releaseChangelog, nextChangelog } from "../dist/changelog.js";
import { IntrideaChangelog, KeepAChangelog } from "../dist/index.js";

const intridea = "# Changelog\n\n## 0.1.0 (Next)\n\n- Fix Unicode offsets: caf\u00e9.\n- Your contribution here.\n";
const keep = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Ship a package.\n\n## [0.0.1] - 2025-01-01\n\n- Earlier.\n\n[Unreleased]: https://github.com/a/b/compare/v0.0.1...master\n[0.0.1]: https://github.com/a/b/releases/tag/v0.0.1\n";
const options = { version: "0.1.0", date: "2026-11-09" };

test("changelog classes resolve default, relative and absolute paths against the invocation directory", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "npr-changelog-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "docs"));
  for (const [changelog, source, path] of [
    [new KeepAChangelog(), keep, join(cwd, "CHANGELOG.md")],
    [new KeepAChangelog("docs/HISTORY.md"), keep, join(cwd, "docs/HISTORY.md")],
    [new IntrideaChangelog(join(cwd, "INTRIDEA.md")), intridea, join(cwd, "INTRIDEA.md")],
  ]) {
    await writeFile(path, source);
    const notes = await changelog.release({ ...options, cwd });
    assert.ok(notes);
    await changelog.next({ version: "0.1.1", releasedVersion: "0.1.0", cwd });
    const actual = await readFile(path, "utf8");
    const released = releaseChangelog(source, { ...options, format: changelog.format });
    assert.equal(actual, nextChangelog(released.source, {
      format: changelog.format, version: "0.1.1", releasedVersion: "0.1.0",
    }));
    await assert.rejects(changelog.release({ version: "0.1.1", date: "2026-11-10", cwd }), /empty/u);
    assert.equal(await readFile(path, "utf8"), actual);
  }
});

test("Intridea releases preserve source/Unicode and insert the next section", () => {
  const released = releaseChangelog(intridea, { ...options, format: "intridea" });
  assert.match(released.source, /## 0\.1\.0 \(2026\/11\/09\)/u);
  assert.match(released.notes, /caf\u00e9/u);
  assert.doesNotMatch(released.notes, /Your contribution/u);
  const next = nextChangelog(released.source, { format: "intridea", version: "0.1.1", releasedVersion: "0.1.0" });
  assert.match(next, /## 0\.1\.1 \(Next\)\n\n- Your contribution here\.\n\n## 0\.1\.0/u);
  assert.equal(nextChangelog(next, { format: "intridea", version: "0.1.1", releasedVersion: "0.1.0" }), next);
});

test("Keep a Changelog updates compare references and preserves historical content", () => {
  const released = releaseChangelog(keep, { ...options, format: "keep-a-changelog" });
  assert.match(released.source, /## \[0\.1\.0\] - 2026-11-09/u);
  assert.match(released.source, /\[Unreleased\]: https:\/\/github\.com\/a\/b\/compare\/v0\.1\.0\.\.\.master/u);
  assert.match(released.source, /\[0\.1\.0\]: https:\/\/github\.com\/a\/b\/compare\/v0\.0\.1\.\.\.v0\.1\.0/u);
  assert.match(released.source, /\[0\.0\.1\]: https:\/\/github\.com\/a\/b\/releases\/tag\/v0\.0\.1/u);
  const next = nextChangelog(released.source, { format: "keep-a-changelog", version: "0.1.1", releasedVersion: "0.1.0" });
  assert.match(next, /## \[Unreleased\]\n\n## \[0\.1\.0\]/u);
  assert.equal(nextChangelog(next, { format: "keep-a-changelog", version: "0.1.1", releasedVersion: "0.1.0" }), next);
});

test("CRLF paragraphs and fenced/quoted fake headings are preserved", () => {
  const prefix = "```md\n## 0.1.0 (Next)\n```\n\n> ## 0.1.0 (Next)\n\n";
  const source = (prefix + intridea).replaceAll("\n", "\r\n");
  const result = releaseChangelog(source, { ...options, format: "intridea" });
  assert.ok(result.source.startsWith(prefix.replaceAll("\n", "\r\n")));
  assert.doesNotMatch(result.source, /(?<!\r)\n/u);
});

test("empty release sections cannot borrow historical or structural content", () => {
  for (const body of ["", "### Added\n", "<!-- TODO -->\n", "[link]: https://example.com\n", "---\n"]) {
    assert.throws(() => releaseChangelog(
      `## 0.1.0 (Next)\n\n${body}\n- Your contribution here.\n\n## 0.0.1 (2025/01/01)\n\n- Historical.\n`,
      { ...options, format: "intridea" },
    ), /must not be empty/u);
  }
});

test("actual code and image descriptions can be release notes", () => {
  for (const notes of ["```js\nchanged();\n```", "![A change](image.png)"]) {
    assert.ok(releaseChangelog(`## [Unreleased]\n\n${notes}\n`, { ...options, format: "keep-a-changelog" }).notes);
  }
});

test("ambiguous headings, placeholders, and already released headings fail before writing", () => {
  for (const source of [
    intridea + "\n## 0.2.0 (Next)\n",
    intridea.replace("- Your contribution here.\n", ""),
    intridea + "- Your contribution here.\n",
    intridea + "\n## 0.1.0 (2025/01/01)\n",
  ]) assert.throws(() => releaseChangelog(source, { ...options, format: "intridea" }));
  assert.throws(() => releaseChangelog(intridea, { ...options, format: "unknown" }), /Unknown/u);
  assert.throws(() => releaseChangelog(intridea, { ...options, date: "yesterday", format: "intridea" }), /date/u);
  assert.throws(() => releaseChangelog(intridea, { ...options, version: "01.2.3", format: "intridea" }), /numeric/u);
  const released = releaseChangelog(intridea, { ...options, format: "intridea" }).source;
  assert.throws(() => nextChangelog(released + "\n## 1.0.0 (Next)\n", {
    format: "intridea", version: "0.1.1", releasedVersion: "0.1.0",
  }), /already exists/u);
  assert.throws(() => nextChangelog(released, {
    format: "bad", version: "0.1.1", releasedVersion: "0.1.0",
  }), /Unknown/u);
});

test("Keep a Changelog supports no comparison reference and rejects unsupported/duplicate references", () => {
  assert.match(releaseChangelog("## [Unreleased]\n\n- Ship.\n", {
    ...options, format: "keep-a-changelog",
  }).source, /## \[0.1.0\]/u);
  for (const source of [
    keep.replace("v0.0.1...master", "unsupported"),
    keep + "\n[0.1.0]: https://example.com\n",
    keep + "\n[Unreleased]: https://example.com/compare/v0.0.1...main\n",
    keep + "\n## [0.1.0] - 2026-01-01\n",
  ]) assert.throws(() => releaseChangelog(source, { ...options, format: "keep-a-changelog" }));
});
