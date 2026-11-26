import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import type { CommandOptions } from "./contracts.js";

const execute = promisify(execFile);

function invocation(program: string, args: string[], extra: CommandOptions["env"]) {
  const env = { ...process.env, ...extra };
  delete env.npm_config_call;
  delete env.npm_config_package;
  delete env.npm_config_offline;
  if (program === "npm" && (env.npm_execpath || process.platform === "win32")) {
    args = [env.npm_execpath || join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), ...args];
    program = process.execPath;
  }
  return { program, args, env };
}

/** Runs a command attached to the terminal, so npm can prompt for authentication and 2FA. */
export function interactive(program: string, args: string[], options: CommandOptions = {}): Promise<void> {
  const resolved = invocation(program, args, options.env);
  return new Promise((done, fail) => {
    const child = spawn(resolved.program, resolved.args, { cwd: options.cwd, env: resolved.env, stdio: "inherit" });
    child.on("error", fail);
    child.on("close", (code, signal) => code === 0 ? done()
      : fail(new Error(`${[program, ...args].join(" ")} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`)));
  });
}

export async function command(program: string, args: string[], options: CommandOptions = {}): Promise<string> {
  const { output, ...executionOptions } = options;
  const resolved = invocation(program, args, options.env);
  const env = resolved.env;
  program = resolved.program;
  args = resolved.args;
  const { stdout } = await execute(program, args, {
    encoding: output ? null : "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
    ...executionOptions,
    env,
  });
  if (output) {
    await writeFile(resolve(options.cwd || ".", output), stdout);
    return "";
  }
  return stdout.toString();
}

export function numericVersion(version: unknown): string {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
    throw new Error("Expected a numeric MAJOR.MINOR.PATCH version.");
  }
  return version;
}
