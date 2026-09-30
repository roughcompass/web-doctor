import fs from "node:fs";
import { describe, expect, it } from "vitest";

const documentation = fs.readFileSync(new URL("../../docs/package-release.md", import.meta.url), "utf8");

describe("package release documentation", () => {
  it.each([
    "npm run release:verify",
    "npm pack --dry-run",
    "SHA-512",
    "web-doctor provenance --json",
    "Reproduce a Prior Revision",
    "package-manager lockfile",
    "Rollback",
  ])("documents %s", (requirement) => {
    expect(documentation).toContain(requirement);
  });
});