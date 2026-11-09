import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { release, verify } from "./release.js";
import { version } from "./index.js";

export const help = `Usage: npr [--help | --version]
       npr release [--config npr.config.js] [--version X.Y.Z] [--artifacts PATH]
       npr verify [--artifacts PATH]

Release publishes to npm and pushes Git commits/tags. Verify never publishes.
`;

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
  if (!["release", "verify"].includes(action)) throw new Error("Unknown arguments. Use npr --help.");
  const { values, positionals } = parseArgs({
    args: flags,
    options: { artifacts: { type: "string" }, ...(action === "release" ? {
      config: { type: "string", default: "npr.config.js" }, version: { type: "string" },
    } : {}) },
    allowPositionals: true,
  });
  if (positionals.length) throw new Error("Unexpected positional arguments.");
  if (action === "verify") return await verify({ artifacts: values.artifacts });
  const { default: config } = await import(pathToFileURL(resolve(values.config)).href);
  return await release(config, { version: values.version, artifacts: values.artifacts });
}
