# Testing Custom Workflows

Import the optional `npm-package-release/testing` entry point to test your real workflow builder against a disposable checkout, local bare Git remote, and retained test archives. It has no test-framework dependency and works with `node:test`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { ReleaseTestProject } from "npm-package-release/testing";
import { createReleaseWorkflow } from "./workflow.js";

test("release documentation", async (t) => {
  const project = await ReleaseTestProject.create();
  t.after(() => project.dispose());
  await project.copyFiles(import.meta.dirname, [
    "README.md", "CHANGELOG.md", "index.js", "check.js",
  ]);
  // Write a fixture manifest with real test/lint commands before committing.
  await project.write("package.json", JSON.stringify({
    name: "@example/fixture", version: "0.1.0", type: "module", exports: "./index.js",
    files: ["index.js", "README.md"],
    scripts: { test: "node --test check.js", lint: "node --check index.js" },
  }));
  await project.commit();
  const workflow = createReleaseWorkflow(project.services);
  await workflow.run({ ...project.options, version: "0.2.0" });
  assert.ok((await project.remoteFile("v0.2.0", "README.md")).includes("0.2.0"));
});
```

See the [complete lifecycle example](../examples/lifecycle-hooks/README.md) and its [executable tests](../examples/lifecycle-hooks/release.test.js). They import the same workflow builder as the production configuration, copy the real README and changelog, and assert exact release/development content rather than merely checking registered hooks. Removing a README hook breaks validation or the release assertions.

## Project API

`ReleaseTestProject.create()` creates an owned temporary directory with `cwd`, bare `remote`, and private `artifacts` paths. Call `dispose()` from your test framework's cleanup hook, including when a test fails. The factory removes its directory if initialization fails; cleanup never targets the caller's checkout.

| Member | Behavior |
| --- | --- |
| `write(path, content)` | Write a relative text file inside the fixture, creating parent directories. |
| `copyFiles(root, selection?)` | Copy all files recursively, a glob's matches, or an exact list of relative files, preserving nested paths, bytes, and permission bits. |
| `commit(message?)` | Commit fixture changes and push them to the local `master` branch. |
| `git(...args)` | Run real Git commands in the fixture. |
| `remoteFile(ref, path)` | Read a file from a tag or branch in the bare remote. |
| `run(program, args, options?)` | Run an argument-based command with the fixture's isolated environment. |
| `options` | Release invocation options with fixture paths, environment, runner, and silent logging. |
| `services` | Explicit local publisher, host, and execution-provider overrides for your real builder. |

Omit `selection` to copy a whole project, pass a glob string to select matches, or use an array for exact file paths. Pass `[]` to copy nothing:

```js
export async function copyProject(project, sourceRoot) {
  await project.copyFiles(sourceRoot);
  await project.copyFiles(sourceRoot, "**/*.{js,md}");
  await project.copyFiles(sourceRoot, ["README.md", "scripts/release.js"]);
  await project.copyFiles(sourceRoot, []);
}
```

Glob strings support wildcards, recursive `**`, character classes, and brace alternatives. Use `/` as the separator on every platform; matches include hidden files and directories. No matches copy nothing. Arrays are always literal file paths, even when a filename contains glob characters.

Recursive and glob copying skip `.git` files and directories at every level, preserving the fixture's isolated repository. They do not apply Git ignore rules or exclude dependencies/build outputs; select files explicitly or with a glob when those files are not wanted.

`copyFiles` validates every selected source and destination before copying any file. Absolute paths, parent traversal, missing explicit files, explicit directories, Git metadata in exact file lists, metadata aliases, and escaping or dangling symbolic links fail. File links that resolve inside their respective roots are allowed unless they target Git metadata; directory links are not traversed and selected directory links fail regular-file validation. Preflight validation is not an atomic filesystem transaction or a defense against concurrent hostile mutations.

Child commands retain runtime paths and platform essentials, but clear inherited credentials, Actions state, npm settings, Git overrides, and outer release state. HOME, npm configuration, and npm cache are private to the fixture; system Git configuration is disabled and global Git configuration starts in a private empty regular file. Your package tests still run when configured, so use a focused fixture test command rather than recursively running the release spec itself.

## Local Publication Adapters

`project.publisher` is a `TestPublisher`; `project.host` is a `TestReleaseHost`. They copy the exact archive into their respective local directories and never call npm publication or GitHub APIs. Publisher metadata comes from the retained archive with its real SHA-512/SHA-1 checksums. Repetition accepts identical bytes and rejects conflicts without overwriting existing files.

Use `publisher.archive(name, version)` or `host.archive(name, version)` to inspect retained bytes. The host checks archive identity and that the supplied notes file exists, but does not model GitHub release metadata or assets beyond the archive. Keep live hosting/authentication tests separate.

For a failure case, supply a new class instance to the same builder:

```js
import { TestPublisher } from "npm-package-release/testing";

export function rejectedPublisher(directory) {
  return new TestPublisher(directory, { failure: "Publication rejected" });
}
```

`TestReleaseHost(directory, { failure })` supports the same explicit failure. Existing identical outputs remain reusable even with failure configured. Release operations reconcile matching outputs and reject conflicting archives or refs.

These are explicit service replacements, not a sandbox: arbitrary callbacks or explicit command/environment overrides can still contact external systems. Keep all fixture remotes local, replace every publication/hosting boundary through your builder, and never dispatch a publishing Actions workflow from these tests.
