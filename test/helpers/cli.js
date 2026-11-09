import assert from "node:assert/strict";

export function checkCli(run) {
  for (const args of [[], ["--help"]]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage: npr /u);
    assert.match(result.stdout, /Release commands are not implemented yet\./u);
    assert.equal(result.stderr, "");
  }
  const version = run(["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/u);
  assert.equal(version.stderr, "");

  for (const args of [["release"], ["--help", "--version"]]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Unknown arguments: /u);
  }
}
