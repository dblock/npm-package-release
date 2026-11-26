import assert from "node:assert/strict";

export function checkCli(run) {
  for (const args of [[], ["--help"]]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage: npr /u);
    assert.match(result.stdout, /npr release \[--config npr\.config\.js\]/u);
    assert.match(result.stdout, /Verify never publishes\./u);
    assert.match(result.stdout, /npr reserve .*\n\s+npr trust .*\n\s+npr bootstrap /u);
    assert.equal(result.stderr, "");
  }
  const preview = run(["bootstrap", "--dry-run", "--name", "example", "--repo", "owner/example"]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /^\[npr\] placeholder package\.json: \{"name":"example","version":"0\.0\.0"/u);
  assert.match(preview.stdout, /would run: npm trust github example --repo owner\/example --file release\.yml --env release --allow-publish/u);
  const version = run(["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/u);
  assert.equal(version.stderr, "");

  for (const args of [["unknown"], ["--help", "--version"]]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^\[npr\] Unknown arguments/u);
  }
}
