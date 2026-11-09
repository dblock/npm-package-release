import { readFile, writeFile, mkdir, readdir, realpath, rename } from "node:fs/promises";
import console from "node:console";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { inc, valid } from "semver";
import { command, numericVersion } from "./command.js";
import { releaseChangelog, nextChangelog } from "./changelog.js";
import { Git } from "./git.js";
import { NpmPackage } from "./package.js";

function verificationOptions(options = {}) {
  const { attempts = 6, delay = 10_000 } = options;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 60 ||
    !Number.isInteger(delay) || delay < 0 || delay > 60_000) throw new Error("Invalid bounded verification options.");
  return { attempts, delay };
}

function calendarDate(timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type).value).join("-");
}

function runner(cwd, run, timezone, phase, env) {
  return (program, args, options = {}) => run(program, args, {
    cwd,
    ...options,
    env: { ...env, TZ: timezone, ...(phase === "next" ? { PACKAGE_ARCHIVE: "" } : {}), ...options.env },
  });
}

async function save(directory, state) {
  await writeFile(join(directory, "release.json.tmp"), JSON.stringify(state, null, 2) + "\n");
  await rename(join(directory, "release.json.tmp"), join(directory, "release.json"));
}

async function report(directory, state, log, phase) {
  state.phase = phase;
  await save(directory, state);
  log(`[npr] ${phase}: ${state.name}@${state.version}`);
}

async function checkRegistry(pkg, state, options, log) {
  const { attempts, delay } = verificationOptions(options);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const metadata = await pkg.view(state.name, state.version);
    if (metadata) {
      if (metadata.dist?.integrity !== state.artifact.integrity || metadata.dist?.shasum !== state.artifact.shasum) {
        throw new Error("Published archive integrity mismatch.");
      }
      return "verified";
    }
    if (attempt + 1 < attempts) {
      log(`[npr] waiting for registry visibility (${attempt + 1}/${attempts})`);
      await setTimeout(delay);
    }
  }
  return "unverified";
}

async function artifactDirectory(cwd, run, path) {
  return resolve(cwd, path?.trim() || (await run("git", ["rev-parse", "--git-path", "npr-release"])).trim());
}

export async function verify({ cwd = process.cwd(), artifacts, run = command, log = console.log, env = process.env } = {}) {
  const execute = runner(cwd, run, "UTC", "verify", env);
  const directory = await artifactDirectory(cwd, execute, artifacts);
  const state = JSON.parse(await readFile(join(directory, "release.json"), "utf8"));
  numericVersion(state.version);
  const pkg = new NpmPackage(cwd, execute);
  try {
    if (typeof state.name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(state.name)) {
      throw new Error("Invalid retained package name.");
    }
    await pkg.intact(directory, state);
    if (!/^[a-f0-9]{40,64}$/u.test(state.releaseCommit)) throw new Error("Missing release commit identity.");
    const git = new Git(execute, state);
    git.releaseCommit = state.releaseCommit;
    await git.verify(null, state.version);
    log(`[npr] verifying: ${state.name}@${state.version}`);
    state.verification = await checkRegistry(pkg, state, state.verificationOptions, log);
    await save(directory, state);
    const message = state.verification === "verified" ? "verified" : "release could not be verified";
    log(`[npr] ${message}: ${state.name}@${state.version}`);
    if (env.GITHUB_STEP_SUMMARY) {
      await writeFile(env.GITHUB_STEP_SUMMARY,
        `\n## npm Release Verification\n\n${state.name}@${state.version}: ${message}.\n`, { flag: "a" });
    }
    return state;
  } catch (error) {
    state.verification = "failed";
    state.error = error.message;
    await save(directory, state);
    throw error;
  }
}

export async function release(config, {
  cwd = process.cwd(), version, artifacts, run = command, log = console.log, env = process.env,
} = {}) {
  if (!config || !Object.hasOwn(config, "changelog")) throw new Error("Configure an explicit changelog format, or changelog: null.");
  if (config.changelog !== null && !["intridea", "keep-a-changelog"].includes(config.changelog.format)) {
    throw new Error("Unknown changelog format.");
  }
  for (const hook of ["prepare", "validate", "validateArtifact", "next"]) {
    if (config[hook] !== undefined && typeof config[hook] !== "function") throw new Error(`${hook} must be a function.`);
  }
  const timezone = config.timezone || env.NPR_TIMEZONE || "UTC";
  const date = calendarDate(timezone);
  const verification = verificationOptions(config.verification);
  const execute = runner(cwd, run, timezone, "release", env);
  if (await realpath(cwd) !== await realpath((await execute("git", ["rev-parse", "--show-toplevel"])).trim())) {
    throw new Error("Run releases from the repository root.");
  }
  const git = new Git(execute, { branch: config.branch || env.NPR_DEFAULT_BRANCH, remote: config.remote });
  await git.initialize();
  if (env.GITHUB_ACTIONS === "true" &&
    (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_REF !== `refs/heads/${git.branch}`)) {
    throw new Error("Actions publication requires manual dispatch from the default branch.");
  }
  const pkg = new NpmPackage(cwd, execute);
  const manifest = await pkg.read();
  const repository = config.repository || manifest.repository?.url?.replace(/^git\+/u, "").match(
    /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/u,
  )?.[1];
  if (config.github !== false && (!repository || !/^[\w.-]+\/[\w.-]+$/u.test(repository))) {
    throw new Error("Configure a GitHub owner/repository.");
  }
  version = numericVersion(version?.trim() || manifest.version);
  if (!valid(version)) throw new Error("Invalid semantic version.");
  const nextVersion = inc(version, "patch");
  if (!nextVersion) throw new Error("Cannot increment the selected version.");
  await git.missingTag(version);
  await pkg.available(manifest.name, version);
  const directory = await artifactDirectory(cwd, execute, artifacts);
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length) throw new Error("Existing release artifacts: inspect recovery state; never blindly republish.");
  const state = {
    name: manifest.name, version, previousVersion: manifest.version, nextVersion,
    date, timezone, branch: git.branch, remote: git.remote, initialCommit: git.initialCommit,
    verificationOptions: verification, phase: "started",
  };
  await writeFile(join(directory, "release.json"), JSON.stringify(state, null, 2) + "\n", { flag: "wx" });
  const context = (phase, extra = {}) => Object.freeze({
    cwd, version: phase === "next" ? state.nextVersion : version, releasedVersion: version,
    previousVersion: manifest.version, date, phase, run: runner(cwd, run, timezone, phase, env), ...extra,
  });
  const changelogPath = resolve(cwd, config.changelog?.path || "CHANGELOG.md");
  const validate = config.validate || (async ({ run: exec }) => {
    await exec("npm", ["test"]);
    await exec("npm", ["run", "lint"]);
  });
  try {
    let notes = "";
    const preparedTree = await git.stage(async () => {
      await pkg.setVersion(version);
      if (config.changelog) {
        const updated = releaseChangelog(await readFile(changelogPath, "utf8"), { ...config.changelog, version, date });
        notes = updated.notes;
        await writeFile(changelogPath, updated.source);
      }
      await config.prepare?.(context("prepare"));
      if ((await pkg.read()).version !== version) throw new Error("Preparation changed the selected version.");
      await pkg.lockfile(await pkg.read());
    });
    state.preparedTree = preparedTree;
    await report(directory, state, log, "prepared");
    await report(directory, state, log, "validating");
    await validate(context("validate"));
    await git.unchanged(preparedTree);
    await report(directory, state, log, "validated");
    state.releaseCommit = await git.commit(`Prepare release ${version}`, preparedTree);
    await report(directory, state, log, "building");
    state.artifact = await pkg.pack(directory, state);
    const archive = join(directory, state.artifact.filename);
    await pkg.consumer(archive, (consumer) => config.validateArtifact?.(context("artifact", { archive, consumer })));
    await pkg.intact(directory, state);
    await git.clean();
    await git.current(state.initialCommit);
    await git.missingTag(version);
    await pkg.available(state.name, version);
    await git.run("tag", "--no-sign", `v${version}`);
    await git.run("bundle", "create", join(directory, "release.bundle"), "HEAD", `refs/tags/v${version}`);
    await writeFile(join(directory, "release-notes.md"), notes + "\n");
    await report(directory, state, log, "built");
    await report(directory, state, log, "publishing");
    await pkg.publish(archive);
    await report(directory, state, log, "published");
    await pkg.intact(directory, state);
    await git.current(state.initialCommit);
    await git.push(state.releaseCommit, version);
    await report(directory, state, log, "pushed");
    if (config.github !== false) {
      await execute("gh", ["release", "create", `v${version}`, archive, "--repo", repository,
        "--verify-tag", "--title", version, "--notes-file", join(directory, "release-notes.md")]);
    }
    await report(directory, state, log, "hosted");
    const nextTree = await git.stage(async () => {
      await pkg.setVersion(state.nextVersion);
      if (config.changelog) {
        await writeFile(changelogPath, nextChangelog(await readFile(changelogPath, "utf8"), {
          ...config.changelog, version: state.nextVersion, releasedVersion: version,
        }));
      }
      await config.next?.(context("next"));
      if ((await pkg.read()).version !== state.nextVersion) throw new Error("Next hook changed the development version.");
      await pkg.lockfile(await pkg.read());
    });
    await validate(context("next"));
    state.nextCommit = await git.commit(`Prepare next development iteration, ${state.nextVersion}`, nextTree);
    await save(directory, state);
    await git.run("bundle", "create", join(directory, "next.bundle"), "HEAD", `refs/tags/v${version}`);
    await git.current(state.releaseCommit);
    await git.push(state.nextCommit);
    await report(directory, state, log, "next");
    await pkg.intact(directory, state);
    return await verify({ cwd, artifacts: directory, run, log, env });
  } catch (error) {
    state.error = error.message;
    if (state.phase === "next") state.verification = "failed";
    await save(directory, state);
    log(`[npr] stopped at ${state.phase}; recovery artifacts: ${directory}`);
    throw error;
  }
}
