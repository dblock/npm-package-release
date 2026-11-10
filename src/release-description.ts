import type { ReleaseIdentity } from "./contracts.js";

export interface ReleaseDescription extends ReleaseIdentity {
  readonly manifestVersion: string;
  readonly date: string;
  readonly nextVersion?: string;
  readonly notes?: string;
}

export class Release implements ReleaseDescription {
  readonly name: string;
  readonly version: string;
  readonly manifestVersion: string;
  readonly date: string;
  readonly nextVersion?: string;
  readonly notes?: string;

  constructor(description: ReleaseDescription) {
    for (const value of [description.name, description.version, description.manifestVersion]) {
      if (typeof value !== "string" || !value.trim()) throw new Error("Release identity fields must be nonempty strings.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(description.date) ||
      (description.nextVersion !== undefined && (typeof description.nextVersion !== "string" || !description.nextVersion.trim())) ||
      (description.notes !== undefined && typeof description.notes !== "string")) {
      throw new Error("Invalid release metadata.");
    }
    this.name = description.name;
    this.version = description.version;
    this.manifestVersion = description.manifestVersion;
    this.date = description.date;
    this.nextVersion = description.nextVersion;
    this.notes = description.notes;
    Object.freeze(this);
  }

  withVersion(version: string): Release {
    return new Release({ ...this, version });
  }

  withNextVersion(nextVersion: string): Release {
    return new Release({ ...this, nextVersion });
  }

  withNotes(notes: string): Release {
    return new Release({ ...this, notes });
  }
}
