import { Buffer } from "node:buffer";
import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { numericVersion } from "./command.js";
import { verificationOptions } from "./services.js";
import { readZip } from "./zip.js";
import type {
  Artifact, Environment, Log, PackagePublisher, ProjectContext, RegistryDescription, RegistryMetadata, RegistryOutcome,
  RegistryVerifier, ReleaseIdentity, VerificationOptions,
} from "./contracts.js";

/** The OAuth scope the Chrome Web Store API requires for uploads and submissions. */
export const chromeWebStoreScope = "https://www.googleapis.com/auth/chromewebstore";
const api = "https://chromewebstore.googleapis.com";
const tokenEndpoint = "https://oauth2.googleapis.com/token";

export type Fetch = typeof fetch;
export interface AccessTokenContext {
  readonly env: Environment;
  readonly fetch: Fetch;
}
/** Supplies a Google OAuth access token with the Chrome Web Store scope; never stored in configuration or state. */
export interface AccessTokenSource {
  token(context: AccessTokenContext): Promise<string>;
}

/** Reads an access token, such as the `google-github-actions/auth` output, from an environment variable. */
export class EnvironmentAccessToken implements AccessTokenSource {
  constructor(readonly variable = "CHROME_WEB_STORE_ACCESS_TOKEN") {
    environmentName(variable);
    Object.freeze(this);
  }

  async token({ env }: AccessTokenContext): Promise<string> {
    const token = env[this.variable]?.trim();
    if (!token) throw new Error(`Set ${this.variable} to a Chrome Web Store access token.`);
    return token;
  }
}

interface ServiceAccount { readonly email: string; readonly key: string; readonly id?: string }

/** Exchanges a service account JSON key, read from an environment variable, for a short-lived access token. */
export class ServiceAccountKey implements AccessTokenSource {
  #cached?: { readonly source: string; readonly token: string; readonly expires: number };

  constructor(readonly variable = "CHROME_WEB_STORE_SERVICE_ACCOUNT_KEY") {
    environmentName(variable);
  }

  async token({ env, fetch }: AccessTokenContext): Promise<string> {
    const source = env[this.variable]?.trim();
    if (!source) throw new Error(`Set ${this.variable} to a service account JSON key.`);
    if (this.#cached?.source === source && this.#cached.expires > Date.now()) return this.#cached.token;
    const account = serviceAccount(source, this.variable);
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT", ...(account.id ? { kid: account.id } : {}) })}.${encode({
      iss: account.email, scope: chromeWebStoreScope, aud: tokenEndpoint, iat: now, exp: now + 3600,
    })}`;
    let signature: string;
    try {
      signature = createSign("RSA-SHA256").update(unsigned).sign(account.key).toString("base64url");
    } catch {
      throw new Error(`${this.variable} contains an unusable private key.`);
    }
    const body = await exchange(fetch, new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}`,
    }));
    const token = body.access_token;
    const lifetime = body.expires_in;
    if (typeof token !== "string" || !token || (lifetime !== undefined && typeof lifetime !== "number")) {
      throw new Error("Google returned an invalid access token response.");
    }
    this.#cached = { source, token, expires: Date.now() + (Math.min(lifetime ?? 3600, 3600) - 60) * 1000 };
    return token;
  }
}

/** Uses `CHROME_WEB_STORE_ACCESS_TOKEN` when set, otherwise a `CHROME_WEB_STORE_SERVICE_ACCOUNT_KEY` JSON key. */
export class ChromeWebStoreCredentials implements AccessTokenSource {
  readonly access = new EnvironmentAccessToken();
  readonly key = new ServiceAccountKey();

  async token(context: AccessTokenContext): Promise<string> {
    if (context.env[this.access.variable]?.trim()) return this.access.token(context);
    if (context.env[this.key.variable]?.trim()) return this.key.token(context);
    throw new Error(`Chrome Web Store credentials are missing: set ${this.access.variable} or ${this.key.variable}.`);
  }
}

function environmentName(variable: string): void {
  if (typeof variable !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variable)) {
    throw new Error("Expected an environment variable name.");
  }
}

function serviceAccount(source: string, variable: string): ServiceAccount {
  let key: Record<string, unknown>;
  try { key = JSON.parse(source); } catch {
    // Parser messages can quote the input, which contains the private key.
    throw new Error(`${variable} is not a valid service account JSON key.`);
  }
  if (typeof key !== "object" || key === null || key.type !== "service_account" ||
    typeof key.client_email !== "string" || typeof key.private_key !== "string" ||
    (key.private_key_id !== undefined && typeof key.private_key_id !== "string")) {
    throw new Error(`${variable} is not a valid service account JSON key.`);
  }
  if (key.token_uri !== undefined && key.token_uri !== tokenEndpoint) {
    throw new Error(`${variable} must use the ${tokenEndpoint} token endpoint.`);
  }
  return { email: key.client_email, key: key.private_key, ...(key.private_key_id ? { id: key.private_key_id as string } : {}) };
}

async function exchange(fetch: Fetch, body: URLSearchParams): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`Google token exchange failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const value = parse(await response.text());
  if (!response.ok) {
    const reason = typeof value?.error === "string" ? value.error : `HTTP ${response.status}`;
    const description = typeof value?.error_description === "string" ? `: ${value.error_description}` : "";
    throw new Error(`Google token exchange failed (${reason})${description}`);
  }
  if (!value) throw new Error("Google returned an invalid access token response.");
  return value;
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

export type ChromeItemState =
  "PENDING_REVIEW" | "STAGED" | "PUBLISHED" | "PUBLISHED_TO_TESTERS" | "REJECTED" | "CANCELLED" | "ITEM_STATE_UNSPECIFIED";
export interface ChromeRevision {
  readonly state?: ChromeItemState;
  readonly distributionChannels?: readonly { readonly crxVersion?: string; readonly deployPercentage?: number }[];
}
export interface ChromeItemStatus {
  readonly name?: string;
  readonly itemId?: string;
  readonly publishedItemRevisionStatus?: ChromeRevision;
  readonly submittedItemRevisionStatus?: ChromeRevision;
  readonly lastAsyncUploadState?: string;
  readonly takenDown?: boolean;
  readonly warned?: boolean;
}

export interface ChromeWebStoreOptions {
  /** Publisher ID from the Developer Dashboard's account page. */
  readonly publisherId: string;
  /** The existing item's 32-character extension ID. */
  readonly itemId: string;
  readonly token?: AccessTokenSource;
  /** `STAGED_PUBLISH` holds an approved revision for manual publication. */
  readonly publishType?: "DEFAULT_PUBLISH" | "STAGED_PUBLISH";
  /** Initial rollout percentage; the store allows partial rollout only for items with many users. */
  readonly deployPercentage?: number;
  /** Bounded polling for an upload still processing and for a submission not yet visible. */
  readonly polling?: Partial<VerificationOptions>;
  readonly env?: Environment;
  readonly fetch?: Fetch;
}

class StoreError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

const active = new Set<string>(["PENDING_REVIEW", "STAGED", "PUBLISHED", "PUBLISHED_TO_TESTERS"]);
const live = new Set<string>(["PUBLISHED", "PUBLISHED_TO_TESTERS"]);

function chromeVersion(version: string): number[] {
  if (typeof version !== "string" || !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/u.test(version)) {
    throw new Error(`Invalid Chrome extension version: ${String(version)}.`);
  }
  return version.split(".").map(Number);
}

export function compareChromeVersions(left: string, right: string): number {
  const [a, b] = [chromeVersion(left), chromeVersion(right)];
  for (let index = 0; index < 4; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function versions(revision?: ChromeRevision): string[] {
  return (revision?.distributionChannels ?? []).map(({ crxVersion }) => crxVersion)
    .filter((version): version is string => typeof version === "string");
}

/** Reads `manifest.json` from a zip and returns its extension version. */
export function extensionVersion(bytes: Uint8Array): string {
  const manifest = readZip(bytes).find(({ path }) => path === "manifest.json");
  if (!manifest) throw new Error("The archive has no manifest.json at its root.");
  let version: unknown;
  try { version = JSON.parse(Buffer.from(manifest.content).toString("utf8")).version; } catch {
    throw new Error("The archive's manifest.json is not valid JSON.");
  }
  if (typeof version !== "string") throw new Error("The archive's manifest.json has no version.");
  chromeVersion(version);
  return version;
}

type Reconciled =
  | { readonly kind: "found"; readonly state: string }
  | { readonly kind: "missing" }
  | { readonly kind: "later"; readonly version: string }
  | { readonly kind: "blocked"; readonly versions: string; readonly state: string };

/**
 * Uploads an exact extension zip to an existing Chrome Web Store item and submits it for review.
 * The store reports versions, not archive checksums, so reconciliation is by manifest version.
 */
export class ChromeWebStore implements PackagePublisher, RegistryVerifier {
  readonly publisherId: string;
  readonly itemId: string;
  readonly checksums = false;
  readonly registry: RegistryDescription;
  readonly options: VerificationOptions;
  readonly publishType?: "DEFAULT_PUBLISH" | "STAGED_PUBLISH";
  readonly deployPercentage?: number;
  readonly #token: AccessTokenSource;
  readonly #env: Environment;
  readonly #fetch: Fetch;

  constructor({
    publisherId, itemId, token = new ChromeWebStoreCredentials(), publishType, deployPercentage, polling,
    env = process.env, fetch = globalThis.fetch,
  }: ChromeWebStoreOptions) {
    if (typeof publisherId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/u.test(publisherId)) {
      throw new Error("ChromeWebStore publisherId must be the publisher ID from the Developer Dashboard.");
    }
    if (typeof itemId !== "string" || !/^[a-p]{32}$/u.test(itemId)) {
      throw new Error("ChromeWebStore itemId must be a 32-character extension ID.");
    }
    if (typeof token?.token !== "function") throw new Error("ChromeWebStore token must implement token().");
    if (publishType !== undefined && publishType !== "DEFAULT_PUBLISH" && publishType !== "STAGED_PUBLISH") {
      throw new Error('ChromeWebStore publishType must be "DEFAULT_PUBLISH" or "STAGED_PUBLISH".');
    }
    if (deployPercentage !== undefined && (!Number.isInteger(deployPercentage) || deployPercentage < 0 || deployPercentage > 100)) {
      throw new Error("ChromeWebStore deployPercentage must be an integer from 0 to 100.");
    }
    if (typeof fetch !== "function") throw new Error("ChromeWebStore fetch must be a function.");
    this.publisherId = publisherId;
    this.itemId = itemId;
    this.registry = Object.freeze({ kind: "chrome-web-store", name: "Chrome Web Store", publisherId, itemId });
    this.options = verificationOptions(polling);
    if (publishType !== undefined) this.publishType = publishType;
    if (deployPercentage !== undefined) this.deployPercentage = deployPercentage;
    this.#token = token;
    this.#env = Object.freeze({ ...env });
    this.#fetch = fetch;
    Object.freeze(this);
  }

  bind({ env }: ProjectContext): ChromeWebStore {
    return new ChromeWebStore({
      publisherId: this.publisherId, itemId: this.itemId, token: this.#token, publishType: this.publishType,
      deployPercentage: this.deployPercentage, polling: this.options, env, fetch: this.#fetch,
    });
  }

  private get item(): string {
    return `publishers/${encodeURIComponent(this.publisherId)}/items/${this.itemId}`;
  }

  private async request(method: "GET" | "POST", url: string, body?: Uint8Array<ArrayBuffer> | string, timeout = 60_000): Promise<Record<string, unknown>> {
    const token = await this.#token.token({ env: this.#env, fetch: this.#fetch });
    const redact = (text: string) => text.split(token).join("[REDACTED]");
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body instanceof Uint8Array ? { "Content-Type": "application/zip" } : body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new StoreError(redact(`Chrome Web Store request failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    const text = await response.text();
    const value = parse(text);
    if (!response.ok) {
      const error = value?.error as { message?: unknown; status?: unknown } | undefined;
      const detail = [typeof error?.status === "string" ? error.status : "", typeof error?.message === "string" ? error.message : ""]
        .filter(Boolean).join(": ");
      const hint = response.status === 401 || response.status === 403
        ? " Check that the token has the chromewebstore scope and its service account is linked in the Developer Dashboard."
        : "";
      throw new StoreError(redact(`Chrome Web Store returned HTTP ${response.status}${detail ? ` (${detail})` : ""}.${hint}`),
        response.status);
    }
    if (!value && text.trim()) throw new StoreError("Chrome Web Store returned an invalid response.");
    return value ?? {};
  }

  /** Reads the item's published and submitted revisions. */
  async status(): Promise<ChromeItemStatus> {
    const status = await this.request("GET", `${api}/v2/${this.item}:fetchStatus`) as ChromeItemStatus;
    for (const revision of [status.publishedItemRevisionStatus, status.submittedItemRevisionStatus]) {
      if (revision !== undefined && (typeof revision !== "object" || revision === null ||
        (revision.distributionChannels !== undefined && !Array.isArray(revision.distributionChannels)))) {
        throw new Error("Chrome Web Store returned an invalid item status.");
      }
    }
    return status;
  }

  private reconcile(status: ChromeItemStatus, version: string): Reconciled {
    if (status.takenDown) throw new Error("The Chrome Web Store item was taken down; inspect the Developer Dashboard.");
    const published = status.publishedItemRevisionStatus;
    if (versions(published).includes(version)) return { kind: "found", state: published?.state ?? "PUBLISHED" };
    const submitted = status.submittedItemRevisionStatus;
    const state = submitted?.state ?? "ITEM_STATE_UNSPECIFIED";
    if (versions(submitted).includes(version)) {
      if (active.has(state)) return { kind: "found", state };
      if (state === "REJECTED") throw new Error(`Chrome Web Store rejected version ${version}; see the Developer Dashboard.`);
      throw new Error(`Chrome Web Store submission of version ${version} is ${state}; inspect the Developer Dashboard.`);
    }
    const later = [...versions(published), ...(active.has(state) ? versions(submitted) : [])]
      .find((existing) => compareChromeVersions(existing, version) > 0);
    if (later) return { kind: "later", version: later };
    if (submitted && active.has(state) && !live.has(state)) {
      return { kind: "blocked", versions: versions(submitted).join(", ") || "unknown", state };
    }
    return { kind: "missing" };
  }

  /** Whether the version is already submitted or published; fails on any state that forbids submitting it. */
  private submitted(status: ChromeItemStatus, version: string): boolean {
    if (status.lastAsyncUploadState === "IN_PROGRESS") {
      throw new Error("A Chrome Web Store upload is still processing; inspect the Developer Dashboard and retry later.");
    }
    const reconciled = this.reconcile(status, version);
    if (reconciled.kind === "later") {
      throw new Error(`Chrome Web Store already has version ${reconciled.version}, later than ${version}.`);
    }
    if (reconciled.kind === "blocked") {
      throw new Error(`Chrome Web Store version ${reconciled.versions} is ${reconciled.state}; ` +
        `wait for it or cancel it before submitting ${version}.`);
    }
    return reconciled.kind === "found";
  }

  async view(name: string, version: string): Promise<RegistryMetadata | null> {
    numericVersion(version);
    return this.submitted(await this.status(), version) ? Object.freeze({ name, version }) : null;
  }

  async publish(archive: string): Promise<void> {
    const bytes = await readFile(archive);
    const version = extensionVersion(bytes);
    if (!basename(archive).endsWith(`-v${version}.zip`)) {
      throw new Error(`The archive's manifest.json version ${version} does not match its release version.`);
    }
    if (this.submitted(await this.status(), version)) return;
    await this.upload(bytes, version);
    const body = {
      ...(this.publishType ? { publishType: this.publishType } : {}),
      ...(this.deployPercentage !== undefined ? { deployInfos: [{ deployPercentage: this.deployPercentage }] } : {}),
    };
    let submitted: Record<string, unknown>;
    try {
      submitted = await this.request("POST", `${api}/v2/${this.item}:publish`, JSON.stringify(body));
    } catch (error) {
      // The submission may have been accepted; read the store once, never submit again.
      let found = false;
      try { found = this.reconcile(await this.status(), version).kind === "found"; } catch { /* Report the original failure. */ }
      if (found) return;
      throw error;
    }
    if (typeof submitted.state !== "string" || !active.has(submitted.state)) {
      throw new Error(`Chrome Web Store did not accept the submission of version ${version} (${String(submitted.state)}).`);
    }
  }

  private async upload(bytes: Uint8Array<ArrayBuffer>, version: string): Promise<void> {
    let uploaded: Record<string, unknown>;
    try {
      uploaded = await this.request("POST", `${api}/upload/v2/${this.item}:upload`, bytes, 300_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof StoreError && error.status !== undefined && error.status < 500) {
        throw new Error(`Chrome Web Store rejected the upload of version ${version}: ${message}`, { cause: error });
      }
      throw new Error(`The Chrome Web Store upload result is unknown; inspect the Developer Dashboard before rerunning: ${message}`,
        { cause: error });
    }
    let state = uploaded.uploadState;
    for (let attempt = 0; (state === "IN_PROGRESS" || state === "UPLOAD_IN_PROGRESS") && attempt < this.options.attempts; attempt++) {
      await setTimeout(this.options.delay);
      state = (await this.status()).lastAsyncUploadState;
    }
    if (state === "IN_PROGRESS" || state === "UPLOAD_IN_PROGRESS") {
      throw new Error("The Chrome Web Store upload is still processing; inspect the Developer Dashboard before rerunning.");
    }
    if (state !== "SUCCEEDED") throw new Error(`The Chrome Web Store upload of version ${version} failed (${String(state)}).`);
    if (uploaded.crxVersion !== undefined && uploaded.crxVersion !== version) {
      throw new Error(`Chrome Web Store received version ${String(uploaded.crxVersion)} instead of ${version}.`);
    }
  }

  /** Reports a published revision as verified, and a submission awaiting review as unverified with its store state. */
  async verify(state: ReleaseIdentity & { readonly artifact: Artifact }, options: VerificationOptions, log: Log): Promise<RegistryOutcome> {
    numericVersion(state.version);
    const { attempts, delay } = verificationOptions(options);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const reconciled = this.reconcile(await this.status(), state.version);
      if (reconciled.kind === "later") return Object.freeze({ verification: "unverified", status: "SUPERSEDED" });
      if (reconciled.kind === "found") {
        return Object.freeze({ verification: live.has(reconciled.state) ? "verified" : "unverified", status: reconciled.state });
      }
      if (attempt + 1 < attempts) {
        log(`[npr] waiting for Chrome Web Store submission (${attempt + 1}/${attempts})`);
        await setTimeout(delay);
      }
    }
    return Object.freeze({ verification: "unverified", status: "NOT_FOUND" });
  }
}
