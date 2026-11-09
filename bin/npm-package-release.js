#!/usr/bin/env node

import process from "node:process";
import { version } from "../src/index.js";

const help = `Usage: npm-package-release [--help | --version]

Release commands are not implemented yet.
`;
const args = process.argv.slice(2);

if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
  process.stdout.write(help);
} else if (args.length === 1 && args[0] === "--version") {
  process.stdout.write(`${version}\n`);
} else {
  process.stderr.write(`Unknown arguments: ${args.join(" ")}\n${help}`);
  process.exitCode = 1;
}
