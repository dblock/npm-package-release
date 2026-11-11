#!/usr/bin/env node

import process from "node:process";
import { main } from "../dist/cli.js";

try {
  await main();
} catch (error) {
  process.stderr.write(`[npr] ${error.message}\n`);
  if (typeof error.stdout === "string" && error.stdout) {
    process.stderr.write(error.stdout.endsWith("\n") ? error.stdout : `${error.stdout}\n`);
  }
  process.exitCode = 1;
}
