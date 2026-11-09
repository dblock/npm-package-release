#!/usr/bin/env node

import process from "node:process";
import { main } from "../dist/cli.js";

try {
  await main();
} catch (error) {
  process.stderr.write(`[npr] ${error.message}\n`);
  process.exitCode = 1;
}
