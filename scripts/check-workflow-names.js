import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { titleCase } from "title-case";
import { parseDocument } from "yaml";

export function checkWorkflowNames(source) {
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((error) => error.message).join("\n"));
  }
  const workflow = document.toJS();
  const errors = [];

  function check(value, path) {
    if (value === undefined) return;
    if (typeof value !== "string" || value.trim() === "") {
      errors.push({ path, message: "Display names must be nonempty strings." });
      return;
    }
    const masked = value.replace(/\$\{\{[\s\S]*?\}\}|`[^`]+`|\bnpm\b/gu, "ZZZ");
    if (masked !== titleCase(masked)) {
      errors.push({ path, message: `Use title case for "${value}".` });
    }
  }

  check(workflow?.name, "name");
  for (const [id, job] of Object.entries(workflow?.jobs ?? {})) {
    check(job.name, `jobs.${id}.name`);
    for (const [index, step] of (job.steps ?? []).entries()) {
      check(step.name, `jobs.${id}.steps[${index}].name`);
    }
  }
  if (workflow?.runs?.using === "composite") {
    for (const [index, step] of (workflow.runs.steps ?? []).entries()) {
      check(step.name, `runs.steps[${index}].name`);
    }
  }
  return errors;
}

async function main() {
  const files = [];
  for (const directory of [".github/workflows", "examples"]) {
    try {
      files.push(...(await readdir(directory)).filter((file) => /\.ya?ml$/u.test(file)).sort()
        .map((file) => `${directory}/${file}`));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  try {
    await readFile("action.yml");
    files.push("action.yml");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const file of files) {
    const path = file;
    try {
      for (const error of checkWorkflowNames(await readFile(path, "utf8"))) {
        process.stderr.write(`${path}: ${error.path}: ${error.message}\n`);
        process.exitCode = 1;
      }
    } catch (error) {
      process.stderr.write(`${path}: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
