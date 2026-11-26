import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { command, interactive } from "./command.js";
import type { Command, CommandOptions, Log } from "./contracts.js";
import { npmName } from "./package.js";

/** Runs a command attached to the terminal, so npm can prompt for authentication and 2FA. */
export type InteractiveCommand = (program: string, args: string[], options?: CommandOptions) => Promise<void>;

export interface BootstrapOptions {
  /** Package directory whose package.json supplies defaults. */
  readonly cwd?: string;
  /** npm package name, including any scope. Defaults to package.json `name`. */
  readonly name?: string;
  /** Placeholder license. Defaults to package.json `license`. */
  readonly license?: string;
  /** GitHub owner/repository. Defaults to package.json `repository`, then the `origin` remote. */
  readonly repo?: string;
  /** Calling workflow filename. Defaults to `release.yml`. */
  readonly file?: string;
  /** GitHub environment. Defaults to `release`. */
  readonly environment?: string;
  /** Print the placeholder and commands without contacting npm. */
  readonly dryRun?: boolean;
  readonly run?: Command;
  readonly interactive?: InteractiveCommand;
  readonly log?: Log;
}

export const placeholderVersion = "0.0.0";
export const placeholderMessage = "Placeholder reserving this name. Install a later version.";
const registry = "--registry=https://registry.npmjs.org/";

interface Manifest { name?: unknown; license?: unknown; repository?: unknown }

async function manifest(cwd: string): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function packageName(options: BootstrapOptions, metadata: Manifest): string {
  const name = options.name ?? metadata.name;
  if (name === undefined) throw new Error("Pass --name or run in a directory with package.json.");
  if (typeof name !== "string" || !npmName.test(name)) throw new Error("Expected an npm package name.");
  return name;
}

function repositoryUrl(metadata: Manifest): string | undefined {
  const { repository } = metadata;
  if (typeof repository === "string") return repository;
  if (repository && typeof repository === "object" && typeof (repository as { url?: unknown }).url === "string") {
    return (repository as { url: string }).url;
  }
  return undefined;
}

/** Extracts owner/repository from GitHub shorthand, HTTPS, or SSH repository URLs. */
export function githubRepository(value: string): string | null {
  const match = /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/u.exec(value) ??
    /^(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/u.exec(value) ??
    /^(?:[^@/]+@)?github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/u.exec(value);
  return match ? `${match[1]}/${match[2]}` : null;
}

async function repository(options: BootstrapOptions, metadata: Manifest, cwd: string, run: Command): Promise<string> {
  if (options.repo !== undefined) {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(options.repo)) throw new Error("Expected --repo as a GitHub owner/repository.");
    return options.repo;
  }
  const url = repositoryUrl(metadata);
  if (url !== undefined) {
    const inferred = githubRepository(url);
    if (inferred) return inferred;
  }
  let origin: string | undefined;
  try { origin = (await run("git", ["remote", "get-url", "origin"], { cwd })).trim(); } catch { /* No origin remote. */ }
  const inferred = origin === undefined ? null : githubRepository(origin);
  if (!inferred) throw new Error("Pass --repo as a GitHub owner/repository; it could not be inferred.");
  return inferred;
}

async function registered(run: Command, name: string): Promise<boolean> {
  try {
    await run("npm", ["view", name, "name", "--json", registry, "--prefer-online", "--offline=false",
      "--fetch-retries=0", "--fetch-timeout=15000"], { timeout: 30_000 });
    return true;
  } catch (error) {
    let output;
    try { output = JSON.parse((error as { stdout: string }).stdout); } catch { /* Only structured npm E404 responses mean missing. */ }
    if (output?.error?.code === "E404") return false;
    throw error;
  }
}

function defaults(options: BootstrapOptions) {
  return {
    cwd: resolve(options.cwd ?? process.cwd()),
    run: options.run ?? command,
    interactive: options.interactive ?? interactive,
    log: options.log ?? console.log,
  };
}

interface ReservePlan { name: string; placeholder: Record<string, string> }
interface TrustPlan { name: string; args: string[] }

async function planReserve(options: BootstrapOptions, metadata: Manifest): Promise<ReservePlan> {
  const name = packageName(options, metadata);
  const license = options.license ?? metadata.license;
  if (license !== undefined && (typeof license !== "string" || !license)) throw new Error("Expected a license string.");
  const url = repositoryUrl(metadata);
  return {
    name,
    placeholder: {
      name, version: placeholderVersion, description: placeholderMessage,
      ...(license ? { license } : {}), ...(url ? { repository: url } : {}),
    },
  };
}

async function planTrust(options: BootstrapOptions, metadata: Manifest, cwd: string, run: Command): Promise<TrustPlan> {
  const name = packageName(options, metadata);
  const repo = await repository(options, metadata, cwd, run);
  const file = options.file ?? "release.yml";
  if (!/^[\w.-]+\.ya?ml$/u.test(file)) throw new Error("Expected --file as a workflow filename such as release.yml.");
  const environment = options.environment ?? "release";
  if (!/^[\w.-]+$/u.test(environment)) throw new Error("Expected --env as a GitHub environment name.");
  return {
    name,
    args: ["trust", "github", name, "--repo", repo, "--file", file, "--env", environment, "--allow-publish", registry],
  };
}

async function executeReserve(plan: ReservePlan, options: BootstrapOptions, settings: ReturnType<typeof defaults>) {
  const { name, placeholder } = plan;
  const publish = ["publish", "--access", "public", registry];
  const deprecate = ["deprecate", `${name}@${placeholderVersion}`, placeholderMessage, registry];
  if (options.dryRun) {
    settings.log(`[npr] placeholder package.json: ${JSON.stringify(placeholder)}`);
    settings.log(`[npr] would run: npm ${publish.join(" ")}`);
    settings.log(`[npr] would run: npm ${deprecate.map((arg) => arg.includes(" ") ? JSON.stringify(arg) : arg).join(" ")}`);
    return;
  }
  if (await registered(settings.run, name)) {
    throw new Error(`${name} already exists on npm; reserve only unpublished names.`);
  }
  const directory = await mkdtemp(join(tmpdir(), "npr-reserve-"));
  try {
    await writeFile(join(directory, "package.json"), `${JSON.stringify(placeholder, null, 2)}\n`);
    await settings.interactive("npm", publish, { cwd: directory });
    settings.log(`[npr] published placeholder: ${name}@${placeholderVersion}`);
    await settings.interactive("npm", deprecate, { cwd: directory });
    settings.log(`[npr] deprecated placeholder: ${name}@${placeholderVersion}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function executeTrust(plan: TrustPlan, options: BootstrapOptions, settings: ReturnType<typeof defaults>) {
  const list = ["trust", "list", plan.name, "--json", registry];
  if (options.dryRun) {
    settings.log(`[npr] would run: npm ${plan.args.join(" ")}`);
    settings.log(`[npr] would run: npm ${list.join(" ")}`);
    return;
  }
  await settings.interactive("npm", plan.args, { cwd: settings.cwd });
  await settings.interactive("npm", list, { cwd: settings.cwd });
  settings.log(`[npr] trusted publisher configured for ${plan.name}; it expires unless it publishes within two days.`);
}

/** Reserves an unpublished npm name with an empty, deprecated 0.0.0 placeholder. */
export async function reserve(options: BootstrapOptions = {}) {
  const settings = defaults(options);
  await executeReserve(await planReserve(options, await manifest(settings.cwd)), options, settings);
}

/** Configures GitHub Actions Trusted Publishing for an existing npm package. */
export async function trust(options: BootstrapOptions = {}) {
  const settings = defaults(options);
  const metadata = await manifest(settings.cwd);
  await executeTrust(await planTrust(options, metadata, settings.cwd, settings.run), options, settings);
}

/** Reserves a new npm name, then configures Trusted Publishing, validating both before publishing anything. */
export async function bootstrap(options: BootstrapOptions = {}) {
  const settings = defaults(options);
  const metadata = await manifest(settings.cwd);
  const reservation = await planReserve(options, metadata);
  const trusted = await planTrust(options, metadata, settings.cwd, settings.run);
  await executeReserve(reservation, options, settings);
  try {
    await executeTrust(trusted, options, settings);
  } catch (error) {
    throw new Error(`Reserved ${reservation.name}@${placeholderVersion}, but Trusted Publishing setup failed; ` +
      `rerun npr trust. ${(error as Error).message}`);
  }
}
