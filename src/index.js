import metadata from "../package.json" with { type: "json" };

export const version = metadata.version;
export { release, verify } from "./release.js";
export { releaseChangelog, nextChangelog } from "./changelog.js";
