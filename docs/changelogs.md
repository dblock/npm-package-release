# Changelog Templates

Supply a changelog class instance to `ReleaseWorkflow`. Paths default to `CHANGELOG.md` and resolve against the release invocation directory. Both classes preserve heading depth, surrounding source, history, Unicode, and LF/CRLF line endings; headings inside code, quotes, and HTML examples are not release headings. Empty notes fail before writing.

## Keep a Changelog

`new KeepAChangelog()` preserves existing categories and creates an empty next `## [Unreleased]` section. Optionally configure a contribution prompt and the categories to restore:

```js
import { KeepAChangelog, ReleaseWorkflow } from "npm-package-release";

export default new ReleaseWorkflow({
  changelog: new KeepAChangelog("CHANGELOG.md", {
    placeholder: "* Your contribution here.",
    sections: ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"],
  }),
});
```

`placeholder` defaults to none; `sections` defaults to `[]`. With either option enabled, releasing removes matching prompts and empty category headings, retaining actual notes, code examples, history, and comparison references. Prompt-only notes are not a release. Preparing the next version restores the configured categories in order, with the prompt under each category when configured. Existing matching next sections are reused, not overwritten.

Prompts must be single nonempty lines. Category names must be unique nonempty lines and create headings one level below the release heading, no deeper than level six. Template arrays are copied when the class is constructed.

## Intridea

```js
import { IntrideaChangelog } from "npm-package-release";

export const changelog = new IntrideaChangelog("CHANGELOG.md", {
  placeholder: "* Your contribution here.",
});
```

The default prompt is `- Your contribution here.`. A release must contain at least one matching prompt outside code, quotes, and HTML examples; all matching prompts are removed. A section with only prompts or structural content still fails.

Preparing the next version carries headings exactly one level below the released heading into the new Next section, adding the prompt under each one without copying old notes or deeper subsections. Uncategorized changelogs retain the usual single-prompt next section.

## Pure Transformations

The exported `releaseChangelog` and `nextChangelog` functions accept the same optional `placeholder` and `sections` fields alongside their existing format/version arguments. They return transformed source without writing files; use class instances in workflow configuration.
