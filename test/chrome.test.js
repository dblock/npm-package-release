import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as api from "../dist/index.js";
import * as testing from "../dist/testing.js";
import { createZip } from "../dist/zip.js";
import { accessToken, checkChromeWebStore, itemId, manifest, publisherId, simulatedStore } from "./helpers/chrome.js";

const {
  ChromeWebStore, ChromeWebStoreCredentials, EnvironmentAccessToken, ServiceAccountKey, chromeWebStoreScope,
  compareChromeVersions, extensionVersion, registryVerifier, RegistryVisibility, ReleaseWorkflow, ZipArchive,
} = api;

const { Response, fetch } = globalThis;
const env = { CHROME_WEB_STORE_ACCESS_TOKEN: accessToken };
const identity = (version) => ({ name: "example-extension", version, artifact: { filename: "x", integrity: "x", shasum: "x" } });

async function archive(t, version = "1.0.0", files = { "manifest.json": manifest(version) }, name = `example-extension-v${version}.zip`) {
  const directory = await mkdtemp(join(tmpdir(), "npr-chrome-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, name);
  await writeFile(path, createZip(Object.entries(files).map(([file, content]) => ({ path: file, content: Buffer.from(content) })), 0));
  return path;
}

function storeClient(store, options = {}) {
  return new ChromeWebStore({ publisherId, itemId, fetch: store.fetch, env, polling: { attempts: 3, delay: 0 }, ...options });
}

test("an extension release uploads the exact zip, submits it for review, reconciles reruns, and verifies review states", async (t) => {
  await checkChromeWebStore(t, api, testing);
});

test("ChromeWebStore validates its configuration and records only identifiers", () => {
  assert.throws(() => new ChromeWebStore({ itemId }), /publisherId/u);
  assert.throws(() => new ChromeWebStore({ publisherId: "-x", itemId }), /publisherId/u);
  assert.throws(() => new ChromeWebStore({ publisherId, itemId: "not-an-extension-id" }), /32-character extension ID/u);
  assert.throws(() => new ChromeWebStore({ publisherId, itemId, token: "secret" }), /token must implement token/u);
  assert.throws(() => new ChromeWebStore({ publisherId, itemId, publishType: "NOW" }), /publishType/u);
  assert.throws(() => new ChromeWebStore({ publisherId, itemId, deployPercentage: 101 }), /deployPercentage/u);
  assert.throws(() => new ChromeWebStore({ publisherId, itemId, deployPercentage: 1.5 }), /deployPercentage/u);
  assert.throws(() => new ChromeWebStore({ publisherId, itemId, fetch: "fetch" }), /fetch must be a function/u);
  assert.throws(() => new ChromeWebStore({ publisherId, itemId, polling: { attempts: 0 } }), /bounded verification/u);
  assert.throws(() => new EnvironmentAccessToken("BAD-NAME"), /environment variable name/u);
  assert.throws(() => new ServiceAccountKey(""), /environment variable name/u);
  const store = new ChromeWebStore({ publisherId, itemId, env: { CHROME_WEB_STORE_ACCESS_TOKEN: accessToken } });
  assert.equal(store.checksums, false);
  assert.ok(Object.isFrozen(store));
  assert.deepEqual(JSON.parse(JSON.stringify(store)), {
    publisherId, itemId, checksums: false, registry: { kind: "chrome-web-store", name: "Chrome Web Store", publisherId, itemId },
    options: { attempts: 6, delay: 10000 },
  });
  assert.equal(registryVerifier(store), store);
  assert.ok(registryVerifier({ async view() { return null; }, async publish() {} }) instanceof RegistryVisibility);
  assert.doesNotThrow(() => new ReleaseWorkflow({ project: new ZipArchive(), publisher: store }));
});

test("compareChromeVersions orders up to four numeric parts and rejects invalid versions", () => {
  assert.equal(compareChromeVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareChromeVersions("1.0", "1.0.0.0"), 0);
  assert.equal(compareChromeVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareChromeVersions("1.0.0", "1.0.0.1"), -1);
  assert.throws(() => compareChromeVersions("1.0.0-beta", "1.0.0"), /Invalid Chrome extension version/u);
  assert.throws(() => compareChromeVersions("1.2.3.4.5", "1"), /Invalid Chrome extension version/u);
});

test("the published zip must carry a manifest version matching its release filename", async (t) => {
  const store = simulatedStore();
  const client = storeClient(store);
  assert.equal(extensionVersion(createZip([{ path: "manifest.json", content: Buffer.from(manifest("2.0.0")) }], 0)), "2.0.0");
  await assert.rejects(client.publish(await archive(t, "1.0.0", { "index.js": "" })), /no manifest\.json/u);
  await assert.rejects(client.publish(await archive(t, "1.0.0", { "manifest.json": "{" })), /not valid JSON/u);
  await assert.rejects(client.publish(await archive(t, "1.0.0", { "manifest.json": "{}" })), /has no version/u);
  await assert.rejects(client.publish(await archive(t, "1.0.0", { "manifest.json": manifest("v1") })), /Invalid Chrome extension version/u);
  await assert.rejects(client.publish(await archive(t, "1.0.0", undefined, "example-extension-v1.0.1.zip")),
    /manifest\.json version 1\.0\.0 does not match its release version/u);
  assert.equal(store.statuses, 0);
  assert.equal(store.uploads.length, 0);
});

test("publication uploads once, submits with configured options, and skips a version already submitted", async (t) => {
  const store = simulatedStore();
  const client = storeClient(store, { publishType: "STAGED_PUBLISH", deployPercentage: 10 });
  const path = await archive(t);
  assert.equal(await client.view("example-extension", "1.0.0"), null);
  await client.publish(path);
  assert.equal(store.uploads.length, 1);
  assert.deepEqual(store.publishes, [{ publishType: "STAGED_PUBLISH", deployInfos: [{ deployPercentage: 10 }] }]);
  assert.deepEqual(await client.view("example-extension", "1.0.0"), { name: "example-extension", version: "1.0.0" });
  await client.publish(path);
  store.approve();
  await client.publish(path);
  assert.equal(store.uploads.length, 1);
  assert.equal(store.publishes.length, 1);
  await assert.rejects(client.view("example-extension", "v1"), /numeric MAJOR\.MINOR\.PATCH/u);
});

test("publication without options sends an empty submission body", async (t) => {
  const store = simulatedStore({ published: null });
  await storeClient(store).publish(await archive(t));
  assert.deepEqual(store.publishes, [{}]);
});

test("store states that forbid submitting the version fail before any upload", async (t) => {
  const path = await archive(t);
  const cases = [
    [(store) => { store.published = { version: "1.1.0", state: "PUBLISHED" }; }, /already has version 1\.1\.0, later than 1\.0\.0/u],
    [(store) => { store.submitted = { version: "2.0.0", state: "PENDING_REVIEW" }; }, /already has version 2\.0\.0/u],
    [(store) => { store.submitted = { version: "0.9.5", state: "PENDING_REVIEW" }; }, /0\.9\.5 is PENDING_REVIEW; wait for it or cancel it/u],
    [(store) => { store.submitted = { version: "0.9.5", state: "STAGED" }; }, /0\.9\.5 is STAGED/u],
    [(store) => { store.submitted = { version: "1.0.0", state: "REJECTED" }; }, /rejected version 1\.0\.0/u],
    [(store) => { store.submitted = { version: "1.0.0", state: "CANCELLED" }; }, /submission of version 1\.0\.0 is CANCELLED/u],
    [(store) => { store.takenDown = true; }, /taken down/u],
    [(store) => { store.lastAsyncUploadState = "IN_PROGRESS"; }, /upload is still processing/u],
  ];
  for (const [arrange, expected] of cases) {
    const store = simulatedStore();
    arrange(store);
    const client = storeClient(store);
    await assert.rejects(client.view("example-extension", "1.0.0"), expected);
    await assert.rejects(client.publish(path), expected);
    assert.equal(store.uploads.length, 0);
  }
  for (const state of ["REJECTED", "CANCELLED"]) {
    const store = simulatedStore();
    store.submitted = { version: "0.9.5", state };
    await storeClient(store).publish(path);
    assert.equal(store.submitted.version, "1.0.0");
  }
});

test("upload results are reported without blind retries", async (t) => {
  const path = await archive(t);
  const rejected = simulatedStore({ published: "1.0.0" });
  rejected.published = null;
  rejected.intercept = async (kind) => kind === "upload"
    ? new Response(JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "Version must be greater." } }), { status: 400 })
    : null;
  await assert.rejects(storeClient(rejected).publish(path), /rejected the upload of version 1\.0\.0: .*HTTP 400 \(INVALID_ARGUMENT: Version must be greater\.\)/u);

  for (const intercept of [
    async (kind) => { if (kind === "upload") throw new TypeError("fetch failed"); },
    async (kind) => kind === "upload" ? new Response("Service unavailable", { status: 503 }) : null,
  ]) {
    const store = simulatedStore();
    let uploads = 0;
    store.intercept = async (kind, init) => { if (kind === "upload") uploads++; return intercept(kind, init); };
    await assert.rejects(storeClient(store).publish(path), /upload result is unknown; inspect the Developer Dashboard/u);
    assert.equal(uploads, 1);
    assert.equal(store.publishes.length, 0);
  }

  const failed = simulatedStore();
  failed.intercept = async (kind) => kind === "upload" ? new Response(JSON.stringify({ uploadState: "FAILED" })) : null;
  await assert.rejects(storeClient(failed).publish(path), /upload of version 1\.0\.0 failed \(FAILED\)/u);
  assert.equal(failed.publishes.length, 0);

  const mismatched = simulatedStore();
  mismatched.intercept = async (kind) => kind === "upload"
    ? new Response(JSON.stringify({ uploadState: "SUCCEEDED", crxVersion: "1.0.1" })) : null;
  await assert.rejects(storeClient(mismatched).publish(path), /received version 1\.0\.1 instead of 1\.0\.0/u);
  assert.equal(mismatched.publishes.length, 0);
});

test("an upload still processing is polled within bounds before submission", async (t) => {
  const path = await archive(t);
  const store = simulatedStore();
  store.asyncUploads = 2;
  await storeClient(store).publish(path);
  assert.equal(store.submitted.version, "1.0.0");

  const stuck = simulatedStore();
  stuck.asyncUploads = 10;
  await assert.rejects(storeClient(stuck, { polling: { attempts: 2, delay: 0 } }).publish(path), /still processing; inspect/u);
  assert.equal(stuck.publishes.length, 0);

  const failed = simulatedStore();
  failed.asyncUploads = 1;
  failed.after = async (kind) => { if (kind === "upload") failed.asyncUploads = 0; };
  failed.intercept = async (kind) => {
    if (kind === "status" && failed.lastAsyncUploadState === "IN_PROGRESS") failed.lastAsyncUploadState = "FAILED";
    return null;
  };
  await assert.rejects(storeClient(failed).publish(path), /failed \(FAILED\)/u);
});

test("an ambiguous submission is accepted only when the store reports it", async (t) => {
  const path = await archive(t);
  const accepted = simulatedStore();
  accepted.after = async (kind) => { if (kind === "publish") throw new TypeError("socket hang up"); };
  await storeClient(accepted).publish(path);
  assert.equal(accepted.publishes.length, 1);
  assert.equal(accepted.submitted.version, "1.0.0");

  const lost = simulatedStore();
  lost.intercept = async (kind) => { if (kind === "publish") throw new TypeError("socket hang up"); };
  await assert.rejects(storeClient(lost).publish(path), /request failed: socket hang up/u);
  assert.equal(lost.submitted, null);

  const unreadable = simulatedStore();
  unreadable.intercept = async (kind) => {
    if (kind === "publish") throw new TypeError("socket hang up");
    if (kind === "status" && unreadable.uploads.length) unreadable.takenDown = true;
    return null;
  };
  await assert.rejects(storeClient(unreadable).publish(path), /socket hang up/u);

  const refused = simulatedStore();
  refused.intercept = async (kind) => kind === "publish" ? new Response(JSON.stringify({ state: "REJECTED" })) : null;
  await assert.rejects(storeClient(refused).publish(path), /did not accept the submission of version 1\.0\.0 \(REJECTED\)/u);
});

test("verification reports review states as bounded outcomes without submitting", async () => {
  const store = simulatedStore();
  const client = storeClient(store);
  const logs = [];
  const verify = (version = "1.0.0") => client.verify(identity(version), { attempts: 2, delay: 0 }, (line) => logs.push(line));
  assert.deepEqual(await verify(), { verification: "unverified", status: "NOT_FOUND" });
  assert.deepEqual(logs, ["[npr] waiting for Chrome Web Store submission (1/2)"]);
  for (const [state, verification] of [
    ["PENDING_REVIEW", "unverified"], ["STAGED", "unverified"], ["PUBLISHED", "verified"], ["PUBLISHED_TO_TESTERS", "verified"],
  ]) {
    store.submitted = { version: "1.0.0", state };
    assert.deepEqual(await verify(), { verification, status: state });
  }
  store.submitted = null;
  store.published = { version: "1.0.0", state: "PUBLISHED_TO_TESTERS" };
  assert.deepEqual(await verify(), { verification: "verified", status: "PUBLISHED_TO_TESTERS" });
  store.published = { version: "1.2.0", state: "PUBLISHED" };
  assert.deepEqual(await verify(), { verification: "unverified", status: "SUPERSEDED" });
  store.published = { version: "0.9.0", state: "PUBLISHED" };
  store.submitted = { version: "1.0.0", state: "REJECTED" };
  await assert.rejects(verify(), /rejected version 1\.0\.0/u);
  assert.equal(store.uploads.length + store.publishes.length, 0);
  await assert.rejects(client.verify(identity("1.0.0"), { attempts: 0, delay: 0 }, () => {}), /bounded verification/u);
});

test("malformed store responses fail closed", async () => {
  for (const response of [
    () => new Response("not json"),
    () => new Response(JSON.stringify({ publishedItemRevisionStatus: "PUBLISHED" })),
    () => new Response(JSON.stringify({ submittedItemRevisionStatus: { distributionChannels: {} } })),
  ]) {
    const store = simulatedStore();
    store.intercept = async (kind) => kind === "status" ? response() : null;
    await assert.rejects(storeClient(store).view("example-extension", "1.0.0"), /invalid (?:response|item status)/u);
  }
  const empty = simulatedStore();
  empty.intercept = async (kind) => kind === "status" ? new Response("") : null;
  assert.equal(await storeClient(empty).view("example-extension", "1.0.0"), null);
});

test("authentication failures explain linking and scopes and never reveal tokens", async () => {
  const store = simulatedStore({ token: "the-right-token" });
  const error = await storeClient(store).view("example-extension", "1.0.0").catch((caught) => caught);
  assert.match(error.message, /HTTP 401 \(UNAUTHENTICATED: Request had invalid authentication credentials: Bearer \[REDACTED\]\.\)/u);
  assert.match(error.message, /chromewebstore scope and its service account is linked in the Developer Dashboard/u);
  assert.doesNotMatch(error.message + error.stack, /example-secret-token/u);
  const forbidden = simulatedStore();
  forbidden.intercept = async () => new Response(JSON.stringify({ error: { message: "The caller does not have permission" } }), { status: 403 });
  await assert.rejects(storeClient(forbidden).view("example-extension", "1.0.0"),
    /HTTP 403 \(The caller does not have permission\)\. Check that the token/u);
  const network = simulatedStore();
  network.intercept = async () => { throw new Error(`connect failed for ${accessToken}`); };
  await assert.rejects(storeClient(network).view("example-extension", "1.0.0"), (caught) =>
    /request failed: connect failed for \[REDACTED\]/u.test(caught.message) && !caught.message.includes(accessToken));
  await assert.rejects(new ChromeWebStore({ publisherId, itemId, env: {} }).view("example-extension", "1.0.0"),
    /credentials are missing: set CHROME_WEB_STORE_ACCESS_TOKEN or CHROME_WEB_STORE_SERVICE_ACCOUNT_KEY/u);
  await assert.rejects(new EnvironmentAccessToken("MY_TOKEN").token({ env: { MY_TOKEN: " " }, fetch }), /Set MY_TOKEN/u);
  assert.equal(await new EnvironmentAccessToken("MY_TOKEN").token({ env: { MY_TOKEN: " abc\n" }, fetch }), "abc");
  const bound = new ChromeWebStore({ publisherId, itemId, fetch: simulatedStore().fetch, env: {} })
    .bind({ cwd: ".", run: async () => "", env });
  assert.equal(await bound.view("example-extension", "1.0.0"), null);
});

test("a service account JSON key is exchanged for a cached, scoped access token", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const email = "release@example-project.iam.gserviceaccount.com";
  const key = JSON.stringify({
    type: "service_account", client_email: email, private_key_id: "key-id",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: "https://oauth2.googleapis.com/token",
  });
  const store = simulatedStore({ publicKey, email });
  const client = storeClient(store, { env: { CHROME_WEB_STORE_SERVICE_ACCOUNT_KEY: key } });
  assert.equal(await client.view("example-extension", "1.0.0"), null);
  assert.equal(await client.view("example-extension", "1.0.0"), null);
  assert.equal(store.exchanges.length, 1);
  const [claims] = store.exchanges;
  assert.equal(claims.scope, chromeWebStoreScope);
  assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
  assert.equal(claims.exp - claims.iat, 3600);

  const source = new ServiceAccountKey("KEY");
  const exchange = (value, fetchImplementation = store.fetch) => source.token({ env: { KEY: value }, fetch: fetchImplementation });
  const invalid = await exchange(`{"private_key": "${"secret-material"}`).catch((caught) => caught);
  assert.match(invalid.message, /KEY is not a valid service account JSON key/u);
  assert.doesNotMatch(invalid.message, /secret-material/u);
  await assert.rejects(exchange(JSON.stringify({ type: "authorized_user" })), /not a valid service account JSON key/u);
  await assert.rejects(exchange(JSON.stringify({ ...JSON.parse(key), token_uri: "https://example.test/token" })),
    /must use the https:\/\/oauth2\.googleapis\.com\/token token endpoint/u);
  await assert.rejects(exchange(JSON.stringify({ ...JSON.parse(key), private_key: "not a key" })), /unusable private key/u);
  await assert.rejects(exchange(JSON.stringify({ ...JSON.parse(key), client_email: "other@example.test" })),
    /token exchange failed \(invalid_grant\): Invalid issuer\./u);
  await assert.rejects(exchange(key, async () => new Response("", { status: 500 })), /token exchange failed \(HTTP 500\)/u);
  await assert.rejects(exchange(key, async () => new Response("[]")), /invalid access token response/u);
  await assert.rejects(exchange(key, async () => new Response(JSON.stringify({ access_token: "" }))), /invalid access token response/u);
  await assert.rejects(exchange(key, async () => { throw new Error("offline"); }), /token exchange failed: offline/u);
  await assert.rejects(source.token({ env: {}, fetch }), /Set KEY to a service account JSON key/u);
  const credentials = new ChromeWebStoreCredentials();
  assert.equal(await credentials.token({ env: { ...env, CHROME_WEB_STORE_SERVICE_ACCOUNT_KEY: "{" }, fetch }), accessToken);
});

test("retained verification records registry outcomes and rejects malformed ones", async () => {
  const { verifyRetained } = await import("../dist/steps.js");
  const saved = [];
  const summaries = [];
  const state = {
    name: "example-extension", version: "1.0.0", releaseCommit: "a".repeat(40), artifact: { filename: "x.zip" },
    verificationOptions: { attempts: 1, delay: 0 }, registry: { kind: "custom", name: "Example Store" },
  };
  const services = (outcome) => ({
    project: { async intact() {} }, repository: { async verifyTag() {} }, verifier: { async verify() { return outcome; } },
    store: { directory: "unused", async read() { return state; }, async save(value) { saved.push(value); } },
  });
  const run = (outcome) => verifyRetained(() => {}, { async summary(text) { summaries.push(text); } }, services(outcome));
  const result = await run({ verification: "unverified", status: "IN_REVIEW" });
  assert.equal(result.registryStatus, "IN_REVIEW");
  assert.ok(Object.isFrozen(result.registry));
  assert.equal(summaries.at(-1), "\n## Example Store Verification\n\nexample-extension@1.0.0: not yet published (IN_REVIEW).\n");
  assert.equal((await run("verified")).registryStatus, undefined);
  await assert.rejects(run({ verification: "maybe", status: "X" }), /Invalid registry verification outcome/u);
  await assert.rejects(run({ verification: "verified", status: "" }), /Invalid registry verification status/u);
  assert.equal(saved.at(-1).verification, "failed");
});
