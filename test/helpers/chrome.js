import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createVerify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { URLSearchParams } from "node:url";
import { readZip } from "../../dist/zip.js";

const { Response } = globalThis;

export const publisherId = "example-publisher";
export const itemId = "abcdefghijklmnopabcdefghijklmnop";
export const accessToken = "ya29.example-secret-token";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function error(status, code, message) {
  return json({ error: { code: status, status: code, message } }, status);
}

function newer(left, right) {
  const [a, b] = [left, right].map((version) => version.split(".").map(Number));
  for (let index = 0; index < 4; index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
}

/**
 * A simulated Chrome Web Store API v2 and Google token endpoint, as an injected fetch. Only versions are
 * reported, as in the real API: `fetchStatus` never exposes the draft revision or package checksums.
 */
export function simulatedStore({ published = "0.9.0", token = accessToken, publicKey, email } = {}) {
  const store = {
    published: published && { version: published, state: "PUBLISHED" },
    submitted: null,
    draft: null,
    uploads: [],
    publishes: [],
    statuses: 0,
    exchanges: [],
    asyncUploads: 0,
    takenDown: false,
    lastAsyncUploadState: undefined,
    /** Called with the request kind before handling; return a Response or throw to inject failures. */
    intercept: null,
    /** Called after a request was handled; throwing simulates a lost response after acceptance. */
    after: null,
    approve() {
      store.published = { version: store.submitted.version, state: "PUBLISHED" };
      store.submitted = null;
    },
    review(state) { store.submitted = { ...store.submitted, state }; },
    status() {
      const revision = (entry) => entry && { state: entry.state, distributionChannels: [{ deployPercentage: 100, crxVersion: entry.version }] };
      return {
        name: `publishers/${publisherId}/items/${itemId}`, itemId,
        ...(store.published ? { publishedItemRevisionStatus: revision(store.published) } : {}),
        ...(store.submitted ? { submittedItemRevisionStatus: revision(store.submitted) } : {}),
        ...(store.lastAsyncUploadState ? { lastAsyncUploadState: store.lastAsyncUploadState } : {}),
        takenDown: store.takenDown, warned: false,
      };
    },
  };
  const item = `publishers/${publisherId}/items/${itemId}`;
  const handle = async (kind, init) => {
    if (kind === "token") {
      const assertion = new URLSearchParams(init.body.toString()).get("assertion");
      const [header, claims, signature] = assertion.split(".");
      const verifier = createVerify("RSA-SHA256").update(`${header}.${claims}`);
      if (!verifier.verify(publicKey, Buffer.from(signature, "base64url"))) {
        return json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400);
      }
      const decoded = JSON.parse(Buffer.from(claims, "base64url").toString());
      store.exchanges.push(decoded);
      if (decoded.iss !== email) return json({ error: "invalid_grant", error_description: "Invalid issuer." }, 400);
      return json({ access_token: token, expires_in: 3599, token_type: "Bearer" });
    }
    if (init.headers.Authorization !== `Bearer ${token}`) {
      return error(401, "UNAUTHENTICATED", `Request had invalid authentication credentials: ${init.headers.Authorization}.`);
    }
    if (kind === "status") {
      store.statuses++;
      if (store.lastAsyncUploadState === "IN_PROGRESS" && store.asyncUploads > 0 && --store.asyncUploads === 0) {
        store.lastAsyncUploadState = "SUCCEEDED";
      }
      return json(store.status());
    }
    if (kind === "upload") {
      const bytes = Buffer.from(init.body);
      store.uploads.push(bytes);
      const manifest = JSON.parse(readZip(bytes).find(({ path }) => path === "manifest.json").content.toString());
      const floor = [store.published?.version, store.submitted?.version].filter(Boolean);
      if (floor.some((version) => !newer(manifest.version, version))) {
        return error(400, "INVALID_ARGUMENT", "The version of the uploaded package must be greater than the existing version.");
      }
      store.draft = manifest.version;
      if (store.asyncUploads) {
        store.lastAsyncUploadState = "IN_PROGRESS";
        return json({ name: item, itemId, uploadState: "IN_PROGRESS" });
      }
      return json({ name: item, itemId, crxVersion: manifest.version, uploadState: "SUCCEEDED" });
    }
    if (kind === "publish") {
      store.publishes.push(JSON.parse(init.body));
      if (!store.draft) return error(400, "FAILED_PRECONDITION", "There is no draft to publish.");
      store.submitted = { version: store.draft, state: "PENDING_REVIEW" };
      store.draft = null;
      return json({ name: item, itemId, state: "PENDING_REVIEW" });
    }
    return error(404, "NOT_FOUND", "Unknown method.");
  };
  store.fetch = async (url, init = {}) => {
    const kinds = {
      "https://oauth2.googleapis.com/token": "token",
      [`https://chromewebstore.googleapis.com/v2/${item}:fetchStatus`]: "status",
      [`https://chromewebstore.googleapis.com/upload/v2/${item}:upload`]: "upload",
      [`https://chromewebstore.googleapis.com/v2/${item}:publish`]: "publish",
    };
    const kind = kinds[url] ?? "unknown";
    const injected = await store.intercept?.(kind, init);
    if (injected) return injected;
    const response = await handle(kind, init);
    await store.after?.(kind, response);
    return response;
  };
  return store;
}

export const manifest = (version) => `{
  "manifest_version": 3,
  "name": "Example Extension",
  "version": "${version}"
}
`;

/** Creates an owned extension project whose build copies `public/` into `build/`. */
export async function extensionProject(t, testing) {
  const project = await testing.ReleaseTestProject.create();
  t.after(() => project.dispose());
  await project.write("package.json", JSON.stringify({
    name: "example-extension", version: "1.0.0", private: true, license: "MIT",
    scripts: { build: "node build.mjs", test: "node --check build.mjs", lint: "node --check build.mjs" },
  }, null, 2) + "\n");
  await project.write(".gitignore", "/build\n");
  await project.write("CHANGELOG.md", "# Changelog\n\n## 1.0.0 (Next)\n\n* Add a toolbar button.\n* Your contribution here.\n");
  await project.write("public/manifest.json", manifest("1.0.0"));
  await project.write("build.mjs", 'import { cpSync, rmSync } from "node:fs";\nrmSync("build", { recursive: true, force: true });\n' +
    'cpSync("public", "build", { recursive: true });\n');
  await project.commit("Extension fixture");
  return project;
}

export class RecordingHost {
  constructor() { this.created = []; this.failures = 0; }
  async create(identity, { archive }) {
    if (this.failures > 0) {
      this.failures--;
      throw new Error("Simulated hosting failure.");
    }
    this.created.push({ ...identity, bytes: await readFile(archive) });
  }
}

/** Releases an extension zip to the simulated store through the real workflow, reruns, and verifies review states. */
export async function checkChromeWebStore(t, api, testing) {
  const project = await extensionProject(t, testing);
  const store = simulatedStore();
  const host = new RecordingHost();
  host.failures = 1;
  const logs = [];
  const summary = join(project.directory, "summary.md");
  const workflow = new api.ReleaseWorkflow({
    changelog: new api.IntrideaChangelog("CHANGELOG.md", { placeholder: "* Your contribution here." }),
    project: new api.ZipArchive({ name: "example-extension" }),
    publisher: new api.ChromeWebStore({ publisherId, itemId, fetch: store.fetch, polling: { attempts: 2, delay: 0 } }),
    host,
    versionReferences: { "public/manifest.json": [/"version": "(?<version>\d+\.\d+\.\d+)"/u] },
  });
  const env = {
    ...project.environment, CHROME_WEB_STORE_ACCESS_TOKEN: accessToken, GITHUB_STEP_SUMMARY: summary,
    GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/master",
  };
  // Like Actions, carry the inputs captured by preparation into each later invocation.
  const built = await api.prepare(workflow, { ...project.options, env, log: (line) => logs.push(line) });
  assert.equal(store.uploads.length, 0);
  const options = { ...project.options, env: built.runtime.env, log: (line) => logs.push(line) };
  await assert.rejects(api.release(workflow, options), /Simulated hosting failure/u);
  assert.equal(store.uploads.length, 1);
  assert.equal(store.publishes.length, 1);
  assert.equal(store.submitted.version, "1.0.0");

  const result = await api.release(workflow, options);
  assert.equal(store.uploads.length, 1, "A rerun must not upload a submitted version again.");
  assert.equal(store.publishes.length, 1, "A rerun must not submit a version again.");
  const archive = await readFile(join(project.artifacts, "example-extension-v1.0.0.zip"));
  assert.deepEqual(store.uploads[0], archive);
  assert.deepEqual(host.created[0].bytes, archive);
  assert.equal(result.verification, "unverified");
  assert.equal(result.registryStatus, "PENDING_REVIEW");
  assert.deepEqual(result.registry, { kind: "chrome-web-store", name: "Chrome Web Store", publisherId, itemId });
  assert.ok(logs.includes("[npr] published: example-extension@1.0.0"));
  assert.ok(logs.includes("[npr] not yet published (PENDING_REVIEW): example-extension@1.0.0"));
  assert.match(await readFile(summary, "utf8"), /## Chrome Web Store Verification\n\nexample-extension@1\.0\.0: not yet published \(PENDING_REVIEW\)\./u);
  assert.equal(await project.remoteFile("master", "public/manifest.json"), manifest("1.0.1"));
  const retained = await readFile(join(project.artifacts, "release.json"), "utf8");
  assert.doesNotMatch(retained + logs.join("\n"), new RegExp(accessToken.replaceAll(".", "\\."), "u"));

  const verifyOptions = { cwd: project.cwd, artifacts: project.artifacts, run: project.run, log: () => {}, provider: project.provider };
  await assert.rejects(api.verify({ ...verifyOptions, env: project.environment }), /credentials are missing/u);
  const services = { publisher: new api.ChromeWebStore({ publisherId, itemId, fetch: store.fetch, env }) };
  store.review("STAGED");
  assert.equal((await api.verify({ ...verifyOptions, services })).registryStatus, "STAGED");
  store.review("PENDING_REVIEW");
  store.approve();
  const verified = await api.verify({ ...verifyOptions, services });
  assert.equal(verified.verification, "verified");
  assert.equal(verified.registryStatus, "PUBLISHED");
  store.submitted = { version: "1.0.0", state: "REJECTED" };
  store.published = { version: "0.9.0", state: "PUBLISHED" };
  await assert.rejects(api.verify({ ...verifyOptions, services }), /rejected version 1\.0\.0/u);
  assert.equal(JSON.parse(await readFile(join(project.artifacts, "release.json"), "utf8")).verification, "failed");
  return { project, store };
}
