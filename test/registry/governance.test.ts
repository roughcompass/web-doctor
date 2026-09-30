import fs from "node:fs";
import { describe, expect, it } from "vitest";

const codeowners = fs.readFileSync(new URL("../../.github/CODEOWNERS", import.meta.url), "utf8");
const workflow = fs.readFileSync(new URL("../../.github/workflows/registry.yml", import.meta.url), "utf8");
const documentation = fs.readFileSync(new URL("../../docs/repository-governance.md", import.meta.url), "utf8");

describe("registry repository governance", () => {
  it.each([
    "registry/catalog.json",
    "registry/ownership.json",
    "registry/registry.lock.json",
  ])("maps %s to the platform review team", (registryPath) => {
    expect(codeownersFor(registryPath)).toEqual(["@platform/web-doctor"]);
  });

  it("defines and documents the required registry validation check", () => {
    expect(workflow).toContain("name: Registry");
    expect(workflow).toContain("  validate:");
    expect(documentation).toContain("Registry / validate");
    expect(documentation).toContain("Dismiss stale approvals");
  });
});

function codeownersFor(filePath: string): string[] {
  let owners: string[] = [];
  for (const line of codeowners.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const [pattern, ...lineOwners] = trimmed.split(/\s+/);
    if (pattern === "/registry/" && filePath.startsWith("registry/")) owners = lineOwners;
  }
  return owners;
}