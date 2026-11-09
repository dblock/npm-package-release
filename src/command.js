import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import process from "node:process";

const execute = promisify(execFile);

export async function command(program, args, options = {}) {
  const env = { ...process.env, ...options.env };
  delete env.npm_config_call;
  delete env.npm_config_package;
  if (program === "npm" && (env.npm_execpath || process.platform === "win32")) {
    args = [env.npm_execpath || join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), ...args];
    program = process.execPath;
  }
  const { stdout } = await execute(program, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
    ...options,
    env,
  });
  return stdout;
}

export function numericVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
    throw new Error("Expected a numeric MAJOR.MINOR.PATCH version.");
  }
  return version;
}
