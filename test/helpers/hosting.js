import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// Simulate `gh release` and `gh api` for GitHubReleaseHost, retaining the hosted release and asset bytes.
export function simulatedGitHub(run, hosted = { release: null, assets: new Map(), creates: 0 }) {
  hosted.releases ??= new Map();
  const command = async (program, args, options) => {
    if (program !== "gh") return run(program, args, options);
    if (hosted.failure) throw new Error(hosted.failure);
    if (args[0] === "api") {
      const found = hosted.releases.get(args.at(-1).split("/").at(-1));
      if (!found) throw Object.assign(new Error("Not found"), { stdout: "HTTP/2.0 404 Not Found\n\n{}", code: 1 });
      return "HTTP/2.0 200 OK\n\n" + JSON.stringify(found);
    }
    const archive = args[3];
    const name = archive.split(/[\\/]/u).at(-1);
    const bytes = await readFile(archive);
    hosted.assets.set(name, bytes);
    const asset = { name, digest: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
    if (args[1] === "create") {
      hosted.creates = (hosted.creates || 0) + 1;
      hosted.release = {
        tag_name: args[2], name: args[args.indexOf("--title") + 1],
        body: await readFile(args[args.indexOf("--notes-file") + 1], "utf8"), draft: false, prerelease: false, assets: [asset],
      };
      hosted.releases.set(args[2], hosted.release);
    } else hosted.releases.get(args[2]).assets.push(asset);
    return "";
  };
  return Object.assign(command, { hosted });
}
