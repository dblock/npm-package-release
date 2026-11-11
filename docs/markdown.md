# Updating Markdown Sections

Use `MarkdownSection` to replace a section's body without rewriting the surrounding document. Keep project-specific wording and version links in your own lifecycle hooks:

```js
import { LifecycleHooks, MarkdownSection, ReleaseWorkflow } from "npm-package-release";

class UpdateReadme {
  id = "update-readme";
  async run({ context }) {
    const section = new MarkdownSection("README.md", "## Release Status");
    await section.replace(`Documentation for version ${context.version}.`, { cwd: context.cwd });
  }
}

export default new ReleaseWorkflow({
  hooks: new LifecycleHooks()
    .after("prepare", new UpdateReadme())
    .after("next", new UpdateReadme()),
});
```

The heading must be a complete, exact ATX heading line with one to six leading `#` characters. There must be exactly one matching top-level heading; code, quotes, and HTML examples do not count. Missing or duplicate headings fail before writing. `await section.validate({ cwd })` checks the same boundaries without changing the file.

`replace(body, { cwd })` replaces everything after the heading through the next equal-or-shallower heading, including nested subsections. Paths resolve against `cwd`, or the invocation directory when omitted; absolute paths also work. Surrounding text and Unicode offsets are preserved. Replacement line endings normalize to the source file's LF or CRLF style; mixed or unsupported endings are rejected.

Pass an optional second string to substitute text inside the existing body instead:

```js
import { MarkdownSection } from "npm-package-release";

export async function updateVersion(cwd, version) {
  const section = new MarkdownSection("README.md", "## Release Status");
  await section.replace("Old wording", "New wording", { cwd });
  await section.replace(/version \d+\.\d+\.\d+/g, `version ${version}`, { cwd });
}
```

`replace(search, replacement, { cwd })` uses JavaScript string replacement semantics within the selected body, including nested subsections. A string search replaces the first literal match; a regular expression with `g` replaces all matches, and capture references such as `$1` work. An empty replacement removes matching text. Unmatched searches leave the file untouched. The selected heading and surrounding sections are never searched or replaced; replacements preserve body spacing rather than rebuilding the section.

Repeated replacement with the same body is stable. A nonempty replacement at the end of a file preserves whether the source had a final newline; an empty body leaves a blank section. Use editing hooks only during trusted prepare/next staging. The helper does not choose release wording, bump versions, or add lifecycle hooks automatically.
