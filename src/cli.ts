import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { bootstrap, reserve, trust } from "./bootstrap.js";
import { release, verify, prepare } from "./release.js";
import { version } from "./index.js";

export const help = `Usage: npr [--help | --version]
       npr release [--config npr.config.js] [--version X.Y.Z] [--artifacts PATH]
       npr prepare [--config npr.config.js] [--version X.Y.Z] [--artifacts PATH]
       npr verify [--artifacts PATH]
       npr reserve [--name NAME] [--license SPDX] [--dry-run]
       npr trust [--name NAME] [--repo OWNER/REPO] [--file release.yml] [--env release] [--dry-run]
       npr bootstrap [--name NAME] [--license SPDX] [--repo OWNER/REPO] [--file release.yml] [--env release] [--dry-run]

Release publishes to npm, unless configured without a registry, and pushes Git commits/tags.
Verify never publishes.
Prepare validates and preserves artifacts without publishing. Release reconciles the current checkout.
Reserve publishes an empty, deprecated 0.0.0 placeholder for an unpublished npm name.
Trust configures GitHub Actions Trusted Publishing for an existing npm package.
Bootstrap reserves a new name, then configures Trusted Publishing.
Names, licenses, and repositories default to ./package.json and the origin remote.
`;

const setup = { reserve, trust, bootstrap } as const;
type Setup = keyof typeof setup;

function setupOptions(action: Setup): ParseArgsConfig["options"] {
  const text = { type: "string" } as const;
  return {
    name: text,
    "dry-run": { type: "boolean" },
    ...(action !== "trust" ? { license: text } : {}),
    ...(action !== "reserve" ? { repo: text, file: text, env: text } : {}),
  };
}

async function runSetup(action: Setup, flags: string[]) {
  const { values, positionals } = parseArgs({ args: flags, options: setupOptions(action), allowPositionals: true });
  if (positionals.length) throw new Error("Unexpected positional arguments.");
  const options = values as Record<string, string | boolean | undefined>;
  await setup[action]({
    name: options.name as string | undefined,
    license: options.license as string | undefined,
    repo: options.repo as string | undefined,
    file: options.file as string | undefined,
    environment: options.env as string | undefined,
    dryRun: options["dry-run"] === true,
  });
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || (args.length === 1 && args[0] === "--help")) {
    process.stdout.write(help);
    return;
  }
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${version}\n`);
    return;
  }
  const [action, ...flags] = args;
  if (Object.hasOwn(setup, action)) return await runSetup(action as Setup, flags);
  if (!["release", "prepare", "verify"].includes(action)) throw new Error("Unknown arguments. Use npr --help.");
  const { values, positionals } = parseArgs({
    args: flags,
    options: {
      artifacts: { type: "string" },
      ...(action !== "verify" ? { config: { type: "string", default: "npr.config.js" } } : {}),
      ...(["release", "prepare"].includes(action) ? { version: { type: "string" } } : {}),
    },
    allowPositionals: true,
  });
  if (positionals.length) throw new Error("Unexpected positional arguments.");
  if (action === "verify") return await verify({ artifacts: values.artifacts as string | undefined });
  const { default: config } = await import(pathToFileURL(resolve(values.config as string)).href);
  const options = { version: values.version as string | undefined, artifacts: values.artifacts as string | undefined };
  if (action === "prepare") return await prepare(config, options);
  return await release(config, options);
}
