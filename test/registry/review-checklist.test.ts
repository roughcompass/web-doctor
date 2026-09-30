import fs from "node:fs";
import { describe, expect, it } from "vitest";

const checklist = fs.readFileSync(new URL("../../docs/platform-review-checklist.md", import.meta.url), "utf8");
const template = fs.readFileSync(new URL("../../.github/PULL_REQUEST_TEMPLATE/contribution.md", import.meta.url), "utf8");

describe("platform contribution review", () => {
  it.each([
    "Identity and Ownership",
    "Fixtures and Signal Quality",
    "Dependencies and Provenance",
    "Capabilities and Resource Bounds",
    "Compatibility and Lifecycle",
    "false-positive evidence",
  ])("documents %s", (topic) => {
    expect(checklist).toContain(topic);
  });

  it("links the review checklist from the contribution pull-request template", () => {
    expect(template).toContain("../../docs/platform-review-checklist.md");
    expect(template).toContain("registry.lock.json");
  });
});